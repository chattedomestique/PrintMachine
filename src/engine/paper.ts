/**
 * Paper.
 *
 * The stock is not white and it is not smooth. Riso is usually pulled on
 * uncoated text weight, which has visible fibre, a slight cloudiness, and a
 * tooth that breaks up solid ink. Rendering onto flat #FFFFFF is the fastest
 * way to make a good screen look like a screenshot of a screen.
 */

import { FbmSampler, ValueNoiseSampler, fbm2D, valueNoise2D } from './rng.ts'

export interface PaperOptions {
  /** Base stock colour, straight from PAPERS in inks.ts. */
  rgb: readonly [number, number, number]
  /** Fibre/tooth strength in [0,1]. ~0.35 is a normal uncoated sheet. */
  texture: number
  /** Large-scale cloudiness in [0,1] — how unevenly the sheet was made. */
  blotch: number
  seed: number
  /**
   * The render height over the reference height. The fibre is a print's
   * texture, so its grain is sized to the sheet: 3 px at the reference height,
   * 6 px at twice it. Omitted, 1.
   */
  scale?: number
}

export interface PaperField {
  /** Per-pixel luminance multiplier around 1.0. */
  shade: Float32Array
  rgb: readonly [number, number, number]
}

/** The paper's shade, held as a field (the preview's cache) or read where it
 *  is printed (an export: `PaperSampler`). The same numbers either way. */
export type PaperSource = PaperField | PaperSampler

/** The fibre's grain at the reference height, in pixels. */
const FIBRE_CELL = 3

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
    // Sized to the sheet, finest octave included: a grain held at 3 px (and
    // its finest octave at one pixel) on every sheet is a finer, different
    // texture on a larger export, which is a different print. Never finer than
    // a pixel, which is all a smaller render (the preview) can show of it.
    const scale = opts.scale ?? 1
    const fibre = fbm2D(w, h, FIBRE_CELL * scale, 3, opts.seed, Math.max(1, scale))
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
 * The same paper as `paperField`, read a row at a time: what an export prints
 * from, so it never holds a sheet-sized shade field. Identical to the field
 * to the last bit (the noise is read with rng's samplers, and the shade is
 * multiplied up in float32 exactly as the field is); a test holds them equal.
 */
export class PaperSampler {
  readonly rgb: readonly [number, number, number]
  private readonly fibre: FbmSampler | null
  private readonly cloud: ValueNoiseSampler | null
  private readonly fibreAmt: number
  private readonly cloudAmt: number

  constructor(
    private readonly w: number,
    h: number,
    opts: PaperOptions,
  ) {
    this.rgb = opts.rgb
    const scale = opts.scale ?? 1
    this.fibre = opts.texture > 0 ? new FbmSampler(w, FIBRE_CELL * scale, 3, opts.seed, Math.max(1, scale)) : null
    this.cloud = opts.blotch > 0 ? new ValueNoiseSampler(w, Math.max(24, Math.min(w, h) / 5), opts.seed ^ 0x5bf03635) : null
    this.fibreAmt = opts.texture * 0.13
    this.cloudAmt = opts.blotch * 0.06
  }

  /** Rows [y0, y1) of the shade into `out`, row y at out[(y - y0) * w]. */
  rows(y0: number, y1: number, out: Float32Array): void {
    const { w, fibre, cloud, fibreAmt, cloudAmt } = this
    let k = 0
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        let v = 1
        if (fibre) v = Math.fround(v * (1 + fibreAmt * (fibre.at(x, y) * 2 - 1)))
        if (cloud) v = Math.fround(v * (1 + cloudAmt * (cloud.at(x, y) * 2 - 1)))
        out[k++] = v
      }
    }
  }
}
