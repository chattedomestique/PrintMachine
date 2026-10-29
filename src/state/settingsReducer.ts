import { type FramePalette, type FrameSettings, type MediaLayer, type PressProfile, type PrintSettings, type TextLayer } from '../engine/types.ts'
import { visibleAspect } from '../engine/frame.ts'
import { makeLayer } from './defaults.ts'
import { contrastPartner } from '../engine/inks.ts'
import { areaOf, clampPan } from '../engine/media.ts'
import { FRAME_WIDTH_FIRST, MAX_PRESSED_PASSES, MAX_TEXT_PLATES, passCount } from '../engine/limits.ts'

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

/**
 * `coalesce`: part of a burst (a drag, typing) that is one undo step. `join`:
 * part of the undo step the last coalescing run opened, even if that run's
 * burst is over: a double tap's reset joins the move its first tap made, and
 * the second tap can be handled long after the first (behind a render). Only
 * that step: when the run left none (it ended where it began, or changed
 * nothing), or anything else has happened since, a join is a step of its own.
 * A join never opens or extends a burst.
 */
export type SettingsAction =
  /** Anything but the photo, which `setMedia` and `patchMedia` change. */
  | { type: 'patch'; patch: Partial<Omit<PrintSettings, 'media'>>; coalesce?: boolean; join?: boolean }
  | { type: 'patchLayer'; id: string; patch: Partial<TextLayer>; coalesce?: boolean; join?: boolean }
  /** `id`: the new plate's, so the UI that adds it can select it. */
  | { type: 'addLayer'; id?: string }
  | { type: 'removeLayer'; id: string }
  | { type: 'patchPress'; patch: Partial<PressProfile>; coalesce?: boolean; join?: boolean }
  | { type: 'patchFrame'; patch: Partial<FrameSettings>; coalesce?: boolean; join?: boolean }
  /** A new photo (or none). Its palette is computed from its pixels
   *  (`setPalette`): one handed in with it is dropped. */
  | { type: 'setMedia'; media: MediaLayer | null }
  /** The photo's placement. Never its palette: that is `setPalette`'s. */
  | { type: 'patchMedia'; patch: Partial<Omit<MediaLayer, 'palette'>>; coalesce?: boolean; join?: boolean }
  /** The photo's frame colours, computed from it: derived data, not an
   *  edit, so it is never an undo step. Written into every history entry
   *  that holds the photo `mediaId`, and into no other. */
  | { type: 'setPalette'; mediaId: string; palette: FramePalette }

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
  /** True while the last step in `past` is the one a coalescing run opened
   *  and nothing else has happened since: no other step, no Undo or Redo, the
   *  run not dropped, no new run that opened nothing. It outlives the burst
   *  (`endBurst` leaves it): it is what a `join` may merge into. */
  joinable: boolean
}

const LIMIT = 60

/** Inks cycle through a sensible sequence as plates are added, so a new layer
 *  never lands on the same ink as the one before it. */
const NEXT_INK = ['fluorescentpink', 'blue', 'yellow', 'black', 'green', 'fluorescentorange']

/**
 * Keep the sheet a sheet and the photo covering it. Re-applied by every action
 * that can move the photo, zoom it, replace or remove it, or change the shape
 * of what it covers (the sheet's shape, or the frame's width):
 *
 *  - An Original sheet takes its shape from the photo, so without one it is
 *    the default 4:5 (removing the photo of an Original sheet lands there).
 *  - The pan is clamped against the NEW shape of the visible rectangle (the
 *    sheet inside its frame: frame.ts `visibleAspect`), so the stored
 *    placement is always one that prints with no bare strip — the renderer
 *    clamps too, but a stored value it has to correct would make the next pan
 *    start from a position the picture is not actually at. In Fit the
 *    placement is not read, and is kept as Crop would show it.
 */
