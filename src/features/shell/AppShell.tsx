import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Canvas from '../editor/Canvas.tsx'
import Controls, { TABS, type TabId } from '../controls/Controls.tsx'
import { IconButton } from '../../ui/controls.tsx'
import { GridIcon, RedoIcon, UndoIcon } from '../../ui/icons.tsx'
import { savePrint, saveMessage } from '../../engine/export.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { loadPrefs, savePrefs } from '../../state/persist.ts'
import { getSWState, subscribeSW } from '../../state/swStatus.ts'
import { useMediaBitmap } from '../media/useMediaBitmap.ts'
import './AppShell.css'

export default function AppShell() {
  const { settings, undo, redo, canUndo, canRedo } = useSettings()
  // One decode, shared by the preview and the save, so the file that lands in
  // Photos is the print that was on screen.
  const media = useMediaBitmap(settings.media?.id ?? null)
  const swState = useSyncExternalStore(subscribeSW, getSWState, getSWState)
  const [showGuides, setShowGuides] = useState(false)
  const [tab, setTab] = useState<TabId | null>(null)
  const [busy, setBusy] = useState(false)
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

  const onSave = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Fresh offscreen surfaces so the export can never read back the visible
      // canvas, which carries the selection crosshair and guides (N8).
      const out = document.createElement('canvas').getContext('2d')
      const scratch = document
        .createElement('canvas')
        .getContext('2d', { willReadFrequently: true })
      if (!out || !scratch) {
        announce('Could not open a canvas to export.')
        return
      }
      const result = await savePrint(out, scratch, settings, 'jpeg', 'print-machine', media)
      announce(saveMessage(result))
    } catch (err) {
      announce(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setBusy(false)
    }
  }, [busy, settings, announce, media])

  return (
    <div className="app" ref={appRef}>
      <header className="header">
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
          <button
            type="button"
            className="icon-button"
            aria-label="Alignment guides"
            aria-pressed={showGuides}
            title="Alignment guides"
            onClick={() => setShowGuides((v) => !v)}
            style={{ color: showGuides ? 'var(--accent)' : undefined }}
          >
            <GridIcon />
          </button>
        </div>
      </header>

      <main className="app__main">
        <div className="app__canvas-wrap">
          <Canvas showGuides={showGuides} media={media} mediaMode={tab === 'media'} />
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
            inert={tab === null ? true : undefined}
          >
            <Controls tab={tab} />
          </div>
        </div>

        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="Control groups">
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
          <IconButton label="Save this print" variant="primary" onClick={onSave} disabled={busy}>
            {busy ? 'Printing…' : 'Save'}
          </IconButton>
        </div>
      </div>

      {/* One shared live region for state changes (playbook §10.1). */}
      <div role="status" aria-live="polite" className="visually-hidden">
        {toast}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
