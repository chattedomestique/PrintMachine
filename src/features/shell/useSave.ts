import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  CanvasLimitError,
  MissingPhotoError,
  PHOTO_MISSING,
  SMALLER_STEP,
  SMALLEST_COPY_HEIGHT,
  dims,
  findSmallerPlanAsync,
  fitsCanvas,
  fileSize,
  planPrint,
  pressCanvases,
  printFile,
  savePrint,
  type ExportFormat,
  type PlanWords,
  type PressedPrint,
} from '../../engine/export.ts'
import type { ExportPlan } from '../../engine/exportPlan.ts'
import { effectiveMode, layoutSheet } from '../../engine/frame.ts'
import { snapCopyRect, type DrawRect } from '../../engine/media.ts'
import { throwIfAborted, type RenderProgress } from '../../engine/render.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { PhotoDecodeError, decodeOriginal, decodeResized } from '../media/decode.ts'
import { FILL_MISSING, FillMissingError, ensureFrameInputs, type PhotoState } from '../media/frameInputs.ts'
import type { FrameInputs } from '../../engine/frame.ts'
import { clearExportInFlight, markExportInFlight, takeExportInFlight } from '../../state/persist.ts'
import { canShareFile, deliverFile, detachedCanvas, saveMessage } from './page.ts'

/**
 * The save flow, as a state machine with no UI in it: the app bar's Save,
 * the status card above the dock, the More sheet and the save questions all
 * render from it.
 *
 * Why a flow at all: the print is pressed at the photo's own resolution,
 * which is seconds of work on a phone, and the share sheet needs the tap that
 * opened it to be recent (WebKit's window is short and undocumented). So:
 *
 *   idle ──tap──▶ loadingPhoto ──▶ pressing (band i of n) ──▶ ready ──tap──▶ sharing ──▶ idle
 *                                                         └──(under a second)──▶ sharing
 *
 * A press that finished within a second of the tap shares at once; a longer
 * one waits on a fresh tap (Save reads "Share", and the card says "2419×3024
 * is ready (6.2 MB)") with the file already encoded. Cancel works at every step of the press. A share that fails keeps
 * the file and the button: in an iOS home-screen app it never falls through to
 * a download, which would navigate away from the app.
 */
export type SaveState =
  | { kind: 'idle' }
  /** Decoding the photo's ORIGINAL bytes for the press. */
  | { kind: 'loadingPhoto'; format: ExportFormat; plan: ExportPlan }
  | { kind: 'pressing'; format: ExportFormat; plan: ExportPlan; progress: RenderProgress | null }
  /** Pressed and encoded; waiting for a tap to share it. */
  | { kind: 'ready'; file: File; plan: ExportPlan }
  | { kind: 'sharing'; file: File; plan: ExportPlan }
  | { kind: 'error'; message: string }
  /** This device could not press `failed` (`why`: a canvas came back blank,
   *  the photo could not be decoded whole, memory ran out — the browser's own
   *  words);
   *  `smaller` is the largest copy it can (null: none it can). Asked, never
   *  done unasked. */
  | { kind: 'tooBig'; format: ExportFormat; failed: ExportPlan; why: string; smaller: ExportPlan | null }
  /** A save of `height` was in flight when the app last went away (a killed
   *  tab, perhaps): said at launch, without claiming why. */
  | { kind: 'interrupted'; format: ExportFormat; height: number }

export type SaveEvent =
  | { type: 'start'; format: ExportFormat; plan: ExportPlan; photo: boolean }
  | { type: 'photoLoaded' }
  | { type: 'progress'; progress: RenderProgress }
  /** The file exists. `now`: hand it over at once (the tap is still fresh, or
   *  there is no share sheet to need it); otherwise wait for a tap. */
  | { type: 'pressed'; file: File; now: boolean }
  | { type: 'share' }
  | { type: 'delivered' }
  | { type: 'shareFailed' }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }
  | { type: 'tooBig'; failed: ExportPlan; why: string; smaller: ExportPlan | null }
  | { type: 'interrupted'; format: ExportFormat; height: number }
  | { type: 'dismiss' }
  /** The document was edited: a file waiting for its tap is no longer this
   *  print, and an old error is no longer about it. */
  | { type: 'documentChanged' }

export const IDLE: SaveState = { kind: 'idle' }

/** A press that finished this soon after the tap shares at once. */
export const SHARE_AT_ONCE_MS = 1000

