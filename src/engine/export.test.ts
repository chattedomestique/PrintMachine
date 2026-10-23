/**
 * Saving: the print is pressed at the size the planner gives (never the
 * preview's), encoded as asked, handed over by a share sheet that never
 * falls back to a download where that would take the app with it, and never
 * printed on bare paper for want of its photo.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ENCODINGS,
  JPEG_QUALITY,
  MissingPhotoError,
  deliverFile,
  describePlan,
  fileSize,
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

/** A canvas and 2D context that record sizes and draws and hand back blank
 *  pixels: enough for renderPrint's glyph and photo calls. */
function fakeContext() {
  const sizes: [number, number][] = []
  const blobs: { mime: string; quality: number | undefined }[] = []
  let width = 0
  let height = 0
  const canvas = {
    get width() {
      return width
    },
    set width(v: number) {
      width = v
      sizes.push([width, height])
    },
    get height() {
      return height
    },
    set height(v: number) {
      height = v
      sizes.push([width, height])
    },
    toBlob(cb: (b: Blob | null) => void, mime: string, quality?: number) {
      blobs.push({ mime, quality })
      cb(new Blob([new Uint8Array(1234)], { type: mime }))
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
    clearRect: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    fillText: () => {},
    fillRect: () => {},
    measureText: (t: string) => ({ width: t.length * 10 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
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

  it('never prints a photo document without its photo', async () => {
    const { render, heights } = spyRender()
    await expect(savePrint(fakeContext().ctx, fakeContext().ctx, withPhoto(100, 100), null, {}, render)).rejects.toBeInstanceOf(
      MissingPhotoError,
    )
    expect(heights).toEqual([])
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
    // Two plates, one with a backing: three passes on the press.
    expect(steps.slice(0, 4)).toEqual(['photo 0/3', 'press 1/3', 'press 2/3', 'press 3/3'])
    expect(steps.slice(4).every((t) => t === 'print 3/3')).toBe(true)
    expect(steps.length).toBeGreaterThan(4)

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
  })
})
