/**
 * The photo's keys, with the Frame tool open on Crop or Original (Border
 * Studio's, BorderCanvas `handleCanvasKeyDown`): the keyboard path to what
 * dragging and pinching the photo do (WCAG 2.1.1).
 *
 *  - The arrows move the VIEW over the photo, as Border Studio's do: Right and
 *    Down show more of the photo's right and bottom, so they raise its
 *    Position X and Y (media.ts `panFraction`) and move its centre left and
 *    up on the sheet, the opposite of a plate's arrows, which move the plate.
 *    One press moves the photo by 0.06 of its drawn size at 100% (Border
 *    Studio's 0.06 / zoom of the photo, at the current zoom), whatever the
 *    zoom, so a press is the same distance on screen at every zoom.
 *  - Plus (or =) and minus (or _) zoom by 1.15 within 100% to 400%, about
 *    the middle of the frame (Border Studio's keys leave the view's centre
 *    where it is): what is in the middle stays there.
 *  - 0 puts it back at 100% and centred.
 *
 * Everything lands through `clampPan` on the visible rectangle, so no key
 * uncovers it. The arrows and the zoom are part of a run (one undo step for a
 * burst of presses, as a plate's keys are); 0 is a step of its own, as the
 * double tap's reset is.
 *
 * Pure: the caller hands in the photo and the visible rectangle's shape.
 */

import { areaOf, clampPan, type MediaPlacement, type MediaSize } from '../../engine/media.ts'
import { MEDIA_FIELDS } from '../../state/fields.ts'

/** One arrow press, as a fraction of the photo's drawn size at 100%. */
export const PHOTO_KEY_STEP = 0.06
/** One plus or minus press: a zoom of this factor. */
export const PHOTO_KEY_ZOOM = 1.15
/** The zoom's range: the schema's, read, never retyped (as Zoom's slider). */
const SCALE = MEDIA_FIELDS.find((r) => r.key === 'scale')!
const ZOOM_MIN = SCALE.min!
const ZOOM_MAX = SCALE.max!

/** The keys the photo answers to, as `aria-keyshortcuts` names them. */
export const PHOTO_KEYS = 'ArrowUp ArrowDown ArrowLeft ArrowRight + - 0'

/** What a key does to the photo: its new placement, and whether it joins a
 *  run (a burst of presses is one undo step). Null for a key it ignores. */
export interface PhotoKeyChange {
  patch: MediaPlacement
  coalesce: boolean
}

/**
 * The change `key` makes to `media` placed on a visible rectangle of shape
 * `aspect` (frame.ts `visibleAspect`).
 */
export function photoKey(key: string, media: MediaSize & MediaPlacement, aspect: number): PhotoKeyChange | null {
  const area = areaOf(aspect, 1)
  const mw = Math.max(1, media.width)
  const mh = Math.max(1, media.height)
  // The drawn size at 100% (the cover fit), over the area's: one press moves
  // the centre by PHOTO_KEY_STEP of it.
  const cover = Math.max(area.w / mw, area.h / mh)
  const dx = (PHOTO_KEY_STEP * mw * cover) / area.w
  const dy = (PHOTO_KEY_STEP * mh * cover) / area.h
  const placed = (p: MediaPlacement): MediaPlacement => {
    const c = clampPan({ ...media, ...p }, area)
    return { scale: c.scale, x: c.x, y: c.y }
  }
  const at = { scale: media.scale, x: media.x, y: media.y }
  // A zoom about the middle of the visible rectangle (0.5, 0.5): the photo's
  // centre moves away from it, or towards it, by the zoom's ratio.
  const zoomTo = (scale: number): MediaPlacement => {
    const k = scale / Math.max(1e-9, media.scale)
    return placed({ scale, x: 0.5 - (0.5 - media.x) * k, y: 0.5 - (0.5 - media.y) * k })
  }
  switch (key) {
    case 'ArrowRight':
      return { patch: placed({ ...at, x: media.x - dx }), coalesce: true }
    case 'ArrowLeft':
      return { patch: placed({ ...at, x: media.x + dx }), coalesce: true }
    case 'ArrowDown':
      return { patch: placed({ ...at, y: media.y - dy }), coalesce: true }
    case 'ArrowUp':
      return { patch: placed({ ...at, y: media.y + dy }), coalesce: true }
    case '+':
    case '=':
      return { patch: zoomTo(Math.min(ZOOM_MAX, media.scale * PHOTO_KEY_ZOOM)), coalesce: true }
    case '-':
    case '_':
      return { patch: zoomTo(Math.max(ZOOM_MIN, media.scale / PHOTO_KEY_ZOOM)), coalesce: true }
    case '0':
      return { patch: { scale: 1, x: 0.5, y: 0.5 }, coalesce: false }
    default:
      return null
  }
}
