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
import { INK_IDS, LAYER_FIELDS, SETTINGS_FIELDS, acceptMedia, type Row } from './fields.ts'

export interface NormalizeEnv {
  /** Measures text as the renderer will draw it. Absent outside a browser. */
  measure?: FontMeasure
}

type Doc = Record<string, unknown>

/** A conversion edits the stored copy in place, before the walk. */
type Conversion = (doc: Doc, env: NormalizeEnv) => void

const isPlainObject = (v: unknown): v is Doc =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * How many words the build that had boxes numbered in this text: runs of
 * anything but a space or a tab, line by line, counted on across lines from
 * 0 (8d17b48's `placeLine`). The caps conversion runs first and changes no
 * whitespace, so the count is the one the box was drawn against.
 */
function wordCount(text: unknown): number {
  if (typeof text !== 'string') return 0
  let n = 0
  for (const line of text.split('\n')) {
    let inWord = false
    for (const ch of line) {
      if (ch === ' ' || ch === '\t') inWord = false
      else if (!inWord) {
        inWord = true
        n++
      }
    }
  }
  return n
}

/** The stored layers that are objects — the only ones the walk will keep. */
const layersOf = (doc: Doc): Doc[] => (Array.isArray(doc.layers) ? doc.layers.filter(isPlainObject) : [])

/** The sheet's width over its height, as the walk will resolve the aspect. */
function sheetAspect(doc: Doc): number {
  const key = doc.aspect
  // hasOwnProperty, not `in`: 'toString' is "in" every object.
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(ASPECTS, key)
    ? ASPECTS[key as keyof typeof ASPECTS]
    : ASPECTS[defaultSettings().aspect]
}

/**
 * Run in this order. A removed field with a replacement is converted here; a
 * removed field with none (the printed photo's ink, contrast and lift, its
 * opacity, the photo's own press, word spacing, justify-by, lines-of-one-word,
 * the typewriter, per-word misprints, plate opacity, box padding and corner
 * radius, dot shape and softness, Midtones, the detail-scaling switch, roughen
 * scale, streaks, smear, patches, banding, paper tooth and cloud) is simply not
 * in the schema, so it goes.
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

  // Opaque first, then boxes, because the box conversion decides between the
  // two when both claim a plate.
  //
  // Opaque ("print over the photo") painted the ink over a dark photo. The
  // same result the riso way is the plate's own ink as its second ink: the
  // photo is cut back to paper wherever it is darker than the ink, and the ink
  // stays transparent. Only with a photo, where opaque did anything, and only
  // where no second ink was already chosen.
  function opaque(doc) {
    const photo = isPlainObject(doc.media) && acceptMedia(doc.media)
    for (const l of layersOf(doc)) {
      if (l.opaque === true && photo && (l.contrastInkId === null || l.contrastInkId === undefined)) {
        l.contrastInkId = l.inkId
      }
      delete l.opaque
    }
  },

  // Word-picked boxes become one per-line backing in the ink of the first box
  // that printed. A plate takes a backing or a second ink, never both, and a
  // box was an explicit act where the second ink may only have been seeded, so
  // the backing wins.
  //
  // "Printed" is the old renderer's own test: a box behind at least one word
  // the text still has, not hidden by its opacity, on a plate not hidden by
  // ITS opacity (`opacity <= 0` skipped either, coercions and all). A box that
  // never reached the sheet becomes nothing: turning it into a backing would
  // print a block the saved print never had, and take the plate's second ink
  // away for it.
  function boxes(doc) {
    const hidden = (opacity: unknown) => Number(opacity) <= 0
    for (const l of layersOf(doc)) {
      if (Array.isArray(l.boxes) && !('backing' in l)) {
        const count = wordCount(l.text)
        // The old renderer drew a box behind a placed word only if the box
        // held that word's number (`Set.has`, so a number, exactly). Word
        // numbers never followed text edits, so a box can hold only numbers
        // the text no longer has, and then it printed nothing.
        const printsAWord = (words: unknown) =>
          Array.isArray(words) && words.some((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < count)
        const first = hidden(l.opacity)
          ? undefined
          : (l.boxes.find((b: unknown) => isPlainObject(b) && printsAWord(b.words) && !hidden(b.opacity)) as
              | Doc
              | undefined)
        // A box in an ink no build knows is no backing (the field's default),
        // and then it does not displace the plate's second ink either.
        if (first && typeof first.inkId === 'string' && INK_IDS.includes(first.inkId)) {
          l.backing = first.inkId
          l.contrastInkId = null
        }
      }
      delete l.boxes
    }
  },

  // The press: four screening methods become two, and six wear and edge
  // controls become two amounts.
  function press(doc) {
    const p = doc.press
    if (!isPlainObject(p)) return
    // Woodcut and scribble are relief printing and pen hatching, not riso: the
    // halftone. Any dither becomes the one grain, with its cell carried over
    // as a screen size (the grain cell is a third of it), so the texture's
    // scale survives — for every cell the old slider could set, 1..12; the
    // walk clamps anything else into the screen size's range.
    if (p.method === 'woodcut' || p.method === 'scribble') p.method = 'halftone'
    else if (p.method === 'dither') {
      p.method = 'grain'
      p.screenPitch = (finiteNumber(p.ditherScale) ? p.ditherScale : 3) * 3
    }
    // Edge was tear (+ bleed), Wear was mottle (+ dropout): each new amount is
    // the old lead value, and the engine derives its partner at the shipped
    // ratio, so a default press converts to exactly the same edge and film.
    if (!('edge' in p) && finiteNumber(p.roughness)) p.edge = p.roughness
    if (!('wear' in p) && finiteNumber(p.mottle)) p.wear = p.mottle
  },
]

/** Deep copy of plain data, so a conversion can never edit what was passed in.
 *  A stored "__proto__" key is data, not a prototype: assigning it would give
 *  the copy an inherited field the walk could then read, so it is skipped. */
function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone)
  if (isPlainObject(v)) {
    const out: Doc = {}
    for (const [k, x] of Object.entries(v)) if (k !== '__proto__') out[k] = clone(x)
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
      if (row.positive && raw <= 0) return invalid
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
      // An item that is not an object is not a layer at all; dropping it loses
      // nothing. A real item is never dropped, however broken.
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
  }
}

/** One level: built from the schema, so unknown keys cannot get in. A field the
 *  template does not have (an `optional` row) and the store does not validly
 *  hold is left out. */
function object(rows: readonly Row[], raw: Doc, template: Doc): Doc {
  const out: Doc = {}
  for (const row of rows) {
    const v = field(row, raw[row.key], row.optional ? undefined : template[row.key])
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
  // Cross-field invariants, once every field is valid on its own. The photo
  // covers the sheet: a pan that was legal on another sheet shape is pulled
  // back to the nearest placement that leaves no bare strip. And a plate has a
  // backing or a second ink, never both; the backing wins, as above.
  if (s.media) s.media = clampPan(s.media, ASPECTS[s.aspect], 1)
  for (const l of s.layers) if (l.backing && l.contrastInkId) l.contrastInkId = null
  return s
}
