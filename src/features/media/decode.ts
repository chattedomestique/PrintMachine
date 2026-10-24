/**
 * Decoding a stored photo, three ways, one rule each.
 *
 *  - At import, in full, only to learn its true size the right way up (and
 *    that this browser can read it at all); the decode is closed at once.
 *  - For the preview, a WORKING copy as large as the preview needs at the
 *    photo's zoom (`previewArea`): 4 MP at 100%, more as the person zooms in
 *    to crop, never more than MAX_AREA or the photo itself. The preview is at
 *    most a megapixel on screen, and a 24 MP photo held decoded for it at
 *    100% would be 98 MB of the phone's memory for pixels nobody sees.
 *    Geometry never reads this copy's size — the cover fit, the pan and the
 *    export plan all use the photo's TRUE size from the document, and the
 *    copy is drawn scaled into that same rectangle.
 *  - For Save, the ORIGINAL in full, so the print is drawn from the original's
 *    pixels, never from the preview's copy. Closed as soon as the ground is
 *    drawn.
 *
 * Every decode applies the photo's EXIF orientation, so the size the document
 * stores and every bitmap drawn from it agree on which way up it is.
 */

import { MissingPhotoError } from '../../engine/export.ts'
import { MAX_AREA } from '../../engine/limits.ts'
import { previewSize } from '../../engine/render.ts'
import { getMedia } from '../../state/mediaStore.ts'

/**
 * The preview's working copy at 100%, and the smallest it is ever decoded at:
 * 4,194,304 px (2048 x 2048). By area, so a reduced copy's long edge is never
 * under 2048 px: the preview never shows a photo with fewer pixels than the
 * 2048 px copy the app used to store. That is more than a 1000 px preview needs
 * at the cover fit, for every photo and sheet.
 */
export const PREVIEW_PHOTO_AREA = 4_194_304

/**
 * The working copy's size for a photo at its zoom on a sheet: enough pixels
 * that the preview shows the photo one copy pixel or more to each preview
 * pixel, in tiers that double from PREVIEW_PHOTO_AREA up to MAX_AREA (4.2,
 * 8.4, 16.8 MP; a photo smaller than its tier is decoded as it is).
 *
 * Zooming in to crop is ordinary, and a copy fixed at 4 MP went soft under the
 * person's eye as they did it (a 12 MP 4:3 photo on 4:5 was stretched past
 * 1:1 from 177% and 2.26x at 400%) while the print kept every pixel. The
 * tiers are coarse on purpose: the photo is decoded again only when the zoom
 * rests on a tier whose copy is not the one held, so at most twice over the
 * whole range, and once for a drag that crosses tiers (useMediaBitmap).
 *
 * Memory: the copy grows with the zoom squared, and the export shrinks with
 * it (fewer of the photo's pixels land on the sheet), so a zoomed save holds
 * less than one at 100%, where the copy is 4 MP as before.
 */
export function previewArea(photo: { width: number; height: number; scale: number }, aspect: number): number {
  const mw = Math.max(1, photo.width)
  const mh = Math.max(1, photo.height)
  const { w, h } = previewSize(aspect)
  // Preview pixels per photo pixel, as the cover fit draws it.
  const s = Math.max(w / mw, h / mh) * Math.max(1, photo.scale)
  const needed = mw * mh * s * s
  let area = PREVIEW_PHOTO_AREA
  while (area < needed && area < MAX_AREA) area = Math.min(MAX_AREA, area * 2)
  return area
}

/** The size to decode the working copy at: the photo's own aspect, inside
 *  `area`, or null to decode it as it is (it is already that small). */
export function workingSize(width: number, height: number, area = PREVIEW_PHOTO_AREA): { width: number; height: number } | null {
  if (width * height <= area) return null
  const k = Math.sqrt(area / (width * height))
  return { width: Math.max(1, Math.floor(width * k)), height: Math.max(1, Math.floor(height * k)) }
}

/**
 * Decode with the EXIF orientation applied, optionally resized to `size` (the
 * oriented size: the resize applies to the upright image). An engine that does
 * not know the option (Safari before 15) refuses it with a TypeError; it gets
 * the plain call, which on those engines is the only one there is.
 */
export async function decodeOriented(blob: Blob, size?: { width: number; height: number }): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = { imageOrientation: 'from-image' }
  if (size) Object.assign(options, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' })
  try {
    return await createImageBitmap(blob, options)
  } catch (err) {
    if (!(err instanceof TypeError)) throw err
    return createImageBitmap(blob)
  }
}

/**
 * The preview's working copy of a stored photo, from its true oriented size,
 * at most `area` pixels (`previewArea`). If an engine hands back a resized
 * copy of the wrong shape (a resize applied before the rotation would squash
 * it), the copy is dropped for a full decode: a slower preview, never a
 * distorted one.
 */
export async function decodePreview(id: string, width: number, height: number, area = PREVIEW_PHOTO_AREA): Promise<ImageBitmap> {
  const blob = await getMedia(id)
  if (!blob) throw new MissingPhotoError()
  const size = workingSize(width, height, area)
  const bmp = await decodeOriented(blob, size ?? undefined)
  if (size && Math.abs(bmp.width / bmp.height - width / height) > 0.01 * (width / height)) {
    bmp.close()
    return decodeOriented(blob)
  }
  return bmp
}

/** The original, in full, for Save. The caller closes it. A failure says
 *  which photo step failed, with the browser's reason. */
export async function decodeOriginal(id: string): Promise<ImageBitmap> {
  const blob = await getMedia(id)
  if (!blob) throw new MissingPhotoError()
  try {
    return await decodeOriented(blob)
  } catch (err) {
    throw new Error(`The photo could not be decoded to save: ${err instanceof Error ? err.message : String(err)}`)
  }
}
