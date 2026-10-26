/**
 * Row windows in the pure stages: every stage the press runs, fed a band of
 * the sheet's rows (and only the rows it declares it reads), gives exactly
 * the numbers it gives on the whole sheet.
 *
 * Each window is handed in as a NEW array holding exactly the declared rows,
 * so a read outside them is `undefined`, a NaN in any float that comes out
 * (and, where a NaN would vanish, the window is padded with a poison value
 * instead). A stage that reads a row it did not declare fails here; a window
 * declared one row too short fails the "necessary" checks.
 */

import { describe, expect, it } from 'vitest'

import { blurInPlace, blurReach, needsSpare } from './blur.ts'
import { compositeLayers, type CompositeLayer } from './composite.ts'
import { GrainStream, cellStarts, ditherField, grainRows } from './dither.ts'
import { applyMottle, edgeToRough, registrationOffset, shiftRows, shiftSource } from './ink.ts'
import { cutKnockoutRows } from './knockout.ts'
import { LumaAccumulator, groundLumaGrid, sampleLumaRows } from './media.ts'
import { paperField } from './paper.ts'
import { maxWindow, plateGeometry, plateHalo, windowsFor } from './render.ts'
import { roughenInPlace, type RoughOptions } from './rough.ts'
import { FbmSampler, fbm2D, mulberry32, type CellNoise } from './rng.ts'
import { screenField } from './screen.ts'
import { plateFontSize } from './text.ts'
import type { PressProfile } from './types.ts'
import { ditherWhole, knockoutMask, lumaGridWhole, shiftField } from './__tests__/reference.ts'
import { makeGround, makeStrokes } from './__tests__/fields.ts'

/** Rows [a, b) of a field, as a new array of exactly those rows. */
const rowsOf = (f: Float32Array, w: number, a: number, b: number) => f.slice(a * w, b * w)

/** Soft-edged discs over the whole sheet: values in 0..1 with edges a tear
 *  and a blur have something to do on, everywhere. */
function blobs(w: number, h: number, seed: number, count = Math.ceil((w * h) / 900)): Float32Array {
  const rand = mulberry32(seed)
  const f = new Float32Array(w * h)
  for (let k = 0; k < count; k++) {
    const cx = rand() * w
    const cy = rand() * h
    const r = 3 + rand() * 30
    const v = 0.4 + rand() * 0.6
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y < Math.min(h, Math.ceil(cy + r + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 1)); x < Math.min(w, Math.ceil(cx + r + 1)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        const c = Math.min(1, Math.max(0, r - d + 0.5)) * v
        if (c > f[y * w + x]) f[y * w + x] = c
      }
    }
  }
  return f
}

/** Uniform noise in 0..1, a fraction of it zero (bare paper). */
function noise(n: number, seed: number, zero = 0.3): Float32Array {
  const rand = mulberry32(seed)
  const f = new Float32Array(n)
  for (let i = 0; i < n; i++) f[i] = rand() < zero ? 0 : rand()
  return f
}

const bandsOf = (h: number, B: number) => {
  const out: [number, number][] = []
  for (let y0 = 0; y0 < h; y0 += B) out.push([y0, Math.min(h, y0 + B)])
  return out
}