/** The transitions. Anything not listed for a state leaves it as it is. */
export function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case 'start':
      if (!startsFrom(state)) return state
      return event.photo
        ? { kind: 'loadingPhoto', format: event.format, plan: event.plan }
        : { kind: 'pressing', format: event.format, plan: event.plan, progress: null }
    case 'photoLoaded':
      return state.kind === 'loadingPhoto' ? { kind: 'pressing', format: state.format, plan: state.plan, progress: null } : state
    case 'progress':
      return state.kind === 'pressing' ? { ...state, progress: event.progress } : state
    case 'pressed':
      if (state.kind !== 'pressing') return state
      return event.now
        ? { kind: 'sharing', file: event.file, plan: state.plan }
        : { kind: 'ready', file: event.file, plan: state.plan }
    case 'share':
      return state.kind === 'ready' ? { kind: 'sharing', file: state.file, plan: state.plan } : state
    case 'delivered':
      return state.kind === 'sharing' ? IDLE : state
    case 'shareFailed':
      // The file is kept, and so is the button: another tap, never a download.
      return state.kind === 'sharing' ? { kind: 'ready', file: state.file, plan: state.plan } : state
    case 'cancelled':
      return state.kind === 'loadingPhoto' || state.kind === 'pressing' ? IDLE : state
    case 'failed':
      return { kind: 'error', message: event.message }
    case 'tooBig':
      return state.kind === 'loadingPhoto' || state.kind === 'pressing'
        ? { kind: 'tooBig', format: state.format, failed: event.failed, why: event.why, smaller: event.smaller }
        : state
    case 'interrupted':
      return state.kind === 'idle' ? { kind: 'interrupted', format: event.format, height: event.height } : state
    case 'dismiss':
      return state.kind === 'error' || state.kind === 'ready' || state.kind === 'tooBig' || state.kind === 'interrupted' ? IDLE : state
    case 'documentChanged':
      // An unfinished save's notice stays: what it offers is worked out from
      // the document as it is now. A smaller copy offered for a failed press
      // was worked out from the document as it was, so it goes.
      return state.kind === 'error' || state.kind === 'ready' || state.kind === 'tooBig' ? IDLE : state
  }
}

/** The states a new save may start from: anything not already pressing or
 *  sharing. */
const startsFrom = (state: SaveState) =>
  state.kind === 'idle' || state.kind === 'error' || state.kind === 'ready' || state.kind === 'tooBig' || state.kind === 'interrupted'

/** The press is running: the preview stops rendering, so a full-size press
 *  and a preview frame never hold their buffers at once, and the page behind
 *  the progress is inert. */
export function pressInProgress(state: SaveState): boolean {
  return state.kind === 'loadingPhoto' || state.kind === 'pressing'
}

/**
 * Why nothing can be pressed for the document's photo as it is, in the words
 * every place that refuses says: its stored photo is gone or will not decode
 * (PHOTO_MISSING), or the photo is drawn but its frame's fill cannot be made
 * from it (FILL_MISSING). Null when nothing stands in the way.
 */
export function saveRefusal(media: PhotoState): string | null {
  return media === 'failed' ? PHOTO_MISSING : media === 'fillFailed' ? FILL_MISSING : null
}

/** Whether a tap may start a save: not while one runs, not while the
 *  document's photo is still loading, and not while it is refused
 *  (saveRefusal; the status card says why). */
export function canStart(state: SaveState, media: PhotoState): boolean {
  return startsFrom(state) && media !== 'loading' && saveRefusal(media) === null
}

/**
 * What the app bar's Save says: ONE word, so the bar never wraps and Save
 * never changes width (the style guide's rule 19; Border Studio keeps it to
 * one word too). "Save"; "Saving" while the photo loads, the print is pressed
 * or the file is handed over (busy: a spinner, and taps are ignored); "Share"
 * once a file is ready and waits for a fresh tap to open the share sheet.
 * Everything longer (the size, the progress, why it cannot be pressed) is
 * said in the status card above the dock (saveStatus), in the More sheet and
 * in the button's accessible name (saveLabel).
 *
 * `disabled` when a tap would do nothing; `why` when it cannot be pressed for
 * a reason the person has to act on (a bare disabled Save explains nothing).
 */
