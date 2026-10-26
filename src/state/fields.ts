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
 *  - number   finite (and above zero when `positive`), else the default;
 *             then clamped to [min, max] (and rounded when `int`)
 *  - boolean  a boolean, else the default
 *  - enum     a member of `values`, else the default — an unknown ink, face
 *             or paper resolves to the field's default, never to "the first
 *             entry in the table"
 *  - object   a plain object, normalised against `fields` and the template
 *  - array    an array of plain objects, each normalised against `fields`
 *
 * `nullable`: null and valid values pass, and anything else becomes null.
 *
 * Ranges are the widest any build's controls could set (sliders, pinch and
 * keys), so a value a person could have chosen is never clamped.
 */

import { PAPERS, RISO_INKS } from '../engine/inks.ts'
import { SIZE_MAX, SIZE_MIN } from '../engine/limits.ts'
import { ASPECTS, FONTS } from '../engine/types.ts'
import { makeLayer, makeMedia, nextLayerId } from './defaults.ts'

export interface Row {
  key: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array'
  nullable?: boolean
  /** string: the empty string is not a valid value. */
  nonEmpty?: boolean
  /** enum */
  values?: readonly string[]
  /** number */
  min?: number
  max?: number
  int?: boolean
  /** number: zero or below is not a value at all (the default), rather than
   *  something to clamp up to `min` — a size of -1 is corruption, not a wish
   *  for the smallest type. */
  positive?: boolean
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
  /** A field the template does not carry: kept when stored and valid,
   *  otherwise left out (never filled in from a default). */
  optional?: boolean
}

const ids = (list: readonly { id: string }[]): readonly string[] => list.map((x) => x.id)

export const INK_IDS = ids(RISO_INKS)
export const FONT_IDS = ids(FONTS)
export const PAPER_IDS = ids(PAPERS)
export const ASPECT_KEYS: readonly string[] = [...Object.keys(ASPECTS), 'original']
export const ALIGNS = ['left', 'center', 'right', 'justify'] as const
export const METHODS = ['halftone', 'grain'] as const

/** Sheet positions: the drag and the keys let type bleed a little off the trim. */
const POSITION = { min: -0.3, max: 1.3 }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const LAYER_FIELDS: readonly Row[] = [
  { key: 'id', kind: 'string', nonEmpty: true },
  { key: 'text', kind: 'string' },
  { key: 'inkId', kind: 'enum', values: INK_IDS },
  { key: 'fontId', kind: 'enum', values: FONT_IDS },
  { key: 'bold', kind: 'boolean' },
  { key: 'size', kind: 'number', min: SIZE_MIN, max: SIZE_MAX, positive: true },
  { key: 'lineHeight', kind: 'number', min: 0.6, max: 2 },
  { key: 'tracking', kind: 'number', min: -0.1, max: 0.4 },
  { key: 'contrastInkId', kind: 'enum', nullable: true, values: INK_IDS },
  { key: 'contrastThreshold', kind: 'number', min: 0.1, max: 0.9 },
  { key: 'align', kind: 'enum', values: ALIGNS },
  { key: 'x', kind: 'number', ...POSITION },
  { key: 'y', kind: 'number', ...POSITION },
  { key: 'rotation', kind: 'number', min: -180, max: 180 },
  { key: 'backing', kind: 'enum', nullable: true, values: INK_IDS },
]

export const PRESS_FIELDS: readonly Row[] = [
  { key: 'method', kind: 'enum', values: METHODS },
  // 36 is a 12 px dither cell (the old Dot size slider's top) in this unit, so
  // every converted grain keeps its cell. The Screen size slider stops at 24;
  // a larger stored value prints as saved and pins the thumb at the end.
  { key: 'screenPitch', kind: 'number', min: 2, max: 36 },
  { key: 'density', kind: 'number', min: 0.3, max: 1 },
  { key: 'misregistration', kind: 'number', min: 0, max: 30 },
  { key: 'edge', kind: 'number', min: 0, max: 1 },
  { key: 'wear', kind: 'number', min: 0, max: 0.8 },
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
  // Stored as imported (original bytes). Optional: a document an older build
  // saved has none, and that absence is what marks its 2048 px copy.
  { key: 'native', kind: 'boolean', optional: true },
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