describe('the tear on a window of rows', { timeout: 60_000 }, () => {
  const w = 72
  const h = 760
  const tone = blobs(w, h, 11)
  const tear = (radius: number, over: Partial<RoughOptions> = {}): RoughOptions => ({
    roughness: 0.55,
    bleed: 0.35,
    scale: radius,
    seed: 4242,
    ...over,
  })

  /** The whole sheet torn, and the sheet torn band by band from glyph
   *  windows widened by the blur's reach: differing floats, overall and in
   *  the range the threshold turns into a byte. */
  function compare(opts: RoughOptions, B: number) {
    const whole = tone.slice()
    roughenInPlace(whole, w, h, opts, new Float32Array(w * h), new Float32Array(w * h))
    const reach = 3 * blurReach(opts.scale)
    let differ = 0
    let worst = 0
    for (const [y0, y1] of bandsOf(h, B)) {
      const a = Math.max(0, y0 - reach)
      const b = Math.min(h, y1 + reach)
      const win = rowsOf(tone, w, a, b)
      const n = win.length
      roughenInPlace(win, w, b - a, opts, new Float32Array(n), new Float32Array(n), a)
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const got = win[(y - a) * w + x]
          const want = whole[y * w + x]
          if (got !== want) {
            differ++
            worst = Math.max(worst, Math.abs(got - want))
          }
        }
      }
    }
    return { differ, worst }
  }

  for (const radius of [0.5, 3.2, 8.6, 10.6, 14.7, 20]) {
    it(`radius ${radius}: the torn tone is the sheet's, every float`, () => {
      for (const B of [1, 37, 301]) expect(compare(tear(radius), B)).toEqual({ differ: 0, worst: 0 })
    })
  }

  it('bleed only (no wander), and the tear with no blur at all', () => {
    for (const radius of [0, 3.2, 14.7]) expect(compare(tear(radius, { roughness: 0 }), 53)).toEqual({ differ: 0, worst: 0 })
    expect(compare(tear(8.6, { bleed: 0 }), 53)).toEqual({ differ: 0, worst: 0 })
  })

  it('the reach is necessary at each end: a glyph window one row short at its top, or at its bottom, changes the torn rows', () => {
    const opts = tear(8.6)
    const whole = tone.slice()
    roughenInPlace(whole, w, h, opts, new Float32Array(w * h), new Float32Array(w * h))
    const reach = 3 * blurReach(opts.scale)
    const changed = { top: 0, bottom: 0 }
    for (const [y0, y1] of bandsOf(h, 61)) {
      if (y0 - reach <= 0 || y1 + reach >= h) continue
      for (const [end, a, b] of [
        ['top', y0 - reach + 1, y1 + reach],
        ['bottom', y0 - reach, y1 + reach - 1],
      ] as const) {
        const win = rowsOf(tone, w, a, b)
        roughenInPlace(win, w, b - a, opts, new Float32Array(win.length), new Float32Array(win.length), a)
        for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (win[(y - a) * w + x] !== whole[y * w + x]) changed[end]++
      }
    }
    expect(changed.top).toBeGreaterThan(0)
    expect(changed.bottom).toBeGreaterThan(0)
  })
})

