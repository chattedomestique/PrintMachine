/**
 * One whitelist normaliser: anything stored in, a valid document out.
 *
 * Every saved print goes through here on load, whichever build wrote it. Two
 * guarantees, and they pull against each other, which is why this is a schema
 * walk and not a merge:
 *
 *  - **Nothing removed survives.** The result is BUILT from the templates
 *    (`defaultSettings()`, `makeLayer()`, `makeMedia()`), copying across only
 *    the fields `fields.ts` lists. A field a later build cut — or one no
 *    control can reach any more — cannot ride along and keep changing the
 *    print. Spreading the stored document over the defaults, which is what this
 *    replaced, kept every one of them forever.
 *  - **Nothing valid is lost.** Each stored value is checked against its own
 *    row: a valid one is kept exactly, an invalid one becomes the default. A
 *    `typeof`-of-the-default rule would get this wrong for every field whose
 *    default is null — a stored ink id in `contrastInkId: null` is a string,
 *    "the wrong type", and would be reset on every load. Losing the print on
 *    reload is the worst failure this app has.
 *
 * Before the walk, the named CONVERSIONS run, in order, on a copy of what was
 * stored: each one turns a field a build removed into whatever replaced it.
 * Each is added by the commit that removes its field.
 *
 * Pure: no DOM, no storage. Anything that needs a canvas (measuring text) is
 * injected through `env`, and is optional — without it the conversions that
 * need it keep the stored value.
 */

import { clampPan } from '../engine/media.ts'
import { ASPECTS, type PrintSettings, type TextLayer } from '../engine/types.ts'
import { fitSize, type FontMeasure } from '../engine/text.ts'
import { defaultSettings, makeLayer } from './defaults.ts'
import { LAYER_FIELDS, SETTINGS_FIELDS, type Row } from './fields.ts'

export interface NormalizeEnv {
  /** Measures text as the renderer will draw it. Absent outside a browser. */
  measure?: FontMeasure
}

type Doc = Record<string, unknown>

/** A conversion edits the stored copy in place, before the walk. */
type Conversion = (doc: Doc, env: NormalizeEnv) => void

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The stored layers that are objects — the only ones the walk will keep. */
const layersOf = (doc: Doc): Doc[] => (Array.isArray(doc.layers) ? doc.layers.filter(isPlainObject) : [])

/** The sheet's width over its height, as the walk will resolve the aspect. */
function sheetAspect(doc: Doc): number {
  const key = doc.aspect
  return typeof key === 'string' && Object.hasOwn(ASPECTS, key)
    ? ASPECTS[key as keyof typeof ASPECTS]
    : ASPECTS[defaultSettings().aspect]
}

/**
 * Run in this order. A removed field with a replacement is converted here; a
 * removed field with none (the printed photo's ink, contrast and lift, its
 * opacity, the photo's own press, word spacing, justify-by, lines-of-one-word,
 * the typewriter) is simply not in the schema, so it goes.
 *
 * The type conversions are ordered because the last one measures: the fitted
 * size depends on the text as it will be drawn — its case, its face and its
 * weight — so those are converted first.
 */
const CONVERSIONS: readonly Conversion[] = [
  // The paper veil was an amount, 0..1, and is now a switch. More than half
  // reads as "on"; a document that never had the field had it fully on.
  function paperVeil(doc) {
    if ('paperVeil' in doc) return
    doc.paperVeil = (finiteNumber(doc.paperAmount) ? doc.paperAmount : 1) > 0.5
  },

  // (1) The caps switch drew the text uppercased; now the text is what prints,
  // so it is uppercased once. Whitespace, and so the word count, is unchanged.
  function caps(doc) {
    for (const l of layersOf(doc)) {
      if (l.caps === true && typeof l.text === 'string') l.text = l.text.toUpperCase()
      delete l.caps
    }
  },

  // (2) Rounded was a fourth sans with no printed character of its own.
  function rounded(doc) {
    for (const l of layersOf(doc)) if (l.fontId === 'rounded') l.fontId = 'grotesk'
  },

  // (3) Nine weights become Bold or not, split where a face turns bold.
  function weight(doc) {
    for (const l of layersOf(doc)) {
      if (finiteNumber(l.weight) && !('bold' in l)) l.bold = l.weight >= 600
      delete l.weight
    }
  },

  // (4) is the schema: word spacing, justify-by, lines-of-one-word and the
  // typewriter are not in it, so they leave with the walk.

  // (5) LAST. Fit to width was a mode that kept a second, hidden size: layout
  // scaled the type and never stored the result. It is converted once to the
  // size that fits, measured on the layer exactly as it will now be drawn, so
  // a fitted headline opens the size it was. Without a measure (outside a
  // browser) the stored size stays. One saved size can shrink here: the old fit
  // was unclamped, so a line whose fit is above SIZE_MAX (in practice a single
  // glyph on a sheet wider than about 2:3) is stored at SIZE_MAX.
  function fitWidth(doc, env) {
    const aspect = sheetAspect(doc)
    for (const l of layersOf(doc)) {
      if (l.fitWidth === true && env.measure) {
        const asDrawn = object(LAYER_FIELDS, l, makeLayer() as unknown as Doc) as unknown as TextLayer
        l.size = fitSize(asDrawn, aspect, env.measure)
      }
      delete l.fitWidth
    }
  },
]

