/**
 * Saving: the print is pressed at the size the planner gives (never the
 * preview's), encoded as asked, handed over by a share sheet that never
 * falls back to a download where that would take the app with it, and never
 * printed on bare paper for want of its photo.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CanvasLimitError,
  ENCODINGS,
  JPEG_QUALITY,
  MissingPhotoError,
  SMALLER_STEP,
  SMALLEST_COPY_HEIGHT,
  deliverFile,
  describePlan,
  fileSize,
  findSmallerPlan,
  fitsCanvas,
  planPrint,
  printFile,
  saveMessage,
  savePrint,
} from './export.ts'
import { planExport } from './exportPlan.ts'
import { DRAFT_HEIGHT, PREVIEW_HEIGHT, renderPrint, renderPrintAsync, type RenderProgress } from './render.ts'
import { REFERENCE_HEIGHT } from './limits.ts'
import { sheetAspect, type PrintSettings } from './types.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'

/**
 * A canvas and 2D context that record sizes and draws and hand back blank
 * pixels: enough for renderPrint's glyph and photo calls. A 1x1 sentinel
 * rectangle reads back as drawn, as on a real canvas, unless the canvas is
 * over `maxArea`: then, as an iOS canvas over its limit does, it reads back
 * blank. With `encodes: false` the encoder hands back null.
 */
function fakeContext(opts: { maxArea?: number; encodes?: boolean } = {}) {
  const sizes: [number, number][] = []
  const blobs: { mime: string; quality: number | undefined }[] = []
  let width = 0
  let height = 0
  // The one-pixel rectangle drawn since the canvas was last sized or cleared.
  let drawn: { x: number; y: number; fill: string } | null = null
  const canvas = {
    get width() {
      return width
    },
    set width(v: number) {
      width = v
      drawn = null
      sizes.push([width, height])
    },
    get height() {
      return height
    },
    set height(v: number) {
      height = v
      drawn = null
      sizes.push([width, height])
    },
    toBlob(cb: (b: Blob | null) => void, mime: string, quality?: number) {
      blobs.push({ mime, quality })
      cb(opts.encodes === false ? null : new Blob([new Uint8Array(1234)], { type: mime }))
    },
  }
  const ctx = {
    canvas,
    font: '',
    fillStyle: '',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    letterSpacing: '0px',
    imageSmoothingQuality: 'low',
    clearRect: (x: number, y: number, w: number, h: number) => {
      if (drawn && drawn.x >= x && drawn.x < x + w && drawn.y >= y && drawn.y < y + h) drawn = null
    },
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    fillText: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      if (w === 1 && h === 1) drawn = { x, y, fill: ctx.fillStyle }
    },
    measureText: (t: string) => ({ width: t.length * 10 }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      const fits = width * height <= (opts.maxArea ?? Infinity)
      if (fits && w === 1 && h === 1 && drawn?.x === x && drawn.y === y && drawn.fill === 'rgb(1, 2, 3)') data.set([1, 2, 3, 255])
      return { data }
    },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, sizes, blobs }
}

/** A renderer stand-in that records the height it was asked for and sizes
 *  the canvas as the real one does. */
function spyRender() {
  const heights: number[] = []
  const render: typeof renderPrintAsync = async (ctx, _scratch, s, height) => {
    heights.push(height)
    ctx.canvas.width = Math.round(height * sheetAspect(s))
    ctx.canvas.height = height
  }
  return { render, heights }
}

const withPhoto = (width: number, height: number, over: Partial<PrintSettings> = {}): PrintSettings => ({
  ...defaultSettings(),
  aspect: '4:5',
  media: makeMedia({ id: 'p', width, height, native: true }),
  ...over,
})
const decoded = {} as CanvasImageSource

