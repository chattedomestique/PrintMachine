/**
 * One numeric setting, as the dock's parameter strip shows it, and the rules
 * every way of changing it follows. Pure: no React, no DOM, so each rule has a
 * test (param.test.ts).
 *
 * TWO RANGES. A setting can hold values its slider does not reach: a pinch
 * makes type 240% on a slider that ends at 100%, a pinch turns a plate 120° on
 * a slider of ±45°, a drag puts type 30% off the trim. Border Studio's
 * components clamp everything to the slider's range, so with one min/max a
 * nudge from "240%" would land on "100%". So a parameter carries both:
 *
 *  - `trackMin..trackMax`, the slider's travel: where the thumb can be. The
 *    thumb sits at the value clamped into it, and pins at an end beyond it;
 *  - `min..max`, the values the setting may hold: what a nudge, a typed
 *    value and a reset are clamped to. The readout always shows the TRUE
 *    value (`format`), never the thumb's.
 *
 * Dragging a thumb that is pinned (the value beyond `trackMax`) moves the
 * value to wherever the finger lands: that is the native range input's own
 * behaviour, it is accepted, and it never happens on a nudge, a typed value or
 * a reset.
 *
 * Knows nothing about what the setting is (ui/ is app-agnostic): the caller
 * supplies the conversions and the words.
 */

export interface ChangeHow {
  /** False for a drag (one coalesced undo step for the whole drag); true for
   *  a nudge, a typed value and a reset (each its own step). */
  discrete: boolean
  /** A double tap's reset after a first tap that moved the thumb: it belongs
   *  to that tap's undo step, even when that step's burst has ended. The two
   *  taps are timed by when they touched, so the second can be handled long
   *  after the first (behind a slow preview render) and after the burst's
   *  idle timer has run. The history decides whether that step is still
   *  there to join; when it is not, the reset is a step of its own. */
  joins?: boolean
}

export interface Param {
  key: string
  /** The setting's name, on screen and in every label that names it. */
  label: string
  /** The slider's travel. */
  trackMin: number
  trackMax: number
  /** The values the setting may hold (nudges and typed values stop here). */
  min: number
  max: number
  /** One step, in value units: the slider's step and one nudge. */
  step: number
  /** What a double-tap on the track resets to: always read from the app's
   *  defaults, never retyped (a retyped default drifts). */
  def: number
  /** Value units to the units a person types ("50" for 0.05 of a sheet), and
   *  back. Linear. */
  toDisplay: (v: number) => number
  fromDisplay: (n: number) => number
  /** The readout, with its unit: "40%", "−4°". */
  format: (v: number) => string
  value: number
  onChange: (v: number, how: ChangeHow) => void
  /** Set when the setting cannot be moved right now, saying why in words
   *  ("Zoom in to move the photo"). The slider and nudges are disabled and
   *  the words take the value's place. */
  unavailable?: string
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Decimal places in a step: 0.005 has 3, 0.5 has 1, 1 has 0. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  for (let d = 0; d < 10; d++) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9 * 10 ** d) return d
  }
  return 10
}

/**
 * A number on a setting's grid and inside its range: `min + k x step`,
 * rounded to the step's own decimals so a stored value never carries a float
 * tail (0.041000000000000002). Shared by the nudges and the typed entry, so
 * both land on values the slider itself can reach.
 */
export function snapTo(n: number, min: number, max: number, step: number): number {
  let v = clamp(n, min, max)
  if (step > 0) {
    v = Math.round((v - min) / step) * step + min
    v = clamp(v, min, max)
  }
  const d = Math.max(decimalsOf(step), decimalsOf(Math.abs(min)))
  return Number(v.toFixed(d))
}

/** Where the thumb sits: the value clamped into the slider's travel. */
export const thumbValue = (p: Pick<Param, 'value' | 'trackMin' | 'trackMax'>): number =>
  clamp(p.value, p.trackMin, p.trackMax)

/** The thumb's place along the travel, 0..1 (the style guide's `--p`). */
export function trackPosition(p: Pick<Param, 'value' | 'trackMin' | 'trackMax'>): number {
  const span = p.trackMax - p.trackMin
  return span > 0 ? (thumbValue(p) - p.trackMin) / span : 0
}

/**
 * One nudge: a step in VALUE space, clamped to the setting's range — not the
 * slider's. From "240%" one tap on [−] gives "239%", never "100%". A value off
 * the grid (a pinch stores finer steps) lands on the grid.
 */
export function nudge(p: Pick<Param, 'value' | 'min' | 'max' | 'step'>, dir: 1 | -1): number {
  return snapTo(p.value + dir * p.step, p.min, p.max, p.step)
}

/** Whether a nudge can move the value: [+] goes unavailable only at `max`
 *  (not at the slider's end), [−] only at `min`. */
export function canNudge(p: Pick<Param, 'value' | 'min' | 'max' | 'step'>, dir: 1 | -1): boolean {
  return dir > 0 ? p.value < p.max : p.value > p.min
}

/** One step in the units a person types. */
export function displayStep(p: Pick<Param, 'toDisplay' | 'min' | 'step'>): number {
  return Math.abs(p.toDisplay(p.min + p.step) - p.toDisplay(p.min))
}

/** The number a typed entry opens with: the value in display units, at the
 *  display step's precision ("41", not "41.2" or "0.0412"). */
