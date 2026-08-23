import { useCallback, useRef } from 'react'
import { useSettings } from '../../state/settingsStore.ts'
import { useRenderer } from './useRenderer.ts'
import { MAX_SIZE, MIN_SIZE, useLayerGestures } from './useLayerGestures.ts'
import type { TextLayer } from '../../engine/types.ts'
import './Canvas.css'

/**
 * The print preview, plus the surface that manipulates the selected layer.
 *
 * Input lives on a dedicated transparent sibling with `touch-action: none`,
 * not on the canvas itself — that avoids the whole genre of "the canvas is
 * eating my taps" bug, and lets the canvas stay `pointer-events: none`
 * (playbook §7).
 */
export default function Canvas({ showGuides }: { showGuides: boolean }) {
  const { settings, dispatch, selectedLayerId, selectLayer, selectedLayer } = useSettings()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  useRenderer(canvasRef, settings, { selectedLayerId, showGuides })

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

  const gestures = useLayerGestures(surfaceRef, layer, patch, ensureSelected)

  const onDoubleClick = useCallback(() => {
    if (!layer) return
    dispatch({ type: 'patchLayer', id: layer.id, patch: { x: 0.5, y: 0.5, rotation: 0 } })
  }, [dispatch, layer])

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

      const patches: Record<string, () => Partial<TextLayer>> = {
        ArrowLeft: () => ({ x: clamp(layer.x - move, -0.3, 1.3) }),
        ArrowRight: () => ({ x: clamp(layer.x + move, -0.3, 1.3) }),
        ArrowUp: () => ({ y: clamp(layer.y - move, -0.3, 1.3) }),
        ArrowDown: () => ({ y: clamp(layer.y + move, -0.3, 1.3) }),
        '+': () => ({ size: clamp(layer.size * (big ? 1.2 : 1.05), MIN_SIZE, MAX_SIZE), fitWidth: false }),
        '=': () => ({ size: clamp(layer.size * (big ? 1.2 : 1.05), MIN_SIZE, MAX_SIZE), fitWidth: false }),
        '-': () => ({ size: clamp(layer.size / (big ? 1.2 : 1.05), MIN_SIZE, MAX_SIZE), fitWidth: false }),
        '[': () => ({ rotation: clamp(layer.rotation - (big ? 15 : 1), -180, 180) }),
        ']': () => ({ rotation: clamp(layer.rotation + (big ? 15 : 1), -180, 180) }),
      }

      const build = patches[e.key]
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