export function saveButton(
  state: SaveState,
  media: PhotoState,
): { text: 'Save' | 'Saving' | 'Share'; busy: boolean; disabled: boolean; why?: string } {
  switch (state.kind) {
    case 'loadingPhoto':
    case 'pressing':
    case 'sharing':
      return { text: 'Saving', busy: true, disabled: true }
    case 'ready':
      return { text: 'Share', busy: false, disabled: false }
    case 'idle':
    case 'error':
    case 'tooBig':
    case 'interrupted': {
      // The document's photo is still decoding: Save waits for it.
      if (media === 'loading') return { text: 'Save', busy: false, disabled: true }
      // The document's photo is gone, or its frame's fill cannot be made
      // from it: no size is promised and nothing can be pressed until that
      // changes (never the type on bare paper, never a frame quietly Paper).
      const why = saveRefusal(media)
      if (why) return { text: 'Save', busy: false, disabled: true, why }
      return { text: 'Save', busy: false, disabled: false }
    }
  }
}

/**
 * Save's accessible name: its one word first (WCAG 2.5.3, the name starts
 * with the label you see), then what it would make or why it cannot. What it
 * would make is said as the More sheet's first row says it: the size, and
 * when the photo is framed the frame in pixels (a frame adds pixels the photo
 * does not have), and past LARGE_PRINT_MP that a phone may not finish it, so
 * the size a frame makes is stated before the tap, from every tool the frame
 * is set in or seen from.
 *
 * @param caption what Save makes now, from describePlan.
 */
export function saveLabel(state: SaveState, media: PhotoState, caption: Pick<PlanWords, 'size' | 'frame' | 'large'>): string {
  const b = saveButton(state, media)
  if (b.why) return `${b.text}: ${b.why}`
  switch (state.kind) {
    case 'loadingPhoto':
    case 'pressing':
    case 'sharing':
      return `Saving ${dims(state.plan.width, state.plan.height)}`
    case 'ready':
      return `Share ${dims(state.plan.width, state.plan.height)} (${fileSize(state.file.size)})`
    default:
      if (media === 'loading') return 'Save: loading the photo'
      return `Save ${caption.size} JPEG${caption.frame ? ` ${caption.frame}` : ''}${caption.large ? `, ${caption.large}` : ''}`
  }
}

/** The More sheet's first row: what a save would make, or why it cannot. */
export interface MoreCaption {
  /** The pixel size a save makes ("2419×3024"); null when it promises none. */
  size: string | null
  /** The row's words: "Saves 2419×3024", or why nothing can be saved. */
  word: string
  /** Under them: why the size is not the photo's own pixels (in numbers),
   *  that it is, or what to do. */
  meta: string
  /** A reason nothing can be saved: drawn as the status card's alert is
   *  (the card is the alert; this row is the same words where More is read). */
  alert: boolean
}

/**
 * The More sheet's first row, from the caption (describePlan) and the
 * document's photo: the size a save makes, why when it is not the photo's own
 * pixels, and its megapixels with the frame's border in pixels (a frame adds
 * pixels the photo does not have, so how many is said before the tap), and
 * past LARGE_PRINT_MP that a phone may not finish it (said, never acted on).
 * While the photo cannot be loaded no size is promised, as Save's name and
 * the status card promise none: the row says why, the same sentence, and
 * nothing is saved without the photo.
 */
export function moreCaption(
  media: PhotoState,
  caption: Pick<PlanWords, 'size' | 'reason' | 'megapixels' | 'frame' | 'large'>,
  photo: boolean,
): MoreCaption {
  if (media === 'failed') {
    return { size: null, word: PHOTO_MISSING, meta: 'Nothing is saved without it: never the type on bare paper.', alert: true }
  }
  if (media === 'fillFailed') {
    return { size: null, word: FILL_MISSING, meta: 'Nothing is saved with its frame left Paper.', alert: true }
  }
  const why = caption.reason ?? (photo ? "the photo's own pixels, one for one" : 'no photo: type on bare paper')
  const size = [caption.megapixels, caption.frame, caption.large].filter((w) => w !== null).join(', ')
  return {
    size: caption.size,
    word: `Saves ${caption.size}`,
    meta: `${why.charAt(0).toUpperCase()}${why.slice(1)}. ${size.charAt(0).toUpperCase()}${size.slice(1)}.`,
    alert: false,
  }
}

/** What a toast says: a thing done, something to know, or a failure (each
 *  with its own symbol, so none is told by colour). */
export type Announcement = 'done' | 'info' | 'error'

