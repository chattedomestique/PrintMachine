import { useCallback, useMemo, useRef } from 'react'
import { useSettings } from '../../state/settingsStore.ts'
import { canvasMeasure } from '../../state/persist.ts'
import { useRenderer } from './useRenderer.ts'
import { useLayerGestures } from './useLayerGestures.ts'
import type { GestureLimits, GesturePatch, GestureTarget, Pt } from './gesture.ts'
import { stepSize } from '../controls/sizeScale.ts'
import { type MediaLayer, type TextLayer } from '../../engine/types.ts'
import { sheetAspect } from '../../engine/frame.ts'
import { clampPan } from '../../engine/media.ts'
import { hitLayer, layoutIn, type FontMeasure } from '../../engine/text.ts'
import './Canvas.css'

/** A photo's gesture limits. Pinch: a zoom on the cover fit, so 1 exactly
 *  fills the sheet and nothing below it is allowed — it would leave bare
 *  paper. Pan: not limited to the sheet the way type is; how far the photo may
 *  travel depends on the zoom and the sheet's shape, and clampPan decides that
 *  below, so the gesture is left free to reach every edge. */
const MEDIA_LIMITS: GestureLimits = { size: [1, 4], position: [-Infinity, Infinity] }

/** How far outside a plate's line boxes a touch still picks it, in CSS
 *  pixels: a caption at a few percent of the sheet is a line a few pixels
 *  tall, under a fingertip several times that. A touch inside a box always
 *  beats one beside a box (hitLayer). */
const HIT_SLOP = 12

/** How recent a double tap's first touch must be to count as its first (a
 *  platform's double-click interval is at most about half this). */
const PICK_THEN_TAP_MS = 1000

/**
 * The print preview, plus the surface that manipulates a plate (the selected
 * one, or the one a touch lands on) or, with the Photo tool open, the photo.
 *
 * Input lives on a dedicated transparent sibling with `touch-action: none`,
 * not on the canvas itself — that avoids the whole genre of "the canvas is
 * eating my taps" bug, and lets the canvas stay `pointer-events: none`
 * (playbook §7).
 */
