/**
 * What the frame's photo-keyed fills are made from: the photo decoded ONCE,
 * at a fixed size (FRAME_SOURCE_LONG on its long side, never above its own),
 * and read back. One decode serves the palette (its small sample, here) and
 * Frosted's field.
 *
 * Fixed, not the preview's working copy: that copy's size moves with the
 * zoom (decode.ts `previewArea`), and colours read from it would depend on
 * the zoom the photo was chosen at. A third decode of the photo (beside the
 * preview's copy and Save's original), made after the preview's copy has
 * landed and before Save decodes the original, never alongside it; it holds
 * a 1024 px image (2.8 MB for a 3:2 photo), once, for the photo in hand.
 */

import { MissingPhotoError } from '../../engine/export.ts'
import { FRAME_SOURCE_LONG, PALETTE_SAMPLE } from '../../engine/limits.ts'
import { areaAverage, type RgbaImage } from '../../engine/resample.ts'
import { getMedia } from '../../state/mediaStore.ts'
import { decodeOriented } from './decode.ts'

/** The size the frame's source is decoded at: the photo's own shape, its
 *  long side FRAME_SOURCE_LONG, or the photo as it is when it is smaller. */
export function frameSourceSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= FRAME_SOURCE_LONG) return { width, height }
  const k = FRAME_SOURCE_LONG / long
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** The frame's source could not be made: the photo's bytes are there (or the
 *  preview could not have drawn it), but this decode of them failed. */
export class FrameSourceError extends Error {
  constructor(readonly reason: string) {
    super(`The photo's colours could not be read: ${reason}`)
    this.name = 'FrameSourceError'
  }
}

/** What making the source needs from the page (a test hands in its own). */
export interface FrameSourceDeps {
  getBlob(id: string): Promise<Blob | null>
  /** Decode with the EXIF orientation applied, resized to `size` when given
   *  and the engine honours it (decode.ts `decodeOriented`). */
  decode(blob: Blob, size?: { width: number; height: number }): Promise<{ width: number; height: number; close(): void }>
  /** The decode drawn into a w x h canvas and read back as RGBA; the canvas
   *  let go. */
  read(bitmap: { width: number; height: number; close(): void }, w: number, h: number): Uint8ClampedArray
}

const PAGE: FrameSourceDeps = {
  getBlob: getMedia,
  decode: decodeOriented,
  read: (bitmap, w, h) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new FrameSourceError('no canvas to read it into')
    try {
      ctx.canvas.width = w
      ctx.canvas.height = h
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap as ImageBitmap, 0, 0, w, h)
      return ctx.getImageData(0, 0, w, h).data
    } finally {
      ctx.canvas.width = 0
    }
  },
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The photo's frame source, decoded at `frameSourceSize` and read back. Never
 * a read-back larger than that size: an engine that ignores the resize (it
 * hands back the photo whole) has its decode drawn into a canvas of the
 * source's size, and one that resizes before it rotates (a squashed copy) is
 * decoded again whole, the right way up, and drawn the same way.
 */
async function decodeSource(media: { id: string; width: number; height: number }, deps: FrameSourceDeps): Promise<RgbaImage> {
  const blob = await deps.getBlob(media.id)
  if (!blob) throw new MissingPhotoError()
  const size = frameSourceSize(media.width, media.height)
  const shape = media.width / media.height
  const shaped = (b: { width: number; height: number }) => Math.abs(b.width / b.height - shape) <= 0.01 * shape
  let bmp: { width: number; height: number; close(): void }
  try {
    bmp = await deps.decode(blob, size)
    if (!shaped(bmp)) {
      bmp.close()
      bmp = await deps.decode(blob)
    }
  } catch (err) {
    throw new FrameSourceError(reasonOf(err))
  }
  try {
    if (!shaped(bmp)) throw new FrameSourceError(`it decoded at ${bmp.width}×${bmp.height}, not the shape of ${media.width}×${media.height}`)
    return { w: size.width, h: size.height, rgba: deps.read(bmp, size.width, size.height) }
  } finally {
    bmp.close()
  }
}

/**
 * The frame sources, one photo's at a time: asked for another photo, the
 * one held is let go. A failure is kept with its photo (asked again, it
 * fails again, without another decode): a new photo is a new id.
 */
export function frameSources(deps: FrameSourceDeps = PAGE) {
  let held: { id: string; source: Promise<RgbaImage> } | null = null
  return {
    load(media: { id: string; width: number; height: number }): Promise<RgbaImage> {
      if (held?.id !== media.id) held = { id: media.id, source: decodeSource(media, deps) }
      return held.source
    },
  }
}

/** The page's. */
export const pageFrameSources = frameSources()

/**
 * The palette's sample of the source: the whole photo area-averaged to
 * PALETTE_SAMPLE on its long side (Border Studio's sample size; it drew the
 * photo into a canvas that size), as RGBA bytes.
 */
export function paletteSample(src: RgbaImage): Uint8ClampedArray {
  const k = Math.min(1, PALETTE_SAMPLE / Math.max(src.w, src.h))
  const w = Math.max(1, Math.round(src.w * k))
  const h = Math.max(1, Math.round(src.h * k))
  return Uint8ClampedArray.from(areaAverage(src, { x: 0, y: 0, w: src.w, h: src.h }, w, h))
}
