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

import type { PrintSettings } from '../engine/types.ts'
import type { FontMeasure } from '../engine/text.ts'
import { defaultSettings } from './defaults.ts'
import { SETTINGS_FIELDS, type Row } from './fields.ts'

export interface NormalizeEnv {
  /** Measures text as the renderer will draw it. Absent outside a browser. */
  measure?: FontMeasure
}

type Doc = Record<string, unknown>

/** A conversion edits the stored copy in place, before the walk. */
type Conversion = (doc: Doc, env: NormalizeEnv) => void

/** Run in this order. Empty until a build removes a field that has a
 *  replacement; a removed field with none is simply not in the schema. */
const CONVERSIONS: readonly Conversion[] = []

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
      // whose default is null (a photo, a typewriter) against its own template.
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
  return object(SETTINGS_FIELDS, doc, defaults as unknown as Doc) as unknown as PrintSettings
}
