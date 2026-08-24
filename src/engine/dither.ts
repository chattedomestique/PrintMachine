/**
 * Dithering — the alternative to a halftone screen.
 *
 * Where a screen clusters ink into regular dots, dithering scatters it. Riso
 * output from a photocopier-style RIP often uses error diffusion instead of a
 * classic screen, and Atkinson in particular has the blown-highlight, crunchy
 * look people associate with early Mac graphics and cheap duplicators.
 *
 * Every kernel here is the standard published one. The point of carrying a
 * dozen rather than two is that they are genuinely different textures, not
 * variations on a slider: Jarvis is smooth and slow, Burkes is fast and
 * contrasty, Sierra-Lite is coarse and cheap, clustered-dot is the one that
 * still looks like a *printing* screen rather than a computer effect.
 *
 * Error-diffusion algorithms ported in spirit from p5.riso's `ditherImage()`
 * (Lavigne & Brain).
 */

export type DitherType =
  | 'none'
  | 'threshold'
  | 'bayer2'
  | 'bayer4'
  | 'bayer8'
  | 'clustered'
  | 'atkinson'
  | 'floydsteinberg'
  | 'jarvis'
  | 'stucki'
  | 'burkes'
  | 'sierra'
  | 'sierralite'

export const DITHER_TYPES: readonly { id: DitherType; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'threshold', name: 'Hard' },
  { id: 'bayer2', name: 'Bayer 2' },
  { id: 'bayer4', name: 'Bayer 4' },
  { id: 'bayer8', name: 'Bayer 8' },
  { id: 'clustered', name: 'Clustered' },
  { id: 'atkinson', name: 'Atkinson' },
  { id: 'floydsteinberg', name: 'Floyd' },
  { id: 'jarvis', name: 'Jarvis' },
  { id: 'stucki', name: 'Stucki' },
  { id: 'burkes', name: 'Burkes' },
  { id: 'sierra', name: 'Sierra' },
  { id: 'sierralite', name: 'Sierra Lite' },
]

/**
 * Bayer matrix of side `n`, normalised to [0,1).
 *
 * Built by the canonical doubling rule, which is easier to verify than a
 * bit-twiddling closed form:
 *
 *   M(1)  = [0]
 *   M(2n) = [ 4·M(n)+0   4·M(n)+2 ]
 *           [ 4·M(n)+3   4·M(n)+1 ]
 */
function bayer(n: number): Float32Array {
  let m = [[0]]
  while (m.length < n) {
    const k = m.length
    const next: number[][] = Array.from({ length: k * 2 }, () => new Array<number>(k * 2))
    for (let y = 0; y < k; y++) {
      for (let x = 0; x < k; x++) {
        const v = 4 * m[y][x]
        next[y][x] = v
        next[y][x + k] = v + 2
        next[y + k][x] = v + 3
        next[y + k][x + k] = v + 1
      }
    }
    m = next
  }
  const flat = new Float32Array(n * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) flat[y * n + x] = m[y][x] / (n * n)
  return flat
}

const BAYER = { 2: bayer(2), 4: bayer(4), 8: bayer(8) } as const

/**
 * Classic 6x6 clustered-dot (45°) ordered matrix.
 *
 * The one ordered pattern that still reads as *printed* rather than as a
 * computer effect, because it grows a single blob per cell the way a real
 * screen does instead of scattering isolated pixels.
 */
const CLUSTERED = (() => {
  const order = [
    [34, 29, 17, 21, 30, 35],
    [28, 14, 9, 16, 20, 31],
    [13, 8, 4, 5, 15, 19],
    [12, 3, 0, 1, 10, 18],
    [27, 7, 2, 6, 23, 24],
    [33, 26, 11, 22, 25, 32],
  ]
  const flat = new Float32Array(36)
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) flat[y * 6 + x] = order[y][x] / 36
  return flat
})()

type Kernel = readonly (readonly [number, number, number])[]

