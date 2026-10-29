/**
 * The print pressed band by band is the print pressed whole: every coverage
 * plane, the knockout and the printed RGBA, byte for byte, at every band
 * height, and equal to the digests recorded before the band engine
 * (golden.test.ts). And a band allocates nothing: everything a band needs is
 * made once, before the first.
 *
 * The planes and the knockout of a print in bands only ever exist a band at a
 * time, so they are read where they are handed to the compositor and put
 * together into whole sheets here.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({
  w: 0,
  h: 0,
  planes: [] as Uint8ClampedArray[],
  knockout: null as Uint8ClampedArray | null,
}))
vi.mock('./composite.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./composite.ts')>()
  return {
    ...real,
    compositeLayers: (...args: Parameters<typeof real.compositeLayers>) => {
      const [, w, h, paper, layers, y0 = 0, y1 = h, , rowBase = 0] = args
      // Rows [y0, y1) of every plane and of the knockout, from arrays that
      // hold the rows from rowBase on, into whole-sheet copies.
      if (seen.w === w && seen.h === h) {
        layers.forEach((l, k) => {
          seen.planes[k] ??= new Uint8ClampedArray(w * h)
          const c = l.coverage as Uint8ClampedArray
          seen.planes[k].set(c.subarray((y0 - rowBase) * w, (y1 - rowBase) * w), y0 * w)
        })
        if (paper.knockout) {
          seen.knockout ??= new Uint8ClampedArray(w * h)
          seen.knockout.set(paper.knockout.subarray((y0 - rowBase) * w, (y1 - rowBase) * w), y0 * w)
        }
      }
      return real.compositeLayers(...args)
    },
  }
})

import { FramedGroundRows, TiledGroundRows, maxWindow, outputSize, plateGeometry, printSheet, printSheetSteps, sampledNoise, type GroundRows, type ToneSource } from './render.ts'
import { composeFrameRows, fillFor, layoutSheet, sheetAspect, type FrameInputs } from './frame.ts'
import { frostField, frostSampler } from './frost.ts'
import { FROST_FIELD_LONG } from './limits.ts'
import { tileAt, tileGrid } from './tiles.ts'
import type { PrintSettings, TextLayer } from './types.ts'
import { lumaCell } from './media.ts'
import { allocations, allocationsAsync, stillHeld } from './__tests__/alloc.ts'
import { makeFrameSource, makeGround } from './__tests__/fields.ts'
import { DOCS, SIZES, syntheticTones } from './__tests__/documents.ts'

const sha = (b: Uint8ClampedArray | Uint8Array) => createHash('sha256').update(b).digest('hex')
const golden: Record<string, { planes: string[]; knockout: string; rgba: string }> = JSON.parse(
  readFileSync(new URL('./__fixtures__/press-golden.json', import.meta.url), 'utf8'),
).digests

/** Tones handed out a window at a time, each a NEW array of exactly the rows
 *  asked for: a read past them is a NaN, not a neighbour's row. */
function exactTones(src: ToneSource, w: number, h: number): ToneSource {
  const made = new Map<string, { field: Uint8Array | Float32Array; fontSize: number }>()
  const tone = (key: string, make: () => unknown) => {
    if (!made.has(key)) made.set(key, make() as { field: Uint8Array | Float32Array; fontSize: number })
    const t = made.get(key)!
    return { rows: { rows: (a: number, b: number) => t.field.slice(a * w, b * w) }, fontSize: t.fontSize }
  }
  return {
    type: (l: TextLayer) => tone(`t${l.id}`, () => src.type(l)),
    backing: (l: TextLayer) => tone(`b${l.id}`, () => src.backing(l)),
    size: (l: TextLayer) => Math.max(1, l.size * h),
  }
}

/** The ground, a band at a time, as a NEW array of exactly those rows. */
const exactGround = (rgba: Uint8ClampedArray, w: number): GroundRows => ({ rows: (a, b) => rgba.slice(a * w * 4, b * w * 4) })

interface Printed {
  planes: string[]
  knockout: string
  rgba: string
}

/** Print a document in bands of `bandRows` and digest the whole sheets it
 *  put together: each plane, the knockout ("none" when nothing was cut) and
 *  the RGBA. */
