/**
 * Taking a photo in from the picker.
 *
 * Two things happen before anything is stored: the file is decoded, and it is
 * downscaled to a bounded long edge. Storing the original would mean decoding
 * a 12-megapixel image on every render, and holding several of those decoded
 * is exactly the memory profile that gets a tab killed on iOS (playbook §4.2).
 *
 * The downscale is done once, here, so every later step — render, export,
 * reload — works from something already small enough.
 */

import { MAX_EDGE, putMedia } from '../../state/mediaStore.ts'
import type { MediaLayer } from '../../engine/types.ts'

export interface ImportedMedia {
  layer: MediaLayer
  bitmap: ImageBitmap
}

let seq = 0
const nextId = () => `media-${Date.now().toString(36)}-${seq++}`

/** Scale so the long edge is at most MAX_EDGE. Never upscales — enlarging a
 *  small image here would only cost memory to blur it. */
function fitted(w: number, h: number): { w: number; h: number } {
  const long = Math.max(w, h)
  if (long <= MAX_EDGE) return { w, h }
  const k = MAX_EDGE / long
  return { w: Math.round(w * k), h: Math.round(h * k) }
}

export async function importMedia(file: File): Promise<ImportedMedia> {
  const source = await createImageBitmap(file)
  const size = fitted(source.width, source.height)

  const canvas = document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not prepare the image.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, size.w, size.h)
  // The full-size decode is done with; let it go before allocating the blob.
  source.close()

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))),
      'image/jpeg',
      0.92,
    ),
  )

  const id = nextId()
  await putMedia(id, blob)

  return {
    layer: {
      id,
      width: size.w,
      height: size.h,
      scale: 1,
      x: 0.5,
      y: 0.5,
      opacity: 1,
      printed: false,
      inkId: 'black',
      contrast: 1,
      lift: 0.1,
    },
    bitmap: await createImageBitmap(blob),
  }
}
