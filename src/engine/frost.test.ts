/**
 * Frosted's field (frost.ts): made from the photo, of the sheet's shape, at
 * a size that does not depend on any rendered size; blurred by Border
 * Studio's shrinking box passes; graded; sampled with one rounding.
 */

import { describe, expect, it } from 'vitest'
import { blurInPlace, boxBlurPlane } from './blur.ts'
import { composeFrameRows, fillFor, fillRgba, layoutSheet, sheetAspect } from './frame.ts'
import { frostBlur, frostCover, frostField, frostFieldSize, frostRadius, frostSampler, type FrostField } from './frost.ts'
import { FROST_DRAFT_LONG, FROST_FIELD_LONG } from './limits.ts'
import { mulberry32 } from './rng.ts'
import { outputSize } from './render.ts'
import type { PrintSettings } from './types.ts'
import { defaultSettings, makeMedia } from '../state/defaults.ts'
import { makeFrameSource } from './__tests__/fields.ts'

const flat = (w: number, h: number, rgb: number[]) => {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) rgba.set([...rgb, 255], i * 4)
  return { w, h, rgba }
}

/** Border Studio's grade, written out: brightness, then saturation about
 *  Rec. 709 luma, held to 0..255. */
const grade = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => v * 0.85)
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [r, g, b].map((v) => Math.min(255, Math.max(0, l + (v - l) * 1.6)))
}

/** Border Studio's shrinking box pass on one plane, written the slow way:
 *  each sample the mean of the samples within r of it that there are. */
function slowShrinkPass(p: Float64Array, w: number, h: number, r: number): Float64Array<ArrayBuffer> {
  const t = new Float64Array(p.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++, n++) s += p[y * w + k]
      t[y * w + x] = s / n
    }
  }
  const o = new Float64Array(p.length)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0
      let n = 0
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++, n++) s += t[k * w + x]
      o[y * w + x] = s / n
    }
  }
  return o
}

