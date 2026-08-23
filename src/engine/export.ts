/**
 * Saving.
 *
 * For a mobile-first tool this is *the* flow — everything upstream is in
 * service of this working every time on the phone. The rules encoded here,
 * from playbook §6.1:
 *
 *  1. Web Share first, <a download> only as the desktop fallback. iOS Safari
 *     largely ignores `download` on blob URLs and instead *navigates* to the
 *     image, destroying app state. Inverting these two is the single most
 *     common failure in this class of app.
 *  2. Do the slow work before the share call, not between the gesture and it.
 *     `navigator.share` needs transient activation.
 *  3. AbortError means the user dismissed the sheet. It is not a failure and
 *     must never surface as an error.
 *  4. JPEG by default. A 1800px PNG of a print is multi-megabyte for no
 *     visible gain (N4).
 */

import { renderPrint, type RenderCache } from './render.ts'
import type { PrintSettings } from './types.ts'

export type ExportFormat = 'jpeg' | 'png' | 'webp'

export interface SaveResult {
  status: 'shared' | 'downloaded' | 'cancelled' | 'error'
  message?: string
}

const MIME: Record<ExportFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

const EXT: Record<ExportFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
}

function encode(canvas: HTMLCanvasElement, format: ExportFormat): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      MIME[format],
      // 0.92 is the quality/size knee for photographic content; flat ink areas
      // survive it without visible blocking.
      format === 'png' ? undefined : 0.92,
    )
  })
}

/**
 * Render a fresh, overlay-free frame and hand it to the share sheet.
 *
 * The export never reads back the on-screen canvas — that canvas may carry a
 * selection crosshair or guides. Re-rendering with `overlay = null` makes an
 * editing aid in a saved file structurally impossible rather than something we
 * remember to avoid (N8).
 */
export async function savePrint(
  exportCtx: CanvasRenderingContext2D,
  scratchCtx: CanvasRenderingContext2D,
  settings: PrintSettings,
  format: ExportFormat = 'jpeg',
  name = 'print-machine',
): Promise<SaveResult> {
  let blob: Blob
  try {
    // A cache of its own: the export renders at REFERENCE_HEIGHT while the
    // preview renders smaller, so sharing one would make each thrash the
    // other's noise fields on every save.
    const cacheRef: { current: RenderCache | null } = { current: null }
    // Synchronous CPU work — does not consume the user gesture.
    renderPrint(exportCtx, scratchCtx, settings, cacheRef, null)
    blob = await encode(exportCtx.canvas, format)
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Export failed.' }
  }

  const filename = `${name}.${EXT[format]}`
  const file = new File([blob], filename, { type: MIME[format] })

  // 1. iOS and modern Android: the native share sheet → Save Image / Files.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return { status: 'shared' }
    } catch (err) {
      // The user dismissed the sheet. Not an error — swallow it silently.
      if (err instanceof Error && err.name === 'AbortError') return { status: 'cancelled' }
      // Anything else: fall through to the download path.
    }
  }

  // 2. Desktop fallback.
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Not synchronous — some browsers need the URL alive briefly past .click().
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return { status: 'downloaded' }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Save failed.' }
  }
}

/** Human-readable confirmation. Deliberately does not claim the file reached
 *  Photos — the share promise resolving only means the sheet was dismissed
 *  (§6.3). "Saved" is honest shorthand; "saved to your camera roll" is not. */
export function saveMessage(result: SaveResult): string | null {
  switch (result.status) {
    case 'shared':
      return 'Saved'
    case 'downloaded':
      return 'Downloaded'
    case 'cancelled':
      return null
    case 'error':
      return result.message ?? 'Save failed.'
  }
}
