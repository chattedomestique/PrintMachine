import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  CanvasLimitError,
  PHOTO_MISSING,
  SMALLER_STEP,
  SMALLEST_COPY_HEIGHT,
  canShareFile,
  deliverFile,
  dims,
  findSmallerPlan,
  fitsCanvas,
  fileSize,
  planPrint,
  printFile,
  saveMessage,
  savePrint,
  type ExportFormat,
} from '../../engine/export.ts'
import type { ExportPlan } from '../../engine/exportPlan.ts'
import type { RenderProgress } from '../../engine/render.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { decodeOriginal } from '../media/decode.ts'
import type { MediaState } from '../media/useMediaBitmap.ts'
import { clearExportInFlight, markExportInFlight, takeExportInFlight } from '../../state/persist.ts'

/**
 * The save flow, as a state machine with no UI in it: the app bar's Save,
 * the status card above the dock, the More sheet and the save questions all
 * render from it.
 *
 * Why a flow at all: the print is pressed at the photo's own resolution,
 * which is seconds of work on a phone, and the share sheet needs the tap that
 * opened it to be recent (WebKit's window is short and undocumented). So:
 *
 *   idle ──tap──▶ loadingPhoto ──▶ pressing (pass i of n) ──▶ ready ──tap──▶ sharing ──▶ idle
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
   *  the encoder gave nothing, memory ran out — the browser's own words);
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

/** Whether a tap may start a save: not while one runs, and not while the
 *  document's photo is still loading or failed to load (the Photo panel says
 *  why). */
export function canStart(state: SaveState, media: MediaState): boolean {
  return startsFrom(state) && media !== 'loading' && media !== 'failed'
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
  media: MediaState,
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
    case 'interrupted':
      // The document's photo is still decoding: Save waits for it.
      if (media === 'loading') return { text: 'Save', busy: false, disabled: true }
      // The document's photo is gone: no size is promised and nothing can be
      // pressed until it is chosen again (never the type on bare paper).
      if (media === 'failed') return { text: 'Save', busy: false, disabled: true, why: PHOTO_MISSING }
      return { text: 'Save', busy: false, disabled: false }
  }
}

/**
 * Save's accessible name: its one word first (WCAG 2.5.3, the name starts
 * with the label you see), then what it would make or why it cannot.
 *
 * @param size what Save makes now ("2419×3024"), from the caption.
 */
export function saveLabel(state: SaveState, media: MediaState, size: string): string {
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
      return media === 'loading' ? 'Save: loading the photo' : `Save ${size} JPEG`
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
export function saveStatus(state: SaveState, media: MediaState): SaveStatus | null {
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
      // Before the first step the press has said nothing yet: a print with no
      // photo never lays one down.
      if (!p) return `Pressing ${size}`
      if (p.step === 'photo') return `Pressing ${size}: laying down the photo`
      if (p.step === 'print') return `Pressing ${size}: printing the sheet`
      return `Pressing ${size}, plate ${p.pass} of ${p.passes}`
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

/** Whether both of the press's canvases can be this size here (each proved
 *  by a sentinel pixel), then let go. */
function canvasesFit(w: number, h: number): boolean {
  const a = document.createElement('canvas').getContext('2d')
  const b = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  try {
    return !!a && !!b && fitsCanvas(a, w, h) && fitsCanvas(b, w, h)
  } finally {
    if (a) a.canvas.width = 0
    if (b) b.canvas.width = 0
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
  media: MediaState,
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
      const plan = planPrint(settings, { maxHeight })
      const tapped = performance.now()
      const controller = new AbortController()
      abortRef.current = controller
      dispatch({ type: 'start', format, plan, photo: settings.media !== null })
      let photo: ImageBitmap | null = null
      try {
        // The label changes before any work: two frames, so it is painted.
        await painted()
        // Fresh offscreen surfaces so the export can never read back the
        // visible canvas, which carries the selection crosshair (N8).
        const out = document.createElement('canvas').getContext('2d')
        const scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
        if (!out || !scratch) throw new Error('Could not open a canvas to press the print.')
        // Marked for the next launch to find, should the tab die from here
        // (the original's decode included).
        markExportInFlight({ height: plan.height, format })
        // The ORIGINAL, decoded now and in full (4 bytes a pixel of the photo,
        // 98 MB for a 24 MP one), and let go the moment the ground is drawn.
        if (settings.media) photo = await decodeOriginal(settings.media.id)
        if (controller.signal.aborted) throw new DOMException('The save was cancelled.', 'AbortError')
        dispatch({ type: 'photoLoaded' })
        const decoded = photo
        const pressed = await savePrint(out, scratch, settings, decoded, {
          format,
          maxHeight,
          signal: controller.signal,
          onProgress: (progress) => dispatch({ type: 'progress', progress }),
          onGround: () => decoded?.close(),
        })
        const file = printFile(pressed)
        // Hand it over now if the tap is still fresh, or if there is no share
        // sheet to need it (a desktop download); otherwise wait for a tap.
        const now = !canShareFile(file) || performance.now() - tapped < SHARE_AT_ONCE_MS
        dispatch({ type: 'pressed', file, now })
        if (now) await deliver(file, pressed.plan)
      } catch (err) {
        if (isAbort(err)) {
          dispatch({ type: 'cancelled' })
          return
        }
        if (err instanceof CanvasLimitError) {
          // Offered, never taken unasked: the largest smaller copy whose
          // canvases this device proves it can hold.
          photo?.close()
          photo = null
          dispatch({ type: 'tooBig', failed: err.plan, why: err.why, smaller: findSmallerPlan(settings, err.plan.height, canvasesFit) })
          return
        }
        // Never a quieter, smaller file: the reason, with the numbers.
        const reason = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'failed', message: `Could not press ${dims(plan.width, plan.height)}: ${reason}` })
      } finally {
        clearExportInFlight()
        photo?.close()
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
