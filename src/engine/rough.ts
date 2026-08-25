/**
 * Edge authenticity — the difference between "vector type tinted pink" and
 * "type that came off a drum".
 *
 * A Riso master is a thermal stencil: the machine burns a bitmap through a
 * plastic film, then forces ink through the holes onto uncoated paper. Nothing
 * in that chain produces a clean curve. The burn is a coarse raster, the film
 * tears slightly at the edges, and the ink wicks into paper fibre once it
 * lands. The outline you get is ragged at a scale of a couple of pixels, and
 * it sits slightly outside where the artwork said it should.
 *
 * The technique here is deliberately not "add noise to the edge" — that just
 * makes a fuzzy edge. Instead: soften the glyph into a wide gradient, then cut
 * it back to hard with a threshold that itself wanders. Where the threshold
 * noise runs high the edge bites inward; where it runs low the ink bulges out.
 * The result is a hard edge in the wrong place by a varying amount, which is
 * exactly what a burned stencil gives you.
 */

import { blurField } from './blur.ts'
import { fbm2D } from './rng.ts'

export interface RoughOptions {
  /** How far the edge is allowed to wander, 0..1. 0 is a clean vector edge. */
  roughness: number
  /** Feature size of the raggedness, in pixels at the current render scale. */
  scale: number
  /** Ink spread past the artwork edge, 0..1. Fattens every shape. */
  bleed: number
  seed: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Roughen and bleed a tone field.
 *
 * Runs on the *tone*, before screening, so the screen bites on the ragged
 * outline rather than a clean one — ordering matters here as much as anywhere
 * else in the pipeline.
 */
export function roughenEdges(
  tone: Float32Array,
  w: number,
  h: number,
  opts: RoughOptions,
): Float32Array {
  const { roughness, bleed, seed } = opts
  if (roughness <= 0 && bleed <= 0) return tone

  // The blur radius sets how far the edge can travel. Tie it to the requested
  // feature scale so raggedness and its wavelength stay proportional — a wide
  // wander at a fine scale reads as fuzz, not as a torn stencil.
  //
  // Taken as given, fraction and all. Rounding it up to a whole pixel is what
  // made the preview and the saved file different pictures: the tear stayed one
  // pixel wide at every render height, so on the smaller raster it was half
  // again as large against type half again as thin, and cut clean through
  // letterforms the print kept whole.
  const radius = Math.max(0, opts.scale)

  const soft = blurField(tone, w, h, radius)

  // Two octaves is enough: a coarse wander plus a fine nibble. More just
  // averages back toward a smooth edge. Unfloored for the same reason as the
  // radius — a wavelength pinned to a pixel is a different wavelength on every
  // size of sheet.
  const wander = roughness > 0 ? fbm2D(w, h, opts.scale * 1.6, 2, seed ^ 0x1b873593) : null

  // Cutting at 0.5 reproduces the original outline. Lowering it keeps more of
  // the blurred skirt, which is precisely ink spread.
  const base = 0.5 - bleed * 0.22
  // A narrow ramp either side of the cut keeps the edge hard but not aliased.
  const e = 0.06

  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const s = soft[i]
    // Interior and bare paper are already settled — leave them alone so the
    // roughening cannot punch holes in the middle of a solid.
    if (s <= 0) continue
    if (s >= 1) {
      out[i] = 1
      continue
    }

    const cut = wander ? base + (wander[i] - 0.5) * roughness * 0.55 : base
    const t = (s - (cut - e)) / (2 * e)
    out[i] = clamp01(t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
  }

  return out
}