/** What the status card above the dock carries, and the one action it
 *  offers. */
export interface SaveStatus {
  text: string
  /** An error, or a reason Save cannot be pressed: role=alert. */
  alert: boolean
  /** Work under way: a spinner beside the words. */
  busy: boolean
  /**
   *  - `cancel`   stop the press (the rest of the page is inert meanwhile);
   *  - `discard`  let go of a file waiting for its Share;
   *  - `dismiss`  close an error;
   *  - `choose`   choose the photo again.
   */
  action: 'cancel' | 'discard' | 'dismiss' | 'choose' | null
  /** Shown only if it is still true after a moment, so a wait that ends at
   *  once never flashes a card. */
  delay?: true
}

/**
 * The status card: the save flow's state when it has something to say beyond
 * the one word on Save. Null: no card.
 */
export function saveStatus(state: SaveState, media: PhotoState): SaveStatus | null {
  const why = saveButton(state, media).why
  if (why) return { text: why, alert: true, busy: false, action: 'choose' }
  switch (state.kind) {
    case 'loadingPhoto':
    case 'pressing':
      return { text: progressText(state) ?? '', alert: false, busy: true, action: 'cancel' }
    case 'sharing':
      return { text: progressText(state) ?? '', alert: false, busy: true, action: null }
    case 'ready':
      return { text: `${dims(state.plan.width, state.plan.height)} is ready (${fileSize(state.file.size)}). Tap Share to save it.`, alert: false, busy: false, action: 'discard' }
    case 'error':
      return { text: state.message, alert: true, busy: false, action: 'dismiss' }
    case 'idle':
    case 'tooBig':
    case 'interrupted':
      // Save waits for the document's photo to decode, and says so.
      return media === 'loading' ? { text: 'Loading the photo…', alert: false, busy: true, action: null, delay: true } : null
  }
}

/** A way to answer a save question: a save no taller than `height`. */
export interface SaveChoice {
  label: string
  height: number
}

/**
 * The question the save flow puts when it cannot go on unasked, in numbers,
 * with the saves it offers (Cancel is always there besides), and a heading for
 * its dialog. Null when there is none.
 *
 * @param planAt the current document's plan no taller than a height.
 */
export function saveQuestion(
  state: SaveState,
  planAt: (maxHeight: number) => ExportPlan,
): { title: string; text: string; choices: SaveChoice[] } | null {
  const size = (p: ExportPlan) => dims(p.width, p.height)
  if (state.kind === 'tooBig') {
    // The reason in the browser's words too: a "too big" that was really
    // something else must not hide behind the offer.
    const failed = `${size(state.failed)} (${state.why})`
    if (!state.smaller) {
      return {
        title: 'Too big for this device',
        text: `This device couldn't press ${failed}, nor a copy smaller than it: it cannot save this print.`,
        choices: [],
      }
    }
    return {
      title: 'Too big for this device',
      text: `This device couldn't press ${failed}. Save a smaller ${size(state.smaller)} copy instead?`,
      choices: [{ label: 'Save smaller', height: state.smaller.height }],
    }
  }
  if (state.kind === 'interrupted') {
    // Not "the device could not": a killed tab may be anything. The same
    // save again, or one step smaller.
    const again = planAt(state.height)
    const smallerHeight = Math.round(again.height * SMALLER_STEP)
    const choices = [{ label: 'Try again', height: again.height }]
    if (smallerHeight >= SMALLEST_COPY_HEIGHT) {
      const smaller = planAt(smallerHeight)
      choices.push({ label: `Save smaller (${size(smaller)})`, height: smaller.height })
    }
    return { title: 'A save did not finish', text: `The last save, ${size(again)}, did not finish.`, choices }
  }
  return null
}

/** The line the save flow shows while it works, or null when it has nothing
 *  to say beyond the caption. */
export function progressText(state: SaveState): string | null {
  switch (state.kind) {
    case 'loadingPhoto':
      return `Pressing ${dims(state.plan.width, state.plan.height)}: loading the photo`
    case 'pressing': {
      const p = state.progress
      const size = dims(state.plan.width, state.plan.height)
      // Before the first step the press has said nothing yet.
      if (!p) return `Pressing ${size}`
      // The photo read for the second ink, before the first band.
      if (p.step === 'photo') return `Pressing ${size}: reading the photo`
      if (p.step === 'write') return `Pressing ${size}: writing the file`
      return `Pressing ${size}, ${Math.floor((100 * p.band) / Math.max(1, p.bands))}%`
    }
    case 'ready':
      return `${dims(state.plan.width, state.plan.height)} is ready.`
    case 'sharing':
      return `Saving ${dims(state.plan.width, state.plan.height)}`
    case 'error':
      return state.message
    case 'tooBig':
    case 'interrupted':
    case 'idle':
      return null
  }
}

