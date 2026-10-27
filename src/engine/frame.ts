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
 * Pure: no DOM.
 */

import { FRAME_CORNER_DIV } from './limits.ts'
import { coverRect, snapRect, type Area, type DrawRect } from './media.ts'
import { ASPECTS, type FrameSettings, type PrintSettings } from './types.ts'

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

/** The border, in pixels, of a w x h sheet: `width` of its long side. */
export const borderPx = (width: number, w: number, h: number): number => Math.round(width * Math.max(w, h))

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
 * A sheet only a few pixels across keeps at least one visible pixel.
 */
export function layoutSheet(s: SheetSpec, w: number, h: number): SheetLayout {
  const sheet: Area = { x0: 0, y0: 0, w, h }
  const media = s.media
  if (!media) return { w, h, border: 0, visible: sheet, shown: sheet, photo: null, radius: 0 }
  const border = Math.min(borderPx(s.frame.width, w, h), Math.floor((Math.min(w, h) - 1) / 2))
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
