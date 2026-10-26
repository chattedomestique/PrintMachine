/**
 * Save's side of the page: the canvases the press is handed, and the file
 * handed over. The engine touches no DOM (README "Layout"): it presses on
 * canvases made here and returns a Blob; sharing or downloading that Blob is
 * done here. The rules, from playbook §6.1:
 *
 *  1. Web Share first, <a download> only as the desktop fallback. iOS Safari
 *     largely ignores `download` on blob URLs and instead *navigates* to the
 *     image, destroying app state. Inverting these two is the single most
 *     common failure in this class of app.
 *  2. `navigator.share` needs transient activation, and a print pressed at the
 *     photo's own resolution takes seconds — longer than the activation a tap
 *     grants. So pressing and sharing are two steps (`savePrint`, then
 *     `deliverFile`), and the save flow (useSave.ts) asks for a fresh tap when
 *     the press outlasted the tap that started it.
 *  3. AbortError means the user dismissed the sheet. It is not a failure and
 *     must never surface as an error.
 */

import { dims } from '../../engine/export.ts'
import type { ExportPlan } from '../../engine/exportPlan.ts'

/** A detached 2D canvas, read from often: each canvas a press makes (its tile
 *  canvas, and the canvas a photo at its own pixels is blitted into). */
export function detachedCanvas(): CanvasRenderingContext2D {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not open a canvas to press the print.')
  return ctx
}

export type Delivery = 'shared' | 'downloaded' | 'cancelled'

/** Whether this browser can hand the file to a share sheet. */
export function canShareFile(file: File): boolean {
  return typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) === true
}

/**
 * Hand the file over: the share sheet where there is one, a download where
 * there is not.
 *
 * A share that fails (anything but the person dismissing it) falls back to a
 * download only where `allowDownload` says that is safe. In an iOS home-screen
 * app it is not — `<a download>` navigates to the image and takes the app
 * with it — so the error is thrown and the caller keeps the file and the
 * Share button for another tap.
 */
export async function deliverFile(file: File, opts: { allowDownload: boolean }): Promise<Delivery> {
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: file.name })
      return 'shared'
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled'
      // An expired activation is the save flow's to handle: another tap.
      if (!opts.allowDownload || (err instanceof Error && err.name === 'NotAllowedError')) throw err
    }
  }
  download(file)
  return 'downloaded'
}

function download(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Not synchronous — some browsers need the URL alive briefly past .click().
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The confirmation after a save. Deliberately does not claim the file reached
 *  Photos — the share promise resolving only means the sheet was dismissed
 *  (§6.3). "Saved" is honest shorthand; "saved to your camera roll" is not.
 *  A smaller copy says it is one: the caption above Save still names the full
 *  size, so the confirmation is where the smaller file is named. */
export function saveMessage(delivery: Delivery, plan: ExportPlan): string | null {
  const what = `${dims(plan.width, plan.height)}${plan.limit === 'smaller' ? ', a smaller copy' : ''}`
  switch (delivery) {
    case 'shared':
      return `Saved ${what}`
    case 'downloaded':
      return `Downloaded ${what}`
    case 'cancelled':
      return null
  }
}
