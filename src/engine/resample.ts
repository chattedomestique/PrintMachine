/**
 * An image made smaller (or larger) by area: each output pixel is the exact
 * mean of the source area under it, fractional pixels weighted by how much of
 * them it covers. No canvas: the same bytes in every browser, and a function
 * of nothing but its arguments.
 *
 * What the frame's photo-keyed fills are made from: the palette's small
 * sample of the photo, and the frosted field.
 *
 * Pure: no DOM.
 */

/** RGBA bytes, straight alpha, `w` x `h`. */
export interface RgbaImage {
  w: number
  h: number
  rgba: Uint8ClampedArray
}

/** A rectangle of the source, in source pixels (fractional allowed). */
export interface SourceBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Which source pixels output pixel `i` of `n` covers along one axis, and how
 * much: the span [x0 + i k, x0 + (i + 1) k), k = len / n, against pixels
 * [j, j + 1) of the source's [0, size). `pairs` holds (j, weight) pairs, the
 * weights of each output pixel summing to 1; output pixel i's are the
 * `count[i]` pairs from `pairs[first[i]]`.
 */
function spans(x0: number, len: number, n: number, size: number): { first: Int32Array; count: Int32Array; pairs: Float64Array } {
  const k = len / n
  const first = new Int32Array(n)
  const count = new Int32Array(n)
  const all: number[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.min(size, Math.max(0, x0 + i * k))
    const b = Math.min(size, Math.max(a, x0 + (i + 1) * k))
    const j0 = Math.min(size - 1, Math.floor(a))
    const j1 = Math.max(j0 + 1, Math.ceil(b))
    first[i] = all.length
    count[i] = j1 - j0
    let sum = 0
    for (let j = j0; j < j1; j++) {
      const wgt = Math.max(0, Math.min(b, j + 1) - Math.max(a, j))
      all.push(j, wgt)
      sum += wgt
    }
    // A mean: the weights over what the span covers of the source. A span
    // that covers nothing of it (only past its edge) takes its edge pixel.
    for (let q = first[i] + 1; q < all.length; q += 2) all[q] = sum > 0 ? all[q] / sum : 1 / count[i]
  }
  return { first, count, pairs: Float64Array.from(all) }
}

/**
 * The area mean of `box` of `src` on a `dw` x `dh` grid, as floats, RGBA
 * interleaved: the colour straight (not multiplied by its alpha), 0..255,
 * weighted by alpha so a transparent pixel adds nothing to the colour round
 * it, and 0 where nothing under the pixel is opaque (as a canvas reads back
 * a transparent pixel); the alpha, 0..255, the mean alpha.
 *
 * Separable: rows first (only the rows the box reaches), then columns, in
 * float64 sums.
 */
export function areaAverage(src: RgbaImage, box: SourceBox, dw: number, dh: number): Float32Array {
  if (!(dw >= 1 && dh >= 1 && box.w > 0 && box.h > 0)) throw new Error(`areaAverage: ${dw}x${dh} of a ${box.w}x${box.h} box`)
  const { w: sw, h: sh, rgba } = src
  const cols = spans(box.x, box.w, dw, sw)
  const rows = spans(box.y, box.h, dh, sh)
  // The source rows the box reaches, each averaged across into dw columns,
  // alpha-weighted: r a, g a, b a, a.
  const ry0 = Math.min(sh - 1, Math.floor(Math.max(0, box.y)))
  const ry1 = Math.max(ry0 + 1, Math.min(sh, Math.ceil(box.y + box.h)))
  const across = new Float64Array((ry1 - ry0) * dw * 4)
  for (let y = ry0; y < ry1; y++) {
    const so = y * sw * 4
    const to = (y - ry0) * dw * 4
    for (let x = 0; x < dw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const f = cols.first[x]
      for (let q = 0; q < cols.count[x]; q++) {
        const p = so + cols.pairs[f + 2 * q] * 4
        const wa = cols.pairs[f + 2 * q + 1] * rgba[p + 3]
        r += wa * rgba[p]
        g += wa * rgba[p + 1]
        b += wa * rgba[p + 2]
        a += wa
      }
      const t = to + x * 4
      across[t] = r
      across[t + 1] = g
      across[t + 2] = b
      across[t + 3] = a
    }
  }
  const out = new Float32Array(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const f = rows.first[y]
    for (let x = 0; x < dw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let q = 0; q < rows.count[y]; q++) {
        const t = ((rows.pairs[f + 2 * q] - ry0) * dw + x) * 4
        const wgt = rows.pairs[f + 2 * q + 1]
        r += wgt * across[t]
        g += wgt * across[t + 1]
        b += wgt * across[t + 2]
        a += wgt * across[t + 3]
      }
      const o = (y * dw + x) * 4
      if (a > 0) {
        out[o] = r / a
        out[o + 1] = g / a
        out[o + 2] = b / a
      }
      out[o + 3] = a
    }
  }
  return out
}
