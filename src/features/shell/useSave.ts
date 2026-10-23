import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  canShareFile,
  deliverFile,
  dims,
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

/**
 * The save flow, as a state machine with no UI in it (the old chrome and the
 * style guide's dock both render from it).
 *
 * Why a flow at all: the print is pressed at the photo's own resolution,
 * which is seconds of work on a phone, and the share sheet needs the tap that
 * opened it to be recent (WebKit's window is short and undocumented). So:
 *
 *   idle ──tap──▶ loadingPhoto ──▶ pressing (pass i of n) ──▶ ready ──tap──▶ sharing ──▶ idle
 *                                                         └──(under a second)──▶ sharing
 *
 * A press that finished within a second of the tap shares at once; a longer
 * one waits on a fresh tap ("Save to Photos (6.2 MB)") with the file already
 * encoded. Cancel works at every step of the press. A share that fails keeps
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
      if (state.kind !== 'idle' && state.kind !== 'error' && state.kind !== 'ready') return state
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
    case 'dismiss':
    case 'documentChanged':
      return state.kind === 'error' || state.kind === 'ready' ? IDLE : state
  }
}

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
  return (state.kind === 'idle' || state.kind === 'error' || state.kind === 'ready') && media !== 'loading' && media !== 'failed'
}

/** What the Save button says, and whether it can be pressed. */
export function saveButton(state: SaveState, media: MediaState): { text: string; disabled: boolean } {
  switch (state.kind) {
    case 'loadingPhoto':
    case 'pressing':
      return { text: 'Cancel', disabled: false }
    case 'ready':
      return { text: `Save to Photos (${fileSize(state.file.size)})`, disabled: false }
    case 'sharing':
      return { text: 'Saving…', disabled: true }
    case 'idle':
    case 'error':
      if (media === 'loading') return { text: 'Loading photo', disabled: true }
      return { text: 'Save', disabled: media === 'failed' }
  }
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
      if (!p || p.step === 'photo') return `Pressing ${size}: laying down the photo`
      if (p.step === 'print') return `Pressing ${size}: printing the sheet`
      return `Pressing ${size}, plate ${p.pass} of ${p.passes}`
    }
    case 'ready':
      return `${dims(state.plan.width, state.plan.height)} is ready.`
    case 'sharing':
      return `Saving ${dims(state.plan.width, state.plan.height)}`
    case 'error':
      return state.message
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

/**
 * Run the save flow for the current document.
 *
 * @param announce shows a one-line message (the toast).
 */
export function useSave(settings: PrintSettings, media: MediaState, announce: (message: string | null) => void) {
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
  // press runs the page is inert, so nothing can edit.)
  useEffect(() => dispatch({ type: 'documentChanged' }), [settings])

  const deliver = useCallback(
    async (file: File, plan: ExportPlan) => {
      try {
        const delivery = await deliverFile(file, { allowDownload: !isStandalone() })
        dispatch({ type: 'delivered' })
        announce(saveMessage(delivery, plan))
      } catch (err) {
        dispatch({ type: 'shareFailed' })
        announce(
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Tap Save to Photos to save it.'
            : `It could not be shared: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [announce],
  )

  const start = useCallback(
    async (format: ExportFormat) => {
      if (runningRef.current || !canStart(stateRef.current, media)) return
      runningRef.current = true
      const plan = planPrint(settings)
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
        // The ORIGINAL, decoded now and in full (4 bytes a pixel of the photo,
        // 98 MB for a 24 MP one), and let go the moment the ground is drawn.
        if (settings.media) photo = await decodeOriginal(settings.media.id)
        if (controller.signal.aborted) throw new DOMException('The save was cancelled.', 'AbortError')
        dispatch({ type: 'photoLoaded' })
        const decoded = photo
        const pressed = await savePrint(out, scratch, settings, decoded, {
          format,
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
        // Never a quieter, smaller file: the reason, with the numbers.
        const reason = err instanceof Error ? err.message : String(err)
        dispatch({ type: 'failed', message: `Could not press ${dims(plan.width, plan.height)}: ${reason}` })
      } finally {
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

  return { state, start, cancel, share, dismiss }
}
