/**
 * The document schema: every field a saved print may carry, and what a valid
 * value of it is.
 *
 * This table is what the normaliser walks. A field that is not in it does not
 * survive a load, so a removed feature leaves saved documents by construction
 * rather than riding along forever; a field that is in it keeps any valid
 * stored value, so nothing a person chose is reset. Defaults are not repeated
 * here: they are the templates (`defaultSettings()`, `makeLayer()`,
 * `makeMedia()`), and a test holds the two key sets equal at every level.
 *
 * Kinds and their rules (normalize.ts applies them):
 *  - string   a string, else the default (`nonEmpty`: '' counts as invalid)
 *  - number   finite, else the default; then clamped to [min, max] (and
 *             rounded when `int`)
 *  - boolean  a boolean, else the default
 *  - enum     a member of `values`, else the default — an unknown ink, face
 *             or paper resolves to the field's default, never to "the first
 *             entry in the table"
 *  - object   a plain object, normalised against `fields` and the template
 *  - array    an array of plain objects, each normalised against `fields`
 *  - custom   its own `normalize`, for the odd shapes
 *
 * `nullable`: null and valid values pass, and anything else becomes null.
 *
 * Ranges are the widest any build's controls could set (sliders, pinch and
 * keys), so a value a person could have chosen is never clamped.
 */

import { DITHER_TYPES } from '../engine/dither.ts'
import { PAPERS, RISO_INKS } from '../engine/inks.ts'
import { SIZE_MAX, SIZE_MIN } from '../engine/limits.ts'
import { ASPECTS, FONTS } from '../engine/types.ts'
import { makeLayer, makeMedia, nextLayerId } from './defaults.ts'

export interface Row {
  key: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'custom'
  nullable?: boolean
  /** string: the empty string is not a valid value. */
  nonEmpty?: boolean
  /** enum */
  values?: readonly string[]
  /** number */
  min?: number
  max?: number
  int?: boolean
  /** object and array: the fields of the object, or of each item. */
  fields?: readonly Row[]
  /** object (when its default is null) and array items: a fresh template. */
  template?: () => Record<string, unknown>
  /** array: fewer valid items than this and the whole field is the default. */
  minItems?: number
  /** array: ids that must be unique across the items, and how to mint one. */
  uniqueId?: () => string
  /** object: a stored object failing this is not one at all (null, or the default). */
  accept?: (raw: Record<string, unknown>) => boolean
  /** custom */
  normalize?: (raw: unknown, fallback: unknown) => unknown
}

const ids = (list: readonly { id: string }[]): readonly string[] => list.map((x) => x.id)

export const INK_IDS = ids(RISO_INKS)
export const FONT_IDS = ids(FONTS)
export const PAPER_IDS = ids(PAPERS)
export const ASPECT_KEYS = Object.keys(ASPECTS)
export const ALIGNS = ['left', 'center', 'right', 'justify'] as const
export const METHODS = ['halftone', 'dither', 'woodcut', 'scribble'] as const
export const SCREEN_SHAPES = ['circle', 'square', 'line', 'ellipse', 'cross', 'diamond'] as const

/** Sheet positions: the drag and the keys let type bleed a little off the trim. */
const POSITION = { min: -0.3, max: 1.3 }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Per-word press overrides: keys are word indices, values deltas on the press. */
function normalizeWordPress(raw: unknown, fallback: unknown): unknown {
  if (!isPlainObject(raw)) return fallback
  const out: Record<string, { bleed?: number; offset?: number }> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!/^(0|[1-9]\d*)$/.test(k) || !isPlainObject(v)) continue
    const entry: { bleed?: number; offset?: number } = {}
    if (finite(v.bleed)) entry.bleed = Math.min(0.6, Math.max(0, v.bleed))
    if (finite(v.offset)) entry.offset = Math.min(30, Math.max(0, v.offset))
    // Zero on both is "normal", which the reducer stores as no entry at all.
    if (entry.bleed || entry.offset) out[k] = entry
  }
  return out
}

/** Word indices a box covers: non-negative integers, each once, in order. */
function normalizeWords(raw: unknown, fallback: unknown): unknown {
  if (!Array.isArray(raw)) return fallback
  const words = raw.filter((n): n is number => Number.isInteger(n) && n >= 0)
  return [...new Set(words)].sort((a, b) => a - b)
}

let restored = 0
const restoredId = (prefix: string) => () => `${prefix}-restored-${Date.now().toString(36)}-${restored++}`

export const BOX_FIELDS: readonly Row[] = [
  { key: 'id', kind: 'string', nonEmpty: true },
  { key: 'words', kind: 'custom', normalize: normalizeWords },
  { key: 'inkId', kind: 'enum', values: INK_IDS },
  { key: 'opacity', kind: 'number', min: 0, max: 1 },
]

export const boxTemplate = (): Record<string, unknown> => ({
  id: restoredId('box')(),
  words: [],
  inkId: 'blue',
  opacity: 1,
})

