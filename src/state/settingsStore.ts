import { createContext, useContext } from 'react'
import type { PrintSettings, TextLayer } from '../engine/types.ts'
import type { SettingsAction } from './settingsReducer.ts'

/** The context lives in its own module so the provider file only exports a
 *  component, which keeps React Fast Refresh working. */

export interface SettingsStore {
  settings: PrintSettings
  dispatch: (action: SettingsAction) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean

  /** UI state — deliberately not part of the document, so it is neither
   *  persisted nor undoable (playbook §8.1). */
  selectedLayerId: string | null
  selectLayer: (id: string | null) => void
  selectedLayer: TextLayer | null
}

export const SettingsContext = createContext<SettingsStore | null>(null)

export function useSettings(): SettingsStore {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}
