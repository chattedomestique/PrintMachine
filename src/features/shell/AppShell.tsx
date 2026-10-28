import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Canvas from '../editor/Canvas.tsx'
import Controls from '../controls/Controls.tsx'
import { FIRST_SUBS, TOOLS, type Subs, type ToolId } from '../controls/tools.ts'
import { Icon } from '../../ui/ui.tsx'
import { describePlan, fileSize, planPrint } from '../../engine/export.ts'
import { pngCompresses, storedSize } from '../../engine/encode/png.ts'
import { effectiveMode, sheetAspect } from '../../engine/frame.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { loadPrefs, savePrefs } from '../../state/persist.ts'
import { getSWState, offlineJustReady, subscribeSW } from '../../state/swStatus.ts'
import { useMediaBitmap } from '../media/useMediaBitmap.ts'
import { useFrameInputs } from '../media/useFrameInputs.ts'
import { frameState } from '../media/frameInputs.ts'
import { usePhotoImport } from '../media/usePhotoImport.ts'
import MoreSheet from './MoreSheet.tsx'
import SaveQuestion from './SaveQuestion.tsx'
import StatusCard from './StatusCard.tsx'
import {
  canStart,
  moreCaption,
  pressInProgress,
  saveButton,
  saveLabel,
  saveQuestion,
  saveStatus,
  useSave,
  type Announcement,
} from './useSave.ts'

/** How long a toast stays (Border Studio's). */
const TOAST_MS = 2400
/** How long its fade-out is given before it is taken away: longer than the
 *  style guide's longest (opacity over --dur-hover, 200ms). */
const TOAST_FADE_MS = 400

/** A toast's symbol, by what it says. */
const TOAST_ICON: Record<Announcement, string> = { done: 'check', info: 'info', error: 'circle-alert' }

/** The offline signal, in words a screen reader hears. */
const OFFLINE_SAID = {
  ready: 'Works offline',
  pending: 'Saving for offline',
  unsupported: 'Offline unavailable',
} as const

/**
 * The editor: Border Studio's shell on the style guide (b59a38d, 34dabad,
 * 449fa1b, fcd91ff, 597ce7a). An app bar (the title, Undo, Redo, More and
 * Save, the one filled shape), the sheet on the stage, and the dock fixed to
 * the bottom: the open tool's panel over the four tools. Cards that float over
 * the stage (the save's status, the toast, the gesture hint) sit just above
 * the dock; sheets and dialogs open on top, on native <dialog>s.
 */
