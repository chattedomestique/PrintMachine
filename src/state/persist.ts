import type { PrintSettings } from '../engine/types.ts'
import { cssFont, type FontMeasure } from '../engine/text.ts'
import { defaultSettings } from './defaults.ts'
import { normalizeSettings } from './normalize.ts'

/**
 * Settings persistence (playbook N11 / §8.3).
 *
 * A reload — or iOS evicting a backgrounded tab, which it does aggressively —
 * must not destroy work. This is the cheap tier: the whole document is
 * serialisable JSON, so it round-trips through localStorage.
 *
 * Restore goes through the one normaliser (normalize.ts), whichever build wrote
 * the document: unknown or malformed values fall back to defaults rather than
 * throwing, removed features leave the document, and every valid value stays.
 * A schema change from a redeploy must never brick the app for an installed
 * client, and must never quietly reset a print either.
 */

const KEY = 'printmachine:settings:v1'

/**
 * Measures text with a throwaway 2D context, the way the renderer will draw
 * it. Every face is a system stack, so nothing has to load first. Undefined
 * outside a browser, where the conversions that need it keep the stored value.
 */
export function canvasMeasure(): FontMeasure | undefined {
  if (typeof document === 'undefined') return undefined
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return undefined
  return (font, text) => {
    ctx.font = cssFont(font)
    return ctx.measureText(text).width
  }
}

export function saveSettings(settings: PrintSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Quota or private mode — losing persistence is not worth breaking a render.
  }
}

export function loadSettings(): PrintSettings {
  let stored: unknown = null
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) stored = JSON.parse(raw)
  } catch {
    // No storage, or not JSON: there is nothing to restore.
  }
  try {
    return normalizeSettings(stored, { measure: canvasMeasure() })
  } catch {
    // The normaliser does not throw by construction; a broken canvas might.
    return defaultSettings()
  }
}

/** Small preferences that shouldn't be asked about twice. */
const PREF_KEY = 'printmachine:prefs:v1'

export interface Prefs {
  hintDismissed: boolean
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    // Built, not spread: a key an older build stored (the export format) must
    // not ride along and be written back on the next save.
    return {
      hintDismissed:
        typeof parsed === 'object' && parsed !== null && (parsed as Partial<Prefs>).hintDismissed === true,
    }
  } catch {
    return { hintDismissed: false }
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
  } catch {
    // Same as above.
  }
}

/**
 * A save in flight, for a launch to find if the tab was killed mid-press (iOS
 * evicts a tab that holds too much without a word). Set before the press with
 * the planned height and format, cleared when it ends either way. Storage
 * failing only means the notice is not shown; it never stops a save.
 */
const IN_FLIGHT_KEY = 'printmachine:export-in-flight'

export interface ExportInFlight {
  height: number
  format: 'jpeg' | 'png'
}

export function markExportInFlight(save: ExportInFlight): void {
  try {
    localStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(save))
  } catch {
    // No storage: nothing to find after a crash, nothing else lost.
  }
}

export function clearExportInFlight(): void {
  try {
    localStorage.removeItem(IN_FLIGHT_KEY)
  } catch {
    // Same as above.
  }
}

/** The save that did not finish, once: reading it clears it. Anything else
 *  found there (an older build's, hand-edited) is not one. */
export function takeExportInFlight(): ExportInFlight | null {
  try {
    const raw = localStorage.getItem(IN_FLIGHT_KEY)
    localStorage.removeItem(IN_FLIGHT_KEY)
    if (raw === null) return null
    const { height, format } = JSON.parse(raw) as Partial<ExportInFlight>
    if (typeof height !== 'number' || !Number.isInteger(height) || height <= 0) return null
    return { height, format: format === 'png' ? 'png' : 'jpeg' }
  } catch {
    return null
  }
}
