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
   * Size of one grain cell in output pixels.
   *
   * At 1 the pattern is one pixel per cell, which at export resolution is far
   * too fine to see and reads as flat tone; the chunky duplicator look is a
   * grain several pixels across. Implemented by dithering a reduced grid and
   * expanding the result.
   */
  scale?: number
}

/**
 * Grain a tone field into a coverage field.
 *
 * @returns a new w*h field of 0s and 1s.
 */
export function ditherField(
  tone: Float32Array,
  w: number,
  h: number,
  opts: DitherOptions = {},
): Float32Array {
  const scale = Math.max(1, Math.round(opts.scale ?? 1))

  if (scale === 1) return ditherAt(tone, w, h)

  // Reduce, dither, expand. Averaging on the way down matters: sampling one
  // pixel per cell would dither the noise rather than the tone, and the result
  // is speckle that does not track the artwork underneath it.
  const sw = Math.max(1, Math.ceil(w / scale))
  const sh = Math.max(1, Math.ceil(h / scale))
  const small = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0
      let n = 0
      for (let dy = 0; dy < scale; dy++) {
        const sy = y * scale + dy
        if (sy >= h) break
        for (let dx = 0; dx < scale; dx++) {
          const sx = x * scale + dx
          if (sx >= w) break
          sum += tone[sy * w + sx]
          n++
        }
      }
      small[y * sw + x] = n > 0 ? sum / n : 0
    }
  }

  const dithered = ditherAt(small, sw, sh)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, (y / scale) | 0)
    for (let x = 0; x < w; x++) {
      out[y * w + x] = dithered[sy * sw + Math.min(sw - 1, (x / scale) | 0)]
    }
  }
  return out
}

function ditherAt(tone: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  // Work on a scratch copy so the input field is not mutated — the caller may
  // still need it (and shared engine inputs must stay pure).
  const buf = Float32Array.from(tone)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = buf[i]
      const next = old >= THRESHOLD ? 1 : 0
      out[i] = next
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
