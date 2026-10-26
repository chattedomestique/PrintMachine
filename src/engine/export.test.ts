/**
 * Saving: the print is pressed at the size the planner gives (never the
 * preview's), in bands, straight into the encoder (a JPEG with every colour
 * sample kept, or a lossless PNG); every canvas it makes is proved first; a
 * press that runs out of memory goes again in bands half as tall, to the same
 * file; and nothing is printed on bare paper for want of its photo. (The
 * file is handed over by the page: features/shell/page.test.ts.)
 *
 * The press runs for real here (node has no 2D context, so the canvases are
 * stand-ins that draw nothing: the type and the photo come out blank, which
 * is all these tests need of them).
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BAND_HALVINGS,
  CanvasLimitError,
  ENCODINGS,
  JPEG_QUALITY,
  MissingPhotoError,
  SMALLER_STEP,
  SMALLEST_COPY_HEIGHT,
  describePlan,
  fileSize,
  findSmallerPlanAsync,
  fitsCanvas,
  planPrint,
  pressCanvases,
  printFile,
  savePrint,
} from './export.ts'
import { planExport } from './exportPlan.ts'
import { DRAFT_HEIGHT, PREVIEW_HEIGHT, renderPrint, renderPrintAsync, type RenderProgress } from './render.ts'
import { REFERENCE_HEIGHT, bandHeight } from './limits.ts'
import { quantTable, LUMA_QUANT } from './encode/jpeg.ts'
import type { PrintSettings } from './types.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'

/**
 * A canvas and 2D context that record their sizes and hand back blank
 * pixels: enough for the press's glyph and photo calls. A 1x1 sentinel
 * rectangle reads back as drawn, as on a real canvas, unless the canvas is
 * over `maxArea` or wider than `maxWidth`: then, as an iOS canvas over its
 * limit does, it reads back blank.
 */
function fakeContext(opts: { maxArea?: number; maxWidth?: number } = {}) {
  const sizes: [number, number][] = []
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
  }
  const ctx = {
    canvas,
    font: '',
    fillStyle: '',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    letterSpacing: '0px',
    imageSmoothingQuality: 'low',
    imageSmoothingEnabled: true,
    clearRect: (x: number, y: number, w: number, h: number) => {
      if (drawn && drawn.x >= x && drawn.x < x + w && drawn.y >= y && drawn.y < y + h) drawn = null
    },
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillText: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      if (w === 1 && h === 1) drawn = { x, y, fill: ctx.fillStyle }
    },
    measureText: (t: string) => ({ width: t.length * 10 }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      const fits = width * height <= (opts.maxArea ?? Infinity) && width <= (opts.maxWidth ?? Infinity)
      if (fits && w === 1 && h === 1 && drawn?.x === x && drawn.y === y && drawn.fill === 'rgb(1, 2, 3)') data.set([1, 2, 3, 255])
      return { data }
    },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, sizes }
}

/** A canvas factory for savePrint that keeps every canvas it made. */
function canvases(opts: Parameters<typeof fakeContext>[0] = {}) {
  const made: ReturnType<typeof fakeContext>[] = []
  return {
    made,
    makeCanvas: () => {
      const c = fakeContext(opts)
      made.push(c)
      return c.ctx
    },
  }
}

const withPhoto = (width: number, height: number, over: Partial<PrintSettings> = {}): PrintSettings => ({
  ...defaultSettings(),
  aspect: '4:5',
  media: makeMedia({ id: 'p', width, height, native: true }),
  ...over,
})
/** A decoded photo, as far as the press asks: its size. */
const decoded = (width: number, height: number) => ({ width, height }) as unknown as CanvasImageSource

/** The frame header of a JPEG: size and each component's sampling. */
async function sof0(blob: Blob): Promise<{ w: number; h: number; sampling: number[] }> {
  const b = new Uint8Array(await blob.arrayBuffer())
  for (let i = 2; i < b.length; ) {
    const m = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    if (m === 0xc0) {
      const n = b[i + 9]
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], sampling: Array.from({ length: n }, (_, c) => b[i + 11 + 3 * c]) }
    }
    i += 2 + len
  }
  throw new Error('no SOF0')
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __PM_TEST__?: unknown }).__PM_TEST__
})

