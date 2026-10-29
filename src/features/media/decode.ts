/**
 * Decoding a stored photo, four ways, one rule each.
 *
 *  - At import, in full, only to learn its true size the right way up (and
 *    that this browser can read it at all); the decode is closed at once.
 *  - For the preview, a WORKING copy as large as the preview needs at the
 *    photo's zoom (`previewArea`): 4 MP at 100%, more as the person zooms in
 *    to crop, never more than PREVIEW_PHOTO_AREA_LARGEST or the photo itself. The preview is at
 *    most a megapixel on screen, and a 24 MP photo held decoded for it at
 *    100% would be 98 MB of the phone's memory for pixels nobody sees.
 *    Geometry never reads this copy's size — the cover fit, the pan and the
 *    export plan all use the photo's TRUE size from the document, and the
 *    copy is drawn scaled into that same rectangle.
 *  - For Save, the ORIGINAL in full, so the print is drawn from the original's
 *    pixels, never from the preview's copy. Closed as soon as its last rows
 *    are in the print.
 *  - For a smaller copy the person chose, the photo decoded straight to the
 *    copy's rectangle (`decodeResized`), so it is resampled once, by the
 *    decoder, and drawn 1:1.
 *
 * The frame's colours are read from one more, of a fixed size
 * (frameSource.ts), made after the preview's copy and before Save's original.
 *
 * Every decode applies the photo's EXIF orientation, so the size the document
 * stores and every bitmap drawn from it agree on which way up it is.
 */

import { MissingPhotoError } from '../../engine/export.ts'
import { borderPx } from '../../engine/frame.ts'
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
 * The largest working copy the preview decodes, zoomed far in: 16,777,216 px
 * (16.8 MP, 67 MB). A memory bound for the preview alone; the print is pressed
 * from the original, whatever its size.
 */
export const PREVIEW_PHOTO_AREA_LARGEST = 16_777_216

/**
 * The working copy's size for a photo at its zoom on a sheet: enough pixels
 * that the preview shows the photo one copy pixel or more to each preview
 * pixel, in tiers that double from PREVIEW_PHOTO_AREA up to
 * PREVIEW_PHOTO_AREA_LARGEST (4.2,
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
export function previewArea(
  photo: { width: number; height: number; scale: number },
  aspect: number,
  /** The sheet's frame: its width, and how the layout places the photo
   *  (frame.ts `effectiveMode`). Unframed Crop by default. */
  frame: { width: number; mode: 'crop' | 'fit' } = { width: 0, mode: 'crop' },
): number {
  const mw = Math.max(1, photo.width)
  const mh = Math.max(1, photo.height)
  const { w, h } = previewSize(aspect)
  // Preview pixels per photo pixel, as the layout draws it: the cover of the
  // visible rectangle at the zoom (Crop, Original), or contained in it (Fit,
  // where the zoom is not read). A frame takes its border off the sheet, so
  // a framed photo is drawn smaller and needs no larger a copy.
  const b = borderPx(frame.width, w, h)
  const vw = w - 2 * b
  const vh = h - 2 * b
  const s = frame.mode === 'fit' ? Math.min(vw / mw, vh / mh) : Math.max(vw / mw, vh / mh) * Math.max(1, photo.scale)
  const needed = mw * mh * s * s
  let area = PREVIEW_PHOTO_AREA
  while (area < needed && area < PREVIEW_PHOTO_AREA_LARGEST) area = Math.min(PREVIEW_PHOTO_AREA_LARGEST, area * 2)
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

/** A decode for Save that failed: which photo step, with the browser's own
 *  reason (`reason`, e.g. WebKit's "Cannot create an image buffer from the
 *  argument to createImageBitmap"). */
export class PhotoDecodeError extends Error {
  constructor(readonly reason: string) {
    super(`The photo could not be decoded to save: ${reason}`)
    this.name = 'PhotoDecodeError'
  }
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The original, in full, for Save. The caller closes it. */
export async function decodeOriginal(id: string): Promise<ImageBitmap> {
  const blob = await getMedia(id)
  if (!blob) throw new MissingPhotoError()
  try {
    return await decodeOriented(blob)
  } catch (err) {
    throw new PhotoDecodeError(reasonOf(err))
  }
}

/**
 * The photo decoded straight to `width` x `height` (its oriented shape at
 * that size), for a smaller copy: one resample, by the decoder, at 'high'.
 * Unlike the preview's copy it has no fallback to a full decode (the very
 * thing that may just have failed): a decode of any other size is an error.
 * The caller closes it.
 */
export async function decodeResized(id: string, width: number, height: number): Promise<ImageBitmap> {
  const blob = await getMedia(id)
  if (!blob) throw new MissingPhotoError()
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  } catch (err) {
    throw new PhotoDecodeError(reasonOf(err))
  }
  if (bmp.width !== width || bmp.height !== height) {
    const got = `${bmp.width}×${bmp.height}`
    bmp.close()
    throw new PhotoDecodeError(`it decoded at ${got}, not the ${width}×${height} asked for`)
  }
  return bmp
}
