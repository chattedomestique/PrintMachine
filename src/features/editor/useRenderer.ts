import { useCallback, useEffect, useRef } from 'react'
import { PREVIEW_HEIGHT, renderPrint, type OverlaySpec, type RenderCache } from '../../engine/render.ts'
import type { PrintSettings } from '../../engine/types.ts'

interface Pending {
  settings: PrintSettings
  overlay: OverlaySpec
}

/**
 * Drives the preview canvas.
 *
 * Redraws are coalesced onto a single requestAnimationFrame, so a slider
 * firing onChange per tick paints once per frame instead of once per event,
 * and nothing paints while the document is hidden (§5.7).
 *
 * What to render is stashed in a ref *from inside an effect*, never during
 * render — the rAF callback fires after the commit, so it has to read the
 * latest values from somewhere, but writing a ref in the render body is a
 * genuine staleness bug and the lint rule that catches it is load-bearing.
 */
export function useRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  settings: PrintSettings,
  overlay: OverlaySpec,
) {
  const scratchRef = useRef<CanvasRenderingContext2D | null>(null)
  const cacheRef = useRef<RenderCache | null>(null)
  const frameRef = useRef<number | undefined>(undefined)
  const pendingRef = useRef<Pending | null>(null)

  const getScratch = useCallback((): CanvasRenderingContext2D | null => {
    if (!scratchRef.current) {
      const canvas = document.createElement('canvas')
      scratchRef.current = canvas.getContext('2d', { willReadFrequently: true })
    }
    return scratchRef.current
  }, [])

  const schedule = useCallback(() => {
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      const pending = pendingRef.current
      const canvas = canvasRef.current
      if (!pending || !canvas || document.visibilityState === 'hidden') return
      const ctx = canvas.getContext('2d')
      const scratch = getScratch()
      if (!ctx || !scratch) return
      renderPrint(ctx, scratch, pending.settings, cacheRef, pending.overlay, PREVIEW_HEIGHT)
    })
  }, [canvasRef, getScratch])

  useEffect(() => {
    pendingRef.current = { settings, overlay }
    schedule()
  }, [settings, overlay, schedule])

  // Repaint on becoming visible again — iOS can discard the canvas backing
  // store while the tab is backgrounded, which leaves a blank preview.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [schedule])

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  return { redraw: schedule }
}
