/**
 * The sheet and its frame: the sheet's shape, the border, and where the photo
 * goes. The one layout the preview, the export and the planner all read.
 *
 * Three rectangles, in whole sheet pixels:
 *  - the SHEET, (0, 0, w, h);
 *  - the VISIBLE rectangle: the sheet inset by the border on every side. The
 *    photo's placement (its zoom, and its centre as a fraction of this
 *    rectangle) is relative to it, and it is what lands on the photo pixel for
 *    pixel at the native size;
 *  - the SHOWN rectangle: where the photo is. In Crop, and always on an
 *    Original sheet, it is the visible rectangle, which the photo covers; in
 *    Fit it is the whole photo contained in the visible rectangle, and the
 *    sheet around it is the fill (the matte). Corners rounds its corners.
 *
 * The border is a fraction of the sheet's long side (`frame.width`), in whole
 * pixels. An Original sheet is the photo's own shape plus the border, so at
 * the photo's own size its visible rectangle IS the photo. Without a photo
 * there is no frame (a frame round nothing is not a print).
 *
 * The photo is never stretched: one scale on both axes, in every mode.
 *
 * The frame is GROUND, not a plate: the fill, the photo and its rounded
 * corners are composed into the ground the ink prints on, a band of rows at
 * a time (`composeFrameRows`), each pixel a function of its position and its
 * own photo pixel only, so a sheet pressed in bands of any height is the
 * sheet composed whole.
 *
 * Pure: no DOM.
 */

import { FRAME_CORNER_DIV } from './limits.ts'
import { coverRect, snapRect, type Area, type DrawRect } from './media.ts'
import { ASPECTS, type FramePalette, type FrameSettings, type PrintSettings } from './types.ts'

/** What the sheet's shape reads of a document. `frame` absent is no frame. */
export interface SheetShape {
  aspect: PrintSettings['aspect']
  media: { width: number; height: number } | null
  frame?: Pick<FrameSettings, 'width'>
}

/** What the layout reads of a document. */
export type SheetSpec = Pick<PrintSettings, 'aspect' | 'media' | 'frame'>

/** How far from square an Original sheet's photo may go: a photo more
 *  extreme than 3:1 (a panorama) or 1:3 is cover-cropped to it, so no sheet
 *  is a sliver. */
const ORIGINAL_MAX_RATIO = 3

/** The Original sheet's shape when there is no photo to take it from (a
 *  document holds 'original' only with a photo; this is the fallback). */
const ORIGINAL_WITHOUT_PHOTO = ASPECTS['4:5']

/** The border, in pixels, of a w x h sheet: `width` of its long side. Never
 *  so wide that nothing is left inside it (only a sheet a few pixels across
 *  could meet that: the widest frame takes 0.32 of the long side, and no
 *  sheet's short side is under a third of it). */
export const borderPx = (width: number, w: number, h: number): number =>
  Math.min(Math.round(width * Math.max(w, h)), Math.floor((Math.min(w, h) - 1) / 2))

/**
 * The part of a photo an Original sheet shows, at the photo's own pixels: the
 * whole photo when it is inside 1:3..3:1, its centred 3:1 (or 1:3) when it is
 * more extreme. A 12000x2000 panorama shows 6000x2000, framed or not.
 */
export function originalVisible(mw: number, mh: number): { vw: number; vh: number } {
  const k = ORIGINAL_MAX_RATIO
  if (mw > k * mh) return { vw: k * mh, vh: mh }
  if (mh > k * mw) return { vw: mw, vh: k * mw }
  return { vw: mw, vh: mh }
}

/**
 * The border of the Original sheet at the photo's own size: the smallest
 * whole b with b = round(width x (L + 2b)), L the visible part's long side.
 * The sheet is then (vw + 2b) x (vh + 2b), and the border its own formula
 * gives on that sheet (`borderPx`) is b again. A fixed point always exists:
 * the right side rises by at most 1 a step of b (2 x width < 1), and none is
 * below round(width x L), where the search starts.
 */
export function originalBorder(vw: number, vh: number, width: number): number {
  const L = Math.max(vw, vh)
  let b = Math.round(width * L)
  while (Math.round(width * (L + 2 * b)) !== b) b++
  return b
}

