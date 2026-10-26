/**
 * How big a saved print is: the export follows the photo.
 *
 * The rule the user set is "no down-rezzing at ALL", of the photo or of the
 * exported image. So the sheet is exported at the height at which the photo
 * lands on it pixel for pixel — its NATIVE height — and never smaller than
 * the reference height, whatever the photo, and whatever its size: there is
 * no ceiling (the print is pressed in bands and encoded as it is pressed, so
 * no canvas or array of the sheet's size exists to hold it back). The one
 * limit left is the JPEG container's own (65,535 px a side), which only a
 * photo wider than that meets, and the plan says so in `limit`.
 *
 * Pure: no DOM. The renderer is handed `height` and computes the width from
 * the same aspect (`round(height x aspect)`), so this and the canvas can never
 * disagree.
 *
 * Derivation. The photo is drawn at the cover fit times the zoom: sheet
 * pixels per photo pixel `s = max(W / mw, H / mh) x zoom`. It lands 1:1
 * (`s = 1`) at `H = min(mh, mw / a) / zoom`; rounded up (and the width's own
 * rounding allowed for), `s` is at least 1 and over it by a pixel's worth at
 * most: the photo is never sampled down. Pan moves the photo without changing
 * its density, so it never enters.
 *
 * Save presses at `height` (export.ts `savePrint`, through `planPrint`).
 */

import { JPEG_MAX_EDGE } from './encode/jpeg.ts'
import { NO_PHOTO_HEIGHT, REFERENCE_HEIGHT } from './limits.ts'

/**
 * Why the height is what it is:
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
  limit: PlanLimit
  /** The smallest sheet height at which the photo lands at least 1:1; 0
   *  with no photo. */
  nativeHeight: number
  /** Sheet pixels per photo pixel, as realised: 1 native, above 1 the photo is
   *  enlarged ("photo is 1600 px, upscaled 1.5x"), below 1 it is reduced
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

/**
 * @param aspect the sheet's width over its height, as a number (any positive
 *               value: an Original sheet can be wider than it is tall).
 * @param opts.maxHeight a height the caller will not go above (a smaller copy).
 * @param opts.format the file it is saved as: a JPEG cannot hold an edge
 *               over 65,535 px; a PNG (and no format) has no such limit.
 */
export function planExport(
  aspect: number,
  photo: PlanPhoto | null,
  opts: { maxHeight?: number; format?: 'jpeg' | 'png' } = {},
): ExportPlan {
  if (!(aspect > 0) || !Number.isFinite(aspect)) throw new RangeError(`Not a sheet aspect: ${aspect}`)
  const a = aspect

  let nativeHeight = 0
  let height: number
  let limit: PlanLimit
  if (photo) {
    const mw = Math.max(1, photo.width)
    const mh = Math.max(1, photo.height)
    const zoom = Math.max(1, photo.scale)
    // The photo lands at least 1:1 on a sheet this tall (s >= 1). The width
    // is round(height x a), so where the width binds its rounding can leave
    // the sheet a fraction of a pixel narrower than the photo (sampled down by
    // under a pixel, which is still sampled down) or wide enough a row early.
    // `lands` grows with the height, so step from the estimate to the
    // smallest height that lands: a row or two at most.
    const lands = (h: number) => Math.round(h * a) * zoom >= mw || h * zoom >= mh
    nativeHeight = Math.ceil(Math.min(mh, mw / a) / zoom)
    while (!lands(nativeHeight)) nativeHeight++
    while (nativeHeight > 1 && lands(nativeHeight - 1)) nativeHeight--
    height = Math.max(REFERENCE_HEIGHT, nativeHeight)
    limit = nativeHeight >= REFERENCE_HEIGHT ? 'native' : 'floor'
  } else {
    height = NO_PHOTO_HEIGHT
    limit = 'none'
  }

  if (opts.maxHeight !== undefined && opts.maxHeight < height) {
    height = Math.max(1, Math.floor(opts.maxHeight))
    limit = 'smaller'
  }
  // A JPEG's frame header holds an edge of at most 65,535: the largest height
  // whose width (rounded) and height both fit.
  if (opts.format === 'jpeg' && Math.max(height, Math.round(height * a)) > JPEG_MAX_EDGE) {
    height = Math.min(height, JPEG_MAX_EDGE)
    while (height > 1 && Math.round(height * a) > JPEG_MAX_EDGE) height--
    limit = 'format'
  }
  const width = Math.max(1, Math.round(height * a))

  const upscale = photo
    ? Math.max(width / Math.max(1, photo.width), height / Math.max(1, photo.height)) * Math.max(1, photo.scale)
    : null

  return { width, height, limit, nativeHeight, upscale }
}
