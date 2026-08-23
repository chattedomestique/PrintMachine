/**
 * Paper.
 *
 * The stock is not white and it is not smooth. Riso is usually pulled on
 * uncoated text weight, which has visible fibre, a slight cloudiness, and a
 * tooth that breaks up solid ink. Rendering onto flat #FFFFFF is the fastest
 * way to make a good screen look like a screenshot of a screen.
 */

import { fbm2D, valueNoise2D } from './rng.ts'

export interface PaperOptions {
  /** Base stock colour, straight from PAPERS in inks.ts. */
  rgb: readonly [number, number, number]
  /** Fibre/tooth strength in [0,1]. ~0.35 is a normal uncoated sheet. */
  texture: number
  /** Large-scale cloudiness in [0,1] — how unevenly the sheet was made. */
  blotch: number
  seed: number
}

export interface PaperField {
  /** Per-pixel luminance multiplier around 1.0. */
  shade: Float32Array
  rgb: readonly [number, number, number]
}

/**
 * Build the paper's per-pixel shading field.
 *
 * Two scales, because one looks synthetic: a fine multi-octave fibre grain and
 * a very low-frequency cloud. Both are multiplicative and centred on 1, so a
 * texture of 0 returns exactly 1.0 everywhere and the paper is perfectly flat.
 */
export function paperField(w: number, h: number, opts: PaperOptions): PaperField {
  const shade = new Float32Array(w * h).fill(1)

  if (opts.texture > 0) {
    // Fibre: fine, high-frequency, a few octaves so it isn't a single grain size.
    const fibre = fbm2D(w, h, 3, 3, opts.seed)
    const amt = opts.texture * 0.13
    for (let i = 0; i < shade.length; i++) shade[i] *= 1 + amt * (fibre[i] * 2 - 1)
  }

  if (opts.blotch > 0) {
    // Cloud: one big soft field, cell sized to the sheet so it never tiles.
    const cloud = valueNoise2D(w, h, Math.max(24, Math.min(w, h) / 5), opts.seed ^ 0x5bf03635)
    const amt = opts.blotch * 0.06
    for (let i = 0; i < shade.length; i++) shade[i] *= 1 + amt * (cloud[i] * 2 - 1)
  }

  return { shade, rgb: opts.rgb }
}

/**
 * Faint horizontal banding from the feed rollers, applied to a coverage field.
 *
 * Very subtle by design — at more than a few percent it stops reading as a
 * print artefact and starts reading as a broken gradient.
 */
export function applyRollerBanding(
  coverage: Float32Array,
  w: number,
  h: number,
  amount: number,
  seed: number,
): Float32Array {
  if (amount <= 0) return coverage
  const out = new Float32Array(coverage.length)
  // One noise value per scanline, smoothed — banding runs across the sheet in
  // the feed direction, so it varies in y and is constant in x.
  const band = valueNoise2D(1, h, Math.max(8, h / 40), seed)
  for (let y = 0; y < h; y++) {
    const m = 1 + amount * 0.18 * (band[y] * 2 - 1)
    const row = y * w
    for (let x = 0; x < w; x++) {
      const v = coverage[row + x] * m
      out[row + x] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return out
}