/**
 * The sheet's width over its height, as a number: the one place an aspect key
 * becomes a ratio. A fixed key's ratio, whatever the frame. 'original' is the
 * photo's own shape (`originalVisible`), and, framed, that shape plus the
 * border round it: (vw + 2b) / (vh + 2b), a function of the photo and the
 * width only, so the same at every size. With no photo, 4:5.
 *
 * Original is what the first photo opens on: with zoom at 100% and no pan the
 * photo then fills the visible rectangle exactly, so the untouched path
 * neither crops nor resamples a pixel.
 */
export function sheetAspect(s: SheetShape): number {
  if (s.aspect !== 'original') return ASPECTS[s.aspect]
  if (!s.media || !(s.media.width > 0) || !(s.media.height > 0)) return ORIGINAL_WITHOUT_PHOTO
  const { vw, vh } = originalVisible(s.media.width, s.media.height)
  const width = s.frame?.width ?? 0
  const b = width > 0 ? originalBorder(vw, vh, width) : 0
  return (vw + 2 * b) / (vh + 2 * b)
}

/**
 * The visible rectangle's width over its height: what the photo's placement
 * (its cover fit and its pan) is relative to. Independent of the sheet's size
 * (the border is a fraction of the long side): on a fixed sheet of shape a,
 * long side 1, it is (1 - 2w) / (1/a - 2w) landscape and (a - 2w) / (1 - 2w)
 * portrait; on Original it is the photo's own shape. Unframed, or without a
 * photo, it is the sheet's.
 */
export function visibleAspect(s: SheetShape): number {
  const a = sheetAspect(s)
  const width = s.frame?.width ?? 0
  if (!(width > 0) || !s.media || !(s.media.width > 0) || !(s.media.height > 0)) return a
  if (s.aspect === 'original') {
    const { vw, vh } = originalVisible(s.media.width, s.media.height)
    return vw / vh
  }
  return a >= 1 ? (1 - 2 * width) / (1 / a - 2 * width) : (a - 2 * width) / (1 - 2 * width)
}

/** Crop or Fit as the layout reads it: an Original sheet is the photo's own
 *  shape, so it is always Crop (a stored 'fit' is kept for a fixed sheet). */
export const effectiveMode = (s: Pick<PrintSettings, 'aspect' | 'frame'>): FrameSettings['mode'] =>
  s.aspect === 'original' ? 'crop' : s.frame.mode

/**
 * Fit: the whole photo inside `area`, as large as it goes, centred. The axis
 * that binds is the area's side exactly; the other is that times the photo's
 * shape, rounded; the offset is rounded too. On the sheet the planner sizes
 * for the photo's own pixels it is exactly mw x mh. Never a cover, and never
 * snapped: it is the photo's rectangle as it is.
 */
export function containRect(mw: number, mh: number, area: Area): Area {
  const shape = mw / mh
  let w: number
  let h: number
  if (area.w / area.h > shape) {
    h = area.h
    w = Math.max(1, Math.round(h * shape))
  } else {
    w = area.w
    h = Math.max(1, Math.round(w / shape))
  }
  return { x0: area.x0 + Math.round((area.w - w) / 2), y0: area.y0 + Math.round((area.h - h) / 2), w, h }
}

/** A w x h sheet laid out for its frame and its photo. */
export interface SheetLayout {
  w: number
  h: number
  /** The frame in pixels: `borderPx` of the sheet; 0 without a photo. */
  border: number
  visible: Area
  shown: Area
  /** Where the photo is drawn (fractional in Crop away from 1:1); null
   *  without a photo. */
  photo: DrawRect | null
  /** The corners of `shown`, in pixels; not rounded (coverage is exact). */
  radius: number
}

/**
 * The one layout of a w x h sheet: the border, the visible and shown
 * rectangles, the photo's rectangle and the corner radius.
 *
 *  - Crop and Original: the photo covers the visible rectangle at its zoom,
 *    its centre where the placement puts it (`coverRect`), snapped to its own
 *    pixels when it lands 1:1 (`snapRect`); shown is the visible rectangle.
 *  - Fit: the whole photo contained in the visible rectangle
 *    (`containRect`); the zoom and the pan are kept in the document but not
 *    read.
 *
 * Unframed (width 0) in Crop, the visible rectangle is the sheet and the
 * photo's rectangle is exactly the cover fit of the sheet, as it always was.
 */