export default function AppShell() {
  const { settings, undo, redo, canUndo, canRedo } = useSettings()
  // The preview's working copy of the photo. Save does not use it: it decodes
  // the original, so the print is drawn from the original's pixels.
  const { bitmap: media, state: decoded } = useMediaBitmap(settings.media, sheetAspect(settings), { width: settings.frame.width, mode: effectiveMode(settings) })
  // What the frame's fill is made from (the photo's palette, Frosted's
  // field), made from the photo once its preview copy has landed.
  const frameInputs = useFrameInputs(settings, decoded)
  // The photo, as Save and the panels see it: a photo the frame's fill cannot
  // be made from (it needs the frame source, which would not decode) is a
  // photo that could not be loaded, and is said the same way; its frame
  // stays Paper.
  const mediaState = frameState(decoded, frameInputs.failed)
  const swState = useSyncExternalStore(subscribeSW, getSWState, getSWState)
  const [tool, setTool] = useState<ToolId | null>(null)
  const [subs, setSubs] = useState<Subs>(FIRST_SUBS)
  const [moreOpen, setMoreOpen] = useState(false)
  // The toast's words stay while it fades out (an emptied card would fade as
  // a squashed frame); `shown` is what comes and goes. Once the fade is over
  // the toast is gone (null), so it takes no room above the status card.
  const [toast, setToast] = useState<{ text: string; kind: Announcement; shown: boolean } | null>(null)
  const [hintDismissed, setHintDismissed] = useState(() => loadPrefs().hintDismissed)

  const toastTimer = useRef<number | undefined>(undefined)
  const appRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLElement>(null)
  const overlayRef = useRef<HTMLElement>(null)
  const toolsRef = useRef<HTMLDivElement>(null)

  /**
   * The dock's live height, published as `--overlay-h`: the sheet reserves
   * exactly the room the dock takes, so it is as large as it can be. And the
   * app bar's, as `--bar-h`: the cards over the stage stay between the two.
   *
   * The BORDER box: the dock has safe-area padding at the bottom, and
   * contentRect leaves it out (on a phone with a home indicator that put the
   * bottom of the sheet under the dock); the bar has it at the top. The dock's
   * is written on the app AND on :root, because the sheets and dialogs
   * portalled to <body> live outside .app.
   */
  useEffect(() => {
    const el = overlayRef.current
    const bar = barRef.current
    const root = appRef.current
    if (!el || !bar || !root) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0]
        const h = `${Math.round(box ? box.blockSize : entry.target.getBoundingClientRect().height)}px`
        if (entry.target === bar) {
          root.style.setProperty('--bar-h', h)
          continue
        }
        root.style.setProperty('--overlay-h', h)
        document.documentElement.style.setProperty('--overlay-h', h)
      }
    })
    ro.observe(el)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  // The tray mounts after the page has loaded, so the style guide's toolbar
  // script never saw it. Its documented hook for a toolbar added later: roving
  // focus, and paging whole tools when they cannot all fit.
  useEffect(() => {
    if (toolsRef.current) window.SG?.toolbar?.init(toolsRef.current)
  }, [])

  const announce = useCallback((message: string | null, kind: Announcement = 'done') => {
    if (!message) return
    window.clearTimeout(toastTimer.current)
    setToast({ text: message, kind, shown: true })
    toastTimer.current = window.setTimeout(() => {
      setToast((t) => (t ? { ...t, shown: false } : t))
      toastTimer.current = window.setTimeout(() => setToast(null), TOAST_FADE_MS)
    }, TOAST_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // The offline signal is said once, when precaching finishes during this
  // launch; every later launch finds it ready (the More sheet says so).
  useEffect(() => {
    let said = false
    const check = () => {
      if (said || getSWState() !== 'ready' || !offlineJustReady()) return
      said = true
      announce('Ready to open offline', 'done')
    }
    const unsubscribe = subscribeSW(check)
    // It may have finished before this mounted.
    const t = window.setTimeout(check, 0)
    return () => {
      unsubscribe()
      window.clearTimeout(t)
    }
  }, [announce])

  const fileRef = useRef<HTMLInputElement>(null)
  const photo = usePhotoImport(fileRef, announce)

  // Dismissed for good by its ×, or by the first gesture on the sheet that
  // moves something: by then what it says has been learned, and while it
  // shows it covers the foot of the sheet.
  const dismissHint = useCallback(() => {
    setHintDismissed(true)
    savePrefs({ ...loadPrefs(), hintDismissed: true })
  }, [])

  // Tapping the open tool closes the dock's panel: the sheet at full height.
  // With no photo, the Frame tool opens where one is chosen.
  const toggleTool = useCallback(
    (id: ToolId) => {
      setTool((prev) => (prev === id ? null : id))
      if (id === 'frame' && !settings.media) setSubs((s) => ({ ...s, frame: 'photo' }))
    },
    [settings.media],
  )
  const onSub = useCallback(<T extends ToolId>(t: T, sub: Subs[T]) => setSubs((s) => ({ ...s, [t]: sub })), [])

  const save = useSave(settings, mediaState, announce)
  const pressing = pressInProgress(save.state)

  // While the print is pressed focus is on the card's Cancel (the rest is
  // inert); when the press ends the card goes, and focus comes back to Save
  // rather than being dropped on the page.
  //
  // Cancel is focused from here, not by autoFocus: a press started from a
  // dialog (More's PNG, a save question's answer) mounts the card while that
  // dialog is still open, when everything outside it, the card included, is
  // inert and cannot take focus. So once more after the dialog has closed
  // (two frames: its own focus restore runs in the first).
  const saveRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasPressing = useRef(false)
  useEffect(() => {
    let frame = 0
    if (pressing && !wasPressing.current) {
      const focusCancel = () => {
        const c = cancelRef.current
        if (c && document.activeElement !== c) c.focus()
      }
      focusCancel()
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(focusCancel)
      })
    }
    if (wasPressing.current && !pressing && (!document.activeElement || document.activeElement === document.body)) {
      saveRef.current?.focus()
    }
    wasPressing.current = pressing
    return () => cancelAnimationFrame(frame)
  }, [pressing])

  // Keyboard undo/redo (Ctrl or Cmd+Z, with Shift to redo). A window
  // listener, which `inert` does not reach, so it is off while the print is
  // pressed, as the Undo and Redo buttons are: the document cannot change
  // under a press, and the file it makes is of the document on screen.
  useEffect(() => {
    if (pressing) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement | null
      // Not inside a text field (the text, a typed value): its own undo.
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pressing, undo, redo])

  // What Save will make: the pixel size, and why when it is not the photo's
  // own pixels. Said in the More sheet (unless the photo cannot be loaded:
  // moreCaption), in Save's name, and in the toast when a save starts.
  const caption = useMemo(() => describePlan(planPrint(settings), settings), [settings])
  // The lossless PNG's: the same but past a JPEG's edge (65,535 px), and its
  // file's size where this browser cannot compress (stored, 3 bytes a pixel).
  const pngPlan = useMemo(() => planPrint(settings, { format: 'png' }), [settings])
  const pngCaption = useMemo(() => describePlan(pngPlan, settings), [pngPlan, settings])
  const pngMeta = pngCompresses() ? pngCaption.size : `${pngCaption.size} (about ${fileSize(storedSize(pngPlan.width, pngPlan.height))})`
  const button = saveButton(save.state, mediaState)
  const status = saveStatus(save.state, mediaState)
  // A save that cannot go on unasked: a print too big for this device, or one
  // that did not finish last time.
  const question = saveQuestion(save.state, (maxHeight) => planPrint(settings, { maxHeight }))

  const startSave = (format: 'jpeg' | 'png') => {
    if (!canStart(save.state, mediaState)) return
    const c = format === 'png' ? pngCaption : caption
    announce(`Saving ${c.size} ${format.toUpperCase()}${c.reason ? `: ${c.reason}` : ''}`, 'info')
    void save.start(format)
  }
  const onSave = () => {
    if (button.disabled) return
    if (save.state.kind === 'ready') save.share()
    else startSave('jpeg')
  }

  // The hint is up from the first photo until it is dismissed. Its card hides
  // while the print is pressed; its words, for a screen reader, stay.
  const hintUp = settings.media !== null && !hintDismissed
  const showHint = hintUp && !pressing
  // What the sheet's gestures do in the open tool: with Frame open they are
  // the photo's, except in Fit, where the whole photo shows and there is
  // nothing to move.
  const hintText =
    tool !== 'frame'
      ? 'Tap type to pick it · drag to move · pinch to size and turn'
      : effectiveMode(settings) === 'fit'
        ? 'Fit shows the whole photo · choose Crop to move or zoom it'
        : 'Pinch to zoom the photo · drag to move it · double‑tap to reset'

  return (
    <div className="app" ref={appRef}>
      {/* While the print is pressed, everything but its status card (and its
          Cancel) is inert: the document cannot change under the press. */}
      <header className="appbar app__bar" ref={barRef} inert={pressing || undefined}>
        <h1 className="appbar__title">Print Machine</h1>
        <div className="appbar__end">
          <button className="btn ed-bare" type="button" data-shape="circle" data-size="sm" onClick={undo} disabled={!canUndo} aria-label="Undo">
            <Icon name="undo-2" />
          </button>
          <button className="btn ed-bare" type="button" data-shape="circle" data-size="sm" onClick={redo} disabled={!canRedo} aria-label="Redo">
            <Icon name="redo-2" />
          </button>
          <button
            className="btn ed-bare"
            type="button"
            data-shape="circle"
            data-size="sm"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-label="More"
          >
            <Icon name="ellipsis" />
          </button>
          {/* Save is the one action of the screen, so it is the one filled
              shape, at the bar's end where photo editors put Export. One word
              (Save, Saving, Share), so the bar never wraps and Save never
              changes width; busy is aria-busy and aria-disabled, not
              disabled, so focus is not lost. */}
          <button
            ref={saveRef}
            className="btn app__save"
            type="button"
            data-variant="primary"
            data-size="sm"
            onClick={onSave}
            aria-busy={button.busy || undefined}
            aria-disabled={button.disabled || undefined}
            aria-label={saveLabel(save.state, mediaState, caption.size)}
          >
            <span className="btn__label">
              {/* Busy, the style guide's spinner takes the icon's place. */}
              {!button.busy && <Icon name={button.text === 'Share' ? 'share-2' : 'download'} />}
              <span className="app__save-word">{button.text}</span>
            </span>
          </button>
        </div>
      </header>

      <main className="app__main" inert={pressing || undefined}>
        <div className="app__canvas-wrap">
          {/* Paused while pressing, so a full-size press and a preview frame
              never hold their buffers at once. */}
          <Canvas media={media} inputsFor={frameInputs.inputsFor} mediaMode={tool === 'frame'} paused={pressing} onGesture={showHint ? dismissHint : undefined} />
        </div>
      </main>

      {/* Fixed to the viewport bottom so it never takes flow space from the
          sheet; the stage reserves --overlay-h for it instead. A labelled
          landmark: a screen reader's way straight to the tools. */}
      <section className="app__overlay" aria-label="Tools" ref={overlayRef} inert={pressing || undefined}>
        <div className={`app__panel${tool ? ' app__panel--open' : ''}`}>
          <div className="app__panel-inner" inert={tool === null || undefined}>
            <Controls tool={tool} subs={subs} onSub={onSub} mediaState={mediaState} photo={photo} />
          </div>
        </div>

        {/* The editor's tools: the style guide's toolbar. Each tool is a
            toggle (tap it again to close its panel), named by a real <label
            for> under it. Toggle buttons, not tabs: a tab cannot be "none
            open", and closing the panel is the gesture for a full-height
            sheet. */}
        <div className="app__tools">
          <div className="toolbar app__tray">
            <button
              className="btn ed-bare toolbar__scroll"
              type="button"
              data-shape="circle"
              data-size="sm"
              data-dir="back"
              aria-label="Scroll tools back"
              tabIndex={-1}
              hidden
            >
              <Icon name="chevron-left" />
            </button>
            <div className="toolbar__list" role="toolbar" aria-label="Tools" ref={toolsRef}>
              {TOOLS.map((t) => (
                <div className="toolbar__item" key={t.id}>
                  <button
                    className="btn ed-bare"
                    type="button"
                    data-shape="circle"
                    data-size="sm"
                    id={`tool-${t.id}`}
                    data-tool={t.id}
                    aria-pressed={tool === t.id}
                    onClick={() => toggleTool(t.id)}
                  >
                    <Icon name={t.icon} />
                  </button>
                  <label className="toolbar__label" htmlFor={`tool-${t.id}`}>
                    {t.label}
                  </label>
                </div>
              ))}
            </div>
            <button
              className="btn ed-bare toolbar__scroll"
              type="button"
              data-shape="circle"
              data-size="sm"
              data-dir="forward"
              aria-label="Scroll tools forward"
              tabIndex={-1}
              hidden
            >
              <Icon name="chevron-right" />
            </button>
          </div>
        </div>
      </section>

      {/* The floating plane over the stage, between the bar and the dock. The
          status card is nearest the dock: it carries the one action its state
          needs (Cancel, ×, Choose again), so nothing above it can push it out
          of reach; what does not fit gives way at the top, under the bar. A
          labelled landmark, as the style guide's toast region is. */}
      <section className="app__float" aria-label="Notifications">
        {/* The hint's words for a screen reader, in a live region that is
            there before them, so they are said when they appear (after the
            first photo) and again only when what the gestures move changes.
            A region born holding its words is not reliably announced. They
            stay while the print is pressed (only the card hides): emptied and
            refilled, they were read out again after every save. */}
        <p className="sr-only" role="status">
          {hintUp ? hintText : ''}
        </p>
        {showHint && (
          <div className="card app__hint">
            <p className="app__hint-text" aria-hidden="true">
              {hintText}
            </p>
            <button type="button" className="btn ed-bare" data-shape="circle" data-size="sm" aria-label="Dismiss the hint" onClick={dismissHint}>
              <Icon name="x" />
            </button>
          </div>
        )}
        {/* The one live region for state changes ("Saved 2419×3024"). Always
            in the DOM, so what is written into it is announced; empty (no
            toast, or one whose fade is over) it takes no room. */}
        <div className="app__said" role="status" aria-live="polite">
          {toast && (
            <div className={`card app__toast${toast.shown ? ' app__toast--show' : ''}`}>
              <span className="app__toast-body num" aria-hidden={!toast.shown || undefined}>
                <Icon name={TOAST_ICON[toast.kind]} />
                {toast.text}
              </span>
            </div>
          )}
        </div>
        <StatusCard
          status={status}
          cancelRef={cancelRef}
          onCancel={save.cancel}
          onDiscard={save.dismiss}
          onDismiss={save.dismiss}
          onChoose={photo.choose}
        />
        {/* Offline readiness as a DOM fact (scripts/verify-offline.mjs waits
            on the attribute), never hidden from a screen reader (this plane
            is never inert); seen in More. */}
        <span className="sr-only" data-offline-state={swState}>
          {OFFLINE_SAID[swState]}
        </span>
      </section>

      {/* One file input for every "Choose photo". */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void photo.onPick(e.target.files?.[0])}
      />

      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        caption={moreCaption(mediaState, caption, settings.media !== null)}
        pngSize={mediaState === 'failed' ? null : pngMeta}
        swState={swState}
        canSavePng={canStart(save.state, mediaState)}
        onSavePng={() => startSave('png')}
      />

      <SaveQuestion
        question={question}
        mediaState={mediaState}
        canAnswer={canStart(save.state, mediaState)}
        onAnswer={(height) => {
          // The size the answer saves, said as the save starts.
          const format = save.state.kind === 'tooBig' || save.state.kind === 'interrupted' ? save.state.format : 'jpeg'
          const c = describePlan(planPrint(settings, { maxHeight: height, format }), settings)
          announce(`Saving ${c.size} ${format.toUpperCase()}${c.reason ? `: ${c.reason}` : ''}`, 'info')
          save.answer(height)
        }}
        onDismiss={save.dismiss}
      />
    </div>
  )
}