describe('the export height: the planner, never the preview', () => {
  it('passes the planned height to the renderer: >= the reference height, never the preview or draft height', async () => {
    const docs: PrintSettings[] = [
      defaultSettings(),
      withPhoto(4032, 3024),
      withPhoto(3024, 4032),
      withPhoto(1600, 1200),
      withPhoto(5712, 4284, { aspect: 'original' }),
      withPhoto(4032, 3024, { media: makeMedia({ id: 'p', width: 4032, height: 3024, scale: 4 }) }),
    ]
    for (const s of docs) {
      const { render, heights } = spyRender()
      const out = fakeContext()
      const pressed = await savePrint(out.ctx, fakeContext().ctx, s, s.media ? decoded : null, {}, render)
      expect(heights).toEqual([planPrint(s).height])
      expect(pressed.plan).toEqual(planPrint(s))
      expect(heights[0]).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
      expect(heights[0]).not.toBe(PREVIEW_HEIGHT)
      expect(heights[0]).not.toBe(DRAFT_HEIGHT)
    }
  })

  it('a 12 MP photo on 4:5 is pressed at 3024 tall: 2419x3024, its own pixels', async () => {
    const s = withPhoto(4032, 3024)
    const { render, heights } = spyRender()
    const out = fakeContext()
    const pressed = await savePrint(out.ctx, fakeContext().ctx, s, decoded, {}, render)
    expect(heights).toEqual([3024])
    expect(pressed.plan).toMatchObject({ width: 2419, height: 3024, limit: 'native' })
    expect(out.sizes).toContainEqual([2419, 3024])
  })

  it('plans from the photo\'s true size and zoom, through the sheet\'s numeric aspect', () => {
    const s = withPhoto(5712, 4284, { aspect: 'original' })
    expect(planPrint(s)).toEqual(planExport(5712 / 4284, { width: 5712, height: 4284, scale: 1 }))
    expect(planPrint(defaultSettings())).toEqual(planExport(4 / 5, null))
  })
})

describe('the file', () => {
  it('JPEG at 0.95; PNG lossless, with no quality', async () => {
    expect(JPEG_QUALITY).toBe(0.95)
    expect(ENCODINGS.jpeg).toEqual({ mime: 'image/jpeg', ext: 'jpg', quality: 0.95 })
    expect(ENCODINGS.png).toEqual({ mime: 'image/png', ext: 'png', quality: undefined })
    for (const format of ['jpeg', 'png'] as const) {
      const out = fakeContext()
      const pressed = await savePrint(out.ctx, fakeContext().ctx, defaultSettings(), null, { format }, spyRender().render)
      expect(out.blobs).toEqual([{ mime: ENCODINGS[format].mime, quality: ENCODINGS[format].quality }])
      const file = printFile(pressed)
      expect(file.name).toBe(`print-machine.${ENCODINGS[format].ext}`)
      expect(file.type).toBe(ENCODINGS[format].mime)
    }
  })

  it('lets both canvases go once the file exists, and when the press fails', async () => {
    const out = fakeContext()
    const scratch = fakeContext()
    await savePrint(out.ctx, scratch.ctx, defaultSettings(), null, {}, spyRender().render)
    expect(out.ctx.canvas.width).toBe(0)
    expect(scratch.ctx.canvas.width).toBe(0)

    const failing: typeof renderPrintAsync = async (ctx) => {
      ctx.canvas.width = 2880
      ctx.canvas.height = 3600
      throw new RangeError('Array buffer allocation failed')
    }
    const out2 = fakeContext()
    await expect(savePrint(out2.ctx, fakeContext().ctx, defaultSettings(), null, {}, failing)).rejects.toThrow(/allocation/)
    expect(out2.ctx.canvas.width).toBe(0)
  })

  it('refuses a canvas that is not the planned size, rather than saving it under that caption', async () => {
    const short: typeof renderPrintAsync = async (ctx) => {
      ctx.canvas.width = 1440
      ctx.canvas.height = 1800
    }
    await expect(savePrint(fakeContext().ctx, fakeContext().ctx, defaultSettings(), null, {}, short)).rejects.toThrow(
      /1440×1800, not the planned 2880×3600/,
    )
  })

  it('presses no taller than a smaller copy asked for, and says so', async () => {
    const s = withPhoto(4032, 3024)
    const { render, heights } = spyRender()
    const pressed = await savePrint(fakeContext().ctx, fakeContext().ctx, s, decoded, { maxHeight: 2268 }, render)
    expect(heights).toEqual([2268])
    expect(pressed.plan).toMatchObject({ width: 1814, height: 2268, limit: 'smaller' })
  })

  it('never prints a photo document without its photo', async () => {
    const { render, heights } = spyRender()
    await expect(savePrint(fakeContext().ctx, fakeContext().ctx, withPhoto(100, 100), null, {}, render)).rejects.toBeInstanceOf(
      MissingPhotoError,
    )
    expect(heights).toEqual([])
  })
})