describe("the tear's blur on tall sheets: its float64 noise floor, and what the tear makes of it", { timeout: 60_000 }, () => {
  // The vertical blur keeps a running sum per column in float64 (blur.ts
  // boxV). A window's sums start on another row than the sheet's, so where
  // the sums round, a blurred float can come out a last bit different: from
  // a radius of about 10 px (a sheet over 6,000 px tall), on a sheet dense
  // with type. The blobs above never show it; these strokes, quantised to
  // bytes as a glyph canvas hands them back, do. Some of the floats that
  // differ lie inside the range the tear's threshold reads ([0.02, 0.84]),
  // so the tear's identity is not carried by the blur alone: it is measured
  // here, on the torn tone itself, for the default edge and the roughest.
  const w = 2000
  const h = 1600
  const tone = Float32Array.from(makeStrokes(w, h, 11), (v) => v / 255)
  const B = 271
  const edges: RoughOptions[] = [
    { ...edgeToRough(0.55), scale: 0, seed: 4242 },
    { ...edgeToRough(1), scale: 0, seed: 4242 },
  ]

  function floor(radius: number) {
    const reach = 3 * blurReach(radius)
    const spare = () => (needsSpare(radius) ? new Float32Array(w * h) : undefined)
    const blurred = tone.slice()
    blurInPlace(blurred, w, h, radius, new Float32Array(w * h), spare())
    const torn = edges.map((e) => {
      const t = tone.slice()
      roughenInPlace(t, w, h, { ...e, scale: radius }, new Float32Array(w * h), spare())
      return t
    })
    let any = 0
    let mid = 0
    let worst = 0
    let tornDiffer = 0
    for (const [y0, y1] of bandsOf(h, B)) {
      const a = Math.max(0, y0 - reach)
      const b = Math.min(h, y1 + reach)
      const n = (b - a) * w
      const win = rowsOf(tone, w, a, b)
      blurInPlace(win, w, b - a, radius, new Float32Array(n), needsSpare(radius) ? new Float32Array(n) : undefined)
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const got = win[(y - a) * w + x]
          const want = blurred[y * w + x]
          if (got === want) continue
          any++
          worst = Math.max(worst, Math.abs(got - want))
          if (want >= 0.02 && want <= 0.84) mid++
        }
      }
      edges.forEach((e, k) => {
        const t = rowsOf(tone, w, a, b)
        roughenInPlace(t, w, b - a, { ...e, scale: radius }, new Float32Array(n), needsSpare(radius) ? new Float32Array(n) : undefined, a)
        for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (t[(y - a) * w + x] !== torn[k][y * w + x]) tornDiffer++
      })
    }
    // Printed, so a change in the floor is visible before anything fails.
    console.log(`radius ${radius}: ${any} blurred floats differ (${mid} in [0.02, 0.84]), largest ${worst.toExponential(2)}; torn floats that differ: ${tornDiffer}`)
    return { any, mid, worst, tornDiffer }
  }

  // 14.7 is a sheet about 8,800 px tall at full detail, 20 is 12,000 px (the
  // limit the README states) and 15.84 a 61 MP portrait on Original (9504 px
  // tall, type at 16% or more).
  for (const radius of [14.7, 15.84, 20]) {
    it(`radius ${radius}: the blur's floor shows, and the torn tone is the sheet's, every float`, () => {
      const r = floor(radius)
      expect(r.any).toBeGreaterThan(0)
      expect(r.worst).toBeLessThan(1e-8)
      expect(r.tornDiffer).toBe(0)
    })
  }

  it('radius 33.5 (a sheet 20,000 px tall): recorded, not claimed; every difference is under 1e-8', () => {
    const r = floor(33.5)
    expect(r.any).toBeGreaterThan(0)
    expect(r.worst).toBeLessThan(1e-8)
  })
})

describe('the wear on a window of rows', () => {
  const w = 53
  const h = 211
  const cover = noise(w * h, 3)
  const speckle: CellNoise = { cell: 2.3, seed: 99 }
  const sampler = new FbmSampler(w, 9.5, 3, 777)
  const field = fbm2D(w, h, 9.5, 3, 777)
  for (const detail of [1, 0.3, 0.61]) {
    for (const [label, mottle] of [
      ['sampled', sampler],
      ['cached', field],
    ] as const) {
      it(`detail ${detail}, ${label} mottle: bands equal the sheet (the stride wraps at the sheet's height)`, () => {
        const whole = applyMottle(cover, mottle, speckle, 0.5, 0.1, w, h, detail)
        for (const B of [1, 17, 100]) {
          for (const [y0, y1] of bandsOf(h, B)) {
            const win = rowsOf(cover, w, y0, y1)
            const out = applyMottle(win, mottle, speckle, 0.5, 0.1, w, y1 - y0, detail, new Float32Array(win.length), y0, h)
            expect(out).toEqual(whole.subarray(y0 * w, y1 * w))
          }
        }
      })
    }
  }
})