export default function Canvas({
  media = null,
  mediaMode = false,
  paused = false,
  onGesture,
}: {
  media?: ImageBitmap | null
  /** Point the sheet's gestures at the photo instead of the type. Driven by
   *  the open tab, so what you are touching is whatever panel you are in — no
   *  second selection model to keep in sync. */
  mediaMode?: boolean
  /** Hold the preview where it is (a save is pressing the print). */
  paused?: boolean
  /** Told each time a gesture on the sheet moves something (not a tap): the
   *  gesture hint's cue that what it teaches has been learned. */
  onGesture?: () => void
}) {
  const { settings, dispatch, selectedLayerId, selectLayer, selectedLayer } = useSettings()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  useRenderer(canvasRef, settings, { selectedLayerId }, media, paused)

  const layer = selectedLayer ?? settings.layers[0] ?? null

  // A whole gesture — drag, pinch, rotate — collapses into one undo step. The
  // plate is the gesture's own (by id), which a tap may just have picked.
  const patch = useCallback(
    (p: GesturePatch, id: string) => {
      dispatch({ type: 'patchLayer', id, patch: p, coalesce: true })
      onGesture?.()
    },
    [dispatch, onGesture],
  )

  /**
   * Tap a plate to pick it (Border Studio's tap-to-select): a touch that lands
   * on a plate other than the selected one selects it (the plate button's
   * selection, not an undo step) and the gesture it starts moves that plate,
   * seeded from its own place. A touch on no plate moves the selected one, as
   * it always has. The plates are laid out at the sheet's on-screen size, so
   * the point needs no conversion.
   */
  const measureRef = useRef<FontMeasure | null | undefined>(undefined)
  // The sheet's last two touches (each gesture's first finger): when, and
  // whether it picked a plate. A double tap is two of them.
  const touches = useRef<{ at: number; picked: boolean }[]>([])
  const pick = useCallback(
    (pt: Pt, box: { width: number; height: number }): GestureTarget | null => {
      if (measureRef.current === undefined) measureRef.current = canvasMeasure() ?? null
      const measure = measureRef.current
      let hit: TextLayer | undefined
      if (measure && box.height > 0) {
        const plates = settings.layers.map((l) => ({ layer: l, layout: layoutIn(l, box.height, measure) }))
        const id = hitLayer(plates, pt, { w: box.width, h: box.height }, HIT_SLOP)
        hit = id !== null && id !== layer?.id ? settings.layers.find((l) => l.id === id) : undefined
      }
      touches.current = [...touches.current.slice(-1), { at: performance.now(), picked: hit !== undefined }]
      if (!hit) return null
      selectLayer(hit.id)
      return hit
    },
    [settings.layers, layer, selectLayer],
  )

  // The photo is presented to the gesture hook in the shape it already speaks:
  // x, y and size. `size` carries `scale`, and rotation is left alone because
  // a rotated photo would need its cover fit recomputed against the rotated
  // bounds, which is a different feature.
  const mediaTarget = settings.media
  const aspect = sheetAspect(settings)
  const photoTarget = useMemo<GestureTarget | null>(
    () =>
      mediaMode && mediaTarget
        ? { id: mediaTarget.id, x: mediaTarget.x, y: mediaTarget.y, size: mediaTarget.scale, rotation: 0 }
        : null,
    [mediaMode, mediaTarget],
  )

  const patchMedia = useCallback(
    (p: GesturePatch) => {
      if (!mediaTarget) return
      const next: Partial<MediaLayer> = {}
      if (p.x !== undefined) next.x = p.x
      if (p.y !== undefined) next.y = p.y
      if (p.size !== undefined) next.scale = p.size
      if (Object.keys(next).length === 0) return
      // Clamped while dragging, so the photo stops at its edge on screen
      // rather than the stored value running ahead of what is drawn.
      const placed = clampPan({ ...mediaTarget, ...next }, aspect, 1)
      // A photo that cannot move (100% on its own sheet) clamps straight
      // back, give or take a float's last bit (0.5000000000000001): nothing
      // moved, so nothing is written (no undo step that undoes nothing) and
      // the gesture hint stays.
      const same = (a: number, b: number) => Math.abs(a - b) < 1e-9
      if (same(placed.x, mediaTarget.x) && same(placed.y, mediaTarget.y) && same(placed.scale, mediaTarget.scale)) return
      dispatch({
        type: 'patchMedia',
        patch: { x: placed.x, y: placed.y, scale: placed.scale },
        coalesce: true,
      })
      onGesture?.()
    },
    [dispatch, mediaTarget, aspect, onGesture],
  )

  const typeGestures = useLayerGestures(surfaceRef, mediaMode ? null : layer, patch, { pick })
  const photoGestures = useLayerGestures(surfaceRef, photoTarget, patchMedia, { limits: MEDIA_LIMITS })
  const gestures = mediaMode ? photoGestures : typeGestures

  /**
   * Double-tap: fit the photo again (Photo open), or centre the selected plate
   * and zero its turn. Not when the first tap of the two picked a plate: a tap
   * on a plate picks it and does nothing else (Border Studio's), and a second
   * tap, often only because the first seemed not to take, must not throw away
   * where the plate was and how it was turned.
   */
  const onDoubleClick = useCallback(() => {
    if (mediaMode) {
      if (settings.media) dispatch({ type: 'patchMedia', patch: { x: 0.5, y: 0.5, scale: 1 } })
      return
    }
    const [first] = touches.current
    if (touches.current.length === 2 && first.picked && performance.now() - first.at < PICK_THEN_TAP_MS) return
    if (!layer) return
    dispatch({ type: 'patchLayer', id: layer.id, patch: { x: 0.5, y: 0.5, rotation: 0 } })
  }, [dispatch, layer, mediaMode, settings.media])

  /**
   * A keyboard path to every value the gestures write (playbook §10.1). If the
   * primary editing interaction is a drag, there has to be a focusable,
   * arrow-adjustable equivalent — this is that.
   *
   * Arrows move, +/- size (5% of it, at least one step; sizeScale.ts),
   * [/] rotate; Shift coarsens every step.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!layer) return
      const big = e.shiftKey
      const move = big ? 0.05 : 0.005
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

      const keyPatches: Record<string, () => Partial<TextLayer>> = {
        ArrowLeft: () => ({ x: clamp(layer.x - move, -0.3, 1.3) }),
        ArrowRight: () => ({ x: clamp(layer.x + move, -0.3, 1.3) }),
        ArrowUp: () => ({ y: clamp(layer.y - move, -0.3, 1.3) }),
        ArrowDown: () => ({ y: clamp(layer.y + move, -0.3, 1.3) }),
        '+': () => ({ size: stepSize(layer.size, 1, big) }),
        '=': () => ({ size: stepSize(layer.size, 1, big) }),
        '-': () => ({ size: stepSize(layer.size, -1, big) }),
        '[': () => ({ rotation: clamp(layer.rotation - (big ? 15 : 1), -180, 180) }),
        ']': () => ({ rotation: clamp(layer.rotation + (big ? 15 : 1), -180, 180) }),
      }

      const build = keyPatches[e.key]
      if (!build) return
      e.preventDefault()
      dispatch({ type: 'patchLayer', id: layer.id, patch: build(), coalesce: true })
    },
    [dispatch, layer],
  )

  return (
    // The sheet's shape as a number, so any Original ratio sizes it (Canvas.css).
    <div className="sheet" style={{ '--sheet-ratio': aspect } as React.CSSProperties}>
      <canvas ref={canvasRef} className="print-canvas" />
      <div
        ref={surfaceRef}
        className="drag-surface"
        role="application"
        aria-label={
          mediaMode
            ? 'Print preview, the photo. Drag to move the photo, pinch to zoom it, double-tap to fit it again. Arrow keys move the selected plate.'
            : 'Print preview. Tap a plate to pick it, drag to move it, pinch to scale and rotate, double-tap to centre. Arrow keys move the selected plate, plus and minus scale, brackets rotate.'
        }
        tabIndex={0}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        {...gestures}
      />
    </div>
  )
}
