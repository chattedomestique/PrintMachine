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

import { blurInPlace } from './blur.ts'
import { FbmSampler } from './rng.ts'

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
 * The threshold's wander: two octaves of value noise, the coarse one 1.6 times
 * the tear's feature size, so it grows with the type and the sheet. On the
 * smallest type at the reference height the fine octave is under a pixel and
 * stops at one; the floor is left at a pixel on larger sheets too, because
 * sizing it to the sheet measured as a wash (the scale tests, and the
 * harness's 20% type at the reference height against twice it: 0.9706
 * floored at a pixel, 0.9713 floored at the sheet's scale).
 */
export function tearNoise(w: number, scale: number, seed: number): FbmSampler {
  return new FbmSampler(w, scale * 1.6, 2, seed ^ 0x1b873593)
}

/**
 * Roughen and bleed a tone field, in place: the tone in, the torn tone out.
 * Nothing to do (no roughness, no bleed) leaves it as it is.
 *
 * Runs on the *tone*, before screening, so the screen bites on the ragged
 * outline rather than a clean one — ordering matters here as much as anywhere
 * else in the pipeline. The blur's buffers are the caller's (see blur.ts
 * `blurInPlace`; `needsSpare` says when `spare` is needed), so a press makes
 * no sheet-sized allocation here.
 *
 * `field` may be a WINDOW of the sheet: `h` rows starting at sheet row
 * `row0`. The wander is read at the sheet's own rows (`y + row0`), so a
 * window tears exactly as the sheet does at every row the blur's reach does
 * not cross the window's edge: the blur clamps at the window's first and last
 * rows, which is the sheet's own clamp only where those are the sheet's top
 * and bottom. A caller that presses in bands widens each window by three
 * times the blur's integer radius on any side that is not the sheet's edge
 * (render.ts `plateHalo`), and uses only the rows inside.
 */
export function roughenInPlace(
  field: Float32Array,
  w: number,
  h: number,
  opts: RoughOptions,
  scratch: Float32Array,
  spare?: Float32Array,
  row0 = 0,
): void {
  const { roughness, bleed, seed } = opts
  if (roughness <= 0 && bleed <= 0) return

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

  // The softened tone, in place: each pixel is read once, below, and then
  // overwritten with the cut.
  blurInPlace(field, w, h, radius, scratch, spare)
  const soft = field

  // Two octaves is enough: a coarse wander plus a fine nibble. More just
  // averages back toward a smooth edge. Unrounded for the same reason as the
  // radius — a wavelength pinned to a pixel is a different wavelength on every
  // size of sheet.
  // Read only on the edge (0 < soft < 1), the few percent of the sheet the
  // cut wanders on, rather than laid out over all of it.
  const wander = roughness > 0 ? tearNoise(w, opts.scale, seed) : null

  // Cutting at 0.5 reproduces the original outline. Lowering it keeps more of
  // the blurred skirt, which is precisely ink spread.
  const base = 0.5 - bleed * 0.22
  // A narrow ramp either side of the cut keeps the edge hard but not aliased.
  const e = 0.06

  const out = field
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const s = soft[i]
      // Interior and bare paper are already settled — leave them alone so the
      // roughening cannot punch holes in the middle of a solid.
      if (s <= 0) {
        out[i] = 0
        continue
      }
      if (s >= 1) {
        out[i] = 1
        continue
      }

      const cut = wander ? base + (wander.at(x, y + row0) - 0.5) * roughness * 0.55 : base
      const t = (s - (cut - e)) / (2 * e)
      out[i] = clamp01(t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
    }
  }
}
