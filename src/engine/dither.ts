/**
 * Dithering — the alternative to a halftone screen.
 *
 * Where a screen clusters ink into regular dots, dithering scatters it. Riso
 * output from a photocopier-style RIP often uses error diffusion instead of a
 * classic screen, and Atkinson in particular has the blown-highlight, crunchy
 * look people associate with early Mac graphics and cheap duplicators.
 *
 * Algorithms ported from p5.riso's `ditherImage()` (Lavigne & Brain); the
 * kernels themselves are the standard published ones.
 */

export type DitherType = 'none' | 'atkinson' | 'floydsteinberg' | 'bayer' | 'threshold'

/**
 * 8x8 recursive (Bayer) matrix, normalised to [0,1).
 *
 * Built by the canonical doubling rule, which is easier to verify than a
 * bit-twiddling closed form:
 *
 *   M(1)  = [0]
 *   M(2n) = [ 4·M(n)+0   4·M(n)+2 ]
 *           [ 4·M(n)+3   4·M(n)+1 ]
 */
const BAYER_8 = (() => {
  let m = [[0]]
  while (m.length < 8) {
    const n = m.length
    const next: number[][] = Array.from({ length: n * 2 }, () => new Array<number>(n * 2))
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 4 * m[y][x]
        next[y][x] = v
        next[y][x + n] = v + 2
        next[y + n][x] = v + 3
        next[y + n][x + n] = v + 1
      }
    }
    m = next
  }
  const flat = new Float32Array(64)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) flat[y * 8 + x] = m[y][x] / 64
  return flat
})()

/** Error-diffusion kernels as [dx, dy, weight]; weights sum to 1. */
const KERNELS: Record<'atkinson' | 'floydsteinberg', readonly (readonly [number, number, number])[]> = {
  // Atkinson diffuses only 6/8 of the error, which is why it blows out
  // highlights and crushes shadows — that clipping is the look.
  atkinson: [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ],
  floydsteinberg: [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16],
  ],
}

/**
 * Dither a tone field into a coverage field.
 *
 * @param tone      w*h values in [0,1].
 * @param threshold cut point in [0,1]; 0.5 is neutral, lower prints more ink.
 * @returns         a new w*h field of 0s and 1s (except `none`, which passes
 *                  the tone through unchanged).
 */
export function ditherField(
  tone: Float32Array,
  w: number,
  h: number,
  type: DitherType,
  threshold = 0.5,
): Float32Array {
  if (type === 'none') return tone.slice()

  const out = new Float32Array(w * h)

  if (type === 'threshold') {
    for (let i = 0; i < out.length; i++) out[i] = tone[i] >= threshold ? 1 : 0
    return out
  }

  if (type === 'bayer') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        // Centre the matrix on the threshold so it stays symmetric.
        const bias = BAYER_8[(y & 7) * 8 + (x & 7)] - 0.5
        out[i] = tone[i] >= threshold + bias ? 1 : 0
      }
    }
    return out
  }

  // Error diffusion. Work on a scratch copy so the input field is not mutated —
  // the caller may still need it (and shared engine inputs must stay pure).
  const buf = Float32Array.from(tone)
  const kernel = KERNELS[type]

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = buf[i]
      const next = old >= threshold ? 1 : 0
      out[i] = next
      const err = old - next
      if (err === 0) continue

      for (const [kx, ky, weight] of kernel) {
        const nx = x + kx
        const ny = y + ky
        if (nx < 0 || nx >= w || ny >= h) continue
        buf[ny * w + nx] += err * weight
      }
    }
  }

  return out
}
