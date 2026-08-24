import type { PrintSettings } from '../engine/types.ts'
import { defaultSettings } from './defaults.ts'

/**
 * Settings persistence (playbook N11 / §8.3).
 *
 * A reload — or iOS evicting a backgrounded tab, which it does aggressively —
 * must not destroy work. This is the cheap tier: the whole document is
 * serialisable JSON, so it round-trips through localStorage in ten lines.
 *
 * Restore is deliberately forgiving: an unknown or malformed stored value
 * falls back to defaults rather than throwing, because a schema change from a
 * redeploy should never brick the app for an installed client.
 */

const KEY = 'printmachine:settings:v1'

export function saveSettings(settings: PrintSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Quota or private mode — losing persistence is not worth breaking a render.
  }
}

export function loadSettings(): PrintSettings {
  const fallback = defaultSettings()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback

    // Merge over defaults so a document written by an older build still opens
    // when new fields are added.
    const merged = { ...fallback, ...(parsed as Partial<PrintSettings>) }
    // A stored photo is only a reference; the bytes live in IndexedDB and may
    // have been evicted independently. Anything not shaped like a placement is
    // dropped rather than handed to the renderer to crash on.
    const m = merged.media
    if (m && !(typeof m.id === 'string' && Number.isFinite(m.width) && Number.isFinite(m.height))) {
      merged.media = null
    }
    if (!Array.isArray(merged.layers) || merged.layers.length === 0) {
      merged.layers = fallback.layers
    } else {
      merged.layers = merged.layers.map((l, i) => ({ ...fallback.layers[0], ...l, id: l.id ?? `restored-${i}` }))
    }
    return merged
  } catch {
    return fallback
  }
}

/** Small preferences that shouldn't be asked about twice. */
const PREF_KEY = 'printmachine:prefs:v1'

export interface Prefs {
  hintDismissed: boolean
  format: 'jpeg' | 'png' | 'webp'
}

const DEFAULT_PREFS: Prefs = { hintDismissed: false, format: 'jpeg' }

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
  } catch {
    // Same as above.
  }
}