describe('a print too big for this device: proved before the work, said in numbers, never quietly smaller', () => {
  it('a canvas works when its sentinel pixel reads back; blank, clamped or throwing, it does not', () => {
    const probed = fakeContext()
    expect(fitsCanvas(probed.ctx, 2419, 3024)).toBe(true)
    // Left at that size and blank, for the press to draw on.
    expect([probed.ctx.canvas.width, probed.ctx.canvas.height]).toEqual([2419, 3024])
    expect([...probed.ctx.getImageData(2418, 3023, 1, 1).data]).toEqual([0, 0, 0, 0])
    expect(fitsCanvas(fakeContext({ maxArea: 4096 * 4096 }).ctx, 4096, 4096)).toBe(true)
    expect(fitsCanvas(fakeContext({ maxArea: 4096 * 4096 }).ctx, 4097, 4096)).toBe(false)
    // A canvas that will not take the size asked (some browsers clamp).
    const clamped = fakeContext()
    Object.defineProperty(clamped.ctx.canvas, 'width', { get: () => 0, set: () => {} })
    expect(fitsCanvas(clamped.ctx, 100, 100)).toBe(false)
    const throwing = fakeContext()
    ;(throwing.ctx as unknown as { getImageData: () => never }).getImageData = () => {
      throw new RangeError('Out of memory')
    }
    expect(fitsCanvas(throwing.ctx, 100, 100)).toBe(false)
  })

  it('probes both canvases at the planned size before pressing anything; either blank stops it, both let go', async () => {
    const s = withPhoto(4032, 3024)
    for (const [outArea, scratchArea] of [
      [5e6, Infinity],
      [Infinity, 5e6],
    ]) {
      const { render, heights } = spyRender()
      const out = fakeContext({ maxArea: outArea })
      const scratch = fakeContext({ maxArea: scratchArea })
      const err = await savePrint(out.ctx, scratch.ctx, s, decoded, {}, render).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CanvasLimitError)
      expect((err as CanvasLimitError).plan).toEqual(planPrint(s))
      expect((err as Error).message).toBe("This device couldn't press 2419×3024 (a canvas that size came back blank).")
      expect(heights).toEqual([])
      expect(out.ctx.canvas.width).toBe(0)
      expect(scratch.ctx.canvas.width).toBe(0)
    }
  })

  it('an encoder that hands back nothing, or memory running out, is the same "too big", with the plan', async () => {
    const s = withPhoto(4032, 3024)
    const noFile = await savePrint(fakeContext({ encodes: false }).ctx, fakeContext().ctx, s, decoded, {}, spyRender().render).catch(
      (e: unknown) => e,
    )
    expect(noFile).toBeInstanceOf(CanvasLimitError)
    expect((noFile as Error).message).toBe("This device couldn't press 2419×3024 (the image could not be encoded).")

    const oom: typeof renderPrintAsync = async () => {
      throw new RangeError('Array buffer allocation failed')
    }
    const err = await savePrint(fakeContext().ctx, fakeContext().ctx, s, decoded, {}, oom).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CanvasLimitError)
    expect((err as CanvasLimitError).plan.height).toBe(3024)
    expect((err as Error).message).toMatch(/2419×3024 \(Array buffer allocation failed\)/)

    // Anything else is not dressed up as a size problem.
    const bug: typeof renderPrintAsync = async () => {
      throw new TypeError('x is undefined')
    }
    const other = await savePrint(fakeContext().ctx, fakeContext().ctx, s, decoded, {}, bug).catch((e: unknown) => e)
    expect(other).not.toBeInstanceOf(CanvasLimitError)
  })

  it('the smaller copy offered: three quarters at a time, the sheet kept, the first one that fits', () => {
    expect(SMALLER_STEP).toBe(0.75)
    const s = withPhoto(4032, 3024)
    const tried: [number, number][] = []
    const fits = (w: number, h: number) => (tried.push([w, h]), w * h <= 2.5e6)
    const plan = findSmallerPlan(s, 3024, fits)
    // 3024 -> 2268 (4.1 MP) -> 1701 (2.3 MP): the first under 2.5 MP.
    expect(tried).toEqual([
      [1814, 2268],
      [1361, 1701],
    ])
    expect(plan).toMatchObject({ width: 1361, height: 1701, limit: 'smaller' })
    expect(plan!.width / plan!.height).toBeCloseTo(4 / 5, 3)
  })

  it('never offers one bigger than what failed, and none below the smallest copy: then, no copy at all', () => {
    const s = withPhoto(5712, 4284, { aspect: 'original' })
    const heights: number[] = []
    const plan = findSmallerPlan(s, 3547, (_w, h) => (heights.push(h), false))
    expect(plan).toBeNull()
    expect(SMALLEST_COPY_HEIGHT).toBe(600)
    expect(heights).toEqual([2660, 1995, 1496, 1122, 842, 632])
    for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeLessThan(heights[i - 1])
    // A short sheet steps down from where it failed, never up to the photo.
    expect(findSmallerPlan(s, 1000, () => true)).toMatchObject({ height: 750 })
  })
})

