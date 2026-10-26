/**
 * Reference implementations, for the tests only: the plain versions of
 * passes the press runs in place or in bands, kept as oracles (the app never
 * imports this folder, so the build never ships it).
 *
 *  - `shiftField`: the bilinear shift of a whole field into a NEW field.
 *    `shiftRows` (ink.ts) moves a window of rows at a time; this is what it is
 *    checked against.
 *  - `knockoutMask`: the knockout as a float field of its own, where the
 *    press cuts it into the running bytes a band at a time
 *    (`cutKnockoutRows`). Its behaviour tests and the golden recorded when
 *    the knockout became a stage of its own are written against this shape.
 *  - `groundLuma`: the ground's blurred luminance at every pixel, at full
 *    resolution, as the press held it before the luminance grid.
 *  - `ditherWhole` and `lumaGridWhole`: grain and the ground's luminance grid
 *    as they were before the press could run in bands, over the whole field
 *    at once (dither.ts and media.ts at the commit before). The streaming
 *    versions (`GrainStream`, `LumaAccumulator`) must give their bytes.
 */

import { blurInPlace, needsSpare } from '../blur.ts'
import { holeAt, type KnockoutParams } from '../knockout.ts'
import { lumaCell, luma, type LumaGrid } from '../media.ts'

export function shiftField(src: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  if (dx === 0 && dy === 0) return src.slice()

  const out = new Float32Array(w * h)
  const at = (x: number, y: number): number => (x < 0 || x >= w || y < 0 || y >= h ? 0 : src[y * w + x])

  for (let y = 0; y < h; y++) {
    const sy = y - dy
    const y0 = Math.floor(sy)
    const fy = sy - y0

    for (let x = 0; x < w; x++) {
      const sx = x - dx
      const x0 = Math.floor(sx)
      const fx = sx - x0

      const a = at(x0, y0)
      const b = at(x0 + 1, y0)
      const c = at(x0, y0 + 1)
      const d = at(x0 + 1, y0 + 1)

      const top = a + (b - a) * fx
      const bot = c + (d - c) * fx
      out[y * w + x] = top + (bot - top) * fy
    }
  }
  return out
}

/** How much of the ground to take away under one plate, 0..1 per pixel, as a
 *  new float field (see knockout.ts `cutKnockoutRows` for the rule). */
export function knockoutMask(roughened: Float32Array, groundLum: Float32Array | null, p: KnockoutParams): Float32Array {
  const { w, h } = p
  const moved = shiftField(roughened, w, h, p.dx, p.dy)
  const out = new Float32Array(w * h)
  const split = groundLum ? p.split : undefined
  const unit = split?.light instanceof Uint8ClampedArray ? 255 : 1
  for (let i = 0; i < out.length; i++) out[i] = holeAt(moved[i], groundLum, split, unit, i)
  return out
}

const ATKINSON: readonly (readonly [number, number, number])[] = [
  [1, 0, 1 / 8], [2, 0, 1 / 8],
  [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
  [0, 2, 1 / 8],
]

function cellStartsWhole(n: number, cell: number): Int32Array {
  const count = Math.floor((n - 1) / cell) + 1
  const starts = new Int32Array(count + 1)
  let k = 0
  for (let x = 0; x < n; x++) {
    const c = Math.floor(x / cell)
    if (c >= k) starts[k++] = x
  }
  starts[count] = n
  return starts
}

function ditherAtWhole<T extends Float32Array | Uint8ClampedArray>(tone: Float32Array, w: number, h: number, out: T, unit: number): T {
  const buf = Float32Array.from(tone)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = buf[i]
      const next = old >= 0.5 ? 1 : 0
      out[i] = next * unit
      const err = old - next
      if (err === 0) continue
      for (const [kx, ky, weight] of ATKINSON) {
        const nx = x + kx
        const ny = y + ky
        if (nx < 0 || nx >= w || ny >= h) continue
        buf[ny * w + nx] += err * weight
      }
    }
  }
  return out
}

/** Atkinson grain over the whole field at once: reduce to cells, diffuse,
 *  expand (dither.ts `ditherField` before `GrainStream`). */
export function ditherWhole<T extends Float32Array | Uint8ClampedArray>(tone: Float32Array, w: number, h: number, scale: number, out: T): T {
  const cell = Math.max(1, scale)
  const unit = out instanceof Uint8ClampedArray ? 255 : 1
  if (cell === 1) return ditherAtWhole(tone, w, h, out, unit)
  const cols = cellStartsWhole(w, cell)
  const rows = cellStartsWhole(h, cell)
  const sw = cols.length - 1
  const sh = rows.length - 1
  const small = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0
      let n = 0
      for (let sy = rows[y]; sy < rows[y + 1]; sy++) {
        for (let sx = cols[x]; sx < cols[x + 1]; sx++) {
          sum += tone[sy * w + sx]
          n++
        }
      }
      small[y * sw + x] = n > 0 ? sum / n : 0
    }
  }
  const dithered = ditherAtWhole(small, sw, sh, new Float32Array(sw * sh), 1)
  for (let y = 0; y < sh; y++) {
    for (let sy = rows[y]; sy < rows[y + 1]; sy++) {
      for (let x = 0; x < sw; x++) {
        const v = dithered[y * sw + x] * unit
        for (let sx = cols[x]; sx < cols[x + 1]; sx++) out[sy * w + sx] = v
      }
    }
  }
  return out
}

/** The ground's luminance at every pixel, blurred at full resolution (the
 *  press's `groundLuma` before the grid): transparent ground is bare paper,
 *  the lightest thing there is. */
export function groundLuma(rgba: Uint8ClampedArray, w: number, h: number, blurRadius: number): Float32Array {
  const n = w * h
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255
    lum[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) * a + (1 - a)
  }
  if (blurRadius > 0) blurInPlace(lum, w, h, blurRadius, new Float32Array(n), needsSpare(blurRadius) ? new Float32Array(n) : undefined)
  return lum
}

/** The ground's luminance grid from the whole ground at once (media.ts
 *  `groundLumaGrid` before `LumaAccumulator`). */
export function lumaGridWhole(rgba: Uint8ClampedArray, w: number, h: number, blurRadius: number): LumaGrid {
  const cell = lumaCell(blurRadius)
  if (cell === 1) return { grid: groundLuma(rgba, w, h, blurRadius), gw: w, gh: h, cell, w, h }
  const gw = Math.ceil(w / cell)
  const gh = Math.ceil(h / cell)
  const sum = new Float64Array(gw * gh)
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / cell) * gw
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const a = rgba[o + 3] / 255
      sum[row + Math.floor(x / cell)] += luma(rgba[o], rgba[o + 1], rgba[o + 2]) * a + (1 - a)
    }
  }
  const grid = new Float32Array(gw * gh)
  for (let j = 0; j < gh; j++) {
    const rows = Math.min(h, (j + 1) * cell) - j * cell
    for (let i = 0; i < gw; i++) {
      const cols = Math.min(w, (i + 1) * cell) - i * cell
      grid[j * gw + i] = sum[j * gw + i] / (rows * cols)
    }
  }
  const r = blurRadius / cell
  blurInPlace(grid, gw, gh, r, new Float32Array(gw * gh), needsSpare(r) ? new Float32Array(gw * gh) : undefined)
  return { grid, gw, gh, cell, w, h }
}