describe('the shift on a window of rows', () => {
  const w = 37
  const h = 300
  const src = noise(w * h, 5, 0.1)
  const moves: [number, number][] = [
    [0, 0],
    [0, 3],
    [2.5, 0],
    [-1.3, -7.25],
    [0.4, 12.75],
    [3, -1],
    [-2.2, 86],
    [1.7, -86],
    [0, -33.5],
  ]
  for (const [dx, dy] of moves) {
    it(`(${dx}, ${dy}): rows from exactly shiftSource's rows equal the sheet's, and those rows are all needed`, () => {
      const whole = shiftField(src, w, h, dx, dy)
      // The whole sheet through shiftRows, as through the plain shift.
      expect(shiftRows(src, w, 0, h, dx, dy, 0, h, new Float32Array(w * h))).toEqual(whole)
      for (const B of [1, 23, h]) {
        for (const [y0, y1] of bandsOf(h, B)) {
          const { a, b } = shiftSource(dx, dy, y0, y1, h)
          const out = shiftRows(rowsOf(src, w, a, b), w, a, h, dx, dy, y0, y1, new Float32Array((y1 - y0) * w))
          expect(out).toEqual(whole.subarray(y0 * w, y1 * w))
          if (dx === 0 && dy === 0) continue
          // One row fewer at either end, where that row is in the sheet: a
          // NaN comes out.
          const unclampedA = Math.floor(y0 - dy)
          const unclampedB = Math.floor(y1 - 1 - dy) + 2
          if (unclampedA >= 0 && unclampedA < h && b > a + 1) {
            const short = shiftRows(rowsOf(src, w, a + 1, b), w, a + 1, h, dx, dy, y0, y1, new Float32Array((y1 - y0) * w))
            expect(short.some(Number.isNaN)).toBe(true)
          }
          if (unclampedB <= h && unclampedB > 0 && b - 1 > a) {
            const short = shiftRows(rowsOf(src, w, a, b - 1), w, a, h, dx, dy, y0, y1, new Float32Array((y1 - y0) * w))
            expect(short.some(Number.isNaN)).toBe(true)
          }
        }
      }
    })
  }
})

describe('the screen on a window of rows', () => {
  const w = 64
  const h = 160
  const tone = noise(w * h, 8, 0.2)
  for (const angle of [45, 75, 15, 0]) {
    it(`angle ${angle}: bands equal the sheet`, () => {
      const opts = { pitch: 7.3, angle, softness: 0.7, originX: 1.3, originY: -2.7 }
      const whole = screenField(tone, w, h, opts)
      for (const B of [1, 29, h]) {
        for (const [y0, y1] of bandsOf(h, B)) {
          const out = screenField(rowsOf(tone, w, y0, y1), w, y1 - y0, { ...opts, row0: y0 })
          expect(out).toEqual(whole.subarray(y0 * w, y1 * w))
        }
      }
    })
  }
})

