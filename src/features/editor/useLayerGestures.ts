import { useCallback, useEffect, useRef } from 'react'
import type { TextLayer } from '../../engine/types.ts'

/**
 * Direct manipulation of the selected layer.
 *
 * For a spatial task, direct manipulation beats indirect controls — someone
 * looking at type on a sheet will try to drag the type (playbook §7). All
 * gestures write the same `{x, y, size, rotation}` the sliders write, so the
 * two are views of one model rather than parallel systems.
 *
 * Pointer Events with `setPointerCapture` handle mouse, touch and pencil in one
 * path and survive the pointer leaving the element.
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const MIN_SIZE = 0.015
export const MAX_SIZE = 1.2

interface Pt {
  x: number
  y: number
}

interface Gesture {
  /** Layer state captured when the gesture began. */
  origin: { x: number; y: number; size: number; rotation: number }
  /** Centroid of the starting pointers, in element space. */
  startCentroid: Pt
  /** Distance between the two starting pointers (0 for a one-finger drag). */
  startSpread: number
  /** Angle between the two starting pointers, radians. */
  startAngle: number
}

export interface LayerGestureHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
}

export function useLayerGestures(
  surfaceRef: React.RefObject<HTMLElement | null>,
  layer: TextLayer | null,
  patch: (p: Partial<TextLayer>) => void,
  onGestureStart?: () => void,
): LayerGestureHandlers {
  const pointers = useRef(new Map<number, Pt>())
  const gesture = useRef<Gesture | null>(null)
  // Synced in an effect, never written during render — a ref assigned in the
  // render body is a real staleness bug, and it is the rule the playbook (§8.2)
  // records as having been red and unmonitored in a shipped app. Pointer
  // handlers all fire after commit, so reading it there is safe.
  const layerRef = useRef(layer)
  useEffect(() => {
    layerRef.current = layer
  }, [layer])

  const localPoint = useCallback(
    (e: React.PointerEvent<HTMLElement>): Pt => {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect) return { x: e.clientX, y: e.clientY }
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    },
    [surfaceRef],
  )

  /**
   * Re-seed the gesture from whatever pointers are currently down.
   *
   * This is what makes the two-finger → one-finger handoff seamless: lifting a
   * finger mid-pinch restarts the baseline from the remaining one, so the layer
   * continues panning from where it is instead of snapping to the new centroid.
   */
  const rebase = useCallback(() => {
    const l = layerRef.current
    if (!l || pointers.current.size === 0) {
      gesture.current = null
      return
    }
    const pts = [...pointers.current.values()]
    const centroid = {
      x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
      y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
    }
    const [a, b] = pts

    gesture.current = {
      origin: { x: l.x, y: l.y, size: l.size, rotation: l.rotation },
      startCentroid: centroid,
      startSpread: pts.length >= 2 ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
      startAngle: pts.length >= 2 ? Math.atan2(b.y - a.y, b.x - a.x) : 0,
    }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!layerRef.current) return
      onGestureStart?.()
      surfaceRef.current?.setPointerCapture(e.pointerId)
      pointers.current.set(e.pointerId, localPoint(e))
      rebase()
    },
    [localPoint, rebase, surfaceRef, onGestureStart],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, localPoint(e))

      const g = gesture.current
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!g || !rect || rect.width === 0 || rect.height === 0) return

      const pts = [...pointers.current.values()]
      const centroid = {
        x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
        y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
      }

      // Pan: the centroid's travel, in sheet-relative units. Clamped a little
      // outside the sheet so type can deliberately bleed off the trim, but
      // never so far that it is lost off-screen.
      const next: Partial<TextLayer> = {
        x: clamp(g.origin.x + (centroid.x - g.startCentroid.x) / rect.width, -0.3, 1.3),
        y: clamp(g.origin.y + (centroid.y - g.startCentroid.y) / rect.height, -0.3, 1.3),
      }

      if (pts.length >= 2 && g.startSpread > 8) {
        const [a, b] = pts
        const spread = Math.hypot(b.x - a.x, b.y - a.y)
        next.size = clamp(g.origin.size * (spread / g.startSpread), MIN_SIZE, MAX_SIZE)
        // Scaling by hand is an explicit statement about size, so fit-to-width
        // has to yield — otherwise the layout immediately overrides the pinch
        // and the type appears not to respond at all.
        next.fitWidth = false

        const angle = Math.atan2(b.y - a.y, b.x - a.x)
        let delta = ((angle - g.startAngle) * 180) / Math.PI
        // Normalise into (-180, 180] so rotating through the ±pi seam does not
        // spin the layer the long way round.
        delta = ((((delta + 180) % 360) + 360) % 360) - 180
        next.rotation = clamp(g.origin.rotation + delta, -180, 180)
      }

      patch(next)
    },
    [localPoint, patch, surfaceRef],
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
