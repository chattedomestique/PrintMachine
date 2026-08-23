import { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from '../editor/Canvas.tsx'
import Controls from '../controls/Controls.tsx'
import { IconButton } from '../../ui/controls.tsx'
import { GridIcon, RedoIcon, UndoIcon } from '../../ui/icons.tsx'
import { savePrint, saveMessage } from '../../engine/export.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { loadPrefs, savePrefs } from '../../state/persist.ts'
import './AppShell.css'

export default function AppShell() {
  const { settings, undo, redo, canUndo, canRedo } = useSettings()
  const [showGuides, setShowGuides] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState(() => loadPrefs().hintDismissed)
  const toastTimer = useRef<number | undefined>(undefined)

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
      const result = await savePrint(out, scratch, settings, 'jpeg')
      announce(saveMessage(result))
    } catch (err) {
      announce(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setBusy(false)
    }
  }, [busy, settings, announce])

  return (
    <>
      <header className="header">
        <h1 className="wordmark">
          Print<span>Machine</span>
        </h1>
        <div className="header-actions">
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

      {/* The hint belongs over the sheet it is describing, so it is anchored
          to the stage rather than to an arbitrary offset from the viewport
          bottom — which lands it on top of a slider as the drawer resizes. */}
      <div className="stage-wrap">
        <Canvas showGuides={showGuides} />
        {!hintDismissed && (
          <button type="button" className="hint" onClick={dismissHint}>
            Drag the sheet to move type · double-tap to centre
          </button>
        )}
      </div>

      <Controls />

      <div className="toolbar save-bar">
        <IconButton label="Save this print" variant="primary" onClick={onSave} disabled={busy}>
          {busy ? 'Printing…' : 'Save'}
        </IconButton>
      </div>

      {/* One shared live region for state changes (playbook §10.1). */}
      <div role="status" aria-live="polite" className="visually-hidden">
        {toast}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
