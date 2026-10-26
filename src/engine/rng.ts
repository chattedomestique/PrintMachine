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

/**
 * mulberry32's n-th value (n from 1) for a seed, without drawing the ones
 * before it: its state is a counter, `seed + n x 0x6d2b79f5` (mod 2^32), so any
 * draw can be read directly. Exactly what the n-th call of `mulberry32(seed)`
 * returns.
 */
export function mulberryAt(seed: number, n: number): number {
  let t = ((seed >>> 0) + Math.imul(n, 0x6d2b79f5)) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
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
 *
 * @param minCell the finest cell an octave may have. A pixel by default: a
 *   cell finer than the raster cannot be drawn, only aliased. A field that
 *   has to be the same picture at every render height passes the height's
 *   own scale here (at least a pixel), so its finest octave grows with the
 *   sheet instead of stopping at one pixel while the rest of it grows.
 */
export function fbm2D(
  w: number,
  h: number,
  cell: number,
  octaves: number,
  seed: number,
  minCell = 1,
): Float32Array {
  const out = new Float32Array(w * h)
  let amp = 1
  let total = 0
  let c = cell

  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise2D(w, h, Math.max(minCell, c), seed + o * 8191)
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp
    total += amp
    amp *= 0.5
    c *= 0.5
  }

  if (total > 0) for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

/**
 * A uniform value in [0, 1) for the integer point (i, j), from a seed: a
 * coordinate hash rather than a stream, so any point can be read in any order
 * and nothing has to be stored. (A stream such as mulberry32 numbers its values
 * by how many came before, which ties a value to the pixel COUNT: a sheet twice
 * as tall reads a different value at the same place.)
 *
 * Two rounds of murmur3's finaliser, one per axis, so neighbouring points are
 * unrelated in both directions.
 */
export function hash2D(i: number, j: number, seed: number): number {
  let h = fmix32(Math.imul(j | 0, 0x85ebca77) ^ (seed | 0))
  h = fmix32(Math.imul(i | 0, 0x9e3779b1) ^ h)
  return (h >>> 0) / 4294967296
}

function fmix32(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h
}

/**
 * White noise on square cells of `cell` pixels: one value per cell, the same
 * value across it. Read a pixel at a time (`cellNoiseAt`), so it costs no
 * memory and only the pixels that ask for it are computed.
 *
 * The cell is how a white field stays the same picture at every size: one
 * pixel at the reference height, two at twice it. A field of one value per
 * PIXEL is a different, finer noise on every size of sheet.
 */
export interface CellNoise {
  /** Cell size in pixels, at least 1 (a pixel is the finest a raster holds). */
  cell: number
  seed: number
}

/** The value of `noise` at pixel (x, y), in [0, 1). */
export function cellNoiseAt(noise: CellNoise, x: number, y: number): number {
  return hash2D(Math.floor(x / noise.cell), Math.floor(y / noise.cell), noise.seed)
}

/**
 * `valueNoise2D`, read a point at a time: the value the field would hold at
 * (x, y), to the last bit, without the field. Its lattice is mulberry32 drawn
 * in order, so lattice point i is the (i + 1)-th draw, read with `mulberryAt`;
 * the four corners of the last cell read are kept, so walking a row costs a
 * pair of draws per cell rather than four per pixel.
 *
 * This is how an export holds no noise fields at all (an 11 MP field is 45 MB):
 * it reads each where it is needed, and only there. The preview keeps the
 * arrays, built once and reused every frame; a test holds the two equal.
 */
export class ValueNoiseSampler {
  private readonly gw: number
  private readonly seed: number
  private x0 = -1
  private y0 = -1
  private a = 0
  private b = 0
  private c = 0
  private d = 0

  constructor(
    w: number,
    private readonly cell: number,
    seed: number,
  ) {
    this.gw = Math.max(2, Math.ceil(w / cell) + 2)
    this.seed = seed >>> 0
  }

  /** The field's value at pixel (x, y), as the array stores it (float32). */
  at(x: number, y: number): number {
    const gy = y / this.cell
    const y0 = Math.floor(gy)
    const fy = smoothstep(gy - y0)
    const gx = x / this.cell
    const x0 = Math.floor(gx)
    const fx = smoothstep(gx - x0)
    if (x0 !== this.x0 || y0 !== this.y0) {
      const r0 = y0 * this.gw + x0 + 1
      const r1 = r0 + this.gw
      this.a = Math.fround(mulberryAt(this.seed, r0))
      this.b = Math.fround(mulberryAt(this.seed, r0 + 1))
      this.c = Math.fround(mulberryAt(this.seed, r1))
      this.d = Math.fround(mulberryAt(this.seed, r1 + 1))
      this.x0 = x0
      this.y0 = y0
    }
    const top = this.a + (this.b - this.a) * fx
    const bottom = this.c + (this.d - this.c) * fx
    return Math.fround(top + (bottom - top) * fy)
  }
}

/** `fbm2D`, read a point at a time, to the last bit (see ValueNoiseSampler). */
export class FbmSampler {
  private readonly layers: ValueNoiseSampler[] = []
  private readonly amps: number[] = []
  private readonly total: number

  constructor(w: number, cell: number, octaves: number, seed: number, minCell = 1) {
    let amp = 1
    let total = 0
    let c = cell
    for (let o = 0; o < octaves; o++) {
      this.layers.push(new ValueNoiseSampler(w, Math.max(minCell, c), seed + o * 8191))
      this.amps.push(amp)
      total += amp
      amp *= 0.5
      c *= 0.5
    }
    this.total = total
  }

  /** The field's value at pixel (x, y), as fbm2D's array stores it. */
  at(x: number, y: number): number {
    // The array accumulates in float32, octave by octave: so does this.
    let v = 0
    for (let o = 0; o < this.layers.length; o++) v = Math.fround(v + this.layers[o].at(x, y) * this.amps[o])
    return this.total > 0 ? Math.fround(v / this.total) : v
  }
}
