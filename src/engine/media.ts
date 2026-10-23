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

import { blurInPlace, needsSpare } from './blur.ts'

export interface MediaSize {
  width: number
  height: number
}

export interface MediaPlacement {
  /** Zoom on the cover fit, at least 1: 1 exactly fills the sheet. */
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

/** Where the photo's centre may sit, in sheet fractions, and still cover. */
export interface PanBounds {
  xLo: number
  xHi: number
  yLo: number
  yHi: number
}

/** The drawn size at a zoom: the cover fit, the same factor on both axes. */
function coverSize(media: MediaSize, sheetW: number, sheetH: number, scale: number) {
  const mw = Math.max(1, media.width)
  const mh = Math.max(1, media.height)
  // Never below the cover fit. Zooming out below it has no sane native export
  // size and leaves bare sheet, so the placement cannot ask for it.
  const s = Math.max(sheetW / mw, sheetH / mh) * Math.max(1, scale)
  return { dw: mw * s, dh: mh * s }
}

/**
 * How far the photo can travel and still cover the sheet.
 *
 * A covering photo is at least as large as the sheet on both axes, so its
 * centre may move until one of its edges reaches the trim: `[1 - d/2, d/2]`
 * per axis, with `d` the drawn size over the sheet's. On an axis where the
 * photo exactly fits, the range closes to the middle and there is no travel.
 */
export function panBounds(
  media: MediaSize & { scale: number },
  sheetW: number,
  sheetH: number,
): PanBounds {
  const { dw, dh } = coverSize(media, sheetW, sheetH, media.scale)
  // max() guards the float case where an exact fit computes a hair under half.
  const hx = Math.max(0.5, dw / (2 * sheetW))
  const hy = Math.max(0.5, dh / (2 * sheetH))
  return { xLo: 1 - hx, xHi: hx, yLo: 1 - hy, yHi: hy }
}

const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * The placement with its zoom at least 1 and its centre inside the pan
 * bounds, so the photo covers the sheet. Everything else is returned as given.
 */
export function clampPan<T extends MediaSize & MediaPlacement>(media: T, sheetW: number, sheetH: number): T {
  const scale = Math.max(1, media.scale)
  const b = panBounds({ ...media, scale }, sheetW, sheetH)
  return { ...media, scale, x: clampTo(media.x, b.xLo, b.xHi), y: clampTo(media.y, b.yLo, b.yHi) }
}

/**
 * The photo's position as a fraction of the travel it has: 0 shows its left
 * (or top) edge, 1 its right (or bottom) edge. 0.5 when it cannot travel.
 */
export function panFraction(
  media: MediaSize & MediaPlacement,
  sheetW: number,
  sheetH: number,
  axis: 'x' | 'y',
): number {
  const b = panBounds(media, sheetW, sheetH)
  const [lo, hi] = axis === 'x' ? [b.xLo, b.xHi] : [b.yLo, b.yHi]
  if (hi - lo <= 1e-9) return 0.5
  // The centre sits at `hi` when the photo's left edge is on the trim.
  return clampTo((hi - media[axis]) / (hi - lo), 0, 1)
}

/** The centre, in sheet fractions, for a fraction of the travel. */
export function fromPanFraction(
  media: MediaSize & { scale: number },
  sheetW: number,
  sheetH: number,
  axis: 'x' | 'y',
  fraction: number,
): number {
  const b = panBounds(media, sheetW, sheetH)
  const [lo, hi] = axis === 'x' ? [b.xLo, b.xHi] : [b.yLo, b.yHi]
  return hi - clampTo(fraction, 0, 1) * (hi - lo)
}

/**
 * Where to draw the media so it covers the sheet without ever distorting.
 *
 * The scale factor is the *same on both axes* — that single fact is what keeps
 * a photo from being squashed, and it is asserted directly in the tests rather
 * than inferred from how the output looks. `max` of the two ratios gives cover
 * (fills the sheet, crops the overflow); `min` would give contain and leave
 * bars, which is not what a full-bleed print wants.
 *
 * Cover is enforced HERE, where the sheet is drawn, not only where the photo
 * is edited: the placement is clamped to `panBounds` (and the zoom to at least
 * 1) before the rectangle is computed. A pan that was legal on one sheet shape
 * can uncover another — pan a landscape photo to the side on a square sheet,
 * switch to 4:5, and without this a strip of bare sheet prints. No stored
 * placement can produce that, in the preview or in the export.
 */
export function coverRect(
  media: MediaSize,
  sheetW: number,
  sheetH: number,
  place: MediaPlacement,
): DrawRect {
  const p = clampPan({ ...media, ...place }, sheetW, sheetH)
  const { dw, dh } = coverSize(media, sheetW, sheetH, p.scale)
  return {
    dx: p.x * sheetW - dw / 2,
    dy: p.y * sheetH - dh / 2,
    dw,
    dh,
  }
}

/**
 * A photo a build before full-resolution imports saved: those cut every import
 * to a 2048 px long edge and re-encoded it, and that copy is all the store
 * has. It cannot be recovered, only chosen again. The exact legacy signature:
 * no `native` flag (every import since sets it) and a long edge of exactly
 * 2048.
 */
export function isReducedCopy(media: { width: number; height: number; native?: boolean }): boolean {
  return media.native !== true && Math.max(media.width, media.height) === 2048
}

/**
 * The blit, made pixel-exact when the sheet holds the photo at its own pixels.
 *
 * At the native export height the cover fit lands within a hair of 1:1, but
 * the centred placement puts the photo half a pixel off the grid, and a
 * bilinear blit at a half-pixel offset blurs every pixel into its neighbour
 * (measured: Laplacian energy 0.753 of the original at native height; 1.000
 * snapped). So when the scale is within 1.5 px of 1 over the sheet's height,
 * draw the photo at exactly its own size, at a whole-pixel offset, kept inside
 * the travel that still covers the sheet — zoomed or not, since a zoomed photo
 * lands 1:1 at its own (smaller) native height. Anything that is not 1:1 — the
 * preview, a zoom at another height — or a photo smaller than the sheet is
 * returned untouched.
 */
export function snapRect(r: DrawRect, mw: number, mh: number, sheetW: number, sheetH: number): DrawRect {
  if (Math.abs(r.dw / mw - 1) >= 1.5 / sheetH) return r
  // Snapped to its own size the photo would not cover the sheet: leave it.
  if (mw < sheetW || mh < sheetH) return r
  return {
    dx: clampTo(Math.round(r.dx), sheetW - mw, 0),
    dy: clampTo(Math.round(r.dy), sheetH - mh, 0),
    dw: mw,
    dh: mh,
  }
}

/** Rec. 709 luma, 0..1. The channel weights a print separation actually uses. */
export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * The photo's luminance as the eye judges legibility against it — blurred.
 *
 * A photograph is full of local contrast: a bright speck inside a shadow, a
 * dark seam across a highlight, the glitter on water. Read raw, that decides
 * "light or dark" differently for every letter, and the type flickers between
 * two inks mid-word — far harder to read than either ink alone. Blurring first
 * lets the answer follow the picture's large shapes, which is what the eye is
 * actually weighing a word against.
 *
 * Returned rather than thresholded on the spot because the caller needs the
 * number itself, not just which side of a line it fell: whether an ink can
 * darken what it lands on is a comparison against this, and a mask has already
 * thrown that away.
 */
export function groundLuma(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  blurRadius: number,
  /** Buffers for the blur, if the caller has them (blur.ts `blurInPlace`). */
  scratch?: Float32Array,
  spare?: Float32Array,
): Float32Array {
  const n = w * h
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    // Transparent ground is bare paper, which is the lightest thing there is.
    const a = rgba[o + 3] / 255
    lum[i] = luma(rgba[o], rgba[o + 1], rgba[o + 2]) * a + (1 - a)
  }
  // Blurred where it lies: the luminance is this function's own, so it needs
  // no copy, only the blur's scratch.
  if (blurRadius > 0) {
    const fractional = needsSpare(blurRadius)
    blurInPlace(lum, w, h, blurRadius, scratch ?? new Float32Array(n), fractional ? (spare ?? new Float32Array(n)) : undefined)
  }
  return lum
}