describe('grain, streamed band by band', () => {
  const w = 61
  const h = 241
  const tone = noise(w * h, 21, 0.1)
  for (const cell of [1, 1.7, 2.86, 8.58, 34.3]) {
    it(`cell ${cell}: every band height gives the bytes the whole field always gave, from exactly the rows it declares`, () => {
      const want = ditherWhole(tone, w, h, cell, new Uint8ClampedArray(w * h))
      expect(ditherField(tone, w, h, { scale: cell }, new Uint8ClampedArray(w * h))).toEqual(want)
      expect(ditherField(tone, w, h, { scale: cell })).toEqual(ditherWhole(tone, w, h, cell, new Float32Array(w * h)))
      for (const B of [1, 5, 64, 97, 301, h]) {
        const g = new GrainStream(w, h, cell)
        for (const [y0, y1] of bandsOf(h, B)) {
          const { a, b } = g.need(y0, y1)
          const out = new Uint8ClampedArray((y1 - y0) * w)
          g.run(rowsOf(tone, w, a, b), a, y0, y1, out)
          expect(out).toEqual(want.subarray(y0 * w, y1 * w))
        }
      }
    })
  }

  it('a window one row short (at either end) changes what is printed', () => {
    for (const cell of [1, 2.86, 8.58]) {
      const want = ditherWhole(tone, w, h, cell, new Uint8ClampedArray(w * h))
      for (const trim of ['top', 'bottom'] as const) {
        let changed = false
        const g = new GrainStream(w, h, cell)
        for (const [y0, y1] of bandsOf(h, 37)) {
          let { a, b } = g.need(y0, y1)
          if (b - a > 1 && ((trim === 'top' && a > 0) || (trim === 'bottom' && b < h))) {
            if (trim === 'top') a++
            else b--
          }
          const out = new Uint8ClampedArray((y1 - y0) * w)
          g.run(rowsOf(tone, w, a, b), a, y0, y1, out)
          for (let i = 0; i < out.length; i++) if (out[i] !== want[y0 * w + i]) changed = true
        }
        expect(changed, `cell ${cell}, ${trim}`).toBe(true)
      }
    }
  })

  it('a one-row sheet with a fractional cell, and a sheet whose last cell row is short', () => {
    for (const [ww, hh, cell] of [
      [50, 1, 1.7],
      [33, 100, 8.58],
      [1, 40, 3.3],
    ] as const) {
      const t = noise(ww * hh, 4, 0.05)
      const want = ditherWhole(t, ww, hh, cell, new Uint8ClampedArray(ww * hh))
      for (const B of [1, 3, hh]) {
        const g = new GrainStream(ww, hh, cell)
        for (const [y0, y1] of bandsOf(hh, B)) {
          const { a, b } = g.need(y0, y1)
          const out = new Uint8ClampedArray((y1 - y0) * ww)
          g.run(rowsOf(t, ww, a, b), a, y0, y1, out)
          expect(out).toEqual(want.subarray(y0 * ww, y1 * ww))
        }
      }
    }
  })

  it('needs bands in order, and says what each band reads before it reads it', () => {
    const g = new GrainStream(w, h, 2.86)
    expect(() => g.run(tone, 0, 10, 20, new Uint8ClampedArray(10 * w))).toThrow()
    const rows = cellStarts(h, 2.86)
    // The first band reads two cell rows past its last; a band inside rows
    // already loaded reads none.
    // Cell rows start at 0, 3, 6, 9, 12, 15, 18, 21...
    expect(Array.from(rows.slice(0, 8))).toEqual([0, 3, 6, 9, 12, 15, 18, 21])
    // [0, 5) ends in cell row 1: rows 0 to 3 are loaded, pixel rows [0, 12).
    expect(grainRows(rows, 0, 5)).toEqual({ a: 0, b: 12 })
    // [5, 6) is still cell row 1: nothing new to read.
    expect(grainRows(rows, 5, 6)).toEqual({ a: 5, b: 5 })
    // [5, 13) ends in cell row 4: rows 4 to 6 are new, pixel rows [12, 21).
    expect(grainRows(rows, 5, 13)).toEqual({ a: 12, b: 21 })
    // The last cell rows: never past the sheet.
    expect(grainRows(rows, 230, h).b).toBe(h)
  })
})

describe('the ground luminance, accumulated band by band', () => {
  const w = 203
  const h = 157
  const ground = makeGround(w, h, 9)
  for (const radius of [2.4, 12.5, 70, 140]) {
    it(`radius ${radius}: bands of 1, 7, 97 and the whole ground give the grid of the whole ground, bit for bit`, () => {
      const want = lumaGridWhole(ground, w, h, radius)
      expect(groundLumaGrid(ground, w, h, radius)).toEqual(want)
      for (const B of [1, 7, 97, h]) {
        const acc = new LumaAccumulator(w, h, radius)
        for (const [y0, y1] of bandsOf(h, B)) acc.addRows(ground.slice(y0 * w * 4, y1 * w * 4), y0, y1)
        expect(acc.finish()).toEqual(want)
      }
    })
  }

  it('rows read back from the grid are the sheet read back, row for row', () => {
    for (const radius of [12.5, 70]) {
      const g = groundLumaGrid(ground, w, h, radius)
      const whole = sampleLumaRows(g, 0, h, new Float32Array(w * h))
      for (const [y0, y1] of bandsOf(h, 13)) {
        expect(sampleLumaRows(g, y0, y1, new Float32Array((y1 - y0) * w))).toEqual(whole.subarray(y0 * w, y1 * w))
      }
    }
  })

  it('rows must come in order, and all of them', () => {
    const acc = new LumaAccumulator(w, h, 70)
    expect(() => acc.addRows(ground, 5, 6)).toThrow()
    acc.addRows(ground.slice(0, 10 * w * 4), 0, 10)
    expect(() => acc.finish()).toThrow()
  })
})

