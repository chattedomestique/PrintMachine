/**
 * Misprints.
 *
 * A duplicator is a cheap machine doing a violent thing at speed, and it shows.
 * These are the three artefacts that read as "this came off a Riso" rather than
 * "this had a texture applied", modelled from what actually causes them:
 *
 *  - **Drum streaks.** Ink is distributed across the drum by rollers. Where the
 *    film is thin you get a pale line running the whole length of the print, in
 *    the direction the drum turns. Narrow, hard-edged, and unmistakable.
 *  - **Smear.** Paper leaves the drum faster than the ink sets, and the next
 *    sheet — or a roller — drags a ghost of the image along the feed direction.
 *  - **Dropout patches.** Whole regions where ink simply did not transfer:
 *    a dry patch on the drum, or paper that did not make contact.
 *
 * All three are seeded and all three are no-ops at zero, so a clean print is
 * still available.
 */

import { fbm2D, mulberry32, valueNoise2D } from './rng.ts'

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Pale vertical streaks running the full height of the sheet.
 *
 * Each streak gets its own position, width, depth and a low-frequency wobble
 * along its length, because a real one is not a uniform rectangle — it fades
 * in and out as the ink film varies around the drum.
 */
export function applyStreaks(
  coverage: Float32Array,
  w: number,
  h: number,
  amount: number,
  seed: number,
): Float32Array {
  if (amount <= 0) return coverage

  const rand = mulberry32(seed ^ 0x7f4a7c15)
  const count = Math.round(2 + amount * 7)

  // Per-streak parameters, drawn once.
  const xs: number[] = []
  const widths: number[] = []
  const depths: number[] = []
  for (let s = 0; s < count; s++) {
    xs.push(rand() * w)
    widths.push((0.6 + rand() * 2.6) * Math.max(1, w / 500))
    depths.push((0.25 + rand() * 0.75) * amount)
  }

  // One shared wobble field, sampled per streak at a different offset.
  const wobble = valueNoise2D(count, h, Math.max(10, h / 22), seed ^ 0x2545f491)

  const out = Float32Array.from(coverage)
  for (let s = 0; s < count; s++) {
    const cx = xs[s]
    const halfW = widths[s]
    const x0 = Math.max(0, Math.floor(cx - halfW))
    const x1 = Math.min(w - 1, Math.ceil(cx + halfW))
    if (x1 < x0) continue

    for (let y = 0; y < h; y++) {
      // Wobble modulates depth along the streak, and can close it entirely.
      const strength = depths[s] * clamp01(wobble[y * count + s] * 1.6 - 0.25)
      if (strength <= 0) continue
      const row = y * w
      for (let x = x0; x <= x1; x++) {
        // Soft profile across the streak's width — hard-edged reads as a line
        // drawn on top rather than ink that isn't there.
        const d = Math.abs(x - cx) / halfW
        if (d > 1) continue
        const falloff = 1 - d * d
        out[row + x] *= 1 - strength * falloff
      }
    }
  }
  return out
}

/**
 * Directional ink drag along the feed direction.
 *
 * Accumulates a decaying trail of the coverage above each pixel and adds it
 * back at low strength — the image ghosting downward, fading as the ink runs
 * out. Implemented as a single-pass recurrence so the trail length costs
 * nothing: `trail = max(trail * decay, coverage)` walking down each column.
 */
export function applySmear(
  coverage: Float32Array,
  w: number,
  h: number,
  amount: number,
): Float32Array {
  if (amount <= 0) return coverage

  // Longer, fainter trails as the amount rises.
  const decay = 0.86 + amount * 0.11
  const strength = amount * 0.5

  const out = Float32Array.from(coverage)
  for (let x = 0; x < w; x++) {
    let trail = 0
    for (let y = 0; y < h; y++) {
      const i = y * w + x
      const c = coverage[i]
      trail = Math.max(trail * decay, c)
      // Only the part of the trail beyond the actual ink is a smear; inside
      // the shape there is nothing to add.
      const ghost = (trail - c) * strength
      if (ghost > 0) out[i] = clamp01(out[i] + ghost)
    }
  }
  return out
}

/**
 * Regions where ink did not transfer at all.
 *
 * Driven by a low-frequency field thresholded hard, so patches have soft,
 * organic borders and cover a meaningful area rather than speckling. This is
 * distinct from the per-pixel dropout in ink.ts, which models drum dust.
 */
export function applyDropoutPatches(
  coverage: Float32Array,
  w: number,
  h: number,
  amount: number,
  seed: number,
): Float32Array {
  if (amount <= 0) return coverage

  // Two octaves so the patch borders are irregular rather than smooth blobs —
  // a single frequency reads as a soft light leak, not as ink that failed.
  const field = fbm2D(w, h, Math.max(14, Math.min(w, h) / 11), 2, seed ^ 0x94d049bb)
  const cut = 0.3 * amount
  // A narrow ramp keeps the border of a patch abrupt. Ink either transferred
  // or it did not; the gradient version looks like a lighting effect.
  const ramp = 0.045
  const out = new Float32Array(coverage.length)

  for (let i = 0; i < out.length; i++) {
    const c = coverage[i]
    if (c <= 0) continue
    const d = field[i] - cut
    if (d >= ramp) {
      out[i] = c
      continue
    }
    const k = clamp01((d + ramp) / (2 * ramp))
    out[i] = c * (0.06 + 0.94 * k * k)
  }
  return out
}