describe('the async render: the same stages, with yields, progress and Cancel', () => {
  const doc = (): PrintSettings => {
    const s = defaultSettings()
    s.media = makeMedia({ id: 'p', width: 400, height: 500 })
    s.layers = [makeLayer({ id: 'a' }), makeLayer({ id: 'b', backing: 'yellow' })]
    return s
  }

  it('reports the photo, every pass in order and the print, and prints what the sync render prints', async () => {
    const seen: RenderProgress[] = []
    const a = fakeContext()
    const b = fakeContext()
    let grounded = 0
    await renderPrintAsync(a.ctx, fakeContext().ctx, doc(), 300, decoded, {
      onProgress: (p) => seen.push(p),
      onGround: () => grounded++,
    })
    expect(grounded).toBe(1)
    const steps = seen.map((p) => `${p.step} ${p.pass}/${p.passes}`)
    // Two plates, one with a backing: three passes on the press, in order,
    // then the print.
    expect(steps.filter((t, i) => t !== steps[i - 1])).toEqual(['photo 0/3', 'press 1/3', 'press 2/3', 'press 3/3', 'print 3/3'])
    // A pass yields inside as well as before it (after the tear and the wear).
    for (const pass of ['press 1/3', 'press 2/3', 'press 3/3']) expect(steps.filter((t) => t === pass).length).toBeGreaterThanOrEqual(3)

    // The same pixels as renderPrint at the same height (the harness checks
    // this on real glyphs and a real photo).
    // The canvas's pixels, as the bands are put on it.
    const capture = (fake: ReturnType<typeof fakeContext>) => {
      const sheet = { data: new Uint8ClampedArray(0), bands: 0 }
      ;(fake.ctx as unknown as { putImageData: unknown }).putImageData = (
        img: { data: Uint8ClampedArray },
        _dx: number,
        dy: number,
        _x: number,
        _y: number,
        dw: number,
        dh: number,
      ) => {
        const w = fake.ctx.canvas.width
        if (sheet.data.length !== w * fake.ctx.canvas.height * 4) sheet.data = new Uint8ClampedArray(w * fake.ctx.canvas.height * 4)
        sheet.data.set(img.data.subarray(0, dw * dh * 4), dy * w * 4)
        sheet.bands++
      }
      return sheet
    }
    const asyncOut = capture(a)
    const syncOut = capture(b)
    await renderPrintAsync(a.ctx, fakeContext().ctx, doc(), 300, decoded)
    renderPrint(b.ctx, fakeContext().ctx, doc(), { current: null }, null, 300, decoded)
    expect(asyncOut.bands).toBeGreaterThan(0)
    expect(asyncOut.data.length).toBe(240 * 300 * 4)
    expect(asyncOut.data).toEqual(syncOut.data)
  })

  it('stops at the next step once cancelled, with an AbortError', async () => {
    const controller = new AbortController()
    let presses = 0
    const run = renderPrintAsync(fakeContext().ctx, fakeContext().ctx, doc(), 300, decoded, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.step === 'press') presses++
        if (p.pass === 1) controller.abort()
      },
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(presses).toBe(1)
  })
})

