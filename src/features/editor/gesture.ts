/**
 * The arithmetic of a gesture on the sheet, kept apart from the pointer
 * bookkeeping (useLayerGestures.ts) so it can be tested without a DOM.
 *
 * A gesture holds the thing it moves, captured when it began: a plate, or the
 * photo presented in the same shape. Every patch it makes is computed from
 * that origin and belongs to that target, by its id — never to whatever the
 * editor happens to have selected when the patch lands. That is what lets a
 * tap pick a plate and drag it in one touch: at the pointer-down that picks
 * it, the editor still has the previous plate selected (the selection is
 * React state, and the next render has not happened yet), so a gesture that
 * read the selection would start from the old plate's place and move it.
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export interface Pt {
  x: number
  y: number
}

/** What a gesture moves. A text layer is one as it is; the photo is presented
 *  as one (its zoom as `size`, no rotation). */
export interface GestureTarget {
  id: string
  x: number
  y: number
  size: number
  rotation: number
}

/** What a gesture writes. */
export type GesturePatch = Partial<Pick<GestureTarget, 'x' | 'y' | 'size' | 'rotation'>>

export interface Gesture {
  /** The target, as it was when the gesture (re)began: the origin of every
   *  patch, and whose patches they are. */
  target: GestureTarget
  /** Centroid of the starting pointers, in element space. */
  startCentroid: Pt
  /** Distance between the two starting pointers (0 for a one-finger drag). */
  startSpread: number
  /** Angle between the two starting pointers, radians. */
  startAngle: number
  /** True once the gesture moves its target: a second finger, or one finger
   *  past `DRAG_SLOP`. A tap never is, so a tap writes nothing — not a pixel
   *  of jitter, and not an undo step. */
  live: boolean
}

export interface GestureLimits {
  /** Pinch limits (a plate's size range; a photo's zoom). */
  size: readonly [number, number]
  /** Pan limits, in sheet fractions. */
  position: readonly [number, number]
}

/** How far one finger travels, in CSS pixels, before it is a drag rather than
 *  a tap. A fingertip lands with a pixel or two of wobble; under this a tap
 *  that picks a plate does not also nudge it. Small enough that a drag starts
 *  as soon as it is plainly one. */
export const DRAG_SLOP = 4

/** A pinch is continuous, but what it stores is rounded to this, so a saved
 *  size is never a float tail (0.0412345678...). A tenth of a display percent:
 *  far below anything visible, and the bounds of every range are on it. */
const PINCH_GRID = 1e4

const centroidOf = (pts: readonly Pt[]): Pt => ({
  x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
  y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
})

/**
 * Begin (or re-seed) a gesture from the pointers now down.
 *
 * Re-seeding is what makes the two-finger → one-finger handoff seamless:
 * lifting a finger mid-pinch restarts the baseline from the remaining one, so
 * the target keeps panning from where it is instead of snapping to the new
 * centroid. `live` carries over, so the finger left down is still dragging.
 */
export function beginGesture(target: GestureTarget, pts: readonly Pt[], live: boolean): Gesture {
  const [a, b] = pts
  const two = pts.length >= 2
  return {
    target: { id: target.id, x: target.x, y: target.y, size: target.size, rotation: target.rotation },
    startCentroid: centroidOf(pts),
    startSpread: two ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
    startAngle: two ? Math.atan2(b.y - a.y, b.x - a.x) : 0,
    live: live || two,
  }
}

/**
 * The patch the pointers' positions now ask for, from the gesture's origin:
 * pan by the centroid's travel (in sheet fractions of `box`), and with two
 * fingers pinch the size and turn the rotation. Null while a one-finger touch
 * is still inside the tap slop: nothing to write.
 */
export function stepGesture(
  g: Gesture,
  pts: readonly Pt[],
  box: { width: number; height: number },
  limits: GestureLimits,
): { gesture: Gesture; patch: GesturePatch | null } {
  if (pts.length === 0 || box.width === 0 || box.height === 0) return { gesture: g, patch: null }
  const centroid = centroidOf(pts)
  const live =
    g.live ||
    pts.length >= 2 ||
    Math.hypot(centroid.x - g.startCentroid.x, centroid.y - g.startCentroid.y) > DRAG_SLOP
  const gesture = live === g.live ? g : { ...g, live }
  if (!live) return { gesture, patch: null }

  const { target: o } = g
  const [lo, hi] = limits.position
  const patch: GesturePatch = {
    x: clamp(o.x + (centroid.x - g.startCentroid.x) / box.width, lo, hi),
    y: clamp(o.y + (centroid.y - g.startCentroid.y) / box.height, lo, hi),
  }

  if (pts.length >= 2 && g.startSpread > 8) {
    const [a, b] = pts
    const spread = Math.hypot(b.x - a.x, b.y - a.y)
    const size = clamp(o.size * (spread / g.startSpread), limits.size[0], limits.size[1])
    patch.size = Math.round(size * PINCH_GRID) / PINCH_GRID

    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    let delta = ((angle - g.startAngle) * 180) / Math.PI
    // Normalise into (-180, 180] so rotating through the ±pi seam does not
    // spin the target the long way round.
    delta = ((((delta + 180) % 360) + 360) % 360) - 180
    patch.rotation = clamp(o.rotation + delta, -180, 180)
  }

  return { gesture, patch }
}
