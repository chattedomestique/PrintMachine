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
 * [j, j + 1) of the source's [0, size). Output pixel i's are the `count[i]`
 * pixels `index[first[i] + q]`, weighted `weight[first[i] + q]` (summing to
 * 1).
 */
function spans(x0: number, len: number, n: number, size: number) {
  const k = len / n
  const first = new Int32Array(n)
  const count = new Int32Array(n)
  const index: number[] = []
  const weight: number[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.min(size, Math.max(0, x0 + i * k))
    const b = Math.min(size, Math.max(a, x0 + (i + 1) * k))
    const j0 = Math.min(size - 1, Math.floor(a))
    const j1 = Math.max(j0 + 1, Math.ceil(b))
    first[i] = index.length
    count[i] = j1 - j0
    let sum = 0
    for (let j = j0; j < j1; j++) {
      const wgt = Math.max(0, Math.min(b, j + 1) - Math.max(a, j))
      index.push(j)
      weight.push(wgt)
      sum += wgt
    }
    // A mean: the weights over what the span covers of the source. A span
    // that covers nothing of it (only past its edge) takes its edge pixel.
    for (let q = first[i]; q < index.length; q++) weight[q] = sum > 0 ? weight[q] / sum : 1 / count[i]
  }
  return { first, count, index: Int32Array.from(index), weight: Float64Array.from(weight) }
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
  // alpha-weighted: r a, g a, b a, a. Walked along the source row, each
  // pixel added to the columns it falls in (the spans turned round), so the
  // row is read once, in order.
  const ry0 = Math.min(sh - 1, Math.floor(Math.max(0, box.y)))
  const ry1 = Math.max(ry0 + 1, Math.min(sh, Math.ceil(box.y + box.h)))
  const across = new Float64Array((ry1 - ry0) * dw * 4)
  const { first: cf, count: cn, index: ci, weight: cw } = cols
  const jx0 = ci[cf[0]]
  const jx1 = ci[cf[dw - 1] + cn[dw - 1] - 1] + 1
  // For each source column, the output columns it adds to and how much.
  const byColumn: number[][] = Array.from({ length: jx1 - jx0 }, () => [])
  for (let x = 0; x < dw; x++) for (let q = cf[x]; q < cf[x] + cn[x]; q++) byColumn[ci[q] - jx0].push(x * 4, cw[q])
  const toFirst = new Int32Array(jx1 - jx0 + 1)
  for (let j = 0; j < jx1 - jx0; j++) toFirst[j + 1] = toFirst[j] + byColumn[j].length / 2
  const toCol = new Int32Array(toFirst[jx1 - jx0])
  const toWeight = new Float64Array(toFirst[jx1 - jx0])
  for (let j = 0; j < jx1 - jx0; j++) {
    for (let q = 0; q < byColumn[j].length; q += 2) {
      toCol[toFirst[j] + q / 2] = byColumn[j][q]
      toWeight[toFirst[j] + q / 2] = byColumn[j][q + 1]
    }
  }
  for (let y = ry0; y < ry1; y++) {
    const t = (y - ry0) * dw * 4
    for (let j = jx0, p = (y * sw + jx0) * 4; j < jx1; j++, p += 4) {
      const alpha = rgba[p + 3]
      if (alpha === 0) continue
      const r = rgba[p] * alpha
      const g = rgba[p + 1] * alpha
      const b = rgba[p + 2] * alpha
      for (let q = toFirst[j - jx0], end = toFirst[j - jx0 + 1]; q < end; q++) {
        const o = t + toCol[q]
        const wgt = toWeight[q]
        across[o] += wgt * r
        across[o + 1] += wgt * g
        across[o + 2] += wgt * b
        across[o + 3] += wgt * alpha
      }
    }
  }
  const out = new Float32Array(dw * dh * 4)
  const { first: rf, count: rn, index: ri, weight: rw } = rows
  const sums = new Float64Array(dw * 4)
  for (let y = 0; y < dh; y++) {
    sums.fill(0)
    for (let q = rf[y], end = rf[y] + rn[y]; q < end; q++) {
      const t = (ri[q] - ry0) * dw * 4
      const wgt = rw[q]
      for (let k = 0; k < dw * 4; k++) sums[k] += wgt * across[t + k]
    }
    const o = y * dw * 4
    for (let x = 0, k = 0; x < dw; x++, k += 4) {
      const a = sums[k + 3]
      if (a > 0) {
        out[o + k] = sums[k] / a
        out[o + k + 1] = sums[k + 1] / a
        out[o + k + 2] = sums[k + 2] / a
      }
      out[o + k + 3] = a
    }
  }
  return out
}
