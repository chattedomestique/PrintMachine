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

import { maxWindow, plateGeometry, printSheet, printSheetSteps, sampledNoise, type GroundRows, type ToneSource } from './render.ts'
import type { PrintSettings, TextLayer } from './types.ts'
import { lumaCell } from './media.ts'
import { makeGround } from './__tests__/fields.ts'
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

describe('a band allocates nothing', { timeout: 120_000 }, () => {
  type Ctor = new (...args: unknown[]) => ArrayBufferView & { byteLength: number }
  const NAMES = ['Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Int32Array', 'Uint32Array', 'Uint16Array', 'Int16Array'] as const

  /** Every typed array made while `run` runs (views over existing buffers
   *  excluded: they allocate nothing), with the phase it was made in. */
  function allocations(run: (phase: { now: string }) => void): { bytes: number; phase: string }[] {
    const g = globalThis as unknown as Record<string, Ctor>
    const saved = NAMES.map((n) => [n, g[n]] as const)
    const log: { bytes: number; phase: string }[] = []
    const phase = { now: 'setup' }
    for (const [name, Orig] of saved) {
      const Tracked = class extends Orig {
        constructor(...args: unknown[]) {
          super(...args)
          if (!(args[0] instanceof ArrayBuffer)) log.push({ bytes: this.byteLength, phase: phase.now })
        }
        static [Symbol.hasInstance](x: unknown) {
          return x instanceof Orig
        }
      }
      g[name] = Tracked
    }
    try {
      run(phase)
    } finally {
      for (const [name, Orig] of saved) g[name] = Orig
    }
    return log
  }

  const BIG = 512 * 1024

  /** A wide sheet (a band of 97 rows is over 512 KiB of bytes), a photo, a
   *  backing, two second inks; grain or halftone. */
  function run(method: 'grain' | 'halftone', size: number, bandRows: number, h = 300) {
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
    const noise = sampledNoise(s, w, h)
    const out = new Uint8ClampedArray(w * h * 4)
    let bands = 0
    const log = allocations((phase) => {
      const steps = printSheetSteps(out, s, ground, src, noise, w, h, { bandRows })
      for (;;) {
        const next = steps.next()
        if (next.done) break
        // From the first yield on, the press is in its band loop.
        phase.now = 'loop'
        bands = Math.max(bands, (next.value.band ?? 0) + 1)
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
})