export function layoutSheet(s: SheetSpec, w: number, h: number): SheetLayout {
  const sheet: Area = { x0: 0, y0: 0, w, h }
  const media = s.media
  if (!media) return { w, h, border: 0, visible: sheet, shown: sheet, photo: null, radius: 0 }
  const border = borderPx(s.frame.width, w, h)
  const visible: Area = { x0: border, y0: border, w: w - 2 * border, h: h - 2 * border }
  let shown: Area
  let photo: DrawRect
  if (effectiveMode(s) === 'fit') {
    shown = containRect(media.width, media.height, visible)
    photo = { dx: shown.x0, dy: shown.y0, dw: shown.w, dh: shown.h }
  } else {
    shown = visible
    photo = snapRect(coverRect(media, visible, media), media.width, media.height, visible)
  }
  return { w, h, border, visible, shown, photo, radius: (s.frame.corners * Math.min(shown.w, shown.h)) / FRAME_CORNER_DIV }
}

/**
 * Whether a layout leaves the ground as it is: the photo shown on the whole
 * sheet with square corners (Crop or Original at width 0 and corners 0, or
 * no photo). Then there is nothing to compose, and the ground is the photo
 * as it always was: a print without a frame is pressed from the same bytes
 * it was before the frame existed.
 */
export const isUnframed = (l: SheetLayout): boolean =>
  l.radius === 0 && l.shown.x0 === 0 && l.shown.y0 === 0 && l.shown.w === l.w && l.shown.h === l.h

/** A pixel, RGBA, straight alpha: the colour is the colour, never multiplied
 *  by its alpha (what the compositor reads, composite.ts). */
export type Rgba = readonly [number, number, number, number]

/** Writes the fill of sheet row `y`, columns [x0, x1), as RGBA into `out`
 *  from byte `o`. A pure function of the position: the same pixel is the
 *  same bytes however the sheet is cut into bands. */
export type RowSampler = (y: number, x0: number, x1: number, out: Uint8ClampedArray, o: number) => void

/**
 * What fills the frame: the border, the matte round a photo in Fit, and what
 * shows where the photo does not (its rounded corners, a transparent pixel).
 * Paper is alpha 0: the compositor prints the bare stock there, its tint and
 * tooth, as it prints a sheet with no photo. A colour is opaque, and takes
 * the stock's veil as the photo does when "Paper over the photo" is on.
 */
export interface FrameFill {
  /** The fill's one pixel when it is the same everywhere (Paper, a colour);
   *  null when it varies across the sheet (a sampled fill). */
  readonly flat: Rgba | null
  readonly row: RowSampler
}

/** Paper: no colour, the bare stock. */
export const PAPER_RGBA: Rgba = [0, 0, 0, 0]

/** One pixel repeated over `count` pixels of `out` from byte `o`: written
 *  once, then doubled. */
function fillRun(px: Rgba, out: Uint8ClampedArray, o: number, count: number): void {
  const n = count * 4
  if (n <= 0) return
  out[o] = px[0]
  out[o + 1] = px[1]
  out[o + 2] = px[2]
  out[o + 3] = px[3]
  for (let k = 4; k < n; k *= 2) out.copyWithin(o + k, o, o + Math.min(k, n - k))
}

/** A flat fill's rows: the one pixel over the run. */
const flatRow =
  (px: Rgba): RowSampler =>
  (_y, x0, x1, out, o) =>
    fillRun(px, out, o, x1 - x0)

/** '#rrggbb' as an opaque pixel. */
function hexRgba(hex: string): Rgba {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`fillRgba: not a colour: ${hex}`)
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255]
}

/**
 * A fill: null is Paper (alpha 0); '#rrggbb' is that colour, opaque; a row
 * sampler is a fill that varies across the sheet, read where it is pressed.
 */
export function fillRgba(source: string | RowSampler | null): FrameFill {
  if (source === null) return { flat: PAPER_RGBA, row: flatRow(PAPER_RGBA) }
  if (typeof source === 'string') {
    const px = hexRgba(source)
    return { flat: px, row: flatRow(px) }
  }
  return { flat: null, row: source }
}

/**
 * How much of pixel (x, y) to (x + 1, y + 1) the photo keeps at a rounded
 * corner of radius r, the corner at the origin and x and y measured into
 * the photo: 1 is all of it, 0 none (the fill).
 *
 * The corner is Border Studio's: a quadratic curve from (0, r) to (r, 0)
 * whose control point is the corner, i.e. sqrt(x) + sqrt(y) = sqrt(r). What
 * it cuts away under the curve is y < g(x) = (sqrt(r) - sqrt(x))^2 for x in
 * [0, r] (g is its own inverse), so the part of a pixel it cuts is, exactly,
 * the columns where g passes over the pixel's bottom edge (all of the
 * pixel's height) plus the integral of g - y where it passes through it,
 * with the closed form F(t) = r t - 4/3 sqrt(r) t^(3/2) + t^2 / 2. Exact
 * area, not a supersample: the edge is the same at every size and in every
 * band.
 */
