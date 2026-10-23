/**
 * Decoding a stored photo, three ways, one rule each.
 *
 *  - At import, in full, only to learn its true size the right way up (and
 *    that this browser can read it at all); the decode is closed at once.
 *  - For the preview, a WORKING copy no larger than PREVIEW_PHOTO_AREA. The
 *    preview is not the product: it is at most a megapixel on screen, and a
 *    24 MP photo held decoded for it would be 98 MB of the phone's memory for
 *    pixels nobody sees. Geometry never reads this copy's size — the cover
 *    fit, the pan and the export plan all use the photo's TRUE size from the
 *    document, and the copy is drawn scaled into that same rectangle.
 *  - For Save, the ORIGINAL in full, so the print is pressed from every pixel
 *    the photo has, never from the preview's copy. Closed as soon as the
 *    ground is drawn.
 *
 * Every decode applies the photo's EXIF orientation, so the size the document
 * stores and every bitmap drawn from it agree on which way up it is.
 */

import { getMedia } from '../../state/mediaStore.ts'

/**
 * The preview's working copy, at most 4,194,304 px (2048 x 2048). By area, so
 * a reduced copy's long edge is never under 2048 px: the preview never shows a
 * photo with fewer pixels than the 2048 px copy the app used to store. That is
 * more than a 1000 px preview needs at the cover fit, with room to zoom (to
 * about 175% for a 4:3 photo on a 4:5 sheet) before the preview is softer than
 * the print — which Save presses from the original either way.
 */
export const PREVIEW_PHOTO_AREA = 4_194_304

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

/** The stored photo is gone (cleared site data, another device's document). */
export class MissingPhotoError extends Error {
  constructor() {
    super('This photo could not be loaded. Choose it again.')
    this.name = 'MissingPhotoError'
  }
}

/**
 * The preview's working copy of a stored photo, from its true oriented size.
 * If an engine hands back a resized copy of the wrong shape (a resize applied
 * before the rotation would squash it), the copy is dropped for a full decode:
 * a slower preview, never a distorted one.
 */
export async function decodePreview(id: string, width: number, height: number): Promise<ImageBitmap> {
  const blob = await getMedia(id)
  if (!blob) throw new MissingPhotoError()
  const size = workingSize(width, height)
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
