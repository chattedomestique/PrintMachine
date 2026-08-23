/**
 * Seeded randomness. Everything stochastic in the engine — ink mottle, paper
 * fibre, misregistration jitter — draws from here with an explicit seed.
 *
 * Determinism is not a nicety. If the noise re-rolls on every render, dragging
 * an unrelated slider visibly re-randomises the grain, which reads as a bug
 * (playbook §5.7). A seed also makes the engine testable and makes the export
 * match the preview exactly.
 */

/** mulberry32 — small, fast, good enough distribution for texture. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash a string to a 32-bit seed, so a text string can drive its own texture. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t)

/**
 * Value noise on a lattice of `cell` pixels, bilinearly interpolated with a
 * smoothstep fade. Returns w*h values in [0,1].
 *
 * Cheaper than gradient noise and indistinguishable once it is being used as
 * a low-frequency density modulation, which is all we need it for.
 */
export function valueNoise2D(
  w: number,
  h: number,
  cell: number,
  seed: number,
): Float32Array {
  const gw = Math.max(2, Math.ceil(w / cell) + 2)
  const gh = Math.max(2, Math.ceil(h / cell) + 2)
  const rand = mulberry32(seed)

  const lattice = new Float32Array(gw * gh)
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand()

  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const gy = y / cell
    const y0 = Math.floor(gy)
    const fy = smoothstep(gy - y0)
    const row0 = y0 * gw
    const row1 = (y0 + 1) * gw

    for (let x = 0; x < w; x++) {
      const gx = x / cell
      const x0 = Math.floor(gx)
      const fx = smoothstep(gx - x0)

      const a = lattice[row0 + x0]
      const b = lattice[row0 + x0 + 1]
      const c = lattice[row1 + x0]
      const d = lattice[row1 + x0 + 1]

      const top = a + (b - a) * fx
      const bottom = c + (d - c) * fx
      out[y * w + x] = top + (bottom - top) * fy
    }
  }
  return out
}

/**
 * Fractal sum of value noise. `octaves` doublings of frequency at halving
 * amplitude, normalised back to [0,1]. Used for paper fibre, where a single
 * frequency looks obviously synthetic.
 */
export function fbm2D(
  w: number,
  h: number,
  cell: number,
  octaves: number,
  seed: number,
): Float32Array {
  const out = new Float32Array(w * h)
  let amp = 1
  let total = 0
  let c = cell

  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise2D(w, h, Math.max(1, c), seed + o * 8191)
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp
    total += amp
    amp *= 0.5
    c *= 0.5
  }

  if (total > 0) for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

/** White noise in [0,1], one value per pixel. Used for speckle dropout. */
export function whiteNoise2D(w: number, h: number, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = rand()
  return out
}