export function draftOf(p: Pick<Param, 'value' | 'toDisplay' | 'min' | 'step'>): string {
  const d = decimalsOf(Number(displayStep(p).toPrecision(9)))
  return String(Number(p.toDisplay(p.value).toFixed(d)))
}

/** The whole range, in words a person reads: "10% to 1200%". */
export const rangeText = (p: Pick<Param, 'min' | 'max' | 'format'>): string => `${p.format(p.min)} to ${p.format(p.max)}`

/**
 * A typed number (display units), as the value it commits: converted back,
 * then snapped onto the grid and into the setting's FULL range (typing 240 on
 * Size gives 240%, never 100%). The setting's own unit may be typed after it
 * ("40%", "−4°"), and a true minus sign counts as one. Null for anything that
 * is not a plain number — "4 0", "x", "", "1e3" — and for a negative number
 * where the setting has none, so a typo never becomes a value.
 */
export function committedValue(p: Pick<Param, 'fromDisplay' | 'min' | 'max' | 'step'>, typed: string): number | null {
  const bare = typed
    .replace(/\u2212/g, '-')
    .trim()
    .replace(/\s*(%|°|px|em)$/i, '')
    .trim()
  // A plain decimal only: Number() alone would also take "1e3", "0x10" and
  // "Infinity", none of which is a value anyone types on purpose.
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(bare)) return null
  const v = p.fromDisplay(Number(bare))
  if (v < 0 && p.min >= 0) return null
  return snapTo(v, p.min, p.max, p.step)
}

/**
 * What each way of changing a setting changes it to, and how the change is
 * recorded: a drag is coalesced into one undo step, a nudge, a typed value and
 * a reset are each a step of their own. Null when it changes nothing (an
 * unavailable setting, a value already there, a typo).
 */
export type Change = { value: number; discrete: boolean; joins?: true } | null

const change = (p: Pick<Param, 'value' | 'unavailable'>, value: number | null, discrete: boolean): Change =>
  p.unavailable !== undefined || value === null || value === p.value ? null : { value, discrete }

/** A drag: the native range input reports the thumb's place on the TRACK. A
 *  thumb pinned past the end therefore jumps to the touch (stated, accepted). */
export const dragChange = (p: Param, raw: number): Change =>
  change(p, snapTo(raw, p.trackMin, p.trackMax, p.step), false)

/** A tap on [−] or [+]. */
export const nudgeChange = (p: Param, dir: 1 | -1): Change =>
  change(p, canNudge(p, dir) ? nudge(p, dir) : null, true)

/** A reset to the default (a double-click on the track): a step of its own. */
export const resetChange = (p: Param): Change => change(p, p.def, true)

/**
 * A double-tap on the track: the default, as ONE undo step from where the
 * setting was before the two taps. A tap on a native range moves the thumb to
 * the finger, so the first tap of the two has usually changed the value, as a
 * drag does (a coalesced step); the reset then joins that step, and one Undo
 * goes back past both (Border Studio's history, which coalesces by time,
 * gives the same). It joins it by name (`joins`), not by arriving in time: the
 * second tap may be handled after the first tap's burst is over. The reset
 * itself is a step (`discrete`), never part of a drag: a first tap that moved
 * nothing leaves it a step of its own, and so does the history when the first
 * tap's run left no step to join (it wobbled and came back).
 */
export const doubleTapReset = (p: Param, firstTapMoved: boolean): Change => {
  const c = change(p, p.def, true)
  return c && firstTapMoved ? { ...c, joins: true } : c
}

/** A typed value, committed. */
export const typedChange = (p: Param, typed: string): Change => change(p, committedValue(p, typed), true)

/** Hand a change to the setting. */
export function applyChange(p: Param, c: Change): void {
  if (c) p.onChange(c.value, c.joins ? { discrete: c.discrete, joins: true } : { discrete: c.discrete })
}

/** Two taps on the track this close together reset it (Border Studio's
 *  window, c2dc669). */
export const DOUBLE_TAP_MS = 320

/** Whether a tap at `now` is the second of a double tap after one at
 *  `last` (0: no tap yet). */
export const isDoubleTap = (last: number, now: number): boolean => last > 0 && now - last < DOUBLE_TAP_MS

/** How far a finger must move on the parameter sheet before the row under
 *  it counts: the swipe that opened the sheet must not pick whatever row
 *  rose beneath it. */
export const PICK_DEAD_ZONE_PX = 6

/** How far up a swipe from the strip's name opens the parameter sheet. */
export const SWIPE_OPEN_PX = 8

/** Whether a drag that started at `fromY` and is now at `y` picks rows yet. */
export const dragPicks = (fromY: number, y: number): boolean => Math.abs(y - fromY) >= PICK_DEAD_ZONE_PX

/** Whether a pointer that went down on the name at `fromY` and is now at `y`
 *  has swiped up far enough to open the sheet. */
export const swipeOpens = (fromY: number, y: number): boolean => fromY - y > SWIPE_OPEN_PX

/** The key of the row whose band holds `y`, from rows top to bottom; null
 *  between or outside them. */
export function rowAt(rows: readonly { key: string; top: number; bottom: number }[], y: number): string | null {
  for (const r of rows) if (y >= r.top && y <= r.bottom) return r.key
  return null
}