/** An iOS home-screen app (or any installed one): no download fallback. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as { standalone?: boolean }).standalone === true
}

/** Wait for the next painted frame, twice, so a label set now is on screen
 *  before the work starts. */
const painted = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'

/** What a press for Save needs from the page: the decodes, the canvases and
 *  the press itself (a test hands in its own). */
export interface SaveDeps {
  /** What the frame's fill is made from, made now if the document does not
   *  hold it (features/media `ensureFrameInputs`). */
  frameInputs(settings: PrintSettings): Promise<FrameInputs>
  decodeOriginal(id: string): Promise<ImageBitmap>
  decodeResized(id: string, width: number, height: number): Promise<ImageBitmap>
  savePrint: typeof savePrint
  /** Makes each canvas the press draws on (the engine makes none). */
  makeCanvas(): CanvasRenderingContext2D
  /** Whether a canvas of w x h works here (a sentinel pixel read back), then
   *  let go. */
  canvasFits(w: number, h: number): boolean
}

/** The page's own. */
export const PAGE: SaveDeps = {
  frameInputs: (settings) => ensureFrameInputs(settings),
  decodeOriginal,
  decodeResized,
  savePrint,
  makeCanvas: detachedCanvas,
  // The very canvases the press would make, proved and let go.
  canvasFits: (w, h) => {
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = detachedCanvas()
      return fitsCanvas(ctx, w, h)
    } catch {
      return false
    } finally {
      if (ctx) ctx.canvas.width = 0
    }
  },
}

/**
 * The rectangle a smaller copy's photo is decoded to and drawn at, 1:1: the
 * cover of the visible rectangle rounded up to whole pixels (`snapCopyRect`),
 * or in Fit the contained rectangle itself, already whole and never widened
 * to the area it sits in.
 */
export function copyRect(settings: PrintSettings, plan: ExportPlan): DrawRect | null {
  const { photo, visible } = layoutSheet(settings, plan.width, plan.height)
  if (!photo) return null
  return effectiveMode(settings) === 'fit' ? photo : snapCopyRect(photo, visible)
}

/**
 * Whether this device can press a smaller copy `plan`, in two steps, the
 * second only if the first holds: (1) every canvas the press of it makes, at
 * its real size, reads its sentinel pixel back; (2) the photo decodes at the
 * copy's size (closed at once). A photo decoded whole for every candidate
 * would be the very thing that failed.
 */
export async function copyFits(settings: PrintSettings, plan: ExportPlan, deps: SaveDeps): Promise<boolean> {
  for (const c of pressCanvases(plan, settings.media !== null)) if (!deps.canvasFits(c.w, c.h)) return false
  const r = copyRect(settings, plan)
  if (!settings.media || !r) return true
  try {
    ;(await deps.decodeResized(settings.media.id, r.dw, r.dh)).close()
    return true
  } catch {
    return false
  }
}

/** What a press for Save came to: a file, or a print this device cannot
 *  press, with the largest smaller copy it can (null: none). */
export type SaveResult = { kind: 'pressed'; pressed: PressedPrint } | { kind: 'tooBig'; failed: ExportPlan; why: string; smaller: ExportPlan | null }

/**
 * The press behind Save, with no UI in it: decode the photo, press, and, when
 * this device cannot, find the copy it can.
 *
 *  - The frame's inputs (the photo's palette, Frosted's field) are made
 *    first when the document does not hold them, and under any fill the
 *    page's palette decode is waited for, and every other frame-source
 *    decode still running (`ensureFrameInputs`), so the press never starts
 *    without them and no such decode runs beside the original's.
 *  - A print at the photo's own size decodes the ORIGINAL in full. If that
 *    fails, it is a question of size only when a smaller decode of the same
 *    file succeeds (the import already decoded it once): then the largest
 *    copy this device can press is offered, with the browser's reason; a
 *    file that cannot be decoded at any size stays a plain failure.
 *  - A smaller copy (`plan.limit === 'smaller'`) decodes the photo straight
 *    to the copy's integer rectangle (`copyRect`) and presses it 1:1.
 *  - A CanvasLimitError from the press offers the largest copy that fits.
 *
 * Rejects with the press's AbortError on Cancel (also one tapped while the
 * smaller copies are probed), and with an Error that says why on any other
 * failure. The photo is closed by the time it settles.
 */