function withCover(state: PrintSettings): PrintSettings {
  const sheet: PrintSettings = state.aspect === 'original' && !state.media ? { ...state, aspect: '4:5' } : state
  return sheet.media ? { ...sheet, media: clampPan(sheet.media, areaOf(visibleAspect(sheet), 1)) } : sheet
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
      // Never the photo (held for anything typed loosely too).
      const { media: _media, ...patch } = action.patch as Partial<PrintSettings>
      const next = { ...state, ...patch }
      return 'aspect' in patch ? withCover(next) : next
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

    case 'patchFrame': {
      // A new width changes the visible rectangle's shape, which may leave
      // the stored pan outside the travel that still covers it.
      const next = { ...state, frame: { ...state.frame, ...action.patch } }
      return 'width' in action.patch ? withCover(next) : next
    }

    case 'setMedia': {
      // The photo's colours are its pixels', computed once it is here: never
      // carried in with it.
      const media = action.media && withoutPalette(action.media)
      // Replacing a photo keeps the sheet the person chose (an Original sheet
      // takes the new photo's shape); removing one from an Original sheet
      // leaves 4:5 (withCover).
      if (!media || state.media) return withCover({ ...state, media })
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
      //
      // And the photo is framed (Border Studio's first impression: a border
      // keyed to the photo): a frame with no border is given the first
      // photo's (FRAME_WIDTH_FIRST); its fill, corners and mode are already
      // the template's. A frame the document already has is kept. The sheet
      // grows by the border, never the photo shrinks: on Original the photo
      // still lands at its own pixels.
      return withCover({
        ...state,
        aspect: 'original',
        media,
        frame: state.frame.width > 0 ? state.frame : { ...state.frame, width: FRAME_WIDTH_FIRST },
        layers: state.layers.map((l) =>
          l.contrastInkId || l.backing ? l : { ...l, contrastInkId: contrastPartner(l.inkId) },
        ),
      })
    }

    case 'patchMedia':
      // A patch with no photo present is a no-op rather than a crash: the
      // gesture layer can fire one as a drag ends just after a clear.
      return state.media ? withCover({ ...state, media: { ...state.media, ...withoutPalette(action.patch) } }) : state

    case 'setPalette':
      return state.media?.id === action.mediaId ? { ...state, media: { ...state.media, palette: action.palette } } : state
  }
}

/** A photo, or a patch of one, without a palette: only `setPalette` writes
 *  one (the type says so; this holds it for anything typed loosely). */
function withoutPalette<T extends Partial<MediaLayer>>(m: T): Omit<T, 'palette'> {
  if (!('palette' in m)) return m
  const { palette: _palette, ...rest } = m
  return rest
}

/** Equality of plain data, which the document is (it is stored as JSON):
 *  objects, arrays, strings, numbers, booleans and null. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) => Object.hasOwn(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

export function initHistory(settings: PrintSettings): HistoryState {
  return { past: [], present: settings, future: [], bursting: false, joinable: false }
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
        joinable: false,
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
        joinable: false,
      }
    }

    case 'endBurst':
      return state.bursting ? { ...state, bursting: false } : state

    // Derived from the photo, not chosen: every entry that holds that photo
    // takes it in place (the past and the future too, so no Undo or Redo
    // can take it away and have the photo decoded again), and the steps,
    // the burst and what may be joined are left as they were.
    case 'setPalette': {
      const keyed = (s: PrintSettings) => applySettings(s, action)
      const present = keyed(state.present)
      const past = state.past.map(keyed)
      const future = state.future.map(keyed)
      const same = present === state.present && past.every((s, i) => s === state.past[i]) && future.every((s, i) => s === state.future[i])
      return same ? state : { ...state, past, present, future }
    }

    default: {
      const next = applySettings(state.present, action)
      const wantsJoin = 'join' in action && action.join === true
      // A join is a reset, never part of a drag: it does not open a burst.
      const coalesce = 'coalesce' in action && action.coalesce === true && !wantsJoin

      // A change that changes nothing is not an undo step. A drag on a photo
      // that cannot move (100% on its own sheet: every patch clamps back to
      // where it is) or a second reset of a value already at its default
      // used to push one, and Undo then seemed to do nothing. Such a change
      // that starts a run (the burst is over) opened no step, so a double
      // tap's reset after it has no step of its own run to join.
      if (next === state.present || sameData(next, state.present)) {
        return coalesce && !state.bursting && state.joinable ? { ...state, joinable: false } : state
      }

      // Joining: only the step the last coalescing run opened, while nothing
      // else has happened since (`joinable`). Not just the last step: a run
      // that was dropped (below) leaves an unrelated step last, and after an
      // Undo the last step is no longer the change it joins.
      const join = wantsJoin && state.joinable && state.past.length > 0 && state.future.length === 0

      // Mid-burst: replace the present without growing the history, so the
      // whole drag reads as a single step. A join does the same after the
      // burst is over.
      if ((coalesce && state.bursting) || join) {
        // A run that ends where it began (a drag back to its start; a double
        // tap on a setting already at its default, whose first tap moved the
        // thumb) is no step at all: drop the step it opened, and end the
        // burst, so a move after it opens a step of its own. The step now
        // last is someone else's: nothing may join it.
        const start = state.past[state.past.length - 1]
        if (start !== undefined && sameData(next, start)) {
          return { past: state.past.slice(0, -1), present: start, future: [], bursting: false, joinable: false }
        }
        return { ...state, present: next, future: [], joinable: true }
      }

      // A step of its own. Only a coalescing run's step may be joined later;
      // a join that found nothing to join is a plain step.
      const past = [...state.past, state.present]
      return {
        past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
        present: next,
        future: [],
        bursting: coalesce,
        joinable: coalesce,
      }
    }
  }
}