describe('the field', () => {
  const src = makeFrameSource(512, 341, 4)

  it('is the same bytes from the same inputs, every time', () => {
    const a = frostField(src, 1.4, FROST_FIELD_LONG, 60)
    const b = frostField(src, 1.4, FROST_FIELD_LONG, 60)
    for (const k of ['r', 'g', 'b'] as const) expect(Buffer.from(a[k].buffer).equals(Buffer.from(b[k].buffer))).toBe(true)
    expect([a.w, a.h, a.aspect, a.blur]).toEqual([480, 343, 1.4, 60])
  })

  it("its size comes from the sheet's shape and the long side alone, Original or fixed, rounded as Border Studio rounds", () => {
    // No rendered size reaches it (the signature takes none), so the
    // preview, the draft and the save sample one field for one shape: what
    // is left to test is the rounding.
    const original = { ...defaultSettings(), aspect: 'original', media: makeMedia({ id: 'p', width: 7728, height: 5152 }) } as PrintSettings
    original.frame = { ...original.frame, width: 1 / 14 }
    const portrait = { ...original, aspect: '4:5' } as PrintSettings
    // 9016x6440 (the default frame on a 40 MP photo): 480 x 343.
    expect(frostFieldSize(sheetAspect(original), FROST_FIELD_LONG)).toEqual({ w: 480, h: 343 })
    expect(frostFieldSize(sheetAspect(portrait), FROST_FIELD_LONG)).toEqual({ w: 384, h: 480 })
    expect(frostFieldSize(sheetAspect(portrait), FROST_DRAFT_LONG)).toEqual({ w: 128, h: 160 })
    // At least 4 on the short side, as Border Studio's.
    expect(frostFieldSize(200, FROST_DRAFT_LONG)).toEqual({ w: 160, h: 4 })
    for (const s of [original, portrait]) expect(frostField(src, sheetAspect(s), FROST_FIELD_LONG, 60)).toMatchObject(frostFieldSize(sheetAspect(s), FROST_FIELD_LONG))
  })

  it('a Blur change keeps the cover: the field from a kept cover is the field made whole, and the cover is not changed', () => {
    for (const source of [src, flat(300, 200, [200, 120, 60])]) {
      const cover = frostCover(source, 1.4, FROST_FIELD_LONG)
      const before = cover.r.slice()
      for (const blur of [10, 61, 240]) {
        const kept = frostBlur(cover, blur)
        const whole = frostField(source, 1.4, FROST_FIELD_LONG, blur)
        for (const k of ['r', 'g', 'b'] as const) expect(Buffer.from(kept[k].buffer).equals(Buffer.from(whole[k].buffer))).toBe(true)
      }
      expect(Buffer.from(cover.r.buffer).equals(Buffer.from(before.buffer))).toBe(true)
    }
  })

  it("a photo's transparent pixels frost to the colour of the photo round them, never black; a photo with nothing opaque is Paper", () => {
    // One light colour, its left quarter fully transparent (a cut-out PNG).
    const w = 400
    const h = 300
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([220, 200, 180, i % w < w / 4 ? 0 : 255], i * 4)
    const want = grade([220, 200, 180])
    for (const blur of [10, 60, 240]) {
      const f = frostField({ w, h, rgba }, w / h, FROST_FIELD_LONG, blur)
      // Every texel, the transparent quarter's too: the photo's colour,
      // graded (black would be 0).
      for (const i of [0, f.w * 60, f.w * 171 + 50, f.w * 171 + 120, f.w * f.h - 1]) {
        expect(Math.abs(f.r[i] - want[0])).toBeLessThan(0.05)
        expect(Math.abs(f.g[i] - want[1])).toBeLessThan(0.05)
        expect(Math.abs(f.b[i] - want[2])).toBeLessThan(0.05)
      }
      expect(f.clear).toBe(false)
    }
    // The test source's clear corner takes the photo's colours round it.
    const corner = frostField(makeFrameSource(512, 341, 4), 1.4, FROST_FIELD_LONG, 10)
    expect(Math.min(corner.r[0], corner.g[0], corner.b[0])).toBeGreaterThan(60)
    // Nothing opaque: no colour to frost.
    const clear = frostField({ w, h, rgba: new Uint8ClampedArray(w * h * 4) }, w / h, FROST_FIELD_LONG, 60)
    expect(clear.clear).toBe(true)
    const s = { ...defaultSettings(), aspect: '4:5', media: makeMedia({ id: 'p', width: 400, height: 300 }) } as PrintSettings
    s.frame = { ...s.frame, width: 0.05, fill: 'frosted', blur: 60 }
    const field = frostField({ w, h, rgba: new Uint8ClampedArray(w * h * 4) }, sheetAspect(s), FROST_FIELD_LONG, 60)
    expect(fillFor(s, { frost: field }, 400, 500).flat).toEqual(fillFor({ ...s, frame: { ...s.frame, fill: 'paper' } }, {}, 400, 500).flat)
  })

  it("the blur's radius scales with the field: Border Studio's 7 and 22 on its 240 px field, x 2 at 480, x 2/3 at the draft's 160", () => {
    expect(frostRadius(60, 240)).toBe(7)
    expect(frostRadius(240, 240)).toBe(22)
    expect([frostRadius(10, 480), frostRadius(60, 480), frostRadius(240, 480)]).toEqual([6, 14, 44])
    expect([frostRadius(60, FROST_DRAFT_LONG), frostRadius(240, FROST_DRAFT_LONG)]).toEqual([5, 15])
    expect(frostRadius(10, 60)).toBe(2)
  })

  it('stays in float: never rounded to bytes before it is sampled (that would leave a stair a field pixel wide)', () => {
    const f = frostField(src, 1.4, FROST_FIELD_LONG, 240)
    let whole = 0
    for (const plane of [f.r, f.g, f.b]) for (const v of plane) if (v === Math.round(v)) whole++
    // A smooth photo blurred and graded: hardly a value falls on a whole
    // level (those held at 0 or 255 aside, which this one has none of).
    expect(whole / (3 * f.w * f.h)).toBeLessThan(0.01)
  })

  it('a photo of one colour is that colour, graded', () => {
    const f = frostField(flat(300, 200, [200, 120, 60]), 1.5, FROST_FIELD_LONG, 120)
    const want = grade([200, 120, 60])
    for (const i of [0, 1234, f.w * f.h - 1]) {
      expect(f.r[i]).toBeCloseTo(want[0], 3)
      expect(f.g[i]).toBeCloseTo(want[1], 3)
      expect(f.b[i]).toBeCloseTo(want[2], 3)
    }
  })

  it('the grade at its shipped values is not the identity, and comes after the blur', () => {
    // Stripes of a red and a cyan the grade drives past 0..255: graded
    // first, the clipped stripes blur to another colour than blurred first.
    const w = 240
    const h = 160
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set((i % w) % 2 ? [250, 20, 20, 255] : [20, 230, 230, 255], i * 4)
    const f = frostField({ w, h, rgba }, 1.5, 240, 60)
    const r = frostRadius(60, 240)
    const blur3 = (planes: Float64Array[]) => {
      let out = planes
      for (let pass = 0; pass < 3; pass++) out = out.map((p) => slowShrinkPass(p, w, h, r))
      return out
    }
    const blurred = blur3([0, 1, 2].map((c) => Float64Array.from({ length: w * h }, (_, i) => rgba[i * 4 + c])))
    const gradedFirst = blur3([0, 1, 2].map((c) => Float64Array.from({ length: w * h }, (_, i) => grade([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]])[c])))
    for (const [y, x] of [[80, 120], [3, 2], [159, 239]]) {
      const i = y * w + x
      const want = grade(blurred.map((p) => p[i]))
      expect(f.r[i]).toBeCloseTo(want[0], 2)
      expect(f.g[i]).toBeCloseTo(want[1], 2)
      expect(f.b[i]).toBeCloseTo(want[2], 2)
      // Not the identity, and not graded before the blur.
      expect(Math.max(...[f.r[i] - blurred[0][i], f.g[i] - blurred[1][i], f.b[i] - blurred[2][i]].map(Math.abs))).toBeGreaterThan(5)
      expect(Math.max(...[f.r[i] - gradedFirst[0][i], f.g[i] - gradedFirst[1][i], f.b[i] - gradedFirst[2][i]].map(Math.abs))).toBeGreaterThan(5)
    }
  })

  it('Blur 240 spreads a point at least 5x wider than Blur 10', () => {
    // A dark field with one bright dot in the middle: how far its light
    // reaches (where the field is still visibly brighter than the rest).
    const w = 480
    const h = 480
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([10, 10, 10, 255], i * 4)
    for (let y = 238; y < 242; y++) for (let x = 238; x < 242; x++) rgba.set([255, 255, 255, 255], (y * w + x) * 4)
    const reach = (blur: number) => {
      const f = frostField({ w, h, rgba }, 1, 480, blur)
      const floor = f.g[0]
      let x = 240
      while (x < w - 1 && f.g[240 * w + x] - floor > 1e-3) x++
      return x - 240
    }
    expect(reach(240)).toBeGreaterThanOrEqual(5 * reach(10))
  })
})