function printed(s: PrintSettings, ground: Uint8ClampedArray | undefined, tones: ToneSource, w: number, h: number, bandRows?: number, exact = true): Printed {
  Object.assign(seen, { w, h, planes: [], knockout: null })
  const out = new Uint8ClampedArray(w * h * 4)
  const src = exact ? exactTones(tones, w, h) : tones
  printSheet(out, s, ground && exact ? exactGround(ground, w) : ground, src, sampledNoise(s, w, h), w, h, { bandRows })
  const k = seen.knockout as Uint8ClampedArray | null
  const result = {
    planes: seen.planes.map(sha),
    knockout: k && k.some((v) => v !== 0) ? sha(k) : 'none',
    rgba: sha(out),
  }
  Object.assign(seen, { w: 0, h: 0, planes: [], knockout: null })
  return result
}

const BANDS = [1, 2, 7, 16, 97, 301, 512]

describe('the eight synthetic documents, in bands: the golden digests', { timeout: 60_000 }, () => {
  for (const name of Object.keys(DOCS)) {
    for (const [w, h] of SIZES) {
      it(`${name}@${w}x${h}: bands of ${BANDS.join(', ')} and the whole sheet`, () => {
        const want = golden[`${name}@${w}x${h}`]
        const { settings, ground } = DOCS[name]
        const g = ground ? makeGround(w, h, 5) : undefined
        for (const B of [...BANDS, h]) {
          const s: PrintSettings = JSON.parse(JSON.stringify(settings))
          expect(printed(s, g, syntheticTones(name, w, h), w, h, B), `bands of ${B}`).toEqual(want)
        }
      })
    }
  }
})

describe('more documents, in bands: equal to the whole sheet', { timeout: 60_000 }, () => {
  const layer = (id: string, over: Partial<TextLayer> = {}): TextLayer => ({
    id,
    text: 'PRINT',
    inkId: 'fluorescentpink',
    fontId: 'poster',
    bold: true,
    size: 0.08,
    lineHeight: 0.94,
    tracking: -0.02,
    contrastInkId: null,
    contrastThreshold: 0.5,
    align: 'center',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    backing: null,
    ...over,
  })
  const doc = (over: Partial<PrintSettings>): PrintSettings => ({
    aspect: '4:5',
    media: { id: 'p', width: 1600, height: 1200, scale: 1, x: 0.5, y: 0.5 },
    paperVeil: true,
    paperId: 'natural',
    press: { method: 'halftone', screenPitch: 9, density: 0.84, misregistration: 5, edge: 0.55, wear: 0.22 },
    frame: { width: 0, corners: 0, fill: 'photo', blur: 60, mode: 'crop' },
    seed: 7,
    layers: [],
    ...over,
  })
  const cases: [string, PrintSettings][] = [
    // Grain, three plates switching at 0.5, 0.4 and 0.5: one stream per
    // point, the 0.5 rows made once per band and used by two plates.
    [
      'grain, switch points 0.5, 0.4, 0.5',
      doc({
        press: { method: 'grain', screenPitch: 9, density: 0.84, misregistration: 12, edge: 0.8, wear: 0.4 },
        layers: [
          layer('a', { contrastInkId: 'blue' }),
          layer('b', { inkId: 'blue', size: 0.05, contrastInkId: 'yellow', contrastThreshold: 0.4, rotation: 5 }),
          layer('c', { inkId: 'green', size: 0.04, contrastInkId: 'fluorescentpink' }),
        ],
      }),
    ],
    // Small type: the ground's luminance at one cell a pixel (a sheet-sized
    // field), a backing beside it.
    [
      'small type (cell-1 luminance), a backing beside it',
      doc({
        paperVeil: false,
        layers: [layer('a', { size: 0.015, contrastInkId: 'black' }), layer('b', { size: 0.03, inkId: 'blue', backing: 'yellow' })],
      }),
    ],
    // No photo, grain: the paper and the plates only.
    [
      'no photo, grain',
      doc({ media: null, press: { method: 'grain', screenPitch: 24, density: 1, misregistration: 30, edge: 1, wear: 0.8 }, layers: [layer('a'), layer('b', { inkId: 'blue' })] }),
    ],
  ]
  for (const [name, settings] of cases) {
    it(name, () => {
      const w = 211
      const h = 377
      const g = settings.media ? makeGround(w, h, 12) : undefined
      const tones = syntheticTones(name, w, h)
      const whole = printed(JSON.parse(JSON.stringify(settings)), g, tones, w, h, undefined, false)
      for (const B of [...BANDS, h]) expect(printed(JSON.parse(JSON.stringify(settings)), g, tones, w, h, B), `bands of ${B}`).toEqual(whole)
    })
  }

  it('a ground handed over a band at a time is read only at the rows asked for, and left as it was', () => {
    const w = 150
    const h = 240
    const g = makeGround(w, h, 3)
    const before = g.slice()
    const s = doc({ layers: [layer('a', { contrastInkId: 'blue', backing: null }), layer('b', { inkId: 'blue', backing: 'yellow' })] })
    printed(s, g, syntheticTones('ground', w, h), w, h, 13)
    expect(g).toEqual(before)
  })
})

