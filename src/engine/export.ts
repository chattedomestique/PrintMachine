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
 *  2. `navigator.share` needs transient activation, and a print pressed at the
 *     photo's own resolution takes seconds — longer than the activation a tap
 *     grants. So pressing and sharing are two steps (`savePrint`, then
 *     `deliverFile`), and the save flow (features/shell/useSave.ts) asks for a
 *     fresh tap when the press outlasted the tap that started it.
 *  3. AbortError means the user dismissed the sheet. It is not a failure and
 *     must never surface as an error.
 *  4. JPEG at 0.95 by default, PNG as the explicit lossless choice.
 *
 * The size is planned from the photo (exportPlan.ts): the print is saved at
 * the height where the photo lands pixel for pixel, never at the preview's,
 * and never quietly smaller.
 */

import { planExport, type ExportPlan } from './exportPlan.ts'
import { renderPrintAsync, throwIfAborted, type RenderProgress } from './render.ts'
import { sheetAspect, type MediaLayer, type PrintSettings } from './types.ts'

export type ExportFormat = 'jpeg' | 'png'

/**
 * JPEG quality. 0.95 rather than 0.92: on a screened print it is a quarter to
 * a third more bytes for visibly cleaner dot edges, and still several times
 * smaller than PNG. Below 1.0 browsers write 4:2:0 chroma (Chromium does,
 * measured), which halves the colour resolution of saturated ink on paper —
 * the one loss a quality setting cannot remove, so PNG is offered as the
 * lossless path rather than this number being pushed to 1.0 (three times the
 * bytes, and still not lossless).
 */
export const JPEG_QUALITY = 0.95

export const ENCODINGS: Record<ExportFormat, { mime: string; ext: string; quality: number | undefined }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', quality: JPEG_QUALITY },
  png: { mime: 'image/png', ext: 'png', quality: undefined },
}

/** What the app says wherever a document's stored photo is gone or cannot be
 *  decoded: the Photo panel, the line above Save, Save's label, this error. */
export const PHOTO_MISSING = 'This photo could not be loaded. Choose it again.'

/** The document has a photo, but no decode of it was handed over: the stored
 *  image is gone or unreadable. Saving would print the type on bare paper — a
 *  different print, saved as if it were this one — so it is refused. */
export class MissingPhotoError extends Error {
  constructor() {
    super(PHOTO_MISSING)
    this.name = 'MissingPhotoError'
  }
}

/** The size this print saves at: from its sheet and its photo's TRUE size
 *  (never the preview's working copy), at its zoom. */
export function planPrint(settings: PrintSettings, opts: { maxHeight?: number } = {}): ExportPlan {
  const m = settings.media
  return planExport(sheetAspect(settings), m ? { width: m.width, height: m.height, scale: m.scale } : null, opts)
}

export interface PressedPrint {
  blob: Blob
  plan: ExportPlan
  format: ExportFormat
}

export interface SaveOptions {
  format?: ExportFormat
  /** Press no taller than this: a smaller copy the person chose (never
   *  automatic: see CanvasLimitError). */
  maxHeight?: number
  /** Cancel: checked at every step of the press, and once more after the
   *  encode, so a cancelled save never returns a file. */
  signal?: AbortSignal
  onProgress?: (progress: RenderProgress) => void
  /** Called once the photo is in the ground: the caller frees its decode. */
  onGround?: () => void
}

/**
 * Press the print at its planned size and encode it.
 *
 * The export never reads back the on-screen canvas — that canvas may carry a
 * selection crosshair. Re-rendering with no overlay makes an editing aid in a
 * saved file structurally impossible rather than something we remember to
 * avoid (N8). Both canvases are let go (width 0) once the file exists, or the
 * press fails: tens of megabytes on a phone.
 *
 * @param media the photo decoded from its ORIGINAL bytes (not the preview's
 *   working copy), so the print is drawn from the original's pixels.
 * @param render the renderer; a test hands in a spy.
 */
export async function savePrint(
  exportCtx: CanvasRenderingContext2D,
  scratchCtx: CanvasRenderingContext2D,
  settings: PrintSettings,
  media: CanvasImageSource | null,
  opts: SaveOptions = {},
  render: typeof renderPrintAsync = renderPrintAsync,
): Promise<PressedPrint> {
  if (settings.media && !media) throw new MissingPhotoError()
  const format = opts.format ?? 'jpeg'
  const plan = planPrint(settings, { maxHeight: opts.maxHeight })
  try {
    // Every full-size canvas the press uses, allocated and proved before any
    // work: over its limit an iOS canvas does not throw, it hands back a
    // blank one, and the print would come out empty.
    if (!fitsCanvas(exportCtx, plan.width, plan.height) || !fitsCanvas(scratchCtx, plan.width, plan.height)) {
      throw new CanvasLimitError(plan, 'a canvas that size came back blank')
    }
    await render(exportCtx, scratchCtx, settings, plan.height, media, {
      signal: opts.signal,
      onProgress: opts.onProgress,
      onGround: opts.onGround,
    })
    const { width, height } = exportCtx.canvas
    // The renderer makes the width from the same aspect; a canvas of any other
    // size is not the print the caption promised.
    if (width !== plan.width || height !== plan.height) {
      throw new Error(`The print came out ${width}×${height}, not the planned ${plan.width}×${plan.height}.`)
    }
    const blob = await encode(exportCtx.canvas, format)
    // Cancel stays live while the file is encoded (up to a second on a
    // desktop, longer on a phone): tapped then, there is no file.
    throwIfAborted(opts.signal)
    if (!blob) throw new CanvasLimitError(plan, 'the image could not be encoded')
    return { blob, plan, format }
  } catch (err) {
    // Out of memory for a typed array or an ImageData is a RangeError: the
    // same "too big for this device", said the same way.
    if (err instanceof RangeError) throw new CanvasLimitError(plan, err.message)
    throw err
  } finally {
    exportCtx.canvas.width = 0
    scratchCtx.canvas.width = 0
  }
}

