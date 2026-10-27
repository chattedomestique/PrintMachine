/**
 * Saving: the press behind Save, and what it says.
 *
 * For a mobile-first tool this is *the* flow — everything upstream is in
 * service of this working every time on the phone.
 *
 *  - The size is planned from the photo (exportPlan.ts): the print is saved at
 *    the height where the photo lands pixel for pixel, never at the preview's,
 *    never quietly smaller, and with no ceiling: the press runs in bands
 *    (render.ts `pressToSink`) and each band goes straight into the encoder,
 *    so no canvas, array or file buffer the size of the sheet is ever made.
 *  - JPEG at quality 95 with every colour sample kept (4:4:4), written by
 *    this app's own encoder (encode/jpeg.ts); PNG (encode/png.ts) as the
 *    explicit lossless choice.
 *  - Like the rest of the engine it touches no DOM: the press's canvases come
 *    from the caller (`SaveOptions.makeCanvas`), and the file it returns is
 *    handed to the share sheet or downloaded by the page
 *    (features/shell/page.ts).
 */

import { JpegEncoder } from './encode/jpeg.ts'
import { PngEncoder } from './encode/png.ts'
import { planExport, type ExportPlan, type PlanSheet } from './exportPlan.ts'
import { effectiveMode, layoutSheet, sheetAspect, type FrameInputs, type SheetSpec } from './frame.ts'
import { LARGE_PRINT_MP, MIN_BAND_ROWS, bandHeight } from './limits.ts'
import type { DrawRect, LumaGrid } from './media.ts'
import { isNativeRect, pressToSink, sourceSize, throwIfAborted, type RenderProgress, type RowSink } from './render.ts'
import type { GlyphPlan } from './text.ts'
import { TILE_BUDGET, tileGrid, type TileBudget } from './tiles.ts'
import { type MediaLayer, type PrintSettings } from './types.ts'

export type ExportFormat = 'jpeg' | 'png'

/**
 * JPEG quality. 0.95 rather than 0.92: on a screened print it is a quarter to
 * a third more bytes for visibly cleaner dot edges, and still several times
 * smaller than PNG. The encoder keeps every colour sample (4:4:4); a
 * browser's own encoder below quality 1.0 halves the colour resolution
 * (4:2:0, measured in Chromium), which smears saturated ink on paper.
 */
export const JPEG_QUALITY = 0.95

