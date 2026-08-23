import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { historyReducer, initHistory, type SettingsAction } from './settingsReducer.ts'
import { loadSettings, saveSettings } from './persist.ts'
import { SettingsContext, type SettingsStore } from './settingsStore.ts'

/** Idle gap that ends a coalescing burst. Long enough to span a slider drag's
 *  natural pauses, short enough that two deliberate nudges stay separate. */
const BURST_MS = 450

/** Debounce on the localStorage write — a drag shouldn't hit disk per tick. */
const PERSIST_MS = 400

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [history, rawDispatch] = useReducer(historyReducer, undefined, () =>
    initHistory(loadSettings()),
  )
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null)

  const burstTimer = useRef<number | undefined>(undefined)
  const persistTimer = useRef<number | undefined>(undefined)

  const dispatch = useCallback((action: SettingsAction) => {
    rawDispatch(action)
    // Restart the burst window on every coalescing action; when it finally
    // elapses, the next edit starts a fresh undo step.
    if ('coalesce' in action && action.coalesce) {
      window.clearTimeout(burstTimer.current)
      burstTimer.current = window.setTimeout(() => rawDispatch({ type: 'endBurst' }), BURST_MS)
    }
  }, [])

  const undo = useCallback(() => rawDispatch({ type: 'undo' }), [])
  const redo = useCallback(() => rawDispatch({ type: 'redo' }), [])

  // Persist the document, debounced.
  const { present } = history
  useEffect(() => {
    window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => saveSettings(present), PERSIST_MS)
    return () => window.clearTimeout(persistTimer.current)
  }, [present])

  // Flush immediately when the page is being backgrounded — on iOS this may be
  // the last callback before the tab is evicted, and the debounce would lose
  // whatever happened in the last 400 ms.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') saveSettings(present)
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [present])

  useEffect(() => () => window.clearTimeout(burstTimer.current), [])

  // Keyboard undo/redo.
  useEffect(() => {
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
  }, [undo, redo])

  const layers = present.layers

  const value = useMemo<SettingsStore>(() => {
    // The selection is *derived*, not repaired. Deleting or undoing away the
    // selected layer just makes this fall back to the first plate, with no
    // effect writing state back — which is both simpler and free of the
    // cascading re-render a repair effect causes.
    const selected = layers.find((l) => l.id === selectedLayerId) ?? layers[0] ?? null
    return {
      settings: present,
      dispatch,
      undo,
      redo,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      selectedLayerId: selected?.id ?? null,
      selectLayer: setSelectedLayerId,
      selectedLayer: selected,
    }
  }, [present, layers, dispatch, undo, redo, history.past.length, history.future.length, selectedLayerId])

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
