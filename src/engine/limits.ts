/**
 * The engine's hard limits, in one place.
 *
 * Here rather than beside the controls that enforce them because the engine
 * needs them too (`fitSize` clamps to the size range) and `engine/` may not
 * import from `features/`. The normaliser reads them from here as well, so a
 * stored value, a fitted value and a gesture can never disagree about what a
 * valid size is. The export's numbers live here for the same reason: the
 * planner (exportPlan.ts) and the renderer must agree on them.
 */

/**
 * Every pitch and offset in the settings is expressed against this height, so
 * the preview and the export produce the same *look* at different resolutions.
 * It is also the export's floor: a print is never saved smaller than this,
 * however few pixels its photo has.
 */
export const REFERENCE_HEIGHT = 1800

/**
 * The export canvas's ceiling, by AREA: 16,777,216 px (4096 x 4096), the most
 * a browser canvas is guaranteed to hold — WebKit's documented limit is an
 * area. Over it, an iOS canvas does not throw; it hands back a blank one.
 * There is no separate edge cap: a 3:1 sheet may be 7092 px wide. The photo
 * itself is never capped (it is stored as imported); only the sheet it is
 * pressed into is. Exporting above this needs tiled rendering and a JS
 * encoder, which are not built.
 */
export const MAX_AREA = 16_777_216

/**
 * The export height of a print with no photo: 2 x REFERENCE_HEIGHT (a 4:5
 * sheet is 2880 x 3600, 10.4 MP). Type is vector and every effect scales, so
 * a larger sheet is strictly crisper; an integer ratio keeps the grain cells,
 * one-pixel kernels and misregistration exact; and it stays below a 12 MP
 * photo's export, so it adds no new memory regime.
 */
export const NO_PHOTO_HEIGHT = 3600

/**
 * Type size, as a fraction of the sheet's height: the em, so `fontSize = size
 * x height`. Shown as `size x 1000` percent (sizeScale.ts), so 0.10 of the
 * sheet reads "100%".
 *
 *  - SIZE_MIN, 0.01 ("10%"): the one floor for the slider, a nudge, a pinch,
 *    the keys, Fit and a typed value. At the 1800 px reference it is an 18 px
 *    em, below which type stops reading. Every size an older build could
 *    store (its floor was 0.015) is above it, so nothing saved moves.
 *  - SIZE_SLIDER_MAX, 0.10 ("100%"): the end of the slider's travel, which is
 *    where captions and headlines over a photo live. 90 steps of SIZE_STEP.
 *  - SIZE_STEP, 0.001 ("1%"): the slider's step and a nudge's.
 *  - SIZE_MAX, 1.2 ("1200%"): the ceiling for everything that is not the
 *    slider — a pinch, the keys, Fit, a typed value, a stored size. Larger
 *    type stays reachable (Fit on a short word lands well past 100%); the
 *    slider's thumb pins at its end and the readout shows the true value.
 */
export const SIZE_MIN = 0.01
export const SIZE_SLIDER_MAX = 0.1
export const SIZE_STEP = 0.001
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