export function cornerCoverage(r: number, x: number, y: number): number {
  if (!(r > 0) || x >= r || y >= r) return 1
  const sr = Math.sqrt(r)
  // Wholly on the photo's side of the curve, or wholly cut away.
  if (Math.sqrt(x) + Math.sqrt(y) >= sr) return 1
  if (Math.sqrt(x + 1) + Math.sqrt(y + 1) <= sr) return 0
  const g = (t: number) => (sr - Math.sqrt(t)) ** 2
  const F = (t: number) => r * t - (4 / 3) * sr * t * Math.sqrt(t) + (t * t) / 2
  const hi = Math.min(x + 1, r)
  // g passes over the pixel's bottom edge up to xa, and over its top edge
  // up to xb.
  const xa = y + 1 >= r ? 0 : g(y + 1)
  const xb = g(y)
  let cut = 0
  if (xa > x) cut += Math.min(hi, xa) - x
  const a = Math.max(x, xa)
  const b = Math.min(hi, xb)
  if (b > a) cut += F(b) - F(a) - y * (b - a)
  return Math.min(1, Math.max(0, 1 - cut))
}

/**
 * What the frame's fill is made from beyond the document: derived data,
 * computed from the photo by the page (features/media) and handed to the
 * engine beside the photo. The engine never decodes and never caches it.
 *  - `palette`: the photo's four colours (stored with the photo,
 *    `media.palette`).
 */
export interface FrameInputs {
  palette?: FramePalette
}

/**
 * The document's fill choice, looked up in its inputs: Paper is bare paper;
 * Photo, Deep, Muted and Comp are the photo's own colours. The document
 * stores the choice, never a colour, so a new photo re-keys the frame by
 * itself. A fill whose input is not there (yet) is Paper, the bare stock,
 * never a wrong colour; the page renders again once it arrives. Frosted is
 * Paper until its field is handed in (the frost field lands with Frosted).
 */
export function fillFor(s: Pick<PrintSettings, 'frame'>, inputs: FrameInputs): FrameFill {
  const fill = s.frame.fill
  if (fill === 'paper' || fill === 'frosted') return fillRgba(null)
  return fillRgba(inputs.palette?.[fill] ?? null)
}

/** A non-flat fill's pixel, read one at a time where a photo pixel needs it. */
const FILL_PX = new Uint8ClampedArray(4)

/**
 * The frame's ground, rows [y0, y1) of the sheet: the photo where the layout
 * shows it, the fill everywhere else, written into `out` (row y at
 * (y - y0) w 4).
 *
 *  - Outside `shown` the pixel IS the fill: the border, and in Fit the matte.
 *    The photo's ground is never read there (its alpha 0 round a contained
 *    photo is not what the matte prints).
 *  - Inside `shown` the photo pixel is laid over the fill, straight alpha:
 *    with a = c x photo alpha (c the corner's coverage, 1 away from the
 *    corners) and the fill's alpha f, the alpha is A = a + f (1 - a) and the
 *    colour (a P + f (1 - a) F) / A, rounded once as the byte store rounds.
 *    An opaque photo pixel away from the corners is copied as it is, byte
 *    for byte: a photo at its own pixels keeps every one of them.
 *
 * `src` is the photo's ground (RGBA, alpha 0 where the photo is not), holding
 * the rows from `srcRow0` on; only rows that meet `shown` are read, so it may
 * be null when none do. `out` may be `src` itself when srcRow0 is y0 (every
 * pixel is a function of the same pixel only): the preview composes in
 * place. A function of each pixel's position and its own ground pixel, so a
 * sheet composed in bands of any height is the same bytes as composed whole.
 */
