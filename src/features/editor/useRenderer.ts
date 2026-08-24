import { useCallback, useEffect, useRef } from 'react'
import {
  DRAFT_HEIGHT,
  PREVIEW_HEIGHT,
  renderPrint,
  type OverlaySpec,
  type RenderCache,
} from '../../engine/render.ts'
import type { PrintSettings } from '../../engine/types.ts'

/** Quiet gap that counts as "the control has stopped". Long enough to span the
 *  pauses inside a real drag, short enough that letting go feels immediate. */
const SETTLE_MS = 160

/**
 * Floor between draft frames.
 *
 * Even a draft render is tens of milliseconds of blocking, and rAF will happily
 * ask for one every frame — which leaves the main thread saturated and makes
 * the *input* stutter even though the picture is keeping up. Rendering at most
 * this often gives touch handling room to breathe. The preview follows a drag
 * at a comfortable rate rather than every tick, which is the normal bargain for
 * an expensive filter and is invisible next to a frozen thread.
 */
const DRAFT_INTERVAL_MS = 90

interface Pending {
  settings: PrintSettings
  overlay: OverlaySpec
  media: ImageBitmap | null
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
  media: ImageBitmap | null = null,
) {
  const scratchRef = useRef<CanvasRenderingContext2D | null>(null)
  // One cache per resolution. They hold the paper field, the noise fields and
  // the rasterised glyphs, all keyed on size — sharing a single ref would make
  // every switch between draft and full throw all of that away and rebuild it,
  // which is most of what the draft pass was meant to save.
  const draftCacheRef = useRef<RenderCache | null>(null)
  const fullCacheRef = useRef<RenderCache | null>(null)
  const frameRef = useRef<number | undefined>(undefined)
  const pendingRef = useRef<Pending | null>(null)
  /** True while values are still arriving. Cleared by the settle timer. */
  const movingRef = useRef(false)
  const settleRef = useRef<number | undefined>(undefined)
  const lastDraftRef = useRef(0)

  const getScratch = useCallback((): CanvasRenderingContext2D | null => {
    if (!scratchRef.current) {
      const canvas = document.createElement('canvas')
      scratchRef.current = canvas.getContext('2d', { willReadFrequently: true })
    }
    return scratchRef.current
  }, [])

  const schedule = useCallback(() => {
    if (frameRef.current !== undefined) return
    const run = () => {
      frameRef.current = undefined
      const pending = pendingRef.current
      const canvas = canvasRef.current
      if (!pending || !canvas || document.visibilityState === 'hidden') return
      const ctx = canvas.getContext('2d')
      const scratch = getScratch()
      if (!ctx || !scratch) return
      const draft = movingRef.current
      if (draft) {
        const now = performance.now()
        if (now - lastDraftRef.current < DRAFT_INTERVAL_MS) {
          // Too soon. Come back on a later frame rather than dropping the
          // update — the settle timer is still running, so nothing is lost.
          // Re-queued directly rather than through `schedule`, which would mean
          // this callback closing over its own definition.
          frameRef.current = requestAnimationFrame(run)
          return
        }
        lastDraftRef.current = now
      }
      renderPrint(
        ctx,
        scratch,
        pending.settings,
        draft ? draftCacheRef : fullCacheRef,
        pending.overlay,
        draft ? DRAFT_HEIGHT : PREVIEW_HEIGHT,
        pending.media,
      )
    }
    frameRef.current = requestAnimationFrame(run)
  }, [canvasRef, getScratch])

  useEffect(() => {
    pendingRef.current = { settings, overlay, media }
    // Anything arriving now is treated as motion. The timer below is what
    // decides it has stopped — a control that is still moving keeps pushing it
    // out, so the expensive frame is only paid for once, at the end.
    movingRef.current = true
    window.clearTimeout(settleRef.current)
    settleRef.current = window.setTimeout(() => {
      movingRef.current = false
      schedule()
    }, SETTLE_MS)
    schedule()
  }, [settings, overlay, media, schedule])

  useEffect(() => () => window.clearTimeout(settleRef.current), [])

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