/**
 * How far past the switch point the blend runs, in luminance.
 *
 * Deliberately narrow. The band is there so a stroke crossing the boundary
 * cross-fades instead of snapping, and with a blur measured in whole words the
 * boundary is already gradual *in space* — widening it in *value* only buys a
 * large region where both inks print at partial strength, which is neither
 * colour and reads as mud. Over water, whose blurred luminance sits close to
 * mid grey across the whole frame, a wide band puts every line in that region
 * at once.
 */
export const SWITCH_BAND = 0.07

/** Turn ground luminance into "light enough for the darker ink", 0..1. */
export function bandMask(
  lum: Float32Array,
  threshold: number,
  band = SWITCH_BAND,
  out: Float32Array = new Float32Array(lum.length),
): Float32Array {
  const lo = threshold - band
  const span = Math.max(1e-6, band * 2)
  for (let i = 0; i < lum.length; i++) {
    const t = (lum[i] - lo) / span
    const c = t <= 0 ? 0 : t >= 1 ? 1 : t
    // Smoothstep: eases in and out of the switch instead of ramping linearly
    // into it, so neither end of the blend shows a visible seam.
    out[i] = c * c * (3 - 2 * c)
  }
  return out
}

export type InkRgb = readonly [number, number, number]

export interface InkSplit {
  /** The ink to lay where the photo is light. */
  onLight: InkRgb
  /** The ink to lay where the photo is dark. */
  onDark: InkRgb
  onLightLuma: number
  onDarkLuma: number
}

/**
 * Which of two inks belongs on light ground, and which on dark.
 *
 * Decided by what the inks *are*, never by which field they were typed into.
 * Keying it to the slot assumes the first ink is the dark one, and the moment
 * it isn't — white type over a photograph, the ordinary case — the switch runs
 * and puts white on the sky and black on the water: both invisible, and worse
 * than not switching at all. Ties keep the given order, because with two inks
 * of the same weight there is nothing to choose between them.
 */
export function splitInks(a: InkRgb, b: InkRgb): InkSplit {
  const la = luma(a[0], a[1], a[2])
  const lb = luma(b[0], b[1], b[2])
  const aFirst = la <= lb
  return {
    onLight: aFirst ? a : b,
    onDark: aFirst ? b : a,
    onLightLuma: Math.min(la, lb),
    onDarkLuma: Math.max(la, lb),
  }
}