describe('the composite of a band, from arrays that hold only the band', () => {
  const w = 41
  const h = 97
  const rand = mulberry32(17)
  const bytes = (n: number, zero = 0.4) => {
    const a = new Uint8ClampedArray(n)
    for (let i = 0; i < n; i++) a[i] = rand() < zero ? 0 : Math.floor(rand() * 256)
    return a
  }
  const paper = paperField(w, h, { rgb: [242, 239, 230], texture: 0.4, blotch: 0.5, seed: 3, scale: 0.7 })
  const layers: CompositeLayer[] = [
    { coverage: bytes(w * h), rgb: [255, 72, 176] },
    { coverage: bytes(w * h), rgb: [0, 120, 191] },
  ]
  const base = makeGround(w, h, 4)
  const knock = bytes(w * h, 0.7)
  for (const withGround of [false, true]) {
    it(withGround ? 'over a ground with a knockout' : 'on paper', () => {
      const ground = withGround ? { base, knockout: knock, paperAmount: 0.6 } : {}
      const whole = new Uint8ClampedArray(w * h * 4)
      compositeLayers(whole, w, h, { ...paper, ...ground }, layers)
      for (const B of [1, 10, h]) {
        for (const [y0, y1] of bandsOf(h, B)) {
          const band = new Uint8ClampedArray((y1 - y0) * w * 4)
          const shade = paper.shade.slice(y0 * w, y1 * w)
          const bandGround = withGround
            ? { base: base.slice(y0 * w * 4, y1 * w * 4), knockout: knock.slice(y0 * w, y1 * w), paperAmount: 0.6 }
            : {}
          const bandLayers = layers.map((l) => ({ ...l, coverage: l.coverage.slice(y0 * w, y1 * w) }))
          compositeLayers(band, w, h, { shade, shadeRow0: y0, rgb: paper.rgb, ...bandGround }, bandLayers, y0, y1, y0, y0)
          expect(band).toEqual(whole.subarray(y0 * w * 4, y1 * w * 4))
        }
      }
    })
  }
})

describe('the knockout of a band, from a window of the torn tone', () => {
  const w = 47
  const h = 180
  const torn = blobs(w, h, 23, 40)
  const lum = noise(w * h, 6, 0)
  const rand = mulberry32(8)
  const light = new Uint8ClampedArray(w * h)
  for (let i = 0; i < light.length; i++) light[i] = rand() < 0.5 ? 0 : 255
  const POISON = 1
  /** Rows [a, b) of the torn tone with `pad` rows of poison each side (a
   *  NaN read would vanish in the knockout's max; a full hole does not). */
  const padded = (a: number, b: number, pad: number) => {
    const out = new Float32Array((b - a + 2 * pad) * w).fill(POISON)
    out.set(torn.subarray(a * w, b * w), pad * w)
    return out
  }
  for (const [dx, dy] of [
    [0, 0],
    [1.5, -3.25],
    [-2, 7],
    [0.3, 0.6],
  ] as const) {
    for (const split of [false, true]) {
      it(`(${dx}, ${dy})${split ? ', split by a second ink' : ''}: bands equal the sheet, and read only shiftSource's rows`, () => {
        const sp = split ? { light, onLightLuma: 0.3, onDarkLuma: 0.7 } : undefined
        // The plain knockout of the whole sheet, in bytes as the press keeps it.
        const whole = Uint8ClampedArray.from(knockoutMask(torn, split ? lum : null, { w, h, dx, dy, split: sp }), (v) => v * 255)
        for (const B of [1, 31, h]) {
          for (const [y0, y1] of bandsOf(h, B)) {
            const { a, b } = shiftSource(dx, dy, y0, y1, h)
            const into = new Uint8ClampedArray((y1 - y0) * w)
            const bandSplit = sp ? { ...sp, light: light.slice(y0 * w, y1 * w) } : undefined
            cutKnockoutRows(into, y0, padded(a, b, 3), a - 3, split ? lum.slice(y0 * w, y1 * w) : null, { w, h, dx, dy, split: bandSplit, y0, y1 })
            expect(into).toEqual(whole.subarray(y0 * w, y1 * w))
          }
        }
      })
    }
  }
})

