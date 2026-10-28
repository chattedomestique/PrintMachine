import { useCallback, useEffect, useRef } from 'react'
import { SIZE_MAX, SIZE_MIN } from '../../engine/limits.ts'
import {
  beginGesture,
  stepGesture,
  type Gesture,
  type GestureBox,
  type GestureLimits,
  type GesturePatch,
  type GestureTarget,
  type Pt,
} from './gesture.ts'

/**
 * Direct manipulation on the sheet: a plate, or the photo.
 *
 * For a spatial task, direct manipulation beats indirect controls — someone
 * looking at type on a sheet will try to drag the type (playbook §7). All
 * gestures write the same `{x, y, size, rotation}` the sliders write, so the
 * two are views of one model rather than parallel systems. The arithmetic is
 * gesture.ts; this is the pointer bookkeeping round it.
 *
 * Pointer Events with `setPointerCapture` handle mouse, touch and pencil in one
 * path and survive the pointer leaving the element.
 */

/** Type's limits: its size range (engine/limits.ts — a pinch reaches past the
 *  slider's end, up to SIZE_MAX), and a little past the trim so it can bleed
 *  off deliberately without being lost off-screen. Module constants, so the
 *  handlers below are not rebuilt on every render. */
const TYPE_LIMITS: GestureLimits = { size: [SIZE_MIN, SIZE_MAX], position: [-0.3, 1.3] }

export interface LayerGestureHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
}

export function useLayerGestures(
  surfaceRef: React.RefObject<HTMLElement | null>,
  /** What the gestures move when nothing else is picked: the selected plate,
   *  or the photo. Null turns them off. */
  target: GestureTarget | null,
  /** Writes a patch to the target whose id it names: the gesture's own
   *  target, which is not always the `target` of this render (see `pick`). */
  patch: (p: GesturePatch, id: string) => void,
  {
    limits = TYPE_LIMITS,
    pick,
    area,
  }: {
    /** Pinch and pan limits. Type and photos want very different ranges — a
     *  photo starts at cover and is zoomed in from it, not sized as a
     *  fraction of the sheet, and its pan is clamped by its caller. */
    limits?: GestureLimits
    /** The box, inside the surface's, that the target's place is a fraction
     *  of: the surface itself for a plate (a fraction of the sheet), the
     *  visible rectangle inside the frame for the photo (gesture.ts
     *  `visibleBox`). */
    area?: (box: { width: number; height: number }) => GestureBox
    /**
     * Asked once at the first pointer of a gesture, with where it landed (in
     * the surface's pixels) and the surface's size: a target to move instead
     * of `target`, or null to keep it. The gesture is seeded from what this
     * returns, there and then, rather than from `target` after a re-render.
     */
    pick?: (pt: Pt, box: { width: number; height: number }) => GestureTarget | null
  } = {},
): LayerGestureHandlers {
  const pointers = useRef(new Map<number, Pt>())
  const gesture = useRef<Gesture | null>(null)
  // Synced in an effect, never written during render — a ref assigned in the
  // render body is a real staleness bug, and it is the rule the playbook (§8.2)
  // records as having been red and unmonitored in a shipped app. Pointer
  // handlers all fire after commit, so reading it there is safe. A pick
  // writes it too, ahead of the render that will say the same.
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  }, [target])

  const localPoint = useCallback(
    (e: React.PointerEvent<HTMLElement>): Pt => {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect) return { x: e.clientX, y: e.clientY }
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    },
    [surfaceRef],
  )

  /** Re-seed the gesture from whatever pointers are down now (gesture.ts). */
  const rebase = useCallback(() => {
    const t = targetRef.current
    if (!t || pointers.current.size === 0) {
      gesture.current = null
      return
    }
    gesture.current = beginGesture(t, [...pointers.current.values()], gesture.current?.live ?? false)
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!targetRef.current) return
      const pt = localPoint(e)
      if (pointers.current.size === 0) {
        gesture.current = null
        const rect = surfaceRef.current?.getBoundingClientRect()
        const picked = pick && rect ? pick(pt, rect) : null
        if (picked) targetRef.current = picked
      }
      surfaceRef.current?.setPointerCapture(e.pointerId)
      pointers.current.set(e.pointerId, pt)
      rebase()
    },
    [localPoint, rebase, surfaceRef, pick],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, localPoint(e))

      const g = gesture.current
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!g || !rect) return
      const step = stepGesture(g, [...pointers.current.values()], area ? area(rect) : rect, limits)
      gesture.current = step.gesture
      if (step.patch) patch(step.patch, g.target.id)
    },
    [localPoint, patch, surfaceRef, limits, area],
  )

  const release = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      pointers.current.delete(e.pointerId)
      surfaceRef.current?.releasePointerCapture?.(e.pointerId)
      // Rebase rather than end: a finger lifting from a pinch should leave the
      // other one still panning.
      rebase()
    },
    [rebase, surfaceRef],
  )

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: release,
    onPointerCancel: release,
  }
}
