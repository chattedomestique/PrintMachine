/**
 * How a type size is shown, typed and nudged.
 *
 * The stored size is a fraction of the sheet's height (the em) and does not
 * change. What changes is the number people see: `size x 1000` percent, so a
 * tenth of the sheet reads "100%" — "10% should be our new 100%". The usable
 * range people actually work in, captions to headlines over a photo, then
 * spans the whole slider instead of its first two percent.
 *
 * Here, not in `engine/` (the engine never shows a number) and not in `ui/`
 * (which knows nothing about type): the Size strip (its readout, its typed
 * value: params.ts) and the keys all read it, so they cannot disagree about
 * what "40%" is.
 */

import { SIZE_MAX, SIZE_MIN, SIZE_STEP } from '../../engine/limits.ts'

/** Display units per unit of size: 0.1 of the sheet's height is 100%. */
const PER_SIZE = 1000

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Steps in one unit of size. Divided by, never multiplied: n / 1000 is the
 *  nearest double to the decimal, so a stored value never carries a float
 *  tail like 0.041000000000000002. */
const STEPS = Math.round(1 / SIZE_STEP)

/** A size on the SIZE_STEP grid. */
const snap = (size: number): number => Math.round(size * STEPS) / STEPS

/** The number shown for a size: 0.1 -> 100, 0.04 -> 40, SIZE_MAX -> 1200. */
export const toDisplay = (size: number): number => Math.round(size * PER_SIZE)

/** The size for a shown number: 100 -> 0.1. */
export const fromDisplay = (pct: number): number => pct / PER_SIZE

/** The readout: "40%". The true value, also past the slider's end ("240%"). */
export const formatSize = (size: number): string => `${toDisplay(size)}%`

/**
 * The size one `+` or `-` key press makes: 5% of the size (20% with Shift),
 * but never less than one SIZE_STEP, on the step grid, inside the size range.
 *
 * Not purely multiplicative: near the floor 5% of 0.01 is 0.0005, half a step,
 * so a press would round back to where it started.
 */
export function stepSize(size: number, direction: 1 | -1, big = false): number {
  const delta = Math.max(SIZE_STEP, size * (big ? 0.2 : 0.05))
  return clamp(snap(size + direction * delta), SIZE_MIN, SIZE_MAX)
}
