/**
 * Ink physics on a coverage field.
 *
 * These are the passes that separate "a halftone filter" from "a Riso". A
 * duplicator lays ink down from a rotating drum onto paper that is fed by
 * rubber rollers, and every part of that is slightly inconsistent — the ink
 * film varies across the drum, the paper does not land in the same place
 * twice, and the ink never reaches full density no matter how many passes.
 */

import { cellNoiseAt, type CellNoise } from './rng.ts'

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The two wear controls, and what each one drives.
 *
 * Edge is the burned stencil's outline: how far it tears, and how far the ink
 * spreads past it. Bleed is the same threshold pass as the tear, so the two
 * move together at the ratio the press always shipped with (0.55 : 0.35) —
 * "fat but clean" against "thin but ragged" is not a decision the job needs.
 *
 * Wear is the drum's ink film: blotchy mottle, and the speckle dropout that is
 * the same failure at a finer grain, together at the shipped 0.22 : 0.012.
 *
 * Written as amount / reference x partner so that at the reference amount the
 * result is the shipped value exactly — the default print does not move.
 */
const EDGE_REFERENCE = 0.55
const BLEED_AT_REFERENCE = 0.35
const WEAR_REFERENCE = 0.22
const DROPOUT_AT_REFERENCE = 0.012

/** Edge (0..1) to the stencil's tear and bleed. */
export function edgeToRough(edge: number): { roughness: number; bleed: number } {
  return { roughness: edge, bleed: (edge / EDGE_REFERENCE) * BLEED_AT_REFERENCE }
}

/** Wear (0..0.8) to the ink film's mottle and dropout. */
export function wearToMottle(wear: number): { mottle: number; dropout: number } {
  return { mottle: wear, dropout: (wear / WEAR_REFERENCE) * DROPOUT_AT_REFERENCE }
}

/**
 * Apply the ink's density ceiling to a tone field.
 *
 * Riso ink at "100%" is not black — it is roughly 85–92% of the pigment's own
 * colour, because the drum only carries so much ink. Capping this is the
 * cheapest single thing that stops output looking like an inkjet print.
 *
 * @param density max coverage in [0,1] — 0.88 is a realistic single pass.
 */
export function applyDensity(tone: Float32Array, density: number): Float32Array {
  const out = new Float32Array(tone.length)
  for (let i = 0; i < tone.length; i++) out[i] = clamp01(tone[i]) * density
  return out
}

/**
 * Modulate coverage by a low-frequency noise field, then punch random dropouts.
 *
 * `amount` swings coverage by ±amount around 1, so 0.25 means the ink film
 * varies between 75% and 125% of nominal across the sheet. `dropout` is the
 * probability of a speck losing most of its ink — dust on the drum, a fibre in
 * the paper. Both are weighted toward areas that already carry ink, because
 * bare paper has nothing to go wrong with.
 *
 * @param mottle  w*h low-frequency noise in [0,1] (see rng.fbm2D).
 * @param speckle white noise on cells sized to the sheet (rng.CellNoise): a
 *   speck is a pixel at the reference height and grows with the sheet, so dust
 *   is the same size on the print at every resolution. Read where the pixel
 *   has ink, and only there.
 */
export function applyMottle(
  coverage: Float32Array,
  mottle: Float32Array,
  speckle: CellNoise,
  amount: number,
  dropout: number,
  w: number,
  h: number,
  /**
   * How fine the blotch should be relative to the sheet, 0..1.
   *
   * The mottle field is generated once per sheet at a fixed cell size, which is
   * right for poster type and catastrophic for body copy: at export size the
   * cell is about the height of a small letter, so the blotch stops texturing
   * the ink and starts deleting chunks of the letterform.
   *
   * Rather than regenerate the field per plate, it is *strided* — read with a
   * step larger than one, which walks through the same noise faster and so
   * yields proportionally finer blotch. Wrapped, because striding runs off the
   * end of a field that was only ever w by h.
   *
   * The speckle is not strided: it is white, so a stride would only pick other
   * values of the same noise, and its speck is already the finest the sheet
   * holds.
   */
  detail = 1,
): Float32Array {
  const out = new Float32Array(coverage.length)
  const step = detail >= 1 ? 1 : Math.max(1, Math.round(1 / detail))

  for (let y = 0; y < h; y++) {
    const sy = step === 1 ? y : (y * step) % h
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const c = coverage[i]
      if (c <= 0) continue
      const j = step === 1 ? i : sy * w + ((x * step) % w)
      const m = 1 + amount * (mottle[j] * 2 - 1)
      let v = c * m
      if (dropout > 0 && cellNoiseAt(speckle, x, y) < dropout) v *= 0.15
      out[i] = clamp01(v)
    }
  }
  return out
}

/**
 * Resample a field by a sub-pixel offset, bilinearly.
 *
 * This is half of misregistration: the *image* on the plate moves. The other
 * half is moving the screen lattice by the same offset (see ScreenOptions'
 * originX/originY), so the dots travel with the plate rather than sliding
 * underneath it. Shifting only one of the two produces a plate whose dots
 * crawl, which looks wrong in a way that is hard to name.
 *
 * Samples outside the source read as 0 — bare paper — rather than clamping to
 * the edge pixel. Clamping smears the outermost row across everything the
 * shift uncovers, which shows up as a hard band along the edge of any artwork
 * that runs to the trim. A plate that slides down should reveal unprinted
 * paper at the top, because that is what it does.
 */
export function shiftField(
  src: Float32Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
): Float32Array {
  if (dx === 0 && dy === 0) return src.slice()

  const out = new Float32Array(w * h)
  const at = (x: number, y: number): number =>
    x < 0 || x >= w || y < 0 || y >= h ? 0 : src[y * w + x]

  for (let y = 0; y < h; y++) {
    const sy = y - dy
    const y0 = Math.floor(sy)
    const fy = sy - y0

    for (let x = 0; x < w; x++) {
      const sx = x - dx
      const x0 = Math.floor(sx)
      const fx = sx - x0

      const a = at(x0, y0)
      const b = at(x0 + 1, y0)
      const c = at(x0, y0 + 1)
      const d = at(x0 + 1, y0 + 1)

      const top = a + (b - a) * fx
      const bot = c + (d - c) * fx
      out[y * w + x] = top + (bot - top) * fy
    }
  }
  return out
}

/**
 * Deterministic per-plate registration offset.
 *
 * Real misregistration is a small, arbitrary translation that differs per pass.
 * Deriving it from (seed, plateIndex) rather than Math.random keeps the export
 * identical to the preview and stops the offsets re-rolling when an unrelated
 * slider moves.
 *
 * Plate 0 is left alone — something has to be the reference, and in practice
 * you register everything against the first colour down.
 */
export function registrationOffset(
  seed: number,
  plateIndex: number,
  amount: number,
): { dx: number; dy: number } {
  if (plateIndex === 0 || amount === 0) return { dx: 0, dy: 0 }
  // Two decorrelated angles from the same seed, so the offsets do not all
  // point the same way.
  const a = Math.sin(seed * 12.9898 + plateIndex * 78.233) * 43758.5453
  const b = Math.sin(seed * 39.3468 + plateIndex * 11.135) * 24634.6345
  const angle = (a - Math.floor(a)) * Math.PI * 2
  const radius = (0.35 + 0.65 * (b - Math.floor(b))) * amount
  return {
    dx: Math.cos(angle) * radius,
    dy: Math.sin(angle) * radius,
  }
}