export async function pressForSave(
  run: {
    settings: PrintSettings
    format: ExportFormat
    maxHeight?: number
    signal?: AbortSignal
    onPhotoLoaded?: () => void
    onProgress?: (progress: RenderProgress) => void
  },
  deps: SaveDeps = PAGE,
): Promise<SaveResult> {
  const { settings, format, maxHeight, signal } = run
  const plan = planPrint(settings, { maxHeight, format })
  // A Cancel tapped while the copies are probed (each may decode the photo)
  // is an AbortError, never the question afterwards.
  const smaller = async (height: number) => {
    const copy = await findSmallerPlanAsync(settings, height, (p) => copyFits(settings, p, deps), { format, signal })
    throwIfAborted(signal)
    return copy
  }
  let photo: ImageBitmap | null = null
  try {
    // The frame's inputs first: made from a decode of their own (the
    // photo's colours), which is over before the original is decoded, as
    // is any such decode still running for another photo or a frame no
    // longer shown, so the two never hold their pixels at once. A photo
    // whose fill they cannot be made from is refused, in the page's words
    // for it (FILL_MISSING): never pressed with a frame quietly Paper. A
    // stored photo that is gone is said as that.
    // A Cancel while they are waited for (their decodes may be another
    // photo's, and slow) ends the save at once: the decodes run on, nothing
    // is decoded or pressed after them.
    let inputs: FrameInputs
    try {
      inputs = await untilAborted(deps.frameInputs(settings), signal)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw err instanceof MissingPhotoError ? err : new FillMissingError()
    }
    throwIfAborted(signal)
    let rect: DrawRect | undefined
    if (settings.media) {
      if (plan.limit === 'smaller') {
        rect = copyRect(settings, plan) ?? undefined
        photo = await deps.decodeResized(settings.media.id, rect!.dw, rect!.dh)
      } else {
        try {
          photo = await deps.decodeOriginal(settings.media.id)
        } catch (err) {
          if (!(err instanceof PhotoDecodeError)) throw err
          // Decoded at import, so a whole decode that fails now is this
          // device's memory if, and only if, a smaller one works.
          const copy = await smaller(plan.height)
          if (copy) return { kind: 'tooBig', failed: plan, why: err.reason, smaller: copy }
          throw err
        }
      }
    }
    throwIfAborted(signal)
    run.onPhotoLoaded?.()
    const decoded = photo
    try {
      const pressed = await deps.savePrint(settings, decoded, inputs, {
        format,
        maxHeight,
        signal,
        rect,
        makeCanvas: deps.makeCanvas,
        onProgress: run.onProgress,
        onGround: () => decoded?.close(),
      })
      return { kind: 'pressed', pressed }
    } catch (err) {
      if (!(err instanceof CanvasLimitError)) throw err
      // Offered, never taken unasked: the largest smaller copy whose canvases
      // and photo this device proves it can hold.
      photo?.close()
      photo = null
      return { kind: 'tooBig', failed: err.plan, why: err.why, smaller: await smaller(err.plan.height) }
    }
  } finally {
    photo?.close()
  }
}

/**
 * `work`, or the save's AbortError as soon as `signal` aborts, whichever comes
 * first. The work is not stopped (a decode cannot be), only no longer waited
 * for; what it settles with later is dropped, never an unhandled rejection.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  work.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('The save was cancelled.', 'AbortError'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (v) => (signal.removeEventListener('abort', abort), resolve(v)),
      (e) => (signal.removeEventListener('abort', abort), reject(e)),
    )
  })
}

/** Ask the screen to stay on while the print is pressed (a screen that sleeps
 *  suspends the page's timers, and a long press is when it would). Best
 *  effort: null where there is no Wake Lock (iOS before 16.4) or it is
 *  refused. */
async function keepAwake(): Promise<{ release(): Promise<void> } | null> {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    return null
  }
}

/**
 * Run the save flow for the current document.
 *
 * @param announce shows a one-line message (the toast): a save done, or why
 *   a share did not happen.
 */
