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

/**
 * The plate budget: at most this many text plates, and this many pressed
 * passes in all — a backing is a pass of its own, while a second ink is
 * pressed once and then split, so it counts once. Every pass is a full press
 * at export resolution, so the cap is what keeps the worst export knowable on
 * a phone.
 */
export const MAX_TEXT_PLATES = 3
export const MAX_PRESSED_PASSES = 4

/** How many times the press runs for this document. */
export function passCount(settings: { layers: readonly { backing: string | null }[] }): number {
  return settings.layers.length + settings.layers.filter((l) => l.backing).length
}
