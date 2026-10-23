/**
 * Grain — the press's second screen, beside the halftone.
 *
 * Where a screen clusters ink into regular dots, error diffusion scatters it.
 * Riso drivers screen with one or the other, so one diffusion earns its place
 * as the second choice: Atkinson, which diffuses only 6/8 of the error and so
 * blows out highlights and crushes shadows — the crunchy duplicator look. The
 * threshold is fixed at the neutral 0.5.
 *
 * Ported in spirit from p5.riso's `ditherImage()` (Lavigne & Brain).
 */

/** Atkinson's kernel as [dx, dy, weight]: six neighbours, an eighth each. */
const ATKINSON: readonly (readonly [number, number, number])[] = [
  [1, 0, 1 / 8], [2, 0, 1 / 8],
  [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
  [0, 2, 1 / 8],
]

/** The cut point: 0.5 is neutral. */
const THRESHOLD = 0.5

export interface DitherOptions {
  /**
   * Size of one grain cell in output pixels, fraction and all.
   *
   * At 1 the pattern is one pixel per cell, which at export resolution is far
   * too fine to see and reads as flat tone; the chunky duplicator look is a
   * grain several pixels across. Implemented by dithering a reduced grid and
   * expanding the result.
   *
   * Not rounded. The cell rides the render height (a third of the screen size
   * times height / reference), and a cell rounded to whole pixels is a
   * different grain on every sheet: 1.68 px rounds to 2 (+19%). A fractional
   * cell maps pixel x to grid column floor(x / cell), so some cells are a
   * pixel wider than others and the grain's average size is exact. A whole
   * number gives exactly the grid it always did.
   */
  scale?: number
}

/**
 * Grain a tone field into a coverage field.
 *
 * @param out where to write: a new float field of 0s and 1s by default, or a
 *            byte field of 0s and 255s.
 * @returns the w*h field.
 */
export function ditherField<T extends Float32Array | Uint8ClampedArray = Float32Array>(
  tone: Float32Array,
  w: number,
  h: number,
  opts: DitherOptions = {},
  out: T = new Float32Array(w * h) as T,
): T {
  const cell = Math.max(1, opts.scale ?? 1)
  const unit = out instanceof Uint8ClampedArray ? 255 : 1

  if (cell === 1) return ditherAt(tone, w, h, out, unit)

  // Reduce, dither, expand. Averaging on the way down matters: sampling one
  // pixel per cell would dither the noise rather than the tone, and the result
  // is speckle that does not track the artwork underneath it. The reduction
  // and the expansion use one mapping (floor(x / cell)), so each pixel is
  // averaged into exactly the cell it is later painted from.
  const cols = cellStarts(w, cell)
  const rows = cellStarts(h, cell)
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

  const dithered = ditherAt(small, sw, sh, new Float32Array(sw * sh), 1)
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

/**
 * Where each grid cell starts along an axis of `n` pixels: cell k holds the
 * pixels with floor(x / cell) === k. One past the last cell is `n`, so cell k
 * runs from starts[k] up to (not including) starts[k + 1]. Every cell holds at
 * least one pixel, since cell >= 1.
 */
function cellStarts(n: number, cell: number): Int32Array {
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

function ditherAt<T extends Float32Array | Uint8ClampedArray>(tone: Float32Array, w: number, h: number, out: T, unit: number): T {
  // Work on a scratch copy so the input field is not mutated — the caller may
  // still need it (and shared engine inputs must stay pure).
  const buf = Float32Array.from(tone)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = buf[i]
      const next = old >= THRESHOLD ? 1 : 0
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