describe('the shrinking box passes (blur.ts)', () => {
  it("'shrink' divides each window by the samples it really holds: Border Studio's pass, three times", () => {
    const rng = mulberry32(8)
    for (const [w, h, r] of [
      [37, 23, 3],
      [11, 40, 7],
      [5, 5, 9],
    ]) {
      const plane = Float32Array.from({ length: w * h }, () => rng() * 255)
      let want: Float64Array<ArrayBuffer> = Float64Array.from(plane)
      for (let pass = 0; pass < 3; pass++) want = slowShrinkPass(want, w, h, r)
      boxBlurPlane(plane, new Float32Array(w * h), w, h, r, 'shrink')
      for (let i = 0; i < w * h; i++) expect(plane[i]).toBeCloseTo(want[i], 3)
    }
  })

  it("at the edge it is not 'clamp': a ramp's edge is the mean of what is there, not pulled to a repeated end", () => {
    const w = 50
    const ramp = () => Float32Array.from({ length: w }, (_, x) => x)
    const shrink = ramp()
    const clamp = ramp()
    boxBlurPlane(shrink, new Float32Array(w), w, 1, 4, 'shrink')
    boxBlurPlane(clamp, new Float32Array(w), w, 1, 4, 'clamp')
    // In the middle a ramp is kept by both; at the end they part.
    expect(shrink[25]).toBeCloseTo(25, 4)
    expect(clamp[25]).toBeCloseTo(25, 4)
    expect(shrink[0]).toBeGreaterThan(clamp[0] + 1)
  })

  it("'clamp' is the plates' blur exactly: the same bytes as blur.ts always gave", () => {
    // The clamped pass as it was before the edge rule, written out.
    const before = (a: Float32Array, w: number, h: number, r: number) => {
      const b = new Float32Array(a.length)
      const norm = 1 / (2 * r + 1)
      for (let pass = 0; pass < 3; pass++) {
        for (let y = 0; y < h; y++) {
          const row = y * w
          let sum = a[row] * (r + 1)
          for (let i = 1; i <= r; i++) sum += a[row + Math.min(i, w - 1)]
          for (let x = 0; x < w; x++) {
            b[row + x] = sum * norm
            sum += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)]
          }
        }
        const sums = new Float64Array(w)
        for (let x = 0; x < w; x++) sums[x] = b[x] * (r + 1)
        for (let i = 1; i <= r; i++) for (let x = 0; x < w; x++) sums[x] += b[Math.min(i, h - 1) * w + x]
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            a[y * w + x] = sums[x] * norm
            sums[x] += b[Math.min(y + r + 1, h - 1) * w + x] - b[Math.max(y - r, 0) * w + x]
          }
        }
      }
    }
    const rng = mulberry32(12)
    for (const r of [1, 3, 6]) {
      const field = Float32Array.from({ length: 61 * 47 }, () => rng())
      const a = field.slice()
      const b = field.slice()
      before(a, 61, 47, r)
      blurInPlace(b, 61, 47, r, new Float32Array(field.length))
      expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true)
    }
  })
})

