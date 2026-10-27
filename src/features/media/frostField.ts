/**
 * Frosted's fields (engine/frost.ts), made from the photo's frame source and
 * kept: one per (photo, sheet shape, blur, field size), a few at a time, the
 * most recently used kept, and every one of another photo let go when a
 * photo's is asked for. Made here, in the page, and handed to the engine
 * (`FrameInputs.frost`); never in the engine's render cache, so a Width,
 * Corners or Blur change never re-rasterises the type.
 *
 * A field is tens of milliseconds to make at 480 px and about one at the
 * draft's 160, so a Blur drag makes a draft field a frame, and the settled
 * one once it rests.
 */

import { frostField, type FrostField } from '../../engine/frost.ts'
import type { RgbaImage } from '../../engine/resample.ts'

/** How many fields are kept: the settled and the draft field of the sheet
 *  as it is, and of the one before a change, with room for one more. */
const KEPT = 5

export function frostFields(kept = KEPT) {
  let held: { key: string; mediaId: string; field: FrostField }[] = []
  return {
    /** The field of photo `mediaId` (its frame source `src`) for a sheet of
     *  `aspect`, at `blur`, `fieldLong` on its long side: kept, or made. */
    field(mediaId: string, src: RgbaImage, aspect: number, blur: number, fieldLong: number): FrostField {
      const key = `${aspect}|${blur}|${fieldLong}`
      held = held.filter((e) => e.mediaId === mediaId)
      const at = held.findIndex((e) => e.key === key)
      const entry = at >= 0 ? held.splice(at, 1)[0] : { key, mediaId, field: frostField(src, aspect, fieldLong, blur) }
      held.unshift(entry)
      held.length = Math.min(held.length, kept)
      return entry.field
    },
  }
}

/** The page's. */
export const pageFrostFields = frostFields()
