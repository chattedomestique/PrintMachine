import { useCallback, useRef } from 'react'
import { useSettings } from '../../state/settingsStore.ts'
import { useRenderer } from './useRenderer.ts'
import './Canvas.css'

/**
 * The print preview, plus the drag surface that moves the selected layer.
 *
 * Input lives on a dedicated transparent sibling with `touch-action: none`,
 * not on the canvas itself — that avoids the whole genre of "the canvas is
 * eating my taps" bug, and it means the canvas can stay `pointer-events: none`
 * (playbook §7).
 */
export default function Canvas({ showGuides }: { showGuides: boolean }) {
  const { settings, dispatch, selectedLayerId, selectLayer, selectedLayer } = useSettings()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number } | null>(null)

  useRenderer(canvasRef, settings, { selectedLayerId, showGuides })

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const surface = surfaceRef.current
      if (!surface) return
      const layer = selectedLayer ?? settings.layers[0]
      if (!layer) return
      if (!selectedLayerId) selectLayer(layer.id)

      surface.setPointerCapture(e.pointerId)
      dragRef.current = {
        id: layer.id,
        startX: e.clientX,
        startY: e.clientY,
        originX: layer.x,
        originY: layer.y,
      }
    },
    [selectedLayer, selectedLayerId, selectLayer, settings.layers],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const surface = surfaceRef.current
      if (!drag || !surface) return
      const rect = surface.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      // Anchors are stored 0..1 of the sheet, so translate in the same space.
      // Clamped a little outside the sheet so type can deliberately bleed off
      // the edge, but never so far that it is lost off-screen.
      const nx = drag.originX + (e.clientX - drag.startX) / rect.width
      const ny = drag.originY + (e.clientY - drag.startY) / rect.height
      dispatch({
        type: 'patchLayer',
        id: drag.id,
        patch: {
          x: Math.max(-0.25, Math.min(1.25, nx)),
          y: Math.max(-0.25, Math.min(1.25, ny)),
        },
        // One drag is one undo step.
        coalesce: true,
      })
    },
    [dispatch],
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    surfaceRef.current?.releasePointerCapture?.(e.pointerId)
    dragRef.current = null
  }, [])

  const onDoubleClick = useCallback(() => {
    const layer = selectedLayer ?? settings.layers[0]
    if (!layer) return
    dispatch({ type: 'patchLayer', id: layer.id, patch: { x: 0.5, y: 0.5, rotation: 0 } })
  }, [dispatch, selectedLayer, settings.layers])

  // A keyboard path to the same value the drag writes (§10.1). Without this
  // the primary spatial interaction has no non-pointer equivalent.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const layer = selectedLayer ?? settings.layers[0]
      if (!layer) return
      const step = e.shiftKey ? 0.05 : 0.005
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const move = moves[e.key]
      if (!move) return
      e.preventDefault()
      dispatch({
        type: 'patchLayer',
        id: layer.id,
        patch: {
          x: Math.max(-0.25, Math.min(1.25, layer.x + move[0])),
          y: Math.max(-0.25, Math.min(1.25, layer.y + move[1])),
        },
        coalesce: true,
      })
    },
    [dispatch, selectedLayer, settings.layers],
  )

  return (
    <div className="stage">
      <div className="sheet" data-aspect={settings.aspect}>
        <canvas ref={canvasRef} className="print-canvas" />
        <div
          ref={surfaceRef}
          className="drag-surface"
          role="application"
          aria-label="Print preview. Drag to move the selected layer; arrow keys nudge it."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