describe('the sampler', () => {
  /** A field whose planes are linear in x and y: its bilinear sample is
   *  linear too, so the exact value at any point is known. */
  const linear = (w: number, h: number): FrostField => {
    const r = new Float32Array(w * h)
    const g = new Float32Array(w * h)
    const b = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        r[y * w + x] = 20 + 0.37 * x + 0.11 * y
        g[y * w + x] = 200 - 0.29 * x
        b[y * w + x] = 60 + 0.53 * y
      }
    }
    return { w, h, r, g, b, aspect: w / h, blur: 60, clear: false }
  }

  it('on a linear field every pixel is the exact value rounded once: no stair from rounding the field first', () => {
    const field = linear(48, 32)
    const W = 1500
    const H = 1000
    const pad = Math.round(0.02 * W)
    const at = (v: number, n: number, f: number) => Math.min(f - 1, Math.max(0, ((v + 0.5 + pad) / (n + 2 * pad)) * f - 0.5))
    const sample = frostSampler(field, W, H)
    const row = new Uint8ClampedArray(W * 4)
    const round = (v: number) => Uint8ClampedArray.of(v)[0]
    let checked = 0
    for (const y of [0, 1, 333, 500, 998, 999]) {
      sample(y, 0, W, row, 0)
      const fy = at(y, H, field.h)
      for (let x = 0; x < W; x++) {
        const fx = at(x, W, field.w)
        expect([row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]]).toEqual([round(20 + 0.37 * fx + 0.11 * fy), round(200 - 0.29 * fx), round(60 + 0.53 * fy), 255])
        checked++
      }
    }
    expect(checked).toBe(6 * W)
    // The same field rounded to bytes before it is stretched over the sheet
    // gives stairs: a run of one value as long as a field pixel is wide.
    const stepped = linear(48, 32)
    for (const k of ['r', 'g', 'b'] as const) stepped[k] = stepped[k].map(Math.round)
    const coarse = new Uint8ClampedArray(W * 4)
    frostSampler(stepped, W, H)(500, 0, W, coarse, 0)
    sample(500, 0, W, row, 0)
    expect(Buffer.from(coarse).equals(Buffer.from(row))).toBe(false)
  })

  it('is a function of the position alone: any band height, any run of columns, the same bytes', () => {
    const s = { ...defaultSettings(), aspect: 'original', media: makeMedia({ id: 'p', width: 900, height: 600 }) } as PrintSettings
    s.frame = { ...s.frame, width: 0.12, corners: 0.7, fill: 'frosted', blur: 90 }
    const { w, h } = outputSize(sheetAspect(s), 410)
    const field = frostField(makeFrameSource(300, 200, 2), sheetAspect(s), FROST_FIELD_LONG, 90)
    const layout = layoutSheet(s, w, h)
    const ground = new Uint8ClampedArray(w * h * 4).fill(128)
    const whole = new Uint8ClampedArray(w * h * 4)
    composeFrameRows(layout, fillRgba(frostSampler(field, w, h)), ground, 0, h, whole)
    for (const B of [1, 7, 97]) {
      const banded = new Uint8ClampedArray(w * h * 4)
      const fill = fillRgba(frostSampler(field, w, h))
      for (let y0 = 0; y0 < h; y0 += B) {
        const y1 = Math.min(h, y0 + B)
        composeFrameRows(layout, fill, ground.subarray(y0 * w * 4, y1 * w * 4), y0, y1, banded.subarray(y0 * w * 4, y1 * w * 4))
      }
      expect(Buffer.from(banded).equals(Buffer.from(whole)), `bands of ${B}`).toBe(true)
    }
    // Pixel by pixel, the row's own bytes.
    const one = new Uint8ClampedArray(4)
    const sample = frostSampler(field, w, h)
    for (const [x, y] of [[0, 0], [w - 1, h - 1], [3, h >> 1]]) {
      sample(y, x, x + 1, one, 0)
      expect([...one]).toEqual([...whole.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)])
    }
  })
})