describe('the export height: the planner, never the preview', () => {
  it('the planned height: at least the reference height, never the preview or draft height', () => {
    for (const s of [
      defaultSettings(),
      withPhoto(4032, 3024),
      withPhoto(3024, 4032),
      withPhoto(1600, 1200),
      withPhoto(5712, 4284, { aspect: 'original' }),
      withPhoto(7728, 5152, { aspect: 'original' }),
      withPhoto(4032, 3024, { media: makeMedia({ id: 'p', width: 4032, height: 3024, scale: 4 }) }),
    ]) {
      const h = planPrint(s).height
      expect(h).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
      expect(h).not.toBe(PREVIEW_HEIGHT)
      expect(h).not.toBe(DRAFT_HEIGHT)
    }
  })

  it('plans from the photo\'s true size and zoom, through the sheet\'s numeric aspect, in the file\'s format', () => {
    const s = withPhoto(5712, 4284, { aspect: 'original' })
    expect(planPrint(s)).toEqual(planExport(5712 / 4284, { width: 5712, height: 4284, scale: 1 }, { format: 'jpeg' }))
    expect(planPrint(s, { format: 'png' })).toEqual(planExport(5712 / 4284, { width: 5712, height: 4284, scale: 1 }))
    expect(planPrint(defaultSettings())).toEqual(planExport(4 / 5, null))
  })

  it('presses at the planned size: the file\'s frame is the plan\'s, for a print with a photo and one without', { timeout: 30_000 }, async () => {
    for (const [s, media, maxHeight] of [
      [defaultSettings(), null, 600],
      [withPhoto(1600, 1200), decoded(1600, 1200), 700],
      [withPhoto(1600, 1200), decoded(1600, 1200), undefined],
    ] as const) {
      const pressed = await savePrint(s, media, { maxHeight, makeCanvas: canvases().makeCanvas })
      const plan = planPrint(s, { maxHeight })
      expect(pressed.plan).toEqual(plan)
      const f = await sof0(pressed.blob)
      expect([f.w, f.h]).toEqual([plan.width, plan.height])
    }
  })
})