describe('framed documents, in bands, on forced small tiles: equal to the whole sheet and to the preview\'s ground', { timeout: 60_000 }, () => {
  const layer = (id: string, over: Partial<TextLayer> = {}): TextLayer => ({
    id,
    text: 'PRINT',
    inkId: 'fluorescentpink',
    fontId: 'poster',
    bold: true,
    size: 0.08,
    lineHeight: 0.94,
    tracking: -0.02,
    contrastInkId: null,
    contrastThreshold: 0.5,
    align: 'center',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    backing: null,
    ...over,
  })
  const palette = { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' }
  const doc = (over: Partial<PrintSettings>): PrintSettings => ({
    aspect: '4:5',
    media: { id: 'p', width: 1600, height: 1200, scale: 1, x: 0.5, y: 0.5, palette },
    paperVeil: true,
    paperId: 'natural',
    press: { method: 'halftone', screenPitch: 9, density: 0.84, misregistration: 5, edge: 0.55, wear: 0.22 },
    frame: { width: 0.1, corners: 1, fill: 'muted', blur: 60, mode: 'fit' },
    seed: 7,
    // A second ink switching on the framed ground (the luminance pass reads
    // it), and a backing cutting it back to paper (the knockout).
    layers: [layer('a', { contrastInkId: 'blue', y: 0.12 }), layer('b', { inkId: 'blue', backing: 'yellow', y: 0.85, rotation: -4 })],
    ...over,
  })
  const cases: [string, PrintSettings][] = [
    ['Fit 4:5, round, Muted, the veil on', doc({})],
    ['Original, corners 0.5, Paper, grain', doc({ aspect: 'original', frame: { width: 1 / 14, corners: 0.5, fill: 'paper', blur: 60, mode: 'crop' }, press: { method: 'grain', screenPitch: 12, density: 0.9, misregistration: 9, edge: 0.7, wear: 0.4 } })],
    ['Crop 1:1 at 250%, widest, Photo, the veil off', doc({ aspect: '1:1', paperVeil: false, media: { id: 'p', width: 1600, height: 1200, scale: 2.5, x: 0.3, y: 0.7, palette }, frame: { width: 0.16, corners: 0, fill: 'photo', blur: 60, mode: 'crop' } })],
    ['Crop 4:5 framed, no palette yet: Paper', doc({ media: { id: 'p', width: 1600, height: 1200, scale: 1, x: 0.5, y: 0.5 }, frame: { width: 0.05, corners: 0.3, fill: 'deep', blur: 60, mode: 'crop' } })],
    ['Original, round, Frosted at Blur 240', doc({ aspect: 'original', frame: { width: 0.12, corners: 1, fill: 'frosted', blur: 240, mode: 'crop' } })],
    ['Fit 4:5, Frosted at Blur 10, the veil off', doc({ paperVeil: false, frame: { width: 0.06, corners: 0.5, fill: 'frosted', blur: 10, mode: 'fit' } })],
  ]

  /** What the fill is made from: the stored palette, and for Frosted its
   *  field, made from a synthetic source as the page makes it. */
  const inputsOf = (s: PrintSettings): FrameInputs =>
    s.frame.fill === 'frosted'
      ? { palette: s.media?.palette, frost: frostField(makeFrameSource(400, 300, 5), sheetAspect(s), FROST_FIELD_LONG, s.frame.blur) }
      : { palette: s.media?.palette }

  /** The photo's ground on a grid of forced 64x32 tiles, each tile row read
   *  out of the whole synthetic ground as the export reads it off a canvas,
   *  and framed: what exportSteps hands the press. */
  const framedRows = (s: PrintSettings, ground: Uint8ClampedArray, w: number, h: number, B: number): GroundRows => {
    const grid = tileGrid(w, h, { edge: 64, pixels: 64 * 32 })
    const tiled = new TiledGroundRows(grid, B, (ty, slot) => {
      for (let cx = 0; cx < grid.cols; cx++) {
        const t = tileAt(grid, cx, ty)
        for (let r = 0; r < t.h; r++) slot.set(ground.subarray(((t.y0 + r) * w + t.x0) * 4, ((t.y0 + r) * w + t.x0 + t.w) * 4), (r * w + t.x0) * 4)
      }
    })
    return new FramedGroundRows(tiled, layoutSheet(s, w, h), fillFor(s, inputsOf(s), w, h), B)
  }

  for (const [name, settings] of cases) {
    it(name, () => {
      const { w, h } = outputSize(sheetAspect(settings), 301)
      const g = makeGround(w, h, 21)
      const tones = syntheticTones(name, w, h)
      const run = (B: number) => {
        Object.assign(seen, { w, h, planes: [], knockout: null })
        const s: PrintSettings = JSON.parse(JSON.stringify(settings))
        const out = new Uint8ClampedArray(w * h * 4)
        printSheet(out, s, framedRows(s, g, w, h, B), exactTones(tones, w, h), sampledNoise(s, w, h), w, h, { bandRows: B })
        const k = seen.knockout as Uint8ClampedArray | null
        const result = { planes: seen.planes.map(sha), knockout: k && k.some((v) => v !== 0) ? sha(k) : 'none', rgba: sha(out) }
        Object.assign(seen, { w: 0, h: 0, planes: [], knockout: null })
        return result
      }
      const whole = run(h)
      for (const B of [1, 7, 97]) expect(run(B), `bands of ${B}`).toEqual(whole)
      // The preview's way: the whole ground composed in place, pressed whole.
      const composed = g.slice()
      composeFrameRows(layoutSheet(settings, w, h), fillFor(settings, inputsOf(settings), w, h), composed, 0, h, composed)
      expect(printed(JSON.parse(JSON.stringify(settings)), composed, tones, w, h, undefined, false), "the preview's ground").toEqual(whole)
      // The frame is really there: not the unframed print.
      expect(printed(JSON.parse(JSON.stringify(settings)), g, tones, w, h, undefined, false).rgba).not.toBe(whole.rgba)
      // And Frosted is its field, not Paper (which every check above would
      // pass): the sheet's top row, all border, is the field sampled there.
      if (settings.frame.fill === 'frosted') {
        const inputs = inputsOf(settings)
        expect(fillFor(settings, inputs, w, h).flat, 'Frosted is a field, not a flat colour').toBeNull()
        const want = new Uint8ClampedArray(w * 4)
        frostSampler(inputs.frost!, w, h)(0, 0, w, want, 0)
        expect(Buffer.from(composed.subarray(0, w * 4)).equals(Buffer.from(want)), 'the top row is the field').toBe(true)
      }
    })
  }
})

describe('a band allocates nothing', { timeout: 120_000 }, () => {
  const BIG = 512 * 1024

  /** A wide sheet (a band of 97 rows is over 512 KiB of bytes), a photo, a
   *  backing, two second inks; grain or halftone. */
  function inputs(method: 'grain' | 'halftone', size: number, h: number) {
    const w = 6000
    const s: PrintSettings = JSON.parse(JSON.stringify(DOCS.backing.settings))
    s.press.method = method
    s.layers = s.layers.map((l) => ({ ...l, size }))
    s.layers[0] = { ...s.layers[0], backing: null, contrastInkId: 'blue' }
    s.layers[1] = { ...s.layers[1], backing: 'yellow', contrastInkId: null }
    const ground = makeGround(w, h, 2)
    const tones = syntheticTones('alloc', w, h)
    const fields = new Map<string, { field: Uint8Array; fontSize: number }>()
    for (const l of s.layers) {
      fields.set(`t${l.id}`, tones.type(l) as { field: Uint8Array; fontSize: number })
      fields.set(`b${l.id}`, tones.backing(l) as { field: Uint8Array; fontSize: number })
    }
    const src: ToneSource = { type: (l) => fields.get(`t${l.id}`)!, backing: (l) => fields.get(`b${l.id}`)!, size: (l) => Math.max(1, l.size * h) }
    return { s, w, h, ground, src, noise: sampledNoise(s, w, h), out: new Uint8ClampedArray(w * h * 4) }
  }

  function run(method: 'grain' | 'halftone', size: number, bandRows: number, h = 300) {
    const { s, w, ground, src, noise, out } = inputs(method, size, h)
    let bands = 0
    const log = allocations((phase) => {
      const steps = printSheetSteps(out, s, ground, src, noise, w, h, { bandRows })
      for (;;) {
        const next = steps.next()
        if (next.done) break
        // From the first step of the press on (the photo's luminance pass,
        // the 'photo' steps, is set-up), the press is in its band loop.
        if (next.value.step === 'press') phase.now = 'loop'
        if (next.value.step === 'press') bands = Math.max(bands, next.value.band + 1)
      }
    })
    // The largest window any band of any plate reads, as the print sized it.
    let index = 0
    const plates = s.layers.flatMap((l) =>
      (l.backing ? [true, false] : [false]).map((backing) => {
        const geometry = plateGeometry(s.press, { fontSize: Math.max(1, l.size * h), index: index++ }, s.seed, h)
        return { geometry, cuts: backing || !!l.contrastInkId }
      }),
    )
    return { log, bands, w, h, E: maxWindow(plates, bandRows, h) }
  }

  for (const method of ['halftone', 'grain'] as const) {
    it(`${method}: no allocation of 512 KiB or more inside the band loop, at bands of 7 or of 97`, () => {
      // Type at 0.2 of the 300 px sheet: a blur of 90 px, a luminance grid of
      // 5 px cells (small).
      const a = run(method, 0.2, 7)
      const b = run(method, 0.2, 97)
      expect(a.bands).toBe(Math.ceil(300 / 7))
      expect(b.bands).toBe(Math.ceil(300 / 97))
      const big = (r: typeof a) => r.log.filter((x) => x.phase === 'loop' && x.bytes >= BIG).length
      expect(big(a)).toBe(0)
      expect(big(b)).toBe(0)
      // And nothing larger than a window of the workspace is made anywhere,
      // but the luminance grid before the first band: its cells' float64 sums
      // (5 px cells here: 1200 x 60), the grid and its blur's buffers.
      for (const r of [a, b]) {
        const cell = lumaCell(Math.max(2, 0.2 * r.h * 1.5))
        const grid = Math.ceil(r.w / cell) * Math.ceil(r.h / cell)
        for (const x of r.log) {
          if (x.bytes <= r.E * r.w * 4) continue
          expect(x.phase).toBe('setup')
          expect(x.bytes).toBeLessThanOrEqual(grid * 8)
        }
      }
    })
  }

  it('one band (every sheet of up to 2 MP): one switch-mask buffer under grain too, however many switch points', () => {
    // Three plates switching at 0.5, 0.4 and 0.3. Under grain in bands each
    // point carries its stream and a buffer of the band's rows; pressed as
    // one band, the mask is remade in one buffer when the point changes, as
    // under halftone, as the parent held it.
    const w = 400
    const h = 300
    const sheetBytes = (method: 'grain' | 'halftone', points: number[]) => {
      const s: PrintSettings = JSON.parse(JSON.stringify(DOCS['switch-two'].settings))
      s.press.method = method
      s.layers = points.map((t, k) => ({ ...s.layers[k % s.layers.length], id: `p${k}`, contrastInkId: 'yellow', contrastThreshold: t, backing: null }))
      const made = syntheticTones('masks', w, h)
      const fields = new Map(s.layers.map((l) => [l.id, made.type(l) as { field: Uint8Array; fontSize: number }]))
      const tones: ToneSource = { type: (l) => fields.get(l.id)!, backing: () => ({ field: new Uint8Array(0), fontSize: 1 }) }
      const noise = sampledNoise(s, w, h)
      const ground = makeGround(w, h, 3)
      const out = new Uint8ClampedArray(w * h * 4)
      const log = allocations(() => {
        const steps = printSheetSteps(out, s, ground, tones, noise, w, h)
        while (!steps.next().done);
      })
      // Arrays of a byte a sheet pixel: coverage and its dark half per plate,
      // the knockout, the masks.
      return log.filter((a) => a.bytes === w * h).length
    }
    const halftone = sheetBytes('halftone', [0.5, 0.4, 0.3])
    expect(sheetBytes('grain', [0.5, 0.4, 0.3])).toBe(halftone)
    expect(sheetBytes('grain', [0.5, 0.5, 0.5])).toBe(halftone)
    // 3 plates x 2 halves, the knockout, one mask.
    expect(halftone).toBe(3 * 2 + 1 + 1)
  })

  it('the one exception, named and bounded: the luminance at one cell a pixel (small type), made before the first band', () => {
    // Type at 0.03 of a 300 px sheet: 9 px, a blur radius of 13.5, cell 1.
    const r = run('halftone', 0.03, 7)
    const over = r.log.filter((x) => x.bytes > r.E * r.w * 4)
    expect(over.every((x) => x.phase === 'setup')).toBe(true)
    // The field itself and the blur's other half (a workspace smaller than
    // the sheet cannot lend it): two sheet-sized floats, no more.
    expect(over.map((x) => x.bytes)).toEqual([r.w * r.h * 4, r.w * r.h * 4])
    expect(r.log.filter((x) => x.phase === 'loop' && x.bytes >= BIG).length).toBe(0)
    // A blur under 4 px with a fraction mixes two blurs: a third sheet-sized
    // float, the spare. Type at 0.01 of a 260 px sheet: 2.6 px, radius 3.9.
    const f = run('halftone', 0.01, 7, 260)
    const fover = f.log.filter((x) => x.bytes > f.E * f.w * 4)
    expect(fover.every((x) => x.phase === 'setup')).toBe(true)
    expect(fover.map((x) => x.bytes)).toEqual([f.w * f.h * 4, f.w * f.h * 4, f.w * f.h * 4])
  })

  it('...made before the press makes its own buffers, so the two never coincide', () => {
    // Type at 0.03 of a 300 px sheet (cell 1), in bands of 7: the
    // luminance's two sheet-sized floats are made, and the second let go,
    // before the workspace's three windows exist. Pressed whole, the blur
    // borrows the workspace instead, so there the workspace comes first.
    const r = run('halftone', 0.03, 7)
    const sheet = r.w * r.h * 4
    const window = r.E * r.w * 4
    const luma = r.log.findIndex((x) => x.bytes === sheet)
    const windows = r.log.findIndex((x) => x.bytes === window)
    expect(luma).toBeGreaterThanOrEqual(0)
    expect(r.log.filter((x) => x.bytes === window).length).toBe(3)
    expect(windows).toBeGreaterThan(r.log.findLastIndex((x) => x.bytes === sheet))
  })

  it('...and released to one: after the gathering, one sheet-sized float is still held through the bands, none once printed', async () => {
    // Type at 0.03 of a 300 px sheet (cell 1), in bands of 7: the field and
    // the blur's other half are made; the other half is let go when the
    // gathering returns, the field (the luminance itself) is read by every
    // band and let go after the last.
    const { s, w, h, ground, src, noise, out } = inputs('halftone', 0.03, 300)
    const sheet = w * h * 4
    let duringBands: number[] = []
    let printed: number[] = []
    const log = await allocationsAsync(async (phase, log) => {
      const steps = printSheetSteps(out, s, ground, src, noise, w, h, { bandRows: 7 })
      let first = true
      for (;;) {
        const next = steps.next()
        if (next.done) break
        if (next.value.step !== 'press') continue
        phase.now = 'loop'
        if (first) {
          first = false
          // Paused at the first band's first step, the gathering done.
          duringBands = (await stillHeld(log)).filter((a) => a.bytes === sheet).map((a) => a.bytes)
        }
      }
      printed = (await stillHeld(log)).filter((a) => a.bytes === sheet).map((a) => a.bytes)
    })
    expect(log.filter((a) => a.bytes === sheet).length).toBe(2)
    expect(duringBands).toEqual([sheet])
    expect(printed).toEqual([])
  })
})
