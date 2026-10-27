/**
 * Every numeric setting the dock shows, as parameters (ui/param.ts): what the
 * slider spans, what the setting may hold, its step, how it reads, and the
 * default a double-tap resets to.
 *
 * The defaults are READ from the templates (`makeLayer()`, `pressProfile()`,
 * `makeMedia()`), never retyped: a default typed twice drifts, and a reset
 * that lands somewhere a new plate does not start is a bug nobody sees. The
 * ranges are read from the document schema (state/fields.ts), so a value a
 * saved print holds can always be nudged and typed, never clamped by the
 * control that shows it. params.test.ts holds both.
 *
 * Pure: the panels hand in the value and the change; nothing here renders.
 */

import { areaOf, fromPanFraction, panFraction } from '../../engine/media.ts'
import { SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX, SIZE_STEP } from '../../engine/limits.ts'
import type { MediaLayer, PressProfile, TextLayer } from '../../engine/types.ts'
import { makeLayer, makeMedia, pressProfile } from '../../state/defaults.ts'
import { LAYER_FIELDS, MEDIA_FIELDS, PRESS_FIELDS, type Row } from '../../state/fields.ts'
import type { ChangeHow, Param } from '../../ui/param.ts'
import { formatSize, fromDisplay as sizeFromDisplay, toDisplay as sizeToDisplay } from './sizeScale.ts'

/** The true minus sign (U+2212), as the style guide asks of a signed number:
 *  a hyphen is shorter than a plus and reads as a dash. */
export const MINUS = '−'

/** A number with its sign: "−4", "4" (or "+4" with `plus`). */
export function signed(n: number, digits = 0, plus = false): string {
  const r = Number(n.toFixed(digits))
  const body = Math.abs(r).toFixed(digits)
  if (r < 0) return `${MINUS}${body}`
  return plus && r > 0 ? `+${body}` : body
}

/** A fraction as a whole percent: 0.84 -> "84%", −0.3 -> "−30%". */
export const percent = (v: number): string => `${signed(v * 100)}%`
/** Degrees: "−4°". */
export const degrees = (v: number): string => `${signed(v)}°`
/** Pixels at the reference height, at a step of a half: "9.0 px", "5 px". */
export const pixels = (digits: number) => (v: number): string => `${signed(v, digits)} px`
/** Tracking, in ems, signed both ways: "−0.020 em", "+0.040 em", "0.000 em". */
export const ems = (v: number): string => `${signed(v, 3, true)} em`

const identity = (v: number): number => v
const hundred = { toDisplay: (v: number) => v * 100, fromDisplay: (n: number) => n / 100 }

/** A row's range in the document schema. */
function rangeOf(rows: readonly Row[], key: string): { min: number; max: number } {
  const row = rows.find((r) => r.key === key)
  if (!row || row.min === undefined || row.max === undefined) throw new Error(`No range for ${key}`)
  return { min: row.min, max: row.max }
}

/** The change a panel hands in: the patch, and whether it is its own undo
 *  step (a drag is not; a nudge, a typed value and a reset are). */
type SetPatch<T> = (patch: Partial<T>, how: ChangeHow) => void

/** The defaults a reset lands on: a NEW plate's, the press a new document
 *  pulls with, a photo as it is placed on import. */
const LAYER = makeLayer()
const PRESS = pressProfile()
const MEDIA = makeMedia({ id: 'default', width: 1, height: 1 })

// ── Type ────────────────────────────────────────────────────────────────────

/**
 * Size: a tenth of the sheet reads 100% (sizeScale.ts). The slider spans 10%
 * to 100% in 1% steps; a pinch, the keys, Fit and a typed value reach 1200%,
 * and then the thumb pins at the end while the readout shows the true value.
 */
