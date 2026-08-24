/**
 * The photo layer — the ground the ink prints on.
 *
 * A photo behind the type is not a sprite drawn on the canvas. It replaces the
 * *paper*: the base colour every transparent ink multiplies down from. That
 * falls out of the compositor already reading paper as `rgb × shade`, and it is
 * why type genuinely overprints a photo rather than sitting on it.
 *
 * Nothing here touches the DOM. The caller blits the pixels — `drawImage` is
 * far faster than sampling four million pixels in JS — but the *rectangle it
 * blits into* is computed here, because that is the part that has to be right
 * and the part worth testing.
 */

import { blurField } from './blur.ts'

export interface MediaSize {
  width: number
  height: number
}

export interface MediaPlacement {
  /** Multiplier on the cover fit. 1 exactly fills the sheet. */
  scale: number
  /** Centre of the media, in sheet fractions. 0.5, 0.5 is the middle. */
  x: number
  y: number
}

export interface DrawRect {
  dx: number
  dy: number
  dw: number
  dh: number
}

/**
 * Where to draw the media so it covers the sheet without ever distorting.
 *
 * The scale factor is the *same on both axes* — that single fact is what keeps
 * a photo from being squashed, and it is asserted directly in the tests rather
 * than inferred from how the output looks. `max` of the two ratios gives cover
 * (fills the sheet, crops the overflow); `min` would give contain and leave
 * bars, which is not what a full-bleed print wants.
 */
export function coverRect(
  media: MediaSize,
  sheetW: number,
  sheetH: number,
  place: MediaPlacement,
): DrawRect {
  const mw = Math.max(1, media.width)
  const mh = Math.max(1, media.height)
  const cover = Math.max(sheetW / mw, sheetH / mh)
  const s = cover * Math.max(0.01, place.scale)
  const dw = mw * s
  const dh = mh * s
  return {
    dx: place.x * sheetW - dw / 2,
    dy: place.y * sheetH - dh / 2,
    dw,
    dh,
  }
}

/** Rec. 709 luma, 0..1. The channel weights a print separation actually uses. */
export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * Turn the photo into ink coverage for a single plate.
 *
 * Coverage is darkness, because ink is what gets *added* to paper: a black
 * pixel wants full ink, a white one wants none. `contrast` pivots around mid
 * grey so pushing it changes the slope rather than the average density.
 *
 * `lift` drops the highlights out — a real duotone almost never runs ink into
 * its brightest areas. It is a *rescale*, not a subtraction: everything below
 * the threshold goes to bare paper and what remains is stretched back over the
 * full range, so the shadows stay as black as they were. Subtracting instead
 * dims the whole image, which is the same "turned the opacity down" mistake
 * the wear passes exist to avoid.
 */
export function separateLuminance(
  rgba: Uint8ClampedArray,
  out: Float32Array,
  opts: { contrast: number; lift: number },
): Float32Array {
  const n = out.length
  const c = Math.max(0.05, opts.contrast)
  const lift = Math.max(0, Math.min(0.95, opts.lift))
  const span = 1 - lift
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const dark = 1 - luma(rgba[o], rgba[o + 1], rgba[o + 2])
    // Pivot at 0.5 so contrast changes the slope, not the average.
    const contrasted = (dark - 0.5) * c + 0.5
    let v = (contrasted - lift) / span
    if (v < 0) v = 0
    else if (v > 1) v = 1
    out[i] = v
  }
  return out
}

/**
 * A mask of where the photo is light enough for dark ink to read on it.
 *
 * Thresholded on a *blurred* luminance, not the raw pixels. A photograph is
 * full of local contrast — a bright speck inside a shadow, a dark seam across
 * a highlight — and thresholding that directly makes the ink flicker between
 * the two colours letter by letter, which is far harder to read than either
 * colour alone. Blurring first lets the mask follow the picture's large shapes,
 * which is what the eye is actually judging legibility against.
 *
 * The edge is deliberately soft over a narrow band so a glyph crossing the
 * boundary cross-fades rather than snapping mid-stroke.
 */
export function lightMask(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
  blurRadius: number,
): Float32Array {
  const n = w * h
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    // Transparent ground is bare paper, which is the lightest thing there is.
    const a = rgba[o + 3] / 255
    lum[i] = luma(rgba[o], rgba[o + 1], rgba[o + 2]) * a + (1 - a)
  }

  const soft = blurRadius > 0 ? blurField(lum, w, h, blurRadius) : lum

  // The band has to be wide enough that the blurred gradient actually lands
  // inside it, or the mapping squeezes the blur back into a hard edge and the
  // ink still snaps mid-stroke. Wider than this and the two inks overlap over
  // a large area, which prints as a muddy third colour rather than a switch.
  const band = 0.2
  const lo = threshold - band
  const span = band * 2
  for (let i = 0; i < n; i++) {
    const t = (soft[i] - lo) / span
    const c = t <= 0 ? 0 : t >= 1 ? 1 : t
    // Smoothstep: eases in and out of the switch instead of ramping linearly
    // into it, so neither end of the blend shows a visible seam.
    soft[i] = c * c * (3 - 2 * c)
  }
  return soft
}
