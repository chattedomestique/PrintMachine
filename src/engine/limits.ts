/**
 * The engine's hard limits, in one place.
 *
 * Here rather than beside the controls that enforce them because the engine
 * needs them too (`fitSize` clamps to the size range) and `engine/` may not
 * import from `features/`. The normaliser reads them from here as well, so a
 * stored value, a fitted value and a gesture can never disagree about what a
 * valid size is.
 */

/** Type size, as a fraction of the sheet's height. */
export const SIZE_MIN = 0.015
export const SIZE_MAX = 1.2