/** Error-diffusion kernels as [dx, dy, weight]. */
const KERNELS: Record<string, Kernel> = {
  // Atkinson diffuses only 6/8 of the error, which is why it blows out
  // highlights and crushes shadows — that clipping is the look.
  atkinson: [
    [1, 0, 1 / 8], [2, 0, 1 / 8],
    [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ],
  floydsteinberg: [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
  ],
  jarvis: [
    [1, 0, 7 / 48], [2, 0, 5 / 48],
    [-2, 1, 3 / 48], [-1, 1, 5 / 48], [0, 1, 7 / 48], [1, 1, 5 / 48], [2, 1, 3 / 48],
    [-2, 2, 1 / 48], [-1, 2, 3 / 48], [0, 2, 5 / 48], [1, 2, 3 / 48], [2, 2, 1 / 48],
  ],
  stucki: [
    [1, 0, 8 / 42], [2, 0, 4 / 42],
    [-2, 1, 2 / 42], [-1, 1, 4 / 42], [0, 1, 8 / 42], [1, 1, 4 / 42], [2, 1, 2 / 42],
    [-2, 2, 1 / 42], [-1, 2, 2 / 42], [0, 2, 4 / 42], [1, 2, 2 / 42], [2, 2, 1 / 42],
  ],
  burkes: [
    [1, 0, 8 / 32], [2, 0, 4 / 32],
    [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 8 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
  ],
  sierra: [
    [1, 0, 5 / 32], [2, 0, 3 / 32],
    [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 5 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
    [-1, 2, 2 / 32], [0, 2, 3 / 32], [1, 2, 2 / 32],
  ],
  sierralite: [
    [1, 0, 2 / 4],
    [-1, 1, 1 / 4], [0, 1, 1 / 4],
  ],
}

const ORDERED: Record<string, { m: Float32Array; n: number }> = {
  bayer2: { m: BAYER[2], n: 2 },
  bayer4: { m: BAYER[4], n: 4 },
  bayer8: { m: BAYER[8], n: 8 },
  clustered: { m: CLUSTERED, n: 6 },
}

export interface DitherOptions {
  /** Cut point in [0,1]; 0.5 is neutral, lower prints more ink. */
  threshold?: number
  /**
   * Size of one dither cell in output pixels.
   *
   * At 1 the pattern is one pixel per cell, which at export resolution is far
   * too fine to see and reads as flat tone. Coarsening it is the whole
   * character of the technique — the chunky duplicator look is a dither whose
   * cells are several pixels across. Implemented by dithering a reduced grid
   * and expanding the result, so every algorithm coarsens the same way rather
   * than each needing its own notion of size.
   */
  scale?: number
}

/**
 * Dither a tone field into a coverage field.
 *
 * @returns a new w*h field of 0s and 1s (except `none`, which passes the tone
 *          through unchanged).
 */
export function ditherField(
  tone: Float32Array,
  w: number,
  h: number,
  type: DitherType,
  opts: DitherOptions = {},
): Float32Array {
  if (type === 'none') return tone.slice()

  const threshold = opts.threshold ?? 0.5
  const scale = Math.max(1, Math.round(opts.scale ?? 1))

  if (scale === 1) return ditherAt(tone, w, h, type, threshold)

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

  const dithered = ditherAt(small, sw, sh, type, threshold)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, (y / scale) | 0)
    for (let x = 0; x < w; x++) {
      out[y * w + x] = dithered[sy * sw + Math.min(sw - 1, (x / scale) | 0)]
    }
  }
  return out
}

function ditherAt(
  tone: Float32Array,
  w: number,
  h: number,
  type: DitherType,
  threshold: number,
): Float32Array {
  const out = new Float32Array(w * h)

  if (type === 'threshold') {
    for (let i = 0; i < out.length; i++) out[i] = tone[i] >= threshold ? 1 : 0
    return out
  }

  const ordered = ORDERED[type]
  if (ordered) {
    const { m, n } = ordered
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        // Centre the matrix on the threshold so it stays symmetric.
        const bias = m[(y % n) * n + (x % n)] - 0.5
        out[i] = tone[i] >= threshold + bias ? 1 : 0
      }
    }
    return out
  }

  // Error diffusion. Work on a scratch copy so the input field is not mutated —
  // the caller may still need it (and shared engine inputs must stay pure).
  const buf = Float32Array.from(tone)
  const kernel = KERNELS[type] ?? KERNELS.floydsteinberg

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