export function composeFrameRows(
  layout: SheetLayout,
  fill: FrameFill,
  src: Uint8ClampedArray | null,
  y0: number,
  y1: number,
  out: Uint8ClampedArray,
  srcRow0 = y0,
): void {
  const { w, shown } = layout
  const r = layout.radius
  const stride = w * 4
  if (out.length < (y1 - y0) * stride) throw new Error(`composeFrameRows: ${out.length} bytes for rows [${y0}, ${y1}) of a ${w} wide sheet`)
  if (out === src && srcRow0 !== y0) throw new Error('composeFrameRows: in place needs the same first row')
  const sx0 = shown.x0
  const sx1 = shown.x0 + shown.w
  const sy0 = shown.y0
  const sy1 = shown.y0 + shown.h
  const a = Math.min(y1, Math.max(y0, sy0))
  const b = Math.min(y1, Math.max(a, sy1))
  fillRows(fill, y0, a, w, out, 0)
  fillRows(fill, b, y1, w, out, (b - y0) * stride)
  if (b <= a) return
  if (!src) throw new Error(`composeFrameRows: rows [${a}, ${b}) show the photo, and no ground was given`)
  const flat = fill.flat
  // The corners' patches: the first `patch` rows and columns from each edge
  // of `shown` (a radius is at most an eighth of its shorter side, so the
  // four never meet but on a photo a pixel or two across).
  const patch = Math.ceil(r)
  for (let y = a; y < b; y++) {
    const o = (y - y0) * stride
    const so = (y - srcRow0) * stride
    fill.row(y, 0, sx0, out, o)
    fill.row(y, sx1, w, out, o + sx1 * 4)
    // The photo: copied as it is, then every pixel that is not an opaque
    // copy (in a corner, or not opaque) laid over the fill.
    if (out !== src) out.set(src.subarray(so + sx0 * 4, so + sx1 * 4), o + sx0 * 4)
    const top = y - sy0
    const bottom = sy1 - 1 - y
    let left = sx0
    let right = sx1
    if (top < patch || bottom < patch) {
      left = Math.min(sx1, sx0 + patch)
      right = Math.max(left, sx1 - patch)
      for (let x = sx0; x < sx1; x = x === left - 1 ? right : x + 1) {
        const c = patchCoverage(r, x - sx0, sx1 - 1 - x, top, bottom)
        const p = o + x * 4
        if (c < 1 || out[p + 3] !== 255) blendPixel(out, p, src, so + x * 4, c, fill, flat, x, y)
      }
    }
    for (let x = left; x < right; x++) {
      const p = o + x * 4
      if (out[p + 3] !== 255) blendPixel(out, p, src, so + x * 4, 1, fill, flat, x, y)
    }
  }
}

/**
 * The coverage of a pixel in a corner's patch, `left`/`right` columns and
 * `top`/`bottom` rows in from the edges of `shown`: what each corner it is
 * near cuts from it. One corner, but on a photo a pixel or two across, where
 * two can cut one pixel (their cuts are apart, so they add).
 */
function patchCoverage(r: number, left: number, right: number, top: number, bottom: number): number {
  let c = 1
  for (let i = 0; i < 4; i++) {
    const k = cornerCoverage(r, i & 1 ? right : left, i & 2 ? bottom : top)
    if (k < 1) c = c === 1 ? k : Math.max(0, c - (1 - k))
  }
  return c
}

/** Whole rows of fill, [y0, y1), into `out` from byte `o`. A flat fill is
 *  written once over all of them and doubled. */
function fillRows(fill: FrameFill, y0: number, y1: number, w: number, out: Uint8ClampedArray, o: number): void {
  if (y1 <= y0) return
  if (fill.flat) return fillRun(fill.flat, out, o, w * (y1 - y0))
  for (let y = y0; y < y1; y++) fill.row(y, 0, w, out, o + (y - y0) * w * 4)
}

/**
 * Photo pixel `src[s]`, kept at coverage `c`, over the fill at (x, y), into
 * `out[p]`: straight-alpha source-over, rounded once. An opaque photo pixel
 * at c = 1 comes out as itself.
 */
function blendPixel(
  out: Uint8ClampedArray,
  p: number,
  src: Uint8ClampedArray,
  s: number,
  c: number,
  fill: FrameFill,
  flat: Rgba | null,
  x: number,
  y: number,
): void {
  const pr = src[s]
  const pg = src[s + 1]
  const pb = src[s + 2]
  const a = (c * src[s + 3]) / 255
  const px: Rgba | Uint8ClampedArray = flat ?? FILL_PX
  if (!flat) fill.row(y, x, x + 1, FILL_PX, 0)
  const f = (px[3] / 255) * (1 - a)
  const A = a + f
  if (!(A > 0)) {
    out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0
    return
  }
  out[p] = (a * pr + f * px[0]) / A
  out[p + 1] = (a * pg + f * px[1]) / A
  out[p + 2] = (a * pb + f * px[2]) / A
  out[p + 3] = A * 255
}
