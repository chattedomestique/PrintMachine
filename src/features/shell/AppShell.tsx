import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Canvas from '../editor/Canvas.tsx'
import Controls, { TABS, type TabId } from '../controls/Controls.tsx'
import { IconButton } from '../../ui/controls.tsx'
import { RedoIcon, UndoIcon } from '../../ui/icons.tsx'
import { PHOTO_MISSING, describePlan, planPrint } from '../../engine/export.ts'
import { sheetAspect } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { loadPrefs, savePrefs } from '../../state/persist.ts'
import { getSWState, subscribeSW } from '../../state/swStatus.ts'
import { useMediaBitmap } from '../media/useMediaBitmap.ts'
import { canStart, pressInProgress, saveButton, saveLine, saveQuestion, useSave } from './useSave.ts'
import './AppShell.css'

export default function AppShell() {
  const { settings, undo, redo, canUndo, canRedo } = useSettings()
  // The preview's working copy of the photo. Save does not use it: it decodes
  // the original, so the print is drawn from the original's pixels.
  const { bitmap: media, state: mediaState } = useMediaBitmap(settings.media, sheetAspect(settings))
  const swState = useSyncExternalStore(subscribeSW, getSWState, getSWState)
  const [tab, setTab] = useState<TabId | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState(() => loadPrefs().hintDismissed)

  const toastTimer = useRef<number | undefined>(undefined)
  const appRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * Track the live height of the bottom overlay and publish it as `--overlay-h`.
   *
   * This is what makes the sheet as large as it can possibly be: the canvas
   * reserves exactly the space the controls currently occupy and not a pixel
   * more, and it re-measures as panels open, close and change height. A fixed
   * reservation either wastes space or lets the drawer cover the artwork.
   */
  useEffect(() => {
    const el = overlayRef.current
    const root = appRef.current
    if (!el || !root) return
    const ro = new ResizeObserver((entries) => {
      root.style.setProperty('--overlay-h', `${Math.round(entries[0].contentRect.height)}px`)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const announce = useCallback((message: string | null) => {
    if (!message) return
    window.clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const dismissHint = useCallback(() => {
    setHintDismissed(true)
    savePrefs({ ...loadPrefs(), hintDismissed: true })
  }, [])

  // Tapping the open tab closes the drawer — the only way to get the sheet to
  // full size on a phone, and the reason the tabs live in the bottom bar.
  const toggleTab = useCallback((id: TabId) => {
    setTab((prev) => (prev === id ? null : id))
  }, [])

  // Move focus into a panel as it opens (playbook §10.1).
  useEffect(() => {
    if (!tab) return
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [tab])

  const save = useSave(settings, mediaState, announce)
  const pressing = pressInProgress(save.state)

  // Keyboard undo/redo (Ctrl or Cmd+Z, with Shift to redo). A window
  // listener, which `inert` does not reach, so it is off while the print is
  // pressed, as the Undo and Redo buttons are: the document cannot change
  // under a press, and the file it makes is of the document on screen.
  useEffect(() => {
    if (pressing) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement | null
      // Don't hijack undo inside a text field.
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pressing, undo, redo])
  // What Save will make, said before the tap: the pixel size, and why when it
  // is not the photo's own pixels.
  const caption = useMemo(() => describePlan(planPrint(settings), settings.media), [settings])
  const button = saveButton(save.state, mediaState)
  // How far the press has got, an error, or why Save cannot be pressed; the
  // caption otherwise.
  const line = saveLine(save.state, mediaState)
  // A save that cannot go on unasked: a print too big for this device, or one
  // that did not finish last time. A plain dialog (restyled in WP3).
  const question = saveQuestion(save.state, (maxHeight) => planPrint(settings, { maxHeight }))
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (question && !dialog.open) dialog.showModal()
    if (!question && dialog.open) dialog.close()
  }, [question])
  const onSave = () => {
    if (pressing) save.cancel()
    else if (save.state.kind === 'ready') save.share()
    else void save.start('jpeg')
  }

  return (
    <div className="app" ref={appRef}>
      {/* While the print is pressed, everything but the progress and Cancel
          is inert: the document cannot change under the press. */}
      <header className="header" inert={pressing || undefined}>
        <h1 className="wordmark">
          Print<span>Machine</span>
        </h1>
        <div className="header-actions">
          {/* Offline readiness, stated rather than assumed. On iOS a
              home-screen PWA has to be opened once online before it will ever
              launch offline, and without this the only way to discover that is
              to be somewhere with no signal. */}
          <span
            className="offline-dot"
            data-state={swState}
            // The readiness contract scripts/verify-offline.mjs waits on.
            data-offline-state={swState}
            title={
              swState === 'ready'
                ? 'Saved for offline — this will open in airplane mode'
                : swState === 'unsupported'
                  ? 'Offline unavailable in this browser'
                  : 'Saving for offline…'
            }
          >
            <span className="visually-hidden">
              {swState === 'ready'
                ? 'Saved for offline use'
                : swState === 'unsupported'
                  ? 'Offline use unavailable'
                  : 'Saving for offline use'}
            </span>
          </span>
          <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
            <UndoIcon />
          </IconButton>
          <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
            <RedoIcon />
          </IconButton>
        </div>
      </header>

      <main className="app__main" inert={pressing || undefined}>
        <div className="app__canvas-wrap">
          {/* Paused while pressing, so a full-size press and a preview frame
              never hold their buffers at once. */}
          <Canvas media={media} mediaMode={tab === 'media'} paused={pressing} />
          {!hintDismissed && (
            <button type="button" className="hint" onClick={dismissHint}>
              Drag the sheet to move type · double-tap to centre
            </button>
          )}
        </div>
      </main>

      {/* Fixed to the viewport bottom so it never takes flow space from the
          sheet; the canvas reserves --overlay-h for it instead. */}
      <div className="app__overlay" ref={overlayRef}>
        <div className="drawer" data-open={tab !== null}>
          <div
            className="drawer-inner"
            ref={panelRef}
            id={tab ? `panel-${tab}` : undefined}
            role="tabpanel"
            aria-labelledby={tab ? `tab-${tab}` : undefined}
            inert={tab === null || pressing ? true : undefined}
          >
            <Controls tab={tab} mediaState={mediaState} />
          </div>
        </div>

        {/* What Save makes, while it works how far it has got, and when it
            cannot be pressed, why. */}
        <div className="control-group">
          <div className="field-head">
            {line === null ? (
              <span className="field-label">
                Saves {caption.size}
                {caption.reason ? `: ${caption.reason}` : ''}
              </span>
            ) : (
              <span className="field-label" role={line.alert ? 'alert' : 'status'}>
                {line.text}
              </span>
            )}
            {/* The lossless file: JPEG halves the colour resolution below
                quality 1.0, so PNG is the one save that loses nothing. */}
            {(save.state.kind === 'idle' || save.state.kind === 'error' || save.state.kind === 'ready') && (
              <button
                type="button"
                className="icon-button"
                aria-label="Save lossless PNG"
                disabled={!canStart(save.state, mediaState)}
                onClick={() => void save.start('png')}
              >
                PNG
              </button>
            )}
          </div>
        </div>

        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="Control groups" inert={pressing || undefined}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={t.id === tab}
                aria-controls={t.id === tab ? `panel-${t.id}` : undefined}
                aria-expanded={t.id === tab}
                className="tab"
                onClick={() => toggleTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <IconButton
            label={
              pressing
                ? 'Cancel the save'
                : save.state.kind === 'ready'
                  ? button.text
                  : `${button.text}: ${button.why ?? `${caption.size} JPEG`}`
            }
            variant="primary"
            onClick={onSave}
            disabled={button.disabled}
          >
            {button.text}
          </IconButton>
        </div>
      </div>

      <dialog ref={dialogRef} className="save-question" aria-labelledby="save-question" onCancel={save.dismiss}>
        {question && (
          <>
            <p id="save-question">
              {question.text}
            </p>
            {/* Asked at launch, the question can come before the photo is
                back: its saves wait for it, as Save does. */}
            {question.choices.length > 0 && mediaState === 'loading' && (
              <p className="panel-note" role="status">
                Loading the photo…
              </p>
            )}
            {question.choices.length > 0 && mediaState === 'failed' && (
              <p className="panel-note" role="alert">
                {PHOTO_MISSING}
              </p>
            )}
            <div className="media-actions">
              {question.choices.map((choice, i) => (
                <button
                  key={choice.label}
                  type="button"
                  className="icon-button"
                  data-variant={i === 0 ? 'primary' : undefined}
                  disabled={!canStart(save.state, mediaState)}
                  onClick={() => save.answer(choice.height)}
                >
                  {choice.label}
                </button>
              ))}
              <button type="button" className="icon-button" onClick={save.dismiss}>
                {question.choices.length ? 'Cancel' : 'OK'}
              </button>
            </div>
          </>
        )}
      </dialog>

      {/* One shared live region for state changes (playbook §10.1). */}
      <div role="status" aria-live="polite" className="visually-hidden">
        {toast}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