export function sizeParam(layer: TextLayer, set: SetPatch<TextLayer>): Param {
  return {
    key: 'size',
    label: 'Size',
    trackMin: SIZE_MIN,
    trackMax: SIZE_SLIDER_MAX,
    min: SIZE_MIN,
    max: SIZE_MAX,
    step: SIZE_STEP,
    def: LAYER.size,
    // The readout's unit and the typed unit are one conversion (sizeScale.ts).
    toDisplay: sizeToDisplay,
    fromDisplay: sizeFromDisplay,
    format: formatSize,
    value: layer.size,
    onChange: (size, how) => set({ size }, how),
  }
}

/** Line height and tracking: the spacing of a block of type. */
export function spaceParams(layer: TextLayer, set: SetPatch<TextLayer>): Param[] {
  const lh = rangeOf(LAYER_FIELDS, 'lineHeight')
  const tr = rangeOf(LAYER_FIELDS, 'tracking')
  return [
    {
      key: 'lineHeight',
      label: 'Line height',
      trackMin: lh.min,
      trackMax: lh.max,
      ...lh,
      step: 0.01,
      def: LAYER.lineHeight,
      toDisplay: identity,
      fromDisplay: identity,
      format: (v) => v.toFixed(2),
      value: layer.lineHeight,
      onChange: (lineHeight, how) => set({ lineHeight }, how),
    },
    {
      key: 'tracking',
      label: 'Tracking',
      trackMin: tr.min,
      trackMax: tr.max,
      ...tr,
      step: 0.005,
      def: LAYER.tracking,
      toDisplay: identity,
      fromDisplay: identity,
      format: ems,
      value: layer.tracking,
      onChange: (tracking, how) => set({ tracking }, how),
    },
  ]
}

/**
 * Where the plate sits: the tap equivalents of dragging and turning it on the
 * photo (WCAG 2.5.7; a key is not one). Rotation's slider spans ±45°, where a
 * tilted stamp lives; a pinch and the bracket keys turn it to ±180°. Position
 * spans the sheet, 0 to 100%; a drag can take type 30% past the trim, to bleed.
 */
export function placeParams(layer: TextLayer, set: SetPatch<TextLayer>): Param[] {
  const rot = rangeOf(LAYER_FIELDS, 'rotation')
  const pos = rangeOf(LAYER_FIELDS, 'x')
  const position = (axis: 'x' | 'y', label: string): Param => ({
    key: axis,
    label,
    trackMin: 0,
    trackMax: 1,
    ...pos,
    step: 0.01,
    def: LAYER[axis],
    ...hundred,
    format: percent,
    value: layer[axis],
    onChange: (v, how) => set({ [axis]: v } as Partial<TextLayer>, how),
  })
  return [
    {
      key: 'rotation',
      label: 'Rotation',
      trackMin: -45,
      trackMax: 45,
      ...rot,
      step: 1,
      def: LAYER.rotation,
      toDisplay: identity,
      fromDisplay: identity,
      format: degrees,
      value: layer.rotation,
      onChange: (rotation, how) => set({ rotation }, how),
    },
    position('x', 'Position X'),
    position('y', 'Position Y'),
  ]
}

// ── Ink ─────────────────────────────────────────────────────────────────────

/** Where the plate's pass changes from its ink to its second ink, by the
 *  photo's (blurred) lightness under it. */
export function switchPointParam(layer: TextLayer, set: SetPatch<TextLayer>): Param {
  const r = rangeOf(LAYER_FIELDS, 'contrastThreshold')
  return {
    key: 'contrastThreshold',
    label: 'Switch point',
    trackMin: r.min,
    trackMax: r.max,
    ...r,
    step: 0.01,
    def: LAYER.contrastThreshold,
    ...hundred,
    format: percent,
    value: layer.contrastThreshold,
    onChange: (contrastThreshold, how) => set({ contrastThreshold }, how),
  }
}

// ── Photo ───────────────────────────────────────────────────────────────────

/** Said in place of a photo position that cannot move: at 100% on its own
 *  sheet the photo fills it exactly, so there is nowhere to move it to. */
export const NO_TRAVEL = 'Zoom in to move the photo'