export function useSave(
  settings: PrintSettings,
  media: PhotoState,
  announce: (message: string | null, kind?: Announcement) => void,
) {
  const [state, dispatch] = useReducer(saveReducer, IDLE)
  const stateRef = useRef(state)
  const abortRef = useRef<AbortController | null>(null)
  // Set the moment a save starts, before React has re-rendered the button: a
  // second tap in that gap must not start a second press.
  const runningRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  // A save in flight is abandoned with the page.
  useEffect(() => () => abortRef.current?.abort(), [])

  // An edit after the press: the waiting file is of the print as it was, so
  // it is dropped rather than shared under the new one's name. (While the
  // press runs nothing can edit: the page is inert, and keyboard undo, a
  // window listener inert does not reach, is off — AppShell.)
  useEffect(() => dispatch({ type: 'documentChanged' }), [settings])

  // A save that was in flight when the app last went away: said once, at
  // launch (reading the mark clears it).
  useEffect(() => {
    const unfinished = takeExportInFlight()
    if (unfinished) dispatch({ type: 'interrupted', ...unfinished })
  }, [])

  const deliver = useCallback(
    async (file: File, plan: ExportPlan) => {
      try {
        const delivery = await deliverFile(file, { allowDownload: !isStandalone() })
        dispatch({ type: 'delivered' })
        announce(saveMessage(delivery, plan), 'done')
      } catch (err) {
        dispatch({ type: 'shareFailed' })
        if (err instanceof Error && err.name === 'NotAllowedError') announce('Tap Share to save it.', 'info')
        else announce(`It could not be shared: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },
    [announce],
  )

  const start = useCallback(
    async (format: ExportFormat, maxHeight?: number) => {
      if (runningRef.current || !canStart(stateRef.current, media)) return
      runningRef.current = true
      const plan = planPrint(settings, { maxHeight, format })
      const tapped = performance.now()
      const controller = new AbortController()
      abortRef.current = controller
      dispatch({ type: 'start', format, plan, photo: settings.media !== null })
      let awake: { release(): Promise<void> } | null = null
      try {
        // The label changes before any work: two frames, so it is painted.
        await painted()
        // Marked for the next launch to find, should the tab die from here
        // (the original's decode included).
        markExportInFlight({ height: plan.height, format })
        awake = await keepAwake()
        // The ORIGINAL, decoded now and in full (4 bytes a pixel of the photo,
        // 159 MB for a 40 MP one), let go once its last rows are in the print;
        // the press draws on fresh offscreen canvases, so the export can never
        // read back the visible one, which carries the selection crosshair
        // (N8).
        const result = await pressForSave({
          settings,
          format,
          maxHeight,
          signal: controller.signal,
          onPhotoLoaded: () => dispatch({ type: 'photoLoaded' }),
          onProgress: (progress) => dispatch({ type: 'progress', progress }),
        })
        if (result.kind === 'tooBig') {
          dispatch({ type: 'tooBig', failed: result.failed, why: result.why, smaller: result.smaller })
          return
        }
        const file = printFile(result.pressed)
        // Hand it over now if the tap is still fresh, or if there is no share
        // sheet to need it (a desktop download); otherwise wait for a tap.
        const now = !canShareFile(file) || performance.now() - tapped < SHARE_AT_ONCE_MS
        dispatch({ type: 'pressed', file, now })
        if (now) await deliver(file, result.pressed.plan)
      } catch (err) {
        if (isAbort(err)) {
          dispatch({ type: 'cancelled' })
          return
        }
        // Never a quieter, smaller file: the reason, with the numbers.
        const reason = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'failed', message: `Could not press ${dims(plan.width, plan.height)}: ${reason}` })
      } finally {
        clearExportInFlight()
        void awake?.release().catch(() => {})
        if (abortRef.current === controller) abortRef.current = null
        runningRef.current = false
      }
    },
    [settings, media, deliver],
  )

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  const share = useCallback(() => {
    const current = stateRef.current
    if (current.kind !== 'ready') return
    dispatch({ type: 'share' })
    void deliver(current.file, current.plan)
  }, [deliver])

  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), [])

  /** Answer the question (saveQuestion) with a height: the smaller copy it
   *  offers, or, after an unfinished save, that save again. */
  const answer = useCallback(
    (height: number) => {
      const current = stateRef.current
      if (current.kind === 'tooBig' || current.kind === 'interrupted') void start(current.format, height)
    },
    [start],
  )

  return { state, start, cancel, share, dismiss, answer }
}
