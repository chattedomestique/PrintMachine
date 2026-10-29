/**
 * How big a saved print is: the export follows the photo.
 *
 * The rule the user set is "no down-rezzing at ALL", of the photo or of the
 * exported image. So the sheet is exported at the size at which the photo
 * lands on it pixel for pixel — its NATIVE size — and never smaller than the
 * reference height, whatever the photo, and whatever its size: there is no
 * ceiling (the print is pressed in bands and encoded as it is pressed, so no
 * canvas or array of the sheet's size exists to hold it back). The one limit
 * left is the JPEG container's own (65,535 px a side), which only a photo
 * wider than that meets, and the plan says so in `limit`.
 *
 * What lands pixel for pixel is the photo's rectangle on the sheet's VISIBLE
 * rectangle, the sheet inside its frame (frame.ts; unframed, the whole
 * sheet). How it lands depends on how the photo is placed:
 *  - Crop, on a fixed sheet: the photo covers the visible rectangle, so it
 *    lands once the cover fit times the zoom reaches 1 on either axis (the
 *    other overhangs: Crop trims by design);
 *  - Fit: the whole photo is contained in it, so it lands once both of its
 *    sides hold the photo's (the zoom is not read);
 *  - Original: the visible rectangle HOLDS the part of the photo the sheet
 *    shows (the whole photo inside 1:3..3:1, its 3:1 cut beyond), over the
 *    zoom, on both axes. At 100% that is exactly the photo and its border, so
 *    nothing of the photo is trimmed, not even a row. (A cover would trim a
 *    row from a photo taller than 1:2, or a column from one wider than 2:1.)
 * The photo is still drawn by its cover fit and snapped (frame.ts
 * `layoutSheet`); on every plan this makes native it lands at its own pixels.
 *
 * A native plan steps the sheet's LONG axis a pixel at a time (a landscape
 * sheet's width, any other's height; the other side is that over the shape,
 * rounded), so the side that binds reaches every whole size. Stepping the
 * height of a landscape sheet would move its width by up to ceil(aspect)
 * pixels a row and skip the one the photo needs. With a border, whether a
 * size lands is not monotone (the border is rounded, so the visible side can
 * move back a pixel as the sheet grows), so from an estimate the search steps
 * UP to the first size that lands, then walks DOWN until K sizes in a row do
 * not (K = min(1000, ceil(1 / width)); 1 unframed, where landing is monotone),
 * and takes the smallest that landed: the same size as a scan from 1 upward
 * (exportPlan.test.ts). Every other plan (the floor, a smaller copy, the
 * JPEG's edge) is height-driven: the width is round(height x aspect), as the
 * preview's and the harness's are.
 *
 * Pure: no DOM. Save presses at the plan's width and height (export.ts
 * `savePrint`, through `planPrint`).
 */

import { JPEG_MAX_EDGE } from './encode/jpeg.ts'
import { borderPx, originalVisible } from './frame.ts'
import { NO_PHOTO_HEIGHT, REFERENCE_HEIGHT } from './limits.ts'

/**
 * Why the size is what it is:
 *  - `native`  the photo's own pixels, one for one;
 *  - `floor`   the photo has fewer pixels than the reference height, so it is
 *              enlarged (`upscale` > 1) rather than the print made smaller;
 *  - `none`    no photo: NO_PHOTO_HEIGHT;
 *  - `format`  a JPEG holds at most JPEG_MAX_EDGE (65,535) px a side, and the
 *              print would be bigger: the largest height that fits (a PNG
 *              has no such limit) — said, with the way round it;
 *  - `smaller` the caller asked for a smaller copy (`maxHeight`).
 */
export type PlanLimit = 'native' | 'floor' | 'none' | 'format' | 'smaller'

export interface ExportPlan {
  width: number
  height: number
  /** The frame, in pixels, on this sheet (frame.ts `borderPx`); 0 unframed
   *  or with no photo. */
  border: number
  limit: PlanLimit
  /** The height of the smallest sheet on which the photo lands at least 1:1;
   *  0 with no photo. */
  nativeHeight: number
  /** Sheet pixels per photo pixel, as realised: 1 native, above 1 the photo
   *  is enlarged ("photo is 1600 px, upscaled 1.5x"), below 1 it is reduced
   *  (only for a smaller copy or past a JPEG's edge). Null with no photo. */
  upscale: number | null
}

export interface PlanPhoto {
  /** The photo's true, oriented pixel size — never a preview's working copy. */
  width: number
  height: number
  /** Zoom on the cover fit; below 1 counts as 1, as the renderer draws it. */
  scale: number
}

/** The sheet as the planner reads it (export.ts `planSheet`). */
export interface PlanSheet {
  /** Its width over its height (frame.ts `sheetAspect`): any positive value. */
  aspect: number
  /** An Original sheet: the photo is held whole, not covered. */
  original?: boolean
  /** The frame's width, a fraction of the long side; absent or 0 is none. */
  width?: number
  /** Crop or Fit, as the layout reads it (an Original sheet is Crop). */
  mode?: 'crop' | 'fit'
}