/**
 * The photo's framing: Zoom (in only, 100% to 400%), and where it sits as a
 * FRACTION OF THE TRAVEL it has (0% shows its left or top edge, 100% its right
 * or bottom), so the slider always spans exactly the positions that keep the
 * sheet covered. Where there is no travel the position is unavailable, and
 * says why. `aspect` is the shape of what the photo covers: the visible
 * rectangle inside the frame (frame.ts `visibleAspect`).
 */
export function frameParams(media: MediaLayer, aspect: number, set: SetPatch<MediaLayer>): Param[] {
  const zoom = rangeOf(MEDIA_FIELDS, 'scale')
  const area = areaOf(aspect, 1)
  const position = (axis: 'x' | 'y', label: string): Param => {
    const f = panFraction(media, area, axis)
    const travel = (() => {
      const lo = fromPanFraction(media, area, axis, 1)
      const hi = fromPanFraction(media, area, axis, 0)
      return hi - lo > 1e-9
    })()
    return {
      key: `photo-${axis}`,
      label,
      trackMin: 0,
      trackMax: 1,
      min: 0,
      max: 1,
      step: 0.01,
      // The photo as placed on import: centred, which is half its travel.
      def: panFraction({ ...media, [axis]: MEDIA[axis] }, area, axis),
      ...hundred,
      format: percent,
      value: f,
      onChange: (v, how) => set({ [axis]: fromPanFraction(media, area, axis, v) } as Partial<MediaLayer>, how),
      unavailable: travel ? undefined : NO_TRAVEL,
    }
  }
  return [
    {
      key: 'scale',
      label: 'Zoom',
      trackMin: zoom.min,
      trackMax: zoom.max,
      ...zoom,
      step: 0.01,
      def: MEDIA.scale,
      ...hundred,
      format: percent,
      value: media.scale,
      onChange: (scale, how) => set({ scale }, how),
    },
    position('x', 'Position X'),
    position('y', 'Position Y'),
  ]
}

// ── Press ───────────────────────────────────────────────────────────────────

/** One texture size for both screens: the halftone's dot pitch, and a grain
 *  cell a third of it. The slider stops at 24; a grain converted from an older
 *  build can hold up to 36, and keeps it. */
export function screenParam(press: PressProfile, set: SetPatch<PressProfile>): Param {
  const r = rangeOf(PRESS_FIELDS, 'screenPitch')
  return {
    key: 'screenPitch',
    label: 'Screen size',
    trackMin: r.min,
    trackMax: 24,
    ...r,
    step: 0.5,
    def: PRESS.screenPitch,
    toDisplay: identity,
    fromDisplay: identity,
    format: pixels(1),
    value: press.screenPitch,
    onChange: (screenPitch, how) => set({ screenPitch }, how),
  }
}

/** The machine: how much ink, how far each pass lands from the last, how
 *  ragged the letters are, how blotchy the ink is. */
export function pressParams(press: PressProfile, set: SetPatch<PressProfile>): Param[] {
  const amount = (key: 'density' | 'edge' | 'wear', label: string): Param => {
    const r = rangeOf(PRESS_FIELDS, key)
    return {
      key,
      label,
      trackMin: r.min,
      trackMax: r.max,
      ...r,
      step: 0.01,
      def: PRESS[key],
      ...hundred,
      format: percent,
      value: press[key],
      onChange: (v, how) => set({ [key]: v } as Partial<PressProfile>, how),
    }
  }
  const mis = rangeOf(PRESS_FIELDS, 'misregistration')
  return [
    amount('density', 'Ink'),
    {
      key: 'misregistration',
      label: 'Misregistration',
      trackMin: mis.min,
      trackMax: mis.max,
      ...mis,
      step: 0.5,
      def: PRESS.misregistration,
      toDisplay: identity,
      fromDisplay: identity,
      format: pixels(1),
      value: press.misregistration,
      onChange: (misregistration, how) => set({ misregistration }, how),
    },
    amount('edge', 'Edge'),
    amount('wear', 'Wear'),
  ]
}
