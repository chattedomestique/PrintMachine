import { useCallback, useRef } from 'react'
import { useSettings } from '../../state/settingsStore.ts'
import { useRenderer } from './useRenderer.ts'
import { MAX_SIZE, MIN_SIZE, useLayerGestures } from './useLayerGestures.ts'
import { ASPECTS, type MediaLayer, type TextLayer } from '../../engine/types.ts'
import { clampPan } from '../../engine/media.ts'
import './Canvas.css'

/**
 * The print preview, plus the surface that manipulates the selected layer.
 *
 * Input lives on a dedicated transparent sibling with `touch-action: none`,
 * not on the canvas itself — that avoids the whole genre of "the canvas is
 * eating my taps" bug, and lets the canvas stay `pointer-events: none`
 * (playbook §7).
 */
/** Pinch range for a photo: a zoom on the cover fit, so 1 exactly fills the
 *  sheet and nothing below it is allowed — it would leave bare paper. */
const MEDIA_SIZE: readonly [number, number] = [1, 4]

/** The photo's centre is not limited to the sheet the way type is: how far it
 *  may travel depends on the zoom and the sheet's shape, and clampPan decides
 *  that below. Unbounded here so the gesture can reach every edge. */
const MEDIA_POSITION: readonly [number, number] = [-Infinity, Infinity]

export default function Canvas({
  showGuides,
  media = null,
  mediaMode = false,
}: {
  showGuides: boolean
  media?: ImageBitmap | null
  /** Point the sheet's gestures at the photo instead of the type. Driven by
   *  the open tab, so what you are touching is whatever panel you are in — no
   *  second selection model to keep in sync. */
  mediaMode?: boolean
}) {
  const { settings, dispatch, selectedLayerId, selectLayer, selectedLayer } = useSettings()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  useRenderer(canvasRef, settings, { selectedLayerId, showGuides }, media)

  const layer = selectedLayer ?? settings.layers[0] ?? null

  // A whole gesture — drag, pinch, rotate — collapses into one undo step.
  const patch = useCallback(
    (p: Partial<TextLayer>) => {
      if (!layer) return
      dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce: true })
    },
    [dispatch, layer],
  )

  const ensureSelected = useCallback(() => {
    if (!selectedLayerId && layer) selectLayer(layer.id)
  }, [selectedLayerId, layer, selectLayer])

  // The photo is presented to the gesture hook in the shape it already speaks:
  // x, y and size. `size` carries `scale`, and rotation is left alone because
  // a rotated photo would need its cover fit recomputed against the rotated
  // bounds, which is a different feature.
  const mediaTarget = settings.media
  const mediaAsLayer =
    mediaMode && mediaTarget
      ? ({ ...layer, x: mediaTarget.x, y: mediaTarget.y, size: mediaTarget.scale, rotation: 0 } as TextLayer)
      : null

  const patchMedia = useCallback(
    (p: Partial<TextLayer>) => {
      if (!mediaTarget) return
      const next: Partial<MediaLayer> = {}
      if (p.x !== undefined) next.x = p.x
      if (p.y !== undefined) next.y = p.y
      if (p.size !== undefined) next.scale = p.size
      if (Object.keys(next).length === 0) return
      // Clamped while dragging, so the photo stops at its edge on screen
      // rather than the stored value running ahead of what is drawn.
      const placed = clampPan({ ...mediaTarget, ...next }, ASPECTS[settings.aspect], 1)
      dispatch({
        type: 'patchMedia',
        patch: { x: placed.x, y: placed.y, scale: placed.scale },
        coalesce: true,
      })
    },
    [dispatch, mediaTarget, settings.aspect],
  )

  const typeGestures = useLayerGestures(surfaceRef, mediaMode ? null : layer, patch, ensureSelected)
  const photoGestures = useLayerGestures(
    surfaceRef,
    mediaAsLayer,
    patchMedia,
    undefined,
    MEDIA_SIZE,
    MEDIA_POSITION,
  )
  const gestures = mediaMode ? photoGestures : typeGestures

  const onDoubleClick = useCallback(() => {
    if (mediaMode) {
      if (settings.media) dispatch({ type: 'patchMedia', patch: { x: 0.5, y: 0.5, scale: 1 } })
      return
    }
    if (!layer) return
    dispatch({ type: 'patchLayer', id: layer.id, patch: { x: 0.5, y: 0.5, rotation: 0 } })
  }, [dispatch, layer, mediaMode, settings.media])

  /**
   * A keyboard path to every value the gestures write (playbook §10.1). If the
   * primary editing interaction is a drag, there has to be a focusable,
   * arrow-adjustable equivalent — this is that.
   *
   * Arrows move, +/- size, [/] rotate; Shift coarsens every step.
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
        '+': () => ({ size: clamp(layer.size * (big ? 1.2 : 1.05), MIN_SIZE, MAX_SIZE) }),
        '=': () => ({ size: clamp(layer.size * (big ? 1.2 : 1.05), MIN_SIZE, MAX_SIZE) }),
        '-': () => ({ size: clamp(layer.size / (big ? 1.2 : 1.05), MIN_SIZE, MAX_SIZE) }),
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
    <div className="sheet" data-aspect={settings.aspect}>
      <canvas ref={canvasRef} className="print-canvas" />
      <div
        ref={surfaceRef}
        className="drag-surface"
        role="application"
        aria-label="Print preview. Drag to move the selected plate, pinch to scale and rotate, double-tap to centre. Arrow keys move, plus and minus scale, brackets rotate."
        tabIndex={0}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        {...gestures}
      />
    </div>
  )
}
