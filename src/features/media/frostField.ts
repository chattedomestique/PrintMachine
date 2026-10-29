/**
 * Frosted's fields (engine/frost.ts), made from the photo's frame source and
 * kept: one per (photo, sheet shape, blur, field size), a few at a time, the
 * most recently used kept, and every one of another photo let go when a
 * photo's is asked for. Made here, in the page, and handed to the engine
 * (`FrameInputs.frost`); never in the engine's render cache, so a Width,
 * Corners or Blur change never re-rasterises the type.
 *
 * The photo cover-filled into a field of the sheet's shape (`frostCover`,
 * an area average of the whole 1024 px source, most of a field's cost) does
 * not change with Blur, so it is kept too, per (photo, sheet shape, field
 * size): a Blur drag runs only the three box passes and the grade a frame,
 * about 2 ms over a draft frame in Chromium (the harness's `--frame-cost`;
 * a whole field was 10 to 14 ms at the draft's 160 and 31 to 37 at 480).
 */

import { frostBlur, frostCover, type FrostCover, type FrostField } from '../../engine/frost.ts'
import type { RgbaImage } from '../../engine/resample.ts'

/** How many fields are kept: the settled and the draft field of the sheet
 *  as it is, and of the one before a change, with room for one more. */
const KEPT = 5

/** How many covers: the settled and the draft one of the sheet's shape, and
 *  one of the shape before. */
const COVERS_KEPT = 3

/** Values of one photo, by key: the most recently used first, `kept` at
 *  most; asking for another photo's lets every one of the last photo's go. */
function keptOf<T>(kept: number) {
  let held: { key: string; mediaId: string; value: T }[] = []
  return (mediaId: string, key: string, make: () => T): T => {
    held = held.filter((e) => e.mediaId === mediaId)
    const at = held.findIndex((e) => e.key === key)
    const entry = at >= 0 ? held.splice(at, 1)[0] : { key, mediaId, value: make() }
    held.unshift(entry)
    held.length = Math.min(held.length, kept)
    return entry.value
  }
}

/** What a field is made with (a test counts the calls). */
export interface FrostMakers {
  cover: (src: RgbaImage, aspect: number, fieldLong: number) => FrostCover
  blur: (cover: FrostCover, blur: number) => FrostField
}

export function frostFields(kept = KEPT, make: FrostMakers = { cover: frostCover, blur: frostBlur }) {
  const fields = keptOf<FrostField>(kept)
  const covers = keptOf<FrostCover>(COVERS_KEPT)
  return {
    /** The field of photo `mediaId` (its frame source `src`) for a sheet of
     *  `aspect`, at `blur`, `fieldLong` on its long side: kept, or made (from
     *  its kept cover when there is one). */
    field(mediaId: string, src: RgbaImage, aspect: number, blur: number, fieldLong: number): FrostField {
      return fields(mediaId, `${aspect}|${blur}|${fieldLong}`, () => make.blur(covers(mediaId, `${aspect}|${fieldLong}`, () => make.cover(src, aspect, fieldLong)), blur))
    },
  }
}

/** The page's. */
export const pageFrostFields = frostFields()
