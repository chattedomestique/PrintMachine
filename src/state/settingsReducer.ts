import {
  sheetAspect,
  type MediaLayer,
  type PressProfile,
  type PrintSettings,
  type TextLayer,
} from '../engine/types.ts'
import { makeLayer } from './defaults.ts'
import { contrastPartner } from '../engine/inks.ts'
import { clampPan } from '../engine/media.ts'
import { MAX_PRESSED_PASSES, MAX_TEXT_PLATES, passCount } from '../engine/limits.ts'

/**
 * The document reducer plus an undo/redo history around it.
 *
 * The subtlety that makes undo feel right (playbook §8.2): a slider drag must
 * collapse into one step, while structural actions must not. That is expressed
 * here as a `coalesce` flag on the action rather than a debounce somewhere in
 * the UI, so the rule lives with the history instead of being reimplemented by
 * every control.
 *
 * `canUndo`/`canRedo` are derived from state, never read off a ref during
 * render — reading a ref during render is a real staleness bug.
 */

export type SettingsAction =
  | { type: 'patch'; patch: Partial<PrintSettings>; coalesce?: boolean }
  | { type: 'patchLayer'; id: string; patch: Partial<TextLayer>; coalesce?: boolean }
  /** `id`: the new plate's, so the UI that adds it can select it. */
  | { type: 'addLayer'; id?: string }
  | { type: 'removeLayer'; id: string }
  | { type: 'patchPress'; patch: Partial<PressProfile>; coalesce?: boolean }
  | { type: 'setMedia'; media: MediaLayer | null }
  | { type: 'patchMedia'; patch: Partial<MediaLayer>; coalesce?: boolean }
  | { type: 'reset'; settings: PrintSettings }

export type HistoryAction =
  | SettingsAction
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'endBurst' }

export interface HistoryState {
  past: PrintSettings[]
  present: PrintSettings
  future: PrintSettings[]
  /** True while a run of coalescing actions is still open. */
  bursting: boolean
}

const LIMIT = 60

/** Inks cycle through a sensible sequence as plates are added, so a new layer
 *  never lands on the same ink as the one before it. */
const NEXT_INK = ['fluorescentpink', 'blue', 'yellow', 'black', 'green', 'fluorescentorange']

/**
 * Keep the sheet a sheet and the photo covering it. Re-applied by every action
 * that can move the photo, zoom it, replace or remove it, or change the
 * sheet's shape:
 *
 *  - An Original sheet takes its shape from the photo, so without one it is
 *    the default 4:5 (removing the photo of an Original sheet lands there).
 *  - The pan is clamped against the NEW numeric aspect, so the stored
 *    placement is always one that prints with no bare strip — the renderer
 *    clamps too, but a stored value it has to correct would make the next pan
 *    start from a position the picture is not actually at.
 */
function withCover(state: PrintSettings): PrintSettings {
  const sheet: PrintSettings = state.aspect === 'original' && !state.media ? { ...state, aspect: '4:5' } : state
  return sheet.media ? { ...sheet, media: clampPan(sheet.media, sheetAspect(sheet), 1) } : sheet
}

/** True when the plate budget has no room for another pressed pass. */
export function atPassLimit(state: PrintSettings): boolean {
  return passCount(state) >= MAX_PRESSED_PASSES
}

/** True when no further plate may be added: too many plates, or no pass left. */
export function atPlateLimit(state: PrintSettings): boolean {
  return state.layers.length >= MAX_TEXT_PLATES || atPassLimit(state)
}

/** What a plate does over the photo: nothing, a second ink, or a backing. */
export type OverPhoto = 'off' | 'second' | 'backing'

export const overPhotoOf = (l: TextLayer): OverPhoto =>
  l.backing ? 'backing' : l.contrastInkId ? 'second' : 'off'

/**
 * Whether the plate's Switch point does anything: only when the pass splits
 * between two DIFFERENT inks. With the plate's own ink as its second ink
 * ("Keep this ink") both halves print that ink, so the switch point changes
 * no pixel (engine test), and a control that does nothing is not offered.
 */
export const hasSwitchPoint = (l: TextLayer): boolean =>
  !l.backing && l.contrastInkId !== null && l.contrastInkId !== l.inkId

/**
 * The layer patch for choosing what a plate does over the photo. The second
 * ink starts at the automatic partner, exactly as the first photo seeds it; a
 * backing starts in an ink the type will visibly overprint, never its own.
 */
export function overPhotoPatch(l: TextLayer, over: OverPhoto): Partial<TextLayer> {
  if (over === 'off') return { contrastInkId: null, backing: null }
  if (over === 'second') return { contrastInkId: contrastPartner(l.inkId), backing: null }
  const backing = ['yellow', 'fluorescentpink', 'blue', 'black'].find((id) => id !== l.inkId) ?? 'yellow'
  return { backing, contrastInkId: null }
}