export const LAYER_FIELDS: readonly Row[] = [
  { key: 'id', kind: 'string', nonEmpty: true },
  { key: 'text', kind: 'string' },
  { key: 'inkId', kind: 'enum', values: INK_IDS },
  { key: 'fontId', kind: 'enum', values: FONT_IDS },
  { key: 'bold', kind: 'boolean' },
  { key: 'size', kind: 'number', min: SIZE_MIN, max: SIZE_MAX },
  { key: 'lineHeight', kind: 'number', min: 0.6, max: 2 },
  { key: 'tracking', kind: 'number', min: -0.1, max: 0.4 },
  { key: 'wordPress', kind: 'custom', normalize: normalizeWordPress },
  { key: 'opaque', kind: 'boolean' },
  { key: 'contrastInkId', kind: 'enum', nullable: true, values: INK_IDS },
  { key: 'contrastThreshold', kind: 'number', min: 0.1, max: 0.9 },
  { key: 'align', kind: 'enum', values: ALIGNS },
  { key: 'x', kind: 'number', ...POSITION },
  { key: 'y', kind: 'number', ...POSITION },
  { key: 'rotation', kind: 'number', min: -180, max: 180 },
  { key: 'opacity', kind: 'number', min: 0, max: 1 },
  { key: 'boxes', kind: 'array', fields: BOX_FIELDS, template: boxTemplate, uniqueId: restoredId('box') },
  { key: 'boxPadding', kind: 'number', min: 0, max: 0.6 },
  { key: 'boxRadius', kind: 'number', min: 0, max: 0.8 },
]

export const PRESS_FIELDS: readonly Row[] = [
  { key: 'method', kind: 'enum', values: METHODS },
  { key: 'screenShape', kind: 'enum', values: SCREEN_SHAPES },
  { key: 'screenPitch', kind: 'number', min: 2, max: 24 },
  { key: 'screenSoftness', kind: 'number', min: 0, max: 3 },
  { key: 'ditherType', kind: 'enum', values: ids(DITHER_TYPES) },
  { key: 'ditherThreshold', kind: 'number', min: 0.1, max: 0.9 },
  { key: 'ditherScale', kind: 'number', min: 1, max: 12, int: true },
  { key: 'carvePitch', kind: 'number', min: 3, max: 40 },
  { key: 'carveAngle', kind: 'number', min: 0, max: 180 },
  { key: 'carveRoughness', kind: 'number', min: 0, max: 1 },
  { key: 'density', kind: 'number', min: 0.3, max: 1 },
  { key: 'gamma', kind: 'number', min: 0.4, max: 2.4 },
  { key: 'mottle', kind: 'number', min: 0, max: 0.8 },
  { key: 'dropout', kind: 'number', min: 0, max: 0.08 },
  { key: 'banding', kind: 'number', min: 0, max: 1 },
  { key: 'roughness', kind: 'number', min: 0, max: 1 },
  { key: 'roughScale', kind: 'number', min: 1, max: 14 },
  { key: 'bleed', kind: 'number', min: 0, max: 1 },
  { key: 'streaks', kind: 'number', min: 0, max: 1 },
  { key: 'smear', kind: 'number', min: 0, max: 1 },
  { key: 'patches', kind: 'number', min: 0, max: 1 },
  { key: 'misregistration', kind: 'number', min: 0, max: 30 },
  { key: 'detailScaling', kind: 'boolean' },
]

export const MEDIA_FIELDS: readonly Row[] = [
  { key: 'id', kind: 'string', nonEmpty: true },
  // Intrinsic pixel size of the stored photo: only its ratio is read, for the
  // cover fit, so any positive size is valid.
  { key: 'width', kind: 'number', min: 1, max: 1e6 },
  { key: 'height', kind: 'number', min: 1, max: 1e6 },
  // Zoom in only: below 1 the photo stops covering the sheet.
  { key: 'scale', kind: 'number', min: 1, max: 4 },
  // Any finite centre: the range that keeps the sheet covered depends on the
  // sheet's shape and the zoom, so it is applied after the walk (clampPan).
  { key: 'x', kind: 'number' },
  { key: 'y', kind: 'number' },
]

/** The media placeholder the normaliser fills a stored photo into. Its id and
 *  size are always replaced: `acceptMedia` refuses a photo without them. */
export const mediaTemplate = (): Record<string, unknown> => ({ ...makeMedia({ id: '', width: 1, height: 1 }) })

/**
 * A stored photo is only a reference: the bytes live in IndexedDB. Without an
 * id there is nothing to look up, and without a real size there is no cover
 * fit, so anything not shaped like a placement is dropped rather than handed to
 * the renderer.
 */
export const acceptMedia = (m: Record<string, unknown>): boolean =>
  typeof m.id === 'string' && m.id.length > 0 && finite(m.width) && m.width > 0 && finite(m.height) && m.height > 0

export const SETTINGS_FIELDS: readonly Row[] = [
  { key: 'media', kind: 'object', nullable: true, fields: MEDIA_FIELDS, template: mediaTemplate, accept: acceptMedia },
  { key: 'paperVeil', kind: 'boolean' },
  { key: 'aspect', kind: 'enum', values: ASPECT_KEYS },
  { key: 'paperId', kind: 'enum', values: PAPER_IDS },
  { key: 'paperTexture', kind: 'number', min: 0, max: 1 },
  { key: 'paperBlotch', kind: 'number', min: 0, max: 1 },
  { key: 'press', kind: 'object', fields: PRESS_FIELDS },
  { key: 'seed', kind: 'number', min: 0, max: 0xffffffff, int: true },
  {
    key: 'layers',
    kind: 'array',
    fields: LAYER_FIELDS,
    template: () => ({ ...makeLayer() }),
    minItems: 1,
    uniqueId: nextLayerId,
  },
]
