import type { PressProfile, PrintSettings } from '../engine/types.ts'
import { contrastPartner } from '../engine/inks.ts'
import { defaultSettings, pressProfile } from './defaults.ts'

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

/** One-time repairs to documents written by older builds, by name. Kept out of
 *  the document so a repair is not itself a change to the user's print. */
const MIGRATED_KEY = 'printmachine:migrated:v1'

/** True the first time it is asked about a given repair, false ever after —
 *  including when the repair turns out to have nothing to do. A repair that
 *  re-runs is not a repair, it is the app overruling a deliberate choice on
 *  every launch. */
function firstTime(name: string): boolean {
  try {
    const done = new Set(JSON.parse(localStorage.getItem(MIGRATED_KEY) ?? '[]') as string[])
    if (done.has(name)) return false
    done.add(name)
    localStorage.setItem(MIGRATED_KEY, JSON.stringify([...done]))
    return true
  } catch {
    // No storage means no way to remember having done it, so don't.
    return false
  }
}

/**
 * Give a photo-bearing document the second ink it would get today.
 *
 * A print saved before the pass could split has a single ink across a whole
 * photograph, and a single ink cannot read across one — which is how half the
 * lines end up invisible against a bright sky. Applied once on load, because
 * the alternative is a saved print that stays unreadable until its owner finds
 * a toggle they had no reason to look for.
 */
export function seedSecondInk(settings: PrintSettings): PrintSettings {
  if (!settings.media) return settings
  return {
    ...settings,
    layers: settings.layers.map((l) =>
      l.contrastInkId ? l : { ...l, contrastInkId: contrastPartner(l.inkId) },
    ),
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
  const fallback = defaultSettings()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback

    // Merge over defaults so a document written by an older build still opens
    // when new fields are added.
    const doc = parsed as Partial<PrintSettings> & Partial<PressProfile>
    const merged = { ...fallback, ...(doc as Partial<PrintSettings>) }

    // Documents written before the press was split carried its fields at the
    // top level. Lift them into both profiles so a saved print reopens looking
    // exactly as it did, rather than silently reverting to defaults — the
    // photo then starts matching the type and can be dialled apart from there.
    if (!doc.press && typeof doc.screenPitch === 'number') {
      const lifted = pressProfile(doc as Partial<PressProfile>)
      merged.press = lifted
      merged.photoPress = merged.photoPress ?? pressProfile(doc as Partial<PressProfile>)
    }
    merged.press = { ...fallback.press, ...merged.press }
    merged.photoPress = { ...fallback.photoPress, ...merged.photoPress }
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
    return firstTime('second-ink') ? seedSecondInk(merged) : merged
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