const isPlainObject = (v: unknown): v is Doc =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep copy of plain data, so a conversion can never edit what was passed in. */
function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone)
  if (isPlainObject(v)) {
    const out: Doc = {}
    for (const [k, x] of Object.entries(v)) out[k] = clone(x)
    return out
  }
  return v
}

/** One field: the stored value if it is valid for its row, else `fallback`. */
function field(row: Row, raw: unknown, fallback: unknown): unknown {
  if (row.nullable && raw === null) return null
  const invalid = row.nullable ? null : fallback

  switch (row.kind) {
    case 'string':
      if (typeof raw !== 'string' || (row.nonEmpty && raw.length === 0)) return invalid
      return raw

    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return invalid
      const lo = row.min ?? -Infinity
      const hi = row.max ?? Infinity
      const v = raw < lo ? lo : raw > hi ? hi : raw
      return row.int ? Math.round(v) : v
    }

    case 'boolean':
      return typeof raw === 'boolean' ? raw : invalid

    case 'enum':
      return typeof raw === 'string' && (row.values ?? []).includes(raw) ? raw : invalid

    case 'object': {
      if (!isPlainObject(raw) || (row.accept && !row.accept(raw))) return invalid
      // A field whose default is an object normalises against that object; one
      // whose default is null (the photo) against its own template.
      const template = isPlainObject(fallback) ? fallback : row.template?.()
      if (!template) return invalid
      return object(row.fields ?? [], raw, template)
    }

    case 'array': {
      if (!Array.isArray(raw)) return invalid
      // An item that is not an object is not a layer (or box) at all; dropping
      // it loses nothing. A real item is never dropped, however broken.
      const items = raw
        .filter(isPlainObject)
        .map((item) => object(row.fields ?? [], item, row.template?.() ?? {}))
      if (items.length < (row.minItems ?? 0)) return invalid
      if (row.uniqueId) {
        const seen = new Set<unknown>()
        for (const item of items) {
          if (seen.has(item.id)) item.id = row.uniqueId()
          seen.add(item.id)
        }
      }
      return items
    }

    case 'custom':
      return row.normalize ? row.normalize(raw, fallback) : invalid
  }
}

/** One level: built from the schema, so unknown keys cannot get in. A field the
 *  template does not have and the store does not validly hold is left out. */
function object(rows: readonly Row[], raw: Doc, template: Doc): Doc {
  const out: Doc = {}
  for (const row of rows) {
    const v = field(row, raw[row.key], template[row.key])
    if (v !== undefined) out[row.key] = v
  }
  return out
}

export function normalizeSettings(raw: unknown, env: NormalizeEnv = {}): PrintSettings {
  const defaults = defaultSettings()
  if (!isPlainObject(raw)) return defaults
  const doc = clone(raw) as Doc
  for (const convert of CONVERSIONS) convert(doc, env)
  const s = object(SETTINGS_FIELDS, doc, defaults as unknown as Doc) as unknown as PrintSettings
  // Cross-field invariant, once every field is valid on its own: the photo
  // covers the sheet. A pan that was legal on another sheet shape is pulled
  // back to the nearest placement that leaves no bare strip.
  if (s.media) s.media = clampPan(s.media, ASPECTS[s.aspect], 1)
  return s
}