/** How the photo lands on the visible rectangle (above). */
type Rule = 'cover' | 'contain' | 'holds'

const ruleOf = (sheet: PlanSheet): Rule => (sheet.original ? 'holds' : sheet.mode === 'fit' ? 'contain' : 'cover')

/**
 * The smallest sheet of shape `a` on which the photo lands (above): its long
 * side stepped a pixel at a time, from an estimate up to the first size that
 * lands, then down until K sizes in a row do not.
 */
function nativeSheet(a: number, width: number, rule: Rule, photo: PlanPhoto): { w: number; h: number } {
  const mw = Math.max(1, photo.width)
  const mh = Math.max(1, photo.height)
  const zoom = rule === 'contain' ? 1 : Math.max(1, photo.scale)
  // What has to land: the photo, or on Original the part of it the sheet shows.
  const { vw: pw, vh: ph } = rule === 'holds' ? originalVisible(mw, mh) : { vw: mw, vh: mh }
  const landscape = a > 1
  const at = (L: number) => (landscape ? { w: L, h: Math.max(1, Math.round(L / a)) } : { w: Math.max(1, Math.round(L * a)), h: L })
  const lands = (L: number): boolean => {
    const { w, h } = at(L)
    const b = borderPx(width, w, h)
    const vw = w - 2 * b
    const vh = h - 2 * b
    if (rule === 'cover') return vw * zoom >= pw || vh * zoom >= ph
    if (rule === 'contain') return vw >= pw && vh >= ph
    return vw * zoom >= pw && vh * zoom >= ph
  }
  // The estimate, unrounded: the sheet's sides are (fw, fh) x L, its visible
  // ones (fw - 2 width, fh - 2 width) x L.
  const fw = landscape ? 1 : a
  const fh = landscape ? 1 / a : 1
  if (Math.min(fw, fh) <= 2 * width) throw new Error(`A frame of ${width} leaves nothing of a ${a} sheet.`)
  const needW = pw / zoom / (fw - 2 * width)
  const needH = ph / zoom / (fh - 2 * width)
  let L = Math.max(1, Math.round(rule === 'cover' ? Math.min(needW, needH) : Math.max(needW, needH)))
  while (!lands(L)) L++
  const K = width > 0 ? Math.min(1000, Math.ceil(1 / width)) : 1
  let smallest = L
  for (let fails = 0; L > 1 && fails < K; ) {
    L--
    if (lands(L)) {
      smallest = L
      fails = 0
    } else fails++
  }
  return at(smallest)
}

/**
 * @param sheet the sheet's shape, whether it is Original, its frame and mode.
 * @param opts.maxHeight a height the caller will not go above (a smaller copy).
 * @param opts.format the file it is saved as: a JPEG cannot hold an edge
 *               over 65,535 px; a PNG (and no format) has no such limit.
 */
export function planExport(
  sheet: PlanSheet,
  photo: PlanPhoto | null,
  opts: { maxHeight?: number; format?: 'jpeg' | 'png' } = {},
): ExportPlan {
  const a = sheet.aspect
  if (!(a > 0) || !Number.isFinite(a)) throw new RangeError(`Not a sheet aspect: ${a}`)
  // A frame round nothing is not a print: without a photo there is none.
  const width = photo ? (sheet.width ?? 0) : 0
  const rule = ruleOf(sheet)
  const atHeight = (h: number) => ({ w: Math.max(1, Math.round(h * a)), h })

  let size: { w: number; h: number }
  let limit: PlanLimit
  let nativeHeight = 0
  if (photo) {
    const native = nativeSheet(a, width, rule, photo)
    nativeHeight = native.h
    if (native.h >= REFERENCE_HEIGHT) {
      size = native
      limit = 'native'
    } else {
      size = atHeight(REFERENCE_HEIGHT)
      limit = 'floor'
    }
  } else {
    size = atHeight(NO_PHOTO_HEIGHT)
    limit = 'none'
  }

  if (opts.maxHeight !== undefined && opts.maxHeight < size.h) {
    size = atHeight(Math.max(1, Math.floor(opts.maxHeight)))
    limit = 'smaller'
  }
  // A JPEG's frame header holds an edge of at most 65,535: the largest height
  // whose width (rounded) and height both fit.
  if (opts.format === 'jpeg' && Math.max(size.w, size.h) > JPEG_MAX_EDGE) {
    let h = Math.min(size.h, JPEG_MAX_EDGE)
    while (h > 1 && Math.round(h * a) > JPEG_MAX_EDGE) h--
    size = atHeight(h)
    limit = 'format'
  }

  const border = borderPx(width, size.w, size.h)
  let upscale: number | null = null
  if (photo) {
    const rw = (size.w - 2 * border) / Math.max(1, photo.width)
    const rh = (size.h - 2 * border) / Math.max(1, photo.height)
    upscale = rule === 'contain' ? Math.min(rw, rh) : Math.max(rw, rh) * Math.max(1, photo.scale)
  }
  return { width: size.w, height: size.h, border, limit, nativeHeight, upscale }
}