describe('halos and windows', () => {
  const press = (over: Partial<PressProfile> = {}): PressProfile => ({
    method: 'halftone',
    screenPitch: 9,
    density: 0.84,
    misregistration: 5,
    edge: 0.55,
    wear: 0.22,
    ...over,
  })
  const worst = press({ method: 'grain', screenPitch: 36, misregistration: 30, edge: 1, wear: 0.8 })

  /** The halo at its bound: a plate at detail 1 (type at 0.16 of the sheet
   *  or more), its offset at |dy| = misregistration x scale. */
  const bound = (p: PressProfile, h: number) =>
    plateHalo({ ...plateGeometry(p, { fontSize: 0.16 * h, index: 1 }, 12345, h), dx: 0, dy: p.misregistration * (h / 1800) })

  it('the halo bound, at detail 1 with |dy| at its bound: 41 and 218 rows at 40 MP, 50 and 268 at 61 MP', () => {
    // 40 MP, 7728x5152: u = 2.8622. Default: tear 3u = 8.587, reach 8, 24
    // rows; |dy| 5u = 14.31, 15 + 2. Worst: 24; |dy| 30u = 85.87, 86 + 2;
    // grain cell 12u = 34.35, 3 x 35 + 1.
    expect(bound(press(), 5152)).toMatchObject({ blur: 24, shift: 17, grain: 0, total: 41 })
    expect(bound(worst, 5152)).toMatchObject({ blur: 24, shift: 88, grain: 106, total: 218 })
    // 61 MP, 9504x6336: u = 3.52. Tear 10.56, reach 10, 30; |dy| 17.6 and 105.6;
    // cell 42.24.
    expect(bound(press(), 6336)).toMatchObject({ blur: 30, shift: 20, grain: 0, total: 50 })
    expect(bound(worst, 6336)).toMatchObject({ blur: 30, shift: 108, grain: 130, total: 268 })
    // No edge, no tear; no misregistration, no shift.
    expect(bound(press({ edge: 0, misregistration: 0 }), 5152).total).toBe(0)
  })

  it("the default document's own plates at 40 MP: 18 rows (plate 1 never moves) and 27", () => {
    const h = 5152
    const u = h / 1800
    // Plate 1, the headline at 0.09: 463.68 px, detail sqrt(463.68 / 824.32)
    // = 0.75, tear 3u x 0.75 = 6.44, reach 6.
    const p0 = plateHalo(plateGeometry(press(), { fontSize: plateFontSize({ size: 0.09 }, h), index: 0 }, 12345, h))
    expect(p0).toMatchObject({ blur: 18, shift: 0, grain: 0, total: 18, dx: 0, dy: 0, rMax: 6 })
    // Plate 2 at 0.06: detail sqrt(0.375) = 0.6124, tear 5.258, reach 5; its
    // offset from the seed at amount 5u sqrt(0.6124).
    const detail = Math.sqrt(0.375)
    const { dy } = registrationOffset(12345, 1, 5 * u * Math.sqrt(detail))
    const p1 = plateHalo(plateGeometry(press(), { fontSize: plateFontSize({ size: 0.06 }, h), index: 1 }, 12345, h))
    expect(p1.blur).toBe(15)
    expect(p1.shift).toBe(Math.ceil(Math.abs(dy)) + 2)
    expect(p1.total).toBe(27)
  })

  it('windows: coverage, then what the shift reads, then the knockout, the torn hull and the tear reach, clamped', () => {
    const h = 1000
    const g = plateGeometry(press({ misregistration: 20 }), { fontSize: 160, index: 1 }, 12345, h)
    expect(g.dy).not.toBe(0)
    const win = windowsFor({ y0: 400, y1: 450 }, g, h, true)
    expect(win.coverage).toEqual({ a: 400, b: 450 })
    expect(win.worn).toEqual(shiftSource(g.dx, g.dy, 400, 450, h))
    expect(win.knockout).toEqual(shiftSource(g.dx, g.dy, 400, 450, h))
    expect(win.torn).toEqual(win.worn)
    expect(win.glyph).toEqual({ a: win.torn.a - 3 * g.rMax, b: win.torn.b + 3 * g.rMax })
    // Never outside the sheet, at its top or its bottom.
    for (const band of [
      { y0: 0, y1: 5 },
      { y0: 990, y1: 1000 },
    ]) {
      const edge = windowsFor(band, g, h, true)
      expect(edge.glyph.a).toBe(Math.max(0, edge.torn.a - 3 * g.rMax))
      expect(edge.glyph.b).toBe(Math.min(h, edge.torn.b + 3 * g.rMax))
      expect(edge.glyph.a).toBeGreaterThanOrEqual(0)
      expect(edge.glyph.b).toBeLessThanOrEqual(h)
    }
    // Grain: the coverage is the stream's rows; no knockout without a cut.
    const gg = plateGeometry(press({ method: 'grain', misregistration: 0 }), { fontSize: 160, index: 0 }, 12345, h)
    const rows = cellStarts(h, gg.cell)
    const gw = windowsFor({ y0: 0, y1: 50 }, gg, h, false, rows)
    expect(gw.coverage).toEqual(grainRows(rows, 0, 50))
    expect(gw.knockout.b - gw.knockout.a).toBe(0)
    expect(() => windowsFor({ y0: 0, y1: 50 }, gg, h, false)).toThrow()
  })

  it('the halo is a bound: no window windowsFor cuts reaches further past its band, either side (random presses)', () => {
    // plateHalo sizes memory; the windows are what is cut. The formula may be
    // generous (the shift's "+ 2" is the bilinear's next row and its
    // rounding, which one side or the other never needs), never short.
    const rand = mulberry32(77)
    for (let k = 0; k < 300; k++) {
      const p = press({
        method: rand() < 0.5 ? 'grain' : 'halftone',
        screenPitch: 2 + Math.floor(rand() * 35),
        misregistration: rand() * 30,
        edge: rand() < 0.1 ? 0 : rand(),
      })
      const h = 300 + Math.floor(rand() * 9000)
      const plate = { fontSize: 1 + rand() * h * 0.3, index: Math.floor(rand() * 4) }
      const seed = Math.floor(rand() * 1e6)
      const geometry = plateGeometry(p, plate, seed, h)
      const halo = plateHalo(geometry)
      const rows = geometry.grain ? cellStarts(h, geometry.cell) : undefined
      const B = 1 + Math.floor(rand() * 600)
      const cuts = rand() < 0.5
      for (let y0 = 0; y0 < h; y0 += B) {
        const y1 = Math.min(h, y0 + B)
        const win = windowsFor({ y0, y1 }, geometry, h, cuts, rows)
        if (win.glyph.b <= win.glyph.a) continue
        expect(y0 - win.glyph.a, `press ${k}, band ${y0}`).toBeLessThanOrEqual(halo.total)
        expect(win.glyph.b - y1, `press ${k}, band ${y0}`).toBeLessThanOrEqual(halo.total)
      }
    }
  })

  it('the largest window, walked band by band: the sheets of a 40 and a 61 MP photo', () => {
    // Every plate with a second ink (a knockout), the bands of the pixel rule
    // (2^21 pixels over the width). Plate 1 never moves, so its knockout
    // reads its own rows only: counting the shift's extra row for it too
    // would give 308 and 263 for the default document.
    const doc = (p: PressProfile, sizes: number[], h: number) =>
      sizes.map((size, index) => ({ geometry: plateGeometry(p, { fontSize: plateFontSize({ size }, h), index }, 12345, h), cuts: true }))
    expect(maxWindow(doc(press(), [0.09, 0.06], 5152), Math.floor(2 ** 21 / 7728), 5152)).toBe(307)
    expect(maxWindow(doc(press(), [0.09, 0.06], 6336), Math.floor(2 ** 21 / 9504), 6336)).toBe(262)
    expect(maxWindow(doc(worst, [0.16, 0.16, 0.16, 0.16], 6336), Math.floor(2 ** 21 / 9504), 6336)).toBe(406)
    expect(maxWindow(doc(worst, [0.16, 0.16, 0.16, 0.16], 10954), Math.floor(2 ** 21 / 3651), 10954)).toBe(901)
  })
})