export const ENCODINGS: Record<ExportFormat, { mime: string; ext: string; quality: number | undefined }> = {
  // The encoder's quality, 1..100 (libjpeg's scale): 95.
  jpeg: { mime: 'image/jpeg', ext: 'jpg', quality: Math.round(JPEG_QUALITY * 100) },
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

/** The document's sheet as the planner reads it: its shape, whether it is
 *  Original, its frame's width and the mode the layout uses. */
export const planSheet = (s: SheetSpec): PlanSheet => ({
  aspect: sheetAspect(s),
  original: s.aspect === 'original',
  width: s.frame.width,
  mode: effectiveMode(s),
})

/** The size this print saves at: from its sheet and frame and its photo's
 *  TRUE size (never the preview's working copy), at its zoom, in its
 *  format. */
export function planPrint(settings: PrintSettings, opts: { maxHeight?: number; format?: ExportFormat } = {}): ExportPlan {
  const m = settings.media
  return planExport(planSheet(settings), m ? { width: m.width, height: m.height, scale: m.scale } : null, { maxHeight: opts.maxHeight, format: opts.format ?? 'jpeg' })
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
   *  file is written, so a cancelled save never returns a file. */
  signal?: AbortSignal
  onProgress?: (progress: RenderProgress) => void
  /** Called once the photo's last rows are read (the last band): the caller
   *  frees its decode. */
  onGround?: () => void
  /** Where the photo lands, when not where the document puts it: a smaller
   *  copy decoded to its rectangle (media.ts `snapCopyRect`), drawn 1:1. */
  rect?: DrawRect
  /** Makes the press's canvases (a tile canvas and, for a photo at its own
   *  pixels, the canvas its bands are blitted into): the page's detached
   *  canvases (features/shell/page.ts `detachedCanvas`), or a test's own. */
  makeCanvas: () => CanvasRenderingContext2D
}

/**
 * The test seam (README "Test seams"): read once per press from
 * `globalThis.__PM_TEST__`, inert when absent. `finishDelayMs` holds the
 * file's writing that long after the last band (`onFinishStart` called
 * first), so a gate can tap Cancel while the file is written; `tileBudget`
 * forces small tiles.
 */
interface TestSeam {
  finishDelayMs?: number
  onFinishStart?: () => void
  tileBudget?: TileBudget
}
const testSeam = (): TestSeam => (globalThis as { __PM_TEST__?: TestSeam }).__PM_TEST__ ?? {}

/** A press that runs out of memory starts again with bands half as tall, at
 *  most this many times. */
export const BAND_HALVINGS = 4

/** The reason a canvas that reads back blank is given. */
const BLANK = 'a canvas came back blank'

/**
 * The canvases a press of `plan` makes, at their real sizes: the tile canvas
 * at the grid's first tile (the largest, clipped to the sheet) and, when the
 * photo is drawn at its own pixels (`native`), the canvas each band of it is
 * blitted into (at most TILE_EDGE wide, a band tall).
 */
export function pressCanvases(plan: Pick<ExportPlan, 'width' | 'height'>, native: boolean, budget: TileBudget = TILE_BUDGET): { w: number; h: number }[] {
  const grid = tileGrid(plan.width, plan.height, budget)
  const sizes = [{ w: grid.tileW, h: Math.min(grid.tileH, plan.height) }]
  if (native) sizes.push({ w: Math.min(plan.width, Math.floor(budget.edge)), h: bandHeight(plan.width, plan.height) })
  return sizes
}

/** The save's encoder as the press's sink, its file in `chunks`. */
function encoderSink(format: ExportFormat, w: number, h: number, bandRows: number, chunks: Uint8Array[]): RowSink {
  const onChunk = (c: Uint8Array) => chunks.push(c)
  if (format === 'png') {
    const png = new PngEncoder(w, h, onChunk, { bandRows })
    return { put: (rgba, rows) => png.push(rgba, rows), settled: () => png.settled(), finish: () => png.finish(), abort: () => png.abort() }
  }
  const jpeg = new JpegEncoder(w, h, ENCODINGS.jpeg.quality!, onChunk)
  return { put: (rgba, rows) => jpeg.push(rgba, rows), settled: async () => {}, finish: async () => jpeg.finish(), abort: () => {} }
}

/**
 * Press the print at its planned size and write the file, band by band.
 *
 * The export never reads back the on-screen canvas — that canvas may carry a
 * selection crosshair. Pressing again with no overlay makes an editing aid in
 * a saved file structurally impossible rather than something we remember to
 * avoid (N8). The press's canvases are proved first (a sentinel pixel at
 * each one's last pixel, at the sizes the press will make them) and let go
 * (width 0) once the file exists, or the press fails.
 *
 * Out of memory (a `RangeError` from a typed array, anywhere in the press or
 * the encoder) starts the press again from the first band with bands half as
 * tall, a fresh encoder and fresh buffers, keeping what does not depend on
 * the band (the decoded photo, the photo's luminance grid, the type's
 * layouts), at most BAND_HALVINGS times: the same file, more slowly. Once the
 * photo's last rows are read the caller has closed its decode, so a press
 * that runs out of memory after that is not tried again. What cannot be
 * pressed at all is a CanvasLimitError, with the plan.
 *
 * @param media the photo decoded from its ORIGINAL bytes (not the preview's
 *   working copy), or a smaller copy decoded to `opts.rect`.
 * @param inputs what the frame's fill is made from (frame.ts `FrameInputs`):
 *   the caller has them ready before the press starts.
 */
export async function savePrint(settings: PrintSettings, media: CanvasImageSource | null, inputs: FrameInputs, opts: SaveOptions): Promise<PressedPrint> {
  if (settings.media && !media) throw new MissingPhotoError()
  const format = opts.format ?? 'jpeg'
  const plan = planPrint(settings, { maxHeight: opts.maxHeight, format })
  const { width: w, height: h } = plan
  // The press lays the sheet out at the plan's size (frame.ts `layoutSheet`);
  // a layout whose frame is not the plan's is not the print the caption
  // promised.
  const layout = layoutSheet(settings, w, h)
  if (layout.border !== plan.border) throw new Error(`The print's frame would be ${layout.border} px, not the planned ${plan.border} px.`)
  const seam = testSeam()
  const budget = seam.tileBudget ?? TILE_BUDGET
  const made: CanvasRenderingContext2D[] = []
  const canvas = () => {
    const ctx = opts.makeCanvas()
    made.push(ctx)
    return ctx
  }
  // The photo is closed by the caller once its last rows are read: from then
  // on a press cannot be run again. (With no photo there is nothing to lose.)
  let grounded = false
  const onGround = () => {
    if (media) grounded = true
    opts.onGround?.()
  }
  try {
    const size = media ? sourceSize(media) : null
    const rect = opts.rect ?? layout.photo
    const native = !!rect && !!size && isNativeRect(rect, size.width, size.height)
    // Every canvas the press makes, proved at its real size before any work:
    // over its limit an iOS canvas does not throw, it hands back a blank one,
    // and the print would come out empty.
    const [tileSize, pieceSize] = pressCanvases(plan, native, budget)
    const tile = canvas()
    if (!fitsCanvas(tile, tileSize.w, tileSize.h)) throw new CanvasLimitError(plan, BLANK)
    let piece: CanvasRenderingContext2D | undefined
    if (pieceSize) {
      piece = canvas()
      if (!fitsCanvas(piece, pieceSize.w, pieceSize.h)) throw new CanvasLimitError(plan, BLANK)
    }
    // Kept across a retry: they do not depend on the band.
    const plans = new Map<string, GlyphPlan>()
    const luma: { grid?: LumaGrid } = {}
    let B = bandHeight(w, h)
    for (let halvings = 0; ; halvings++) {
      const chunks: Uint8Array[] = []
      const sink = encoderSink(format, w, h, B, chunks)
      try {
        await pressToSink(settings, { w, h }, media, inputs, sink, {
          bandRows: B,
          tileBudget: budget,
          rect: opts.rect,
          signal: opts.signal,
          onProgress: opts.onProgress,
          onGround,
          plans,
          luma,
          canvases: { tile, piece: () => piece ?? (piece = canvas()) },
        })
        luma.grid = undefined
        // The file: written after the last band (Cancel stays live while it
        // is, a second or more on a phone: tapped then, there is no file).
        opts.onProgress?.({ step: 'write', band: Math.ceil(h / B), bands: Math.ceil(h / B) })
        // A moment for the page to say so.
        await new Promise((resolve) => setTimeout(resolve, 0))
        seam.onFinishStart?.()
        if (seam.finishDelayMs) await new Promise((resolve) => setTimeout(resolve, seam.finishDelayMs))
        throwIfAborted(opts.signal)
        await sink.finish()
        throwIfAborted(opts.signal)
        return { blob: new Blob(chunks as BlobPart[], { type: ENCODINGS[format].mime }), plan, format }
      } catch (err) {
        sink.abort()
        chunks.length = 0
        if (!(err instanceof RangeError) || grounded || halvings >= BAND_HALVINGS || B <= MIN_BAND_ROWS) throw err
        // Out of memory with the photo still held: again from the first band,
        // in bands half as tall. What the last attempt made is let go first.
        B = Math.max(MIN_BAND_ROWS, Math.floor(B / 2))
      }
    }
  } catch (err) {
    // Out of memory for a typed array or an ImageData is a RangeError: the
    // same "too big for this device", said the same way. (The engine's own
    // invariants throw a plain Error, so a bug never reads as a size.)
    if (err instanceof RangeError) throw new CanvasLimitError(plan, err.message)
    throw err
  } finally {
    for (const ctx of made) ctx.canvas.width = 0
  }
}

/**
 * This device could not press the print at this size: a canvas came back
 * blank (a sentinel pixel did not read back), the photo could not be decoded
 * whole while a smaller decode of it could, or memory ran out at the smallest
 * band. Never answered by quietly saving something smaller: the save flow
 * offers a smaller copy, in numbers, and the person chooses it
 * (`findSmallerPlanAsync`).
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
 * that failed, until `fits` holds for a copy that size — or null once a step
 * would go below SMALLEST_COPY_HEIGHT: this device cannot save this print.
 * `fits` is asked of each candidate in turn, largest first, and of none after
 * the first that fits (it may decode the photo at the candidate's size).
 *
 * Cancel (`signal`) is read before each candidate and after each answer: a
 * probe can take as long as a decode, and a Cancel tapped during it rejects
 * with an AbortError rather than putting a question to someone who left.
 */
export async function findSmallerPlanAsync(
  settings: PrintSettings,
  failedHeight: number,
  fits: (plan: ExportPlan) => Promise<boolean>,
  opts: { format?: ExportFormat; signal?: AbortSignal } = {},
): Promise<ExportPlan | null> {
  let maxHeight = failedHeight
  for (;;) {
    throwIfAborted(opts.signal)
    maxHeight = Math.round(maxHeight * SMALLER_STEP)
    if (maxHeight < SMALLEST_COPY_HEIGHT) return null
    const plan = planPrint(settings, { maxHeight, format: opts.format ?? 'jpeg' })
    const fit = await fits(plan)
    throwIfAborted(opts.signal)
    if (fit) return plan
  }
}

/** The pressed print as a named file. */
export function printFile(pressed: PressedPrint, name = 'print-machine'): File {
  const { mime, ext } = ENCODINGS[pressed.format]
  return new File([pressed.blob], `${name}.${ext}`, { type: mime })
}

/** Pixel dimensions as a person reads them. */
export const dims = (w: number, h: number): string => `${w}×${h}`

/** A file size as a person reads it: "6.2 MB", "840 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

const times = (k: number): string => `${Number(k.toFixed(2))}x`

/** What Save says about a plan (`describePlan`). */
export interface PlanWords {
  /** "9016×6440". */
  size: string
  /** "58.1 MP". */
  megapixels: string
  /** "with a 644 px frame", or null unframed: the frame adds pixels the
   *  photo does not have, so how many is said. */
  frame: string | null
  /** Over LARGE_PRINT_MP: that a phone may not finish it. Said before the
   *  tap; nothing is made smaller for it. */
  large: string | null
  /** When the print is not the photo's own pixels: why, in numbers. */
  reason: string | null
}

/**
 * What Save says about the size: the pixel size and the megapixels, the
 * frame when there is one, a very large print as such, and, when the print
 * is not at the photo's own pixels, why — in numbers, never quietly.
 */
export function describePlan(plan: ExportPlan, media: Pick<MediaLayer, 'width' | 'height' | 'scale'> | null): PlanWords {
  const size = dims(plan.width, plan.height)
  const mp = (plan.width * plan.height) / 1e6
  const megapixels = `${mp.toFixed(1)} MP`
  const frame = plan.border > 0 ? `with a ${plan.border} px frame` : null
  const large = mp > LARGE_PRINT_MP ? 'a very large print: a phone may not finish it' : null
  const photo = media ? `${dims(media.width, media.height)}${media.scale > 1 ? ` at ${Math.round(media.scale * 100)}% zoom` : ''}` : ''
  const words = { size, megapixels, frame, large }
  switch (plan.limit) {
    case 'native':
    case 'none':
      return { ...words, reason: null }
    case 'floor':
      return { ...words, reason: `photo is ${photo}: upscaled ${times(plan.upscale ?? 1)}` }
    case 'format':
      return { ...words, reason: 'JPEG holds at most 65,535 px a side: Save lossless PNG for the photo\'s full size' }
    case 'smaller':
      return { ...words, reason: 'a smaller copy, as asked' }
  }
}
