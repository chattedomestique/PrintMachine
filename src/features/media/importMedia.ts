/**
 * Taking a photo in from the picker: stored exactly as it came.
 *
 * The bytes the picker hands over are the bytes kept — never resampled, never
 * re-encoded, whatever the size. The rule is "no down-rezzing at ALL", and a
 * canvas round-trip here was the one place that broke it on every photo: it
 * cut each import to 2048 px and re-encoded it as a 0.92 JPEG (a transparent
 * PNG came out black).
 *
 * What does have a limit is a CANVAS, not a stored file, so the limits live
 * where canvases are made: the preview decodes a working copy (decode.ts) and
 * the export is bounded by its canvas's area (exportPlan.ts).
 *
 * The one decode here is to learn the photo's true size the right way up, and
 * that this browser can read it at all (we ship no HEIC decoder: a format the
 * browser cannot open is refused, plainly). It is closed before anything is
 * stored.
 */

import { putMedia } from '../../state/mediaStore.ts'
import { makeMedia } from '../../state/defaults.ts'
import type { MediaLayer } from '../../engine/types.ts'
import { decodeOriented } from './decode.ts'

export interface ImportedMedia {
  layer: MediaLayer
}

/** What an import needs from the platform, injected so the rule — the stored
 *  bytes are the picked bytes — is tested in node. */
export interface ImportDeps {
  /** Decode with the EXIF orientation applied; throws if it cannot. */
  decode: (blob: Blob) => Promise<{ width: number; height: number; close(): void }>
  put: (id: string, blob: Blob) => Promise<void>
  now: () => number
}

const browser: ImportDeps = { decode: (blob) => decodeOriented(blob), put: putMedia, now: () => Date.now() }

let seq = 0
/** `media-<creation time, base 36>-<n>`: the launch sweep reads the time back
 *  (mediaStore.ts `mediaCreatedAt`), so a fresh import is never swept. */
const nextId = (now: number) => `media-${now.toString(36)}-${seq++}`

export async function importMedia(file: Blob, deps: ImportDeps = browser): Promise<ImportedMedia> {
  let size: { width: number; height: number }
  try {
    const bmp = await deps.decode(file)
    try {
      size = { width: bmp.width, height: bmp.height }
    } finally {
      bmp.close()
    }
  } catch {
    throw new Error('That image could not be read.')
  }

  const id = nextId(deps.now())
  // A Blob of the same bytes, not the File itself: it costs nothing and does
  // not lean on File-in-IndexedDB, which Safari has not always kept.
  await deps.put(id, new Blob([file], { type: file.type }))

  // The size is the ORIGINAL's, upright. It is what the cover fit, the pan
  // and the export plan read, whatever copy the preview happens to draw.
  return { layer: makeMedia({ id, width: size.width, height: size.height, native: true }) }
}