describe('the file', () => {
  it('JPEG at quality 95 with every colour sample kept (4:4:4); PNG lossless', async () => {
    expect(JPEG_QUALITY).toBe(0.95)
    expect(ENCODINGS.jpeg).toEqual({ mime: 'image/jpeg', ext: 'jpg', quality: 95 })
    expect(ENCODINGS.png).toEqual({ mime: 'image/png', ext: 'png', quality: undefined })
    const jpeg = await savePrint(defaultSettings(), null, { maxHeight: 600, makeCanvas: canvases().makeCanvas })
    expect(jpeg.blob.type).toBe('image/jpeg')
    const f = await sof0(jpeg.blob)
    expect(f).toEqual({ w: 480, h: 600, sampling: [0x11, 0x11, 0x11] })
    // The luminance table is quality 95's.
    const bytes = new Uint8Array(await jpeg.blob.arrayBuffer())
    const dqt = bytes.findIndex((v, i) => v === 0xff && bytes[i + 1] === 0xdb)
    expect([...bytes.subarray(dqt + 5, dqt + 13)]).toEqual(quantTable(LUMA_QUANT, 95).slice(0, 8).map((_, k) => quantTable(LUMA_QUANT, 95)[[0, 1, 8, 16, 9, 2, 3, 10][k]]))
    expect(printFile(jpeg).name).toBe('print-machine.jpg')

    // No CompressionStream here, as on iOS before 16.4: stored deflate.
    vi.stubGlobal('CompressionStream', undefined)
    const png = await savePrint(defaultSettings(), null, { format: 'png', maxHeight: 600, makeCanvas: canvases().makeCanvas })
    const p = new Uint8Array(await png.blob.arrayBuffer())
    expect([...p.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    const view = new DataView(p.buffer, p.byteOffset)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([480, 600])
    expect(printFile(png)).toMatchObject({ name: 'print-machine.png', type: 'image/png' })
  })

  it('lets every canvas it made go once the file exists, and when the press fails', async () => {
    const ok = canvases()
    await savePrint(defaultSettings(), null, { maxHeight: 600, makeCanvas: ok.makeCanvas })
    expect(ok.made.length).toBeGreaterThan(0)
    for (const c of ok.made) expect(c.ctx.canvas.width).toBe(0)
    const blank = canvases({ maxArea: 1000 })
    await expect(savePrint(defaultSettings(), null, { maxHeight: 600, makeCanvas: blank.makeCanvas })).rejects.toBeInstanceOf(CanvasLimitError)
    for (const c of blank.made) expect(c.ctx.canvas.width).toBe(0)
  })

  it('never prints a photo document without its photo, and makes no canvas for it', async () => {
    const c = canvases()
    await expect(savePrint(withPhoto(100, 100), null, { makeCanvas: c.makeCanvas })).rejects.toBeInstanceOf(MissingPhotoError)
    expect(c.made).toEqual([])
  })

  it('a Cancel tapped while the file is written: no file, an AbortError, every canvas let go', async () => {
    const controller = new AbortController()
    let started = 0
    ;(globalThis as { __PM_TEST__?: unknown }).__PM_TEST__ = {
      finishDelayMs: 20,
      onFinishStart: () => {
        started++
        controller.abort()
      },
    }
    const c = canvases()
    const steps: RenderProgress['step'][] = []
    const run = savePrint(defaultSettings(), null, { maxHeight: 600, signal: controller.signal, makeCanvas: c.makeCanvas, onProgress: (p) => steps.push(p.step) })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toBe(1)
    expect(steps[steps.length - 1]).toBe('write')
    for (const m of c.made) expect(m.ctx.canvas.width).toBe(0)
  })
})

describe('every canvas the press makes, proved first, at its real size', () => {
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

  it('the canvases a press makes: the first tile (clipped to the sheet) and, for a photo at its own pixels, a band of it at most 4096 wide', () => {
    expect(pressCanvases({ width: 2419, height: 3024 }, true)).toEqual([
      { w: 2419, h: 1733 },
      { w: 2419, h: 866 },
    ])
    expect(pressCanvases({ width: 7728, height: 5152 }, true)).toEqual([
      { w: 4096, h: 1024 },
      { w: 4096, h: 271 },
    ])
    expect(pressCanvases({ width: 2880, height: 3600 }, false)).toEqual([{ w: 2880, h: 1456 }])
    // A sheet of one tile is a canvas of the sheet's own size.
    expect(pressCanvases({ width: 1440, height: 1800 }, false)).toEqual([{ w: 1440, h: 1800 }])
  })

  it('a canvas that comes back blank stops the press before any work, with the plan and the reason', async () => {
    const s = withPhoto(4032, 3024)
    // Canvases wider than 2000 px read back blank: the 2419 px tile.
    const c = canvases({ maxWidth: 2000 })
    const steps: RenderProgress[] = []
    const err = await savePrint(s, decoded(4032, 3024), { makeCanvas: c.makeCanvas, onProgress: (p) => steps.push(p) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CanvasLimitError)
    expect((err as CanvasLimitError).plan).toEqual(planPrint(s))
    expect((err as Error).message).toBe("This device couldn't press 2419×3024 (a canvas came back blank).")
    expect(steps).toEqual([])
    expect(c.made.map((m) => m.sizes.find(([w, h]) => w > 0 && h > 0))).toEqual([[2419, 1733]])
    for (const m of c.made) expect(m.ctx.canvas.width).toBe(0)
    // The photo's band canvas is proved too.
    const piece = canvases({ maxArea: 2419 * 1733 - 1 })
    const err2 = await savePrint(s, decoded(4032, 3024), { makeCanvas: piece.makeCanvas }).catch((e: unknown) => e)
    expect(err2).toBeInstanceOf(CanvasLimitError)
  })
})

/** Typed-array constructors made to throw a RangeError when `fault` says,
 *  the way an allocation fails for want of memory. Restored by `restore`. */
function faulty(fault: (bytes: number) => boolean) {
  const names = ['Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Int32Array'] as const
  const g = globalThis as unknown as Record<string, new (...a: unknown[]) => { byteLength: number }>
  const saved = names.map((n) => [n, g[n]] as const)
  for (const [n, Orig] of saved) {
    g[n] = class extends (Orig as unknown as new (...a: unknown[]) => { byteLength: number }) {
      constructor(...a: unknown[]) {
        super(...a)
        if (!(a[0] instanceof ArrayBuffer) && fault(this.byteLength)) throw new RangeError('Array buffer allocation failed')
      }
      static [Symbol.hasInstance](x: unknown) {
        return x instanceof (Orig as unknown as typeof Object)
      }
    } as unknown as new (...a: unknown[]) => { byteLength: number }
  }
  return () => {
    for (const [n, Orig] of saved) g[n] = Orig
  }
}

describe('out of memory: the press again, in bands half as tall, to the same file', { timeout: 60_000 }, () => {
  // 2400 x 1800 (a 4:3 photo on its own sheet, enlarged to the reference
  // height): three bands of 873 rows.
  const s = () => withPhoto(1600, 1200, { aspect: 'original' })
  const press = async (fault?: (bytes: number, band: number) => boolean) => {
    let band = -1
    const bands: number[] = []
    let grounded = 0
    const restore = fault ? faulty((bytes) => fault(bytes, band)) : () => {}
    try {
      const pressed = await savePrint(s(), decoded(1600, 1200), {
        makeCanvas: canvases().makeCanvas,
        onGround: () => grounded++,
        onProgress: (p) => {
          band = p.band
          bands.push(p.bands)
        },
      })
      return { pressed, bands: [...new Set(bands)], grounded }
    } finally {
      restore()
    }
  }
  /** The file's bytes, as a digest (read once the constructors are back). */
  const digest = async (r: { pressed: { blob: Blob } }) => createHash('sha256').update(new Uint8Array(await r.pressed.blob.arrayBuffer())).digest('hex')

  it('at set-up and mid-press: the same bytes, the bands halved once', async () => {
    expect(bandHeight(2400, 1800)).toBe(873)
    const clean = await press()
    expect(clean.bands).toEqual([3])
    let thrown = 0
    // The first array of a megabyte or more (the press's set-up).
    const setup = await press((bytes) => bytes >= 1 << 20 && thrown++ === 0)
    expect(thrown).toBeGreaterThan(0)
    expect(await digest(setup)).toBe(await digest(clean))
    expect(setup.bands).toEqual([5])
    // Mid-press: the first 256 KB array (a chunk of the file) once the
    // second band has begun, the photo still held (it is let go at the
    // third).
    thrown = 0
    const mid = await press((bytes, band) => band >= 1 && bytes >= 1 << 18 && thrown++ === 0)
    expect(thrown).toBeGreaterThan(0)
    expect(await digest(mid)).toBe(await digest(clean))
    expect(mid.bands).toEqual([3, 5])
    expect(mid.grounded).toBe(1)
    // With no photo there is no photo to lose: pressed again too.
    thrown = 0
    let pressedAgain = 0
    const restore = faulty((bytes) => bytes >= 1 << 20 && thrown++ === 0)
    try {
      await savePrint(defaultSettings(), null, { maxHeight: 1800, makeCanvas: canvases().makeCanvas, onProgress: (p) => (pressedAgain = p.bands) })
    } finally {
      restore()
    }
    expect(thrown).toBeGreaterThan(0)
    expect(pressedAgain).toBe(3)
  })

  it('never once the photo is let go (its last rows read), and at most four halvings: then too big for this device', async () => {
    let grounded = false
    let thrown = 0
    const restore = faulty((bytes) => grounded && bytes >= 1 << 18 && thrown++ === 0)
    try {
      const err = await savePrint(withPhoto(1600, 1200), decoded(1600, 1200), { makeCanvas: canvases().makeCanvas, onGround: () => (grounded = true) }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CanvasLimitError)
      expect((err as CanvasLimitError).why).toBe('Array buffer allocation failed')
    } finally {
      restore()
    }
    expect(BAND_HALVINGS).toBe(4)
    let attempts = 0
    const restore2 = faulty((bytes) => bytes === 1456 * 1440 * 4 / 2 ** attempts && ++attempts > 0)
    try {
      // 1440 x 1800: bands of 1456 rows, halved exactly.
      const err = await savePrint(withPhoto(1600, 1200), decoded(1600, 1200), { makeCanvas: canvases().makeCanvas }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CanvasLimitError)
    } finally {
      restore2()
    }
    // The first try, then four halvings (1456, 728, 364, 182, 91 rows).
    expect(attempts).toBe(5)
  })

  it('anything else is not dressed up as a size problem', async () => {
    const restore = faulty((bytes) => {
      if (bytes >= 1 << 20) throw new TypeError('x is undefined')
      return false
    })
    try {
      const err = await savePrint(defaultSettings(), null, { maxHeight: 600, makeCanvas: canvases().makeCanvas }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TypeError)
    } finally {
      restore()
    }
  })

  it('a tone source that breaks an invariant (a plain Error) is pressed once and said as itself, never offered as a smaller copy', async () => {
    // The glyph tiles' read-back throws what the tile plumbing's checks throw
    // (rowsFromTiles, the ring, the native ground's band): a plain Error.
    // The same fault as a RangeError, for contrast, is memory: pressed again
    // in halved bands, then too big for this device.
    const press = async (fault: () => Error) => {
      let reads = 0
      const made = canvases()
      const makeCanvas = () => {
        const ctx = made.makeCanvas()
        const read = ctx.getImageData.bind(ctx)
        ;(ctx as unknown as { getImageData: typeof read }).getImageData = (x, y, w, h) => {
          // The sentinel (1x1) reads back as drawn; a tile's rows throw.
          if (w * h > 1) {
            reads++
            throw fault()
          }
          return read(x, y, w, h)
        }
        return ctx
      }
      const err = await savePrint(defaultSettings(), null, { maxHeight: 1800, makeCanvas }).catch((e: unknown) => e)
      return { err, reads }
    }
    const bug = await press(() => new Error('rowsFromTiles: rows [1389, 1459) do not fit the span of 69'))
    expect(bug.err).not.toBeInstanceOf(CanvasLimitError)
    expect((bug.err as Error).message).toBe('rowsFromTiles: rows [1389, 1459) do not fit the span of 69')
    expect(bug.reads).toBe(1)
    const memory = await press(() => new RangeError('Array buffer allocation failed'))
    expect(memory.err).toBeInstanceOf(CanvasLimitError)
    expect(memory.reads).toBe(1 + BAND_HALVINGS)
  })
})

describe('the smaller copy offered: three quarters at a time, the sheet kept, the first one that fits', () => {
  it('asks each candidate in turn and none after the first that fits', async () => {
    expect(SMALLER_STEP).toBe(0.75)
    const s = withPhoto(4032, 3024)
    const tried: [number, number][] = []
    const plan = await findSmallerPlanAsync(s, 3024, async (p) => (tried.push([p.width, p.height]), p.width * p.height <= 2.5e6))
    // 3024 -> 2268 (4.1 MP) -> 1701 (2.3 MP): the first under 2.5 MP.
    expect(tried).toEqual([
      [1814, 2268],
      [1361, 1701],
    ])
    expect(plan).toMatchObject({ width: 1361, height: 1701, limit: 'smaller' })
    expect(plan!.width / plan!.height).toBeCloseTo(4 / 5, 3)
  })

  it('never offers one bigger than what failed, and none below the smallest copy: then, no copy at all', async () => {
    const s = withPhoto(7728, 5152, { aspect: 'original' })
    const heights: number[] = []
    const plan = await findSmallerPlanAsync(s, 5152, async (p) => (heights.push(p.height), false))
    expect(plan).toBeNull()
    expect(SMALLEST_COPY_HEIGHT).toBe(600)
    expect(heights).toEqual([3864, 2898, 2174, 1631, 1223, 917, 688])
    for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeLessThan(heights[i - 1])
    expect(await findSmallerPlanAsync(s, 1000, async () => true)).toMatchObject({ height: 750 })
  })

  it('a Cancel during a probe rejects with an AbortError, and no candidate is asked after it', async () => {
    const s = withPhoto(4032, 3024)
    const controller = new AbortController()
    const tried: number[] = []
    const run = findSmallerPlanAsync(
      s,
      3024,
      async (p) => {
        tried.push(p.height)
        // Tapped while the second candidate is probed; it would have fitted.
        if (tried.length === 2) controller.abort()
        return tried.length === 2
      },
      { signal: controller.signal },
    )
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(tried).toEqual([2268, 1701])
    // Cancelled before it starts: nothing is probed.
    await expect(findSmallerPlanAsync(s, 3024, async (p) => (tried.push(p.height), true), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(tried).toEqual([2268, 1701])
  })
})

describe('the async render: the same stages, with yields, progress and Cancel', () => {
  const doc = (): PrintSettings => {
    const s = defaultSettings()
    s.media = makeMedia({ id: 'p', width: 400, height: 500 })
    s.layers = [makeLayer({ id: 'a' }), makeLayer({ id: 'b', backing: 'yellow' })]
    return s
  }

  it('reports every band of the press, and prints what the sync render prints', async () => {
    const seen: RenderProgress[] = []
    let grounded = 0
    await renderPrintAsync(fakeContext().ctx, fakeContext().ctx, doc(), 300, decoded(400, 500), {
      onProgress: (p) => seen.push(p),
      onGround: () => grounded++,
    })
    expect(grounded).toBe(1)
    // One band (300 px tall), three passes (a backing is one), each yielding
    // as it starts and twice inside (after the tear, after the wear), then
    // the band's rows printed.
    expect(seen.every((p) => p.step === 'press' && p.band === 0 && p.bands === 1)).toBe(true)
    expect(seen.length).toBeGreaterThanOrEqual(3 * 3 + 1)

    // The same pixels as renderPrint at the same height (the harness checks
    // this on real glyphs and a real photo).
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
    const a = fakeContext()
    const b = fakeContext()
    const asyncOut = capture(a)
    const syncOut = capture(b)
    await renderPrintAsync(a.ctx, fakeContext().ctx, doc(), 300, decoded(400, 500))
    renderPrint(b.ctx, fakeContext().ctx, doc(), { current: null }, null, 300, decoded(400, 500))
    expect(asyncOut.bands).toBeGreaterThan(0)
    expect(asyncOut.data.length).toBe(240 * 300 * 4)
    expect(asyncOut.data).toEqual(syncOut.data)
  })

  it('stops at the next step once cancelled, with an AbortError', async () => {
    const controller = new AbortController()
    let presses = 0
    const run = renderPrintAsync(fakeContext().ctx, fakeContext().ctx, doc(), 300, decoded(400, 500), {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.step === 'press') presses++
        controller.abort()
      },
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(presses).toBe(1)
  })

  it('a Cancel mid-press of a save: an AbortError at the next step, no file', async () => {
    const controller = new AbortController()
    let steps = 0
    const run = savePrint(defaultSettings(), null, {
      maxHeight: 600,
      signal: controller.signal,
      makeCanvas: canvases().makeCanvas,
      onProgress: () => {
        if (++steps === 2) controller.abort()
      },
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(steps).toBe(2)
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

  it('no ceiling: a 24 MP and a 40 MP photo on their own sheets and cropped, at their own pixels, with nothing to explain', () => {
    expect(plan(withPhoto(5712, 4284, { aspect: 'original' }))).toEqual({ size: '5712×4284', reason: null })
    expect(plan(withPhoto(5712, 4284))).toEqual({ size: '3427×4284', reason: null })
    expect(plan(withPhoto(7728, 5152, { aspect: 'original' }))).toEqual({ size: '7728×5152', reason: null })
    expect(plan(withPhoto(7728, 5152))).toEqual({ size: '4122×5152', reason: null })
    expect(plan(withPhoto(7728, 5152, { aspect: '1:1' }))).toEqual({ size: '5152×5152', reason: null })
  })

  it('past a JPEG\'s edge (65,535 px), the largest JPEG, and how to get the photo\'s full size', () => {
    // A 3:1 panorama of 120,000 px (the widest an Original sheet is).
    const s = withPhoto(120_000, 40_000, { aspect: 'original' })
    expect(describePlan(planPrint(s), s.media)).toEqual({
      size: '65535×21845',
      reason: "JPEG holds at most 65,535 px a side: Save lossless PNG for the photo's full size",
    })
    expect(describePlan(planPrint(s, { format: 'png' }), s.media)).toEqual({ size: '120000×40000', reason: null })
  })

  it('a size in MB or KB', () => {
    expect(fileSize(6_204_000)).toBe('6.2 MB')
    expect(fileSize(840_000)).toBe('840 KB')
  })
})