function encode(canvas: HTMLCanvasElement, format: ExportFormat): Promise<Blob | null> {
  const { mime, quality } = ENCODINGS[format]
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality))
}

/**
 * This device could not press the print at this size: a canvas came back
 * blank (a sentinel pixel did not read back), the encoder returned nothing, or
 * memory ran out. Never answered by quietly saving something smaller: the
 * save flow offers a smaller copy, in numbers, and the person chooses it
 * (`findSmallerPlan`).
 */
export class CanvasLimitError extends Error {
  constructor(
    readonly plan: ExportPlan,
    readonly why: string,
  ) {
    super(`This device couldn't press ${dims(plan.width, plan.height)} (${why}).`)
    this.name = 'CanvasLimitError'
  }
}

/**
 * Whether a canvas of w x h really works here: sized, a sentinel pixel
 * (rgb 1, 2, 3) written at its LAST pixel and read back. Reading a pixel of a
 * blank canvas returns zeros and would pass a plain read; a sentinel cannot.
 * The canvas is left at that size, blank, its state as it was (the press
 * then finds it sized and does not size it again).
 */
export function fitsCanvas(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    ctx.canvas.width = w
    ctx.canvas.height = h
    if (ctx.canvas.width !== w || ctx.canvas.height !== h) return false
    ctx.save()
    ctx.fillStyle = 'rgb(1, 2, 3)'
    ctx.fillRect(w - 1, h - 1, 1, 1)
    ctx.restore()
    const d = ctx.getImageData(w - 1, h - 1, 1, 1).data
    ctx.clearRect(w - 1, h - 1, 1, 1)
    return d[0] === 1 && d[1] === 2 && d[2] === 3 && d[3] === 255
  } catch {
    return false
  }
}

/** Each smaller copy offered is this much shorter than the one before. */
export const SMALLER_STEP = 0.75

/** No copy is offered shorter than this: a third of the reference height,
 *  below which a print is a thumbnail of itself. */
export const SMALLEST_COPY_HEIGHT = 600

/**
 * The largest smaller copy this device can press: the height stepped down by
 * SMALLER_STEP (rounded to a whole pixel, the sheet's shape kept) from the one
 * that failed, until `fits` holds for a sheet that size — or null once a step
 * would go below SMALLEST_COPY_HEIGHT: this device cannot save this print.
 */
export function findSmallerPlan(
  settings: PrintSettings,
  failedHeight: number,
  fits: (w: number, h: number) => boolean,
): ExportPlan | null {
  let maxHeight = failedHeight
  for (;;) {
    maxHeight = Math.round(maxHeight * SMALLER_STEP)
    if (maxHeight < SMALLEST_COPY_HEIGHT) return null
    const plan = planPrint(settings, { maxHeight })
    if (fits(plan.width, plan.height)) return plan
  }
}

/** The pressed print as a named file. */
export function printFile(pressed: PressedPrint, name = 'print-machine'): File {
  const { mime, ext } = ENCODINGS[pressed.format]
  return new File([pressed.blob], `${name}.${ext}`, { type: mime })
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
 * "Save to Photos" button for another tap.
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

/** Pixel dimensions as a person reads them. */
export const dims = (w: number, h: number): string => `${w}×${h}`

/** A file size as a person reads it: "6.2 MB", "840 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

const times = (k: number): string => `${Number(k.toFixed(2))}x`

/**
 * What Save says about the size: the pixel size, and, when the print is not
 * at the photo's own pixels, why — in numbers, never quietly.
 */
export function describePlan(plan: ExportPlan, media: Pick<MediaLayer, 'width' | 'height' | 'scale'> | null): {
  size: string
  reason: string | null
} {
  const size = dims(plan.width, plan.height)
  const photo = media ? `${dims(media.width, media.height)}${media.scale > 1 ? ` at ${Math.round(media.scale * 100)}% zoom` : ''}` : ''
  switch (plan.limit) {
    case 'native':
    case 'none':
      return { size, reason: null }
    case 'floor':
      return { size, reason: `photo is ${photo}: upscaled ${times(plan.upscale ?? 1)}` }
    case 'ceiling':
      return { size, reason: `capped at 16.7 MP, the most a browser canvas is guaranteed to hold; photo is ${photo}` }
    case 'smaller':
      return { size, reason: 'a smaller copy, as asked' }
  }
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
