import type { PrintSettings, TextLayer, WordBox } from '../engine/types.ts'
import { makeLayer } from './defaults.ts'

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
  | { type: 'addLayer' }
  | { type: 'removeLayer'; id: string }
  | { type: 'moveLayer'; id: string; direction: -1 | 1 }
  | { type: 'addBox'; layerId: string }
  | { type: 'removeBox'; layerId: string; boxId: string }
  | { type: 'patchBox'; layerId: string; boxId: string; patch: Partial<WordBox>; coalesce?: boolean }
  | { type: 'toggleBoxWord'; layerId: string; boxId: string; word: number }
  | { type: 'setWordTracking'; layerId: string; words: number[]; em: number; coalesce?: boolean }
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

let boxSeq = 0
const nextBoxId = (): string => `box-${Date.now().toString(36)}-${boxSeq++}`

/** Replace one layer, leaving the rest of the document untouched. */
function mapLayer(
  state: PrintSettings,
  id: string,
  fn: (l: TextLayer) => TextLayer,
): PrintSettings {
  return { ...state, layers: state.layers.map((l) => (l.id === id ? fn(l) : l)) }
}

function applySettings(state: PrintSettings, action: SettingsAction): PrintSettings {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch }

    case 'patchLayer':
      return {
        ...state,
        layers: state.layers.map((l) => (l.id === action.id ? { ...l, ...action.patch } : l)),
      }

    case 'addLayer': {
      const used = new Set(state.layers.map((l) => l.inkId))
      const inkId = NEXT_INK.find((i) => !used.has(i)) ?? NEXT_INK[state.layers.length % NEXT_INK.length]
      return {
        ...state,
        layers: [...state.layers, makeLayer({ text: 'NEW', inkId, size: 0.12, y: 0.3, fitWidth: false })],
      }
    }

    case 'removeLayer':
      // Never leave the document with nothing to print.
      if (state.layers.length <= 1) return state
      return { ...state, layers: state.layers.filter((l) => l.id !== action.id) }

    case 'moveLayer': {
      const i = state.layers.findIndex((l) => l.id === action.id)
      const j = i + action.direction
      if (i < 0 || j < 0 || j >= state.layers.length) return state
      const layers = [...state.layers]
      ;[layers[i], layers[j]] = [layers[j], layers[i]]
      return { ...state, layers }
    }

    case 'addBox': {
      // Each box gets the first ink not already spoken for on this layer, so a
      // new box is visible against the type instead of invisibly matching it.
      return mapLayer(state, action.layerId, (l) => {
        const used = new Set([l.inkId, ...l.boxes.map((b) => b.inkId)])
        const inkId = NEXT_INK.find((i) => !used.has(i)) ?? NEXT_INK[l.boxes.length % NEXT_INK.length]
        const box: WordBox = { id: nextBoxId(), words: [], inkId, opacity: 1 }
        return { ...l, boxes: [...l.boxes, box] }
      })
    }

    case 'removeBox':
      return mapLayer(state, action.layerId, (l) => ({
        ...l,
        boxes: l.boxes.filter((b) => b.id !== action.boxId),
      }))

    case 'patchBox':
      return mapLayer(state, action.layerId, (l) => ({
        ...l,
        boxes: l.boxes.map((b) => (b.id === action.boxId ? { ...b, ...action.patch } : b)),
      }))

    case 'toggleBoxWord':
      return mapLayer(state, action.layerId, (l) => ({
        ...l,
        boxes: l.boxes.map((b) => {
          if (b.id !== action.boxId) {
            // A word belongs to at most one box — otherwise two inks stack in
            // the same rectangle and the result is neither colour.
            return b.words.includes(action.word)
              ? { ...b, words: b.words.filter((n) => n !== action.word) }
              : b
          }
          const has = b.words.includes(action.word)
          return {
            ...b,
            words: has
              ? b.words.filter((n) => n !== action.word)
              : [...b.words, action.word].sort((x, y) => x - y),
          }
        }),
      }))

    case 'setWordTracking':
      return mapLayer(state, action.layerId, (l) => {
        const next = { ...l.wordTracking }
        for (const w of action.words) {
          // Zero is the default, so store nothing rather than an explicit 0 —
          // otherwise the map grows forever with entries that mean "normal".
          if (action.em === 0) delete next[String(w)]
          else next[String(w)] = action.em
        }
        return { ...l, wordTracking: next }
      })

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
