/**
 * The area average (resample.ts): each output pixel the exact mean of the
 * source area under it.
 */

import { describe, expect, it } from 'vitest'
import { areaAverage, type RgbaImage } from './resample.ts'
import { mulberry32 } from './rng.ts'

const image = (w: number, h: number, px: (x: number, y: number) => number[]): RgbaImage => {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(px(x, y), (y * w + x) * 4)
  return { w, h, rgba }
}

/** The mean of the source over [x0, x1) x [y0, y1), integrated pixel by
 *  pixel: the reference, written the slow way. */
function slowMean(src: RgbaImage, x0: number, y0: number, x1: number, y1: number): number[] {
  const acc = [0, 0, 0, 0]
  let area = 0
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const w = (Math.min(x1, x + 1) - Math.max(x0, x)) * (Math.min(y1, y + 1) - Math.max(y0, y))
      if (w <= 0) continue
      const o = (y * src.w + x) * 4
      const a = src.rgba[o + 3]
      for (let k = 0; k < 3; k++) acc[k] += w * a * src.rgba[o + k]
      acc[3] += w * a
      area += w
    }
  }
  const a = acc[3]
  return a > 0 ? [acc[0] / a, acc[1] / a, acc[2] / a, a / area] : [0, 0, 0, 0]
}

describe('areaAverage', () => {
  it('at its own size it is the image', () => {
    const rng = mulberry32(1)
    const src = image(13, 9, () => [rng() * 256, rng() * 256, rng() * 256, 255])
    const out = areaAverage(src, { x: 0, y: 0, w: 13, h: 9 }, 13, 9)
    expect(Array.from(out)).toEqual(Array.from(src.rgba))
  })

  it('each output pixel is the exact mean of the area under it, fractional pixels by how much they are covered', () => {
    const rng = mulberry32(2)
    const src = image(37, 23, () => [rng() * 256, rng() * 256, rng() * 256, 255])
    for (const [box, dw, dh] of [
      [{ x: 0, y: 0, w: 37, h: 23 }, 10, 6],
      [{ x: 2.5, y: 1.25, w: 30.3, h: 19.1 }, 7, 11],
      [{ x: 0, y: 0, w: 37, h: 23 }, 60, 40],
    ] as const) {
      const out = areaAverage(src, box, dw, dh)
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const kx = box.w / dw
          const ky = box.h / dh
          const want = slowMean(src, box.x + x * kx, box.y + y * ky, box.x + (x + 1) * kx, box.y + (y + 1) * ky)
          for (let k = 0; k < 4; k++) expect(out[(y * dw + x) * 4 + k]).toBeCloseTo(want[k], 3)
        }
      }
    }
  })

  it('a transparent pixel adds nothing to the colour round it, only to the alpha', () => {
    // Half red, half transparent black: the mean is red at half alpha, not a
    // dark red.
    const src = image(2, 1, (x) => (x === 0 ? [200, 40, 20, 255] : [0, 0, 0, 0]))
    expect(Array.from(areaAverage(src, { x: 0, y: 0, w: 2, h: 1 }, 1, 1))).toEqual([200, 40, 20, 127.5])
    // Wholly transparent: 0, as a canvas reads it back.
    const clear = image(2, 2, () => [90, 90, 90, 0])
    expect(Array.from(areaAverage(clear, { x: 0, y: 0, w: 2, h: 2 }, 1, 1))).toEqual([0, 0, 0, 0])
  })

  it('a flat colour stays that colour exactly, at any size', () => {
    const src = image(41, 29, () => [37, 141, 222, 255])
    for (const [dw, dh] of [
      [1, 1],
      [7, 5],
      [84, 59],
    ]) {
      const out = areaAverage(src, { x: 0, y: 0, w: 41, h: 29 }, dw, dh)
      for (let i = 0; i < dw * dh; i++) expect(Array.from(out.subarray(i * 4, i * 4 + 4)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([37, 141, 222, 255])
    }
  })

  it('refuses a size of nothing', () => {
    const src = image(2, 2, () => [0, 0, 0, 255])
    expect(() => areaAverage(src, { x: 0, y: 0, w: 2, h: 2 }, 0, 1)).toThrow()
  })
})
