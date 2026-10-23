/**
 * How big a saved print is: the export follows the photo.
 *
 * The rule the user set is "no down-rezzing at ALL", of the photo or of the
 * exported image. So the sheet is exported at the height at which the photo
 * lands on it pixel for pixel — its NATIVE height — and never smaller than
 * the reference height, whatever the photo. The one thing that can bring a
 * print below its photo is the export canvas's own ceiling (MAX_AREA), and the
 * plan says so in `limit` rather than doing it quietly.
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

import { MAX_AREA, NO_PHOTO_HEIGHT, REFERENCE_HEIGHT } from './limits.ts'

/**
 * Why the height is what it is:
 *  - `native`  the photo's own pixels, one for one;
 *  - `floor`   the photo has fewer pixels than the reference height, so it is
 *              enlarged (`upscale` > 1) rather than the print made smaller;
 *  - `none`    no photo: NO_PHOTO_HEIGHT;
 *  - `ceiling` the export canvas's area limit binds, and the print is smaller
 *              than its photo — the one case a photo loses pixels, stated;
 *  - `smaller` the caller asked for a smaller copy (`maxHeight`).
 */
export type PlanLimit = 'native' | 'floor' | 'none' | 'ceiling' | 'smaller'

export interface ExportPlan {
  width: number
  height: number
  limit: PlanLimit
  /** The smallest sheet height at which the photo lands at least 1:1; 0
   *  with no photo. */
  nativeHeight: number
  /** Sheet pixels per photo pixel, as realised: 1 native, above 1 the photo is
   *  enlarged ("photo is 1600 px, upscaled 1.5x"), below 1 it is reduced
   *  (only at the ceiling or for a smaller copy). Null with no photo. */
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
 */
export function planExport(aspect: number, photo: PlanPhoto | null, opts: { maxHeight?: number } = {}): ExportPlan {
  if (!(aspect > 0) || !Number.isFinite(aspect)) throw new RangeError(`Not a sheet aspect: ${aspect}`)
  const a = aspect

  let nativeHeight = 0
  let wanted: number
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
    wanted = Math.max(REFERENCE_HEIGHT, nativeHeight)
    limit = nativeHeight >= REFERENCE_HEIGHT ? 'native' : 'floor'
  } else {
    wanted = NO_PHOTO_HEIGHT
    limit = 'none'
  }

  // The area ceiling, floored so the sheet is never over it; then, since the
  // width rounds, walked down until width x height really is within it.
  let height = Math.min(wanted, Math.floor(Math.sqrt(MAX_AREA / a)))
  if (height < wanted) limit = 'ceiling'
  if (opts.maxHeight !== undefined && opts.maxHeight < height) {
    height = Math.floor(opts.maxHeight)
    limit = 'smaller'
  }
  height = Math.max(1, height)
  while (height > 1 && Math.round(height * a) * height > MAX_AREA) {
    height--
    if (limit !== 'smaller') limit = 'ceiling'
  }
  const width = Math.max(1, Math.round(height * a))

  const upscale = photo
    ? Math.max(width / Math.max(1, photo.width), height / Math.max(1, photo.height)) * Math.max(1, photo.scale)
    : null

  return { width, height, limit, nativeHeight, upscale }
}