describe('handing the file over', () => {
  afterEach(() => vi.unstubAllGlobals())
  const file = () => new File([new Uint8Array(10)], 'print-machine.jpg', { type: 'image/jpeg' })
  /** A share sheet that behaves as told, and a page that records downloads. */
  const browser = (share: () => Promise<void>) => {
    const downloads: string[] = []
    vi.stubGlobal('navigator', { canShare: () => true, share })
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => downloads.push('a'), remove: () => {} }),
      body: { appendChild: () => {} },
    })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    return downloads
  }
  const fail = (name: string) => async () => {
    const e = new Error(name)
    e.name = name
    throw e
  }

  it('shares; a dismissed sheet is a cancel, not an error', async () => {
    browser(async () => {})
    await expect(deliverFile(file(), { allowDownload: true })).resolves.toBe('shared')
    browser(fail('AbortError'))
    await expect(deliverFile(file(), { allowDownload: true })).resolves.toBe('cancelled')
  })

  it('in a home-screen app a failed share never falls through to a download: it throws, and the file waits for another tap', async () => {
    const downloads = browser(fail('DataError'))
    await expect(deliverFile(file(), { allowDownload: false })).rejects.toThrow('DataError')
    expect(downloads).toEqual([])
  })

  it('an expired tap asks for another tap, even where downloads are allowed', async () => {
    const downloads = browser(fail('NotAllowedError'))
    await expect(deliverFile(file(), { allowDownload: true })).rejects.toThrow('NotAllowedError')
    expect(downloads).toEqual([])
  })

  it('in a browser tab a failed share downloads instead, as before', async () => {
    const downloads = browser(fail('DataError'))
    await expect(deliverFile(file(), { allowDownload: true })).resolves.toBe('downloaded')
    expect(downloads).toEqual(['a'])
  })
})

describe('what Save says', () => {
  const plan = (s: PrintSettings) => describePlan(planPrint(s), s.media)

  it('the pixel size, and nothing more when the print is the photo\'s own pixels', () => {
    expect(plan(withPhoto(4032, 3024))).toEqual({ size: '2419×3024', reason: null })
    expect(plan(defaultSettings())).toEqual({ size: '2880×3600', reason: null })
  })

  it('an enlarged photo, in numbers', () => {
    expect(plan(withPhoto(1600, 1200))).toEqual({ size: '1440×1800', reason: 'photo is 1600×1200: upscaled 1.5x' })
    expect(plan(withPhoto(4032, 3024, { media: makeMedia({ id: 'p', width: 4032, height: 3024, scale: 4 }) })).reason).toBe(
      'photo is 4032×3024 at 400% zoom: upscaled 2.38x',
    )
  })

  it('the canvas ceiling, in numbers [O-1]', () => {
    expect(plan(withPhoto(5712, 4284, { aspect: 'original' }))).toEqual({
      size: '4729×3547',
      reason: 'capped at 16.7 MP, the most a browser canvas is guaranteed to hold; photo is 5712×4284',
    })
    // The same photo on 4:5 is not capped: its own 3427x4284.
    expect(plan(withPhoto(5712, 4284))).toEqual({ size: '3427×4284', reason: null })
  })

  it('a size in MB or KB, and a confirmation that repeats the dimensions', () => {
    expect(fileSize(6_204_000)).toBe('6.2 MB')
    expect(fileSize(840_000)).toBe('840 KB')
    const p = planPrint(withPhoto(4032, 3024))
    expect(saveMessage('shared', p)).toBe('Saved 2419×3024')
    expect(saveMessage('downloaded', p)).toBe('Downloaded 2419×3024')
    expect(saveMessage('cancelled', p)).toBeNull()
    // A smaller copy says so: the caption above Save names the full size.
    const smaller = planPrint(withPhoto(4032, 3024), { maxHeight: 2268 })
    expect(saveMessage('shared', smaller)).toBe('Saved 1814×2268, a smaller copy')
  })
})