/**
 * One layer edit, with the rules that keep a plate coherent:
 *
 *  - A plate has a second ink OR a backing, never both (the second ink reads
 *    the photo, but over a backing the ground is the block). Setting one
 *    clears the other.
 *  - "Keep this ink" (a second ink equal to the plate's ink) follows the ink:
 *    changing a pink plate that keeps its own ink to blue must keep blue, not
 *    turn into a blue/pink split nobody chose.
 *  - A new backing is refused when the press budget is spent. Changing an
 *    existing backing's ink costs nothing and is always allowed.
 */
function patchLayer(state: PrintSettings, l: TextLayer, patch: Partial<TextLayer>): TextLayer | null {
  const next = { ...l, ...patch }
  if (patch.backing && !l.backing && atPassLimit(state)) return null
  if ('inkId' in patch && patch.inkId !== undefined && l.contrastInkId === l.inkId && !('contrastInkId' in patch)) {
    next.contrastInkId = patch.inkId
  }
  if (patch.backing) next.contrastInkId = null
  else if (patch.contrastInkId) next.backing = null
  return next
}

/** The document transition, exported so the invariants it enforces — the
 *  cover rule, the plate budget, a backing or a second ink but never both —
 *  can be tested without React. */
export function applySettings(state: PrintSettings, action: SettingsAction): PrintSettings {
  switch (action.type) {
    case 'patch': {
      const next = { ...state, ...action.patch }
      return 'aspect' in action.patch || 'media' in action.patch ? withCover(next) : next
    }

    case 'patchLayer': {
      const i = state.layers.findIndex((l) => l.id === action.id)
      if (i < 0) return state
      const next = patchLayer(state, state.layers[i], action.patch)
      if (!next) return state
      const layers = [...state.layers]
      layers[i] = next
      return { ...state, layers }
    }

    case 'addLayer': {
      // Over budget, Add does nothing (the panel says why). A document saved
      // over the budget keeps every plate: dropping one would destroy work.
      if (atPlateLimit(state)) return state
      const used = new Set(state.layers.map((l) => l.inkId))
      const inkId = NEXT_INK.find((i) => !used.has(i)) ?? NEXT_INK[state.layers.length % NEXT_INK.length]
      return {
        ...state,
        // At makeLayer()'s size, inside the Size slider: a new plate that
        // opened past its end would pin the thumb and jump on the first drag.
        layers: [...state.layers, makeLayer({ text: 'NEW', inkId, y: 0.3, ...(action.id ? { id: action.id } : {}) })],
      }
    }

    case 'removeLayer':
      // Never leave the document with nothing to print.
      if (state.layers.length <= 1) return state
      return { ...state, layers: state.layers.filter((l) => l.id !== action.id) }

    case 'patchPress':
      return { ...state, press: { ...state.press, ...action.patch } }

    case 'setMedia': {
      // Replacing a photo keeps the sheet the person chose (an Original sheet
      // takes the new photo's shape); removing one from an Original sheet
      // leaves 4:5 (withCover).
      if (!action.media || state.media) return withCover({ ...state, media: action.media })
      // The first photo is the moment a single ink stops being enough. Type
      // that was perfectly readable on paper goes invisible over half of any
      // photograph, and the control that fixes it does not even exist in the
      // panel until there is a photo to fix it against — so leaving it off by
      // default means the app's first answer to "put a picture behind this" is
      // an unreadable one. Seeded, not forced: the toggle shows on, it undoes,
      // and turning it off leaves a single ink.
      // A plate with a backing already reads over the photo (the block is
      // printed on paper there), and it may not take a second ink as well.
      //
      // And the sheet becomes the photo's own shape (Original): at 100% and
      // centred the photo then fills it exactly, so the untouched path neither
      // crops nor resamples a pixel. Choosing 4:5 or 1:1 is a crop the person
      // makes, not one the app makes for them. Undo brings the old sheet back.
      return withCover({
        ...state,
        aspect: 'original',
        media: action.media,
        layers: state.layers.map((l) =>
          l.contrastInkId || l.backing ? l : { ...l, contrastInkId: contrastPartner(l.inkId) },
        ),
      })
    }

    case 'patchMedia':
      // A patch with no photo present is a no-op rather than a crash: the
      // gesture layer can fire one as a drag ends just after a clear.
      return state.media ? withCover({ ...state, media: { ...state.media, ...action.patch } }) : state

    case 'reset':
      return action.settings
  }
}

export function initHistory(settings: PrintSettings): HistoryState {
  return { past: [], present: settings, future: [], bursting: false }
}

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'undo': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        bursting: false,
      }
    }

    case 'redo': {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      return {
        past: [...state.past, state.present],
        present: next,
        future: rest,
        bursting: false,
      }
    }

    case 'endBurst':
      return state.bursting ? { ...state, bursting: false } : state

    default: {
      const next = applySettings(state.present, action)
      if (next === state.present) return state

      const coalesce = 'coalesce' in action && action.coalesce === true

      // Mid-burst: replace the present without growing the history, so the
      // whole drag reads as a single step.
      if (coalesce && state.bursting) {
        return { ...state, present: next, future: [] }
      }

      const past = [...state.past, state.present]
      return {
        past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
        present: next,
        future: [],
        bursting: coalesce,
      }
    }
  }
}
