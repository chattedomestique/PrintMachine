/**
 * The normaliser, row by row and against the frozen legacy documents.
 *
 * Two promises are tested, because each is easy to keep by breaking the other:
 * nothing the current model does not have survives a load, and no valid value
 * a person saved is lost.
 */

import { describe, expect, it } from 'vitest'

import defaultDoc from './__fixtures__/legacy-default.json'
import garbage from './__fixtures__/legacy-garbage.json'
import maximal from './__fixtures__/legacy-maximal.json'
import photoSecondInk from './__fixtures__/legacy-photo-second-ink.json'
import preSplit from './__fixtures__/legacy-pre-split.json'
import unknownIds from './__fixtures__/legacy-unknown-ids.json'
import { defaultSettings, makeLayer, makeMedia } from './defaults.ts'
import {
  BOX_FIELDS,
  LAYER_FIELDS,
  MEDIA_FIELDS,
  PRESS_FIELDS,
  SETTINGS_FIELDS,
  boxTemplate,
  mediaTemplate,
  type Row,
} from './fields.ts'
import { normalizeSettings } from './normalize.ts'
import { fitSize, layoutText, type FontMeasure } from '../engine/text.ts'
import { SIZE_MAX } from '../engine/limits.ts'
import { ASPECTS, type PrintSettings } from '../engine/types.ts'

type Doc = Record<string, unknown>

const FIXTURES: Record<string, unknown> = {
  'legacy-default': defaultDoc,
  'legacy-maximal': maximal,
  'legacy-pre-split': preSplit,
  'legacy-photo-second-ink': photoSecondInk,
  'legacy-unknown-ids': unknownIds,
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const keys = (o: object) => Object.keys(o).sort()

/** Layer ids are minted fresh for a default document, so compare without them. */
const withoutIds = (s: PrintSettings) => ({ ...s, layers: s.layers.map((l) => ({ ...l, id: '' })) })

/**
 * Recursive key-set equality, each level against ITS OWN template: the
 * defaults at the top and for both presses, `makeLayer()` for every stored
 * layer (a document can hold more layers than the default has), and the media
 * template for the photo (whose default is null, so the defaults alone cannot
 * check it).
 */
function expectNoExtraKeys(s: PrintSettings) {
  const d = defaultSettings()
  expect(keys(s)).toEqual(keys(d))
  expect(keys(s.press)).toEqual(keys(d.press))
  for (const l of s.layers) {
    expect(keys(l)).toEqual(keys(makeLayer()))
    for (const b of l.boxes) expect(keys(b)).toEqual(keys(boxTemplate()))
    for (const over of Object.values(l.wordPress)) {
      for (const k of Object.keys(over)) expect(['bleed', 'offset']).toContain(k)
    }
  }
  if (s.media) expect(keys(s.media)).toEqual(keys(makeMedia({ id: 'x', width: 1, height: 1 })))
}

describe('the schema matches the model', () => {
  it('lists exactly the fields of each template, at every level', () => {
    const d = defaultSettings()
    const names = (rows: readonly Row[]) => rows.map((r) => r.key).sort()
    expect(names(SETTINGS_FIELDS)).toEqual(keys(d))
    expect(names(PRESS_FIELDS)).toEqual(keys(d.press))
    expect(names(LAYER_FIELDS)).toEqual(keys(makeLayer()))
    expect(names(MEDIA_FIELDS)).toEqual(keys(mediaTemplate()))
    expect(names(BOX_FIELDS)).toEqual(keys(boxTemplate()))
  })

  it('accepts every default as valid — normalising the defaults changes nothing', () => {
    const d = defaultSettings()
    expect(normalizeSettings(copy(d))).toEqual(d)
  })
})

/* ── Every schema row: valid, wrong type, out of range, unknown, null ─────── */

/** A document in which every row is reachable: a photo and a box. */
function reachable(): Doc {
  const d = copy(defaultSettings()) as unknown as Doc
  // Zoomed, so the photo can travel on both axes and a valid position is not
  // pulled back by the cover rule.
  d.media = makeMedia({ id: 'photo', width: 4032, height: 3024, scale: 4 })
  const layers = d.layers as Doc[]
  layers[0].boxes = [{ id: 'box-1', words: [0], inkId: 'yellow', opacity: 1 }]
  return d
}

type Path = (string | number)[]
const get = (o: unknown, path: Path): unknown =>
  path.reduce<unknown>((v, k) => (v as Record<string | number, unknown> | null)?.[k], o)
function set(o: Doc, path: Path, value: unknown) {
  const parent = get(o, path.slice(0, -1)) as Record<string | number, unknown>
  parent[path[path.length - 1]] = value
}

const LEVELS: { name: string; path: Path; rows: readonly Row[] }[] = [
  { name: 'settings', path: [], rows: SETTINGS_FIELDS },
  { name: 'press', path: ['press'], rows: PRESS_FIELDS },
  { name: 'media', path: ['media'], rows: MEDIA_FIELDS },
  { name: 'layer', path: ['layers', 0], rows: LAYER_FIELDS },
  { name: 'box', path: ['layers', 0, 'boxes', 0], rows: BOX_FIELDS },
]

/** Fields a photo is refused without: an invalid one drops the whole photo. */
const MEDIA_IDENTITY = new Set(['id', 'width', 'height'])

/** A valid value for the row that differs from what the base document holds. */
function validValue(row: Row, current: unknown): unknown {
  switch (row.kind) {
    case 'number': {
      const lo = row.min ?? 0
      const hi = row.max ?? 1
      for (const t of [0.37, 0.61, 0.13]) {
        const v = row.int ? Math.round(lo + (hi - lo) * t) : lo + (hi - lo) * t
        if (v !== current) return v
      }
      throw new Error(`no distinct value for ${row.key}`)
    }
    case 'boolean':
      return !current
    case 'enum': {
      const v = (row.values ?? []).find((x) => x !== current)
      if (v === undefined) throw new Error(`enum ${row.key} has one member`)
      return v
    }
    case 'string':
      return `kept-${row.key}`
    default:
      throw new Error(`no generic valid value for ${row.kind}`)
  }
}

describe('every schema row', () => {
  for (const level of LEVELS) {
    for (const row of level.rows) {
      if (!['number', 'boolean', 'enum', 'string'].includes(row.kind)) continue
      const path = [...level.path, row.key]
      const name = `${level.name}.${row.key}`
      const isMediaIdentity = level.name === 'media' && MEDIA_IDENTITY.has(row.key)
      const isId = row.key === 'id' && level.name !== 'media'

      // What an invalid value must turn into.
      const expectInvalid = (raw: unknown) => {
        const doc = reachable()
        const before = get(normalizeSettings(copy(doc)), path)
        set(doc, path, raw)
        const out = normalizeSettings(doc)
        if (isMediaIdentity) expect(out.media).toBeNull()
        else if (isId) {
          expect(typeof get(out, path)).toBe('string')
          expect((get(out, path) as string).length).toBeGreaterThan(0)
        } else if (row.nullable) expect(get(out, path)).toBeNull()
        else expect(get(out, path)).toEqual(row.kind === 'string' ? before : get(defaultsFor(level.name), [row.key]))
      }

      it(`${name}: keeps a valid value`, () => {
        const doc = reachable()
        const v = validValue(row, get(doc, path))
        set(doc, path, v)
        expect(get(normalizeSettings(doc), path)).toEqual(v)
      })

      it(`${name}: a value of the wrong type is ${row.nullable ? 'null' : 'the default'}`, () => {
        expectInvalid(row.kind === 'number' ? 'twelve' : row.kind === 'boolean' ? 'yes' : 42)
        expectInvalid(undefined)
        expectInvalid({})
      })

      if (row.kind === 'number' && row.min !== undefined && row.max !== undefined) {
        it(`${name}: is clamped into [${row.min}, ${row.max}], and non-finite is the default`, () => {
          const lo = row.min ?? -Infinity
          const hi = row.max ?? Infinity
          const below = isMediaIdentity ? lo / 2 : lo - 1
          for (const [raw, want] of [
            [below, lo],
            [hi + 1, hi],
          ] as const) {
            const doc = reachable()
            set(doc, path, raw)
            expect(get(normalizeSettings(doc), path)).toBe(want)
          }
          expectInvalid(Infinity)
          expectInvalid(NaN)
        })
      }

      if (row.kind === 'enum') {
        it(`${name}: an unknown value is ${row.nullable ? 'null' : 'the default'}`, () => {
          expectInvalid('not-a-member')
        })
      }

      if (row.nullable) {
        it(`${name}: null stays null, and a valid member stays`, () => {
          const doc = reachable()
          set(doc, path, null)
          expect(get(normalizeSettings(doc), path)).toBeNull()
          const member = (row.values ?? [])[3]
          set(doc, path, member)
          expect(get(normalizeSettings(doc), path)).toBe(member)
        })
      }
    }
  }
})

/** The default a row's level falls back to (the template of that level). */
function defaultsFor(level: string): Doc {
  const d = defaultSettings() as unknown as Doc
  switch (level) {
    case 'settings':
      return d
    case 'press':
      return d.press as Doc
    case 'media':
      return mediaTemplate()
    case 'layer':
      return makeLayer() as unknown as Doc
    case 'box':
      return boxTemplate()
  }
  throw new Error(level)
}

describe('structured fields', () => {
  it('a press that is not an object is the default press, and its unknown keys go', () => {
    const doc = reachable()
    doc.press = 7
    expect(normalizeSettings(doc).press).toEqual(defaultSettings().press)
    const extra = reachable()
    ;(extra.press as Doc).carveDepth = 3
    expect(normalizeSettings(extra).press).not.toHaveProperty('carveDepth')
  })

  it('never drops a layer, and replaces a layers field that holds none', () => {
    const four = reachable()
    four.layers = [makeLayer(), makeLayer(), makeLayer(), makeLayer({ text: '' })]
    expect(normalizeSettings(four).layers).toHaveLength(4)
    // An empty text is a plate not typed into yet, not an invalid one.
    expect(normalizeSettings(four).layers[3].text).toBe('')

    for (const bad of ['x', [], null, [null, 5, 'layer']]) {
      const doc = reachable()
      doc.layers = bad
      expect(withoutIds(normalizeSettings(doc)).layers).toEqual(withoutIds(defaultSettings()).layers)
    }
  })

  it('skips items that are not layers at all, and keeps the real ones', () => {
    const doc = reachable()
    doc.layers = [null, makeLayer({ text: 'ONE' }), 'two', makeLayer({ text: 'THREE' })]
    expect(normalizeSettings(doc).layers.map((l) => l.text)).toEqual(['ONE', 'THREE'])
  })

  it('makes duplicate layer ids unique, keeping the first', () => {
    const doc = reachable()
    doc.layers = [makeLayer({ id: 'same' }), makeLayer({ id: 'same' }), makeLayer({ id: '' })]
    const ids = normalizeSettings(doc).layers.map((l) => l.id)
    expect(ids[0]).toBe('same')
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })

  it('per-word overrides keep valid word indices and clamp their deltas', () => {
    const doc = reachable()
    ;(doc.layers as Doc[])[0].wordPress = {
      '0': { bleed: 0.2 },
      '3': { offset: 99, colour: 'red' },
      '-1': { bleed: 0.1 },
      x: { bleed: 0.1 },
      '4': 'loud',
      '5': { bleed: 0, offset: 0 },
    }
    expect(normalizeSettings(doc).layers[0].wordPress).toEqual({ '0': { bleed: 0.2 }, '3': { offset: 30 } })
  })

  it('box words are whole, non-negative and each listed once', () => {
    const doc = reachable()
    ;(doc.layers as Doc[])[0].boxes = [{ id: 'b', words: [3, 1, 1, -2, 1.5, 'x'], inkId: 'blue', opacity: 2 }]
    expect(normalizeSettings(doc).layers[0].boxes).toEqual([{ id: 'b', words: [1, 3], inkId: 'blue', opacity: 1 }])
  })

  it('drops a photo with no id or no real size, and keeps one that has them', () => {
    for (const media of [{ id: '', width: 10, height: 10 }, { id: 'm', width: 0, height: 10 }, { width: 10, height: 10 }, 'photo']) {
      const doc = reachable()
      doc.media = media
      expect(normalizeSettings(doc).media).toBeNull()
    }
    const doc = reachable()
    doc.media = { id: 'm', width: 300, height: 200 }
    expect(normalizeSettings(doc).media).toEqual(makeMedia({ id: 'm', width: 300, height: 200 }))
  })

  it('a dither that passed the tone straight through is gone; it dithers', () => {
    const doc = reachable()
    ;(doc.press as Doc).ditherType = 'none'
    expect(normalizeSettings(doc).press.ditherType).toBe(defaultSettings().press.ditherType)
  })
})

/* ── The frozen documents ─────────────────────────────────────────────── */

describe('legacy documents', () => {
  for (const [name, doc] of Object.entries(FIXTURES)) {
    it(`${name}: opens, with no key the model does not have`, () => {
      const s = normalizeSettings(copy(doc))
      expect(s.layers.length).toBeGreaterThan(0)
      expectNoExtraKeys(s)
    })

    it(`${name}: normalising twice is the same as once`, () => {
      const once = normalizeSettings(copy(doc))
      expect(normalizeSettings(copy(once))).toEqual(once)
    })
  }

  it('legacy-garbage: every corrupt document opens as exactly the defaults', () => {
    for (const doc of garbage as unknown[]) {
      const s = normalizeSettings(copy(doc))
      expect(withoutIds(s)).toEqual(withoutIds(defaultSettings()))
      expect(normalizeSettings(copy(s))).toEqual(s)
    }
  })

  it('no valid stored value is lost: every field that still exists keeps what was saved', () => {
    // Checked field by field against the raw fixture, for every field the
    // current schema has and the fixture holds a valid value for — except the
    // ones a named conversion or the cover rule rewrites, which the verdict
    // table below checks one by one.
    const REWRITTEN: Record<string, readonly string[]> = {
      settings: [],
      press: [],
      media: ['scale', 'x', 'y'],
      // caps uppercases the text, Rounded becomes Grotesk, and a fitted
      // layer's size is re-measured (only with a measure; none here).
      layer: ['text', 'fontId', 'size'],
    }
    const levels = (raw: Doc, out: Doc) => [
      { level: 'settings', raw, out, rows: SETTINGS_FIELDS },
      { level: 'press', raw: raw.press as Doc, out: out.press as Doc, rows: PRESS_FIELDS },
      ...(raw.media ? [{ level: 'media', raw: raw.media as Doc, out: out.media as Doc, rows: MEDIA_FIELDS }] : []),
      ...(raw.layers as Doc[]).map((l, i) => ({
        level: 'layer',
        raw: l,
        out: (out.layers as Doc[])[i],
        rows: LAYER_FIELDS,
      })),
    ]
    let checked = 0
    for (const doc of [defaultDoc, maximal, photoSecondInk, preSplit]) {
      const raw = copy(doc) as unknown as Doc
      const out = normalizeSettings(copy(doc)) as unknown as Doc
      for (const { level, raw: r, out: o, rows } of levels(raw, out)) {
        if (!r || typeof r !== 'object') continue
        for (const row of rows) {
          if (!(row.key in r) || REWRITTEN[level].includes(row.key)) continue
          if (row.kind === 'object' || row.kind === 'array') continue
          expect({ at: `${level}.${row.key}`, v: o[row.key] }).toEqual({ at: `${level}.${row.key}`, v: r[row.key] })
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('every fixture with a photo keeps exactly the placement keys; the others have none', () => {
    for (const doc of [maximal, photoSecondInk, unknownIds]) {
      expect(keys(normalizeSettings(copy(doc)).media!)).toEqual(['height', 'id', 'scale', 'width', 'x', 'y'])
    }
    for (const doc of [defaultDoc, preSplit, ...(garbage as unknown[])]) {
      expect(normalizeSettings(copy(doc)).media).toBeNull()
    }
  })

  it('legacy-photo-second-ink: every layer keeps its chosen second ink', () => {
    const s = normalizeSettings(copy(photoSecondInk))
    expect(s.layers.map((l) => l.contrastInkId)).toEqual(['yellow', 'midnight'])
    expect(s.media?.id).toBe('media-legacy-photo')
  })

  it('legacy-unknown-ids: unknown ink, face and paper become the field defaults', () => {
    const s = normalizeSettings(copy(unknownIds))
    const layer = makeLayer()
    expect(s.layers[0].inkId).toBe(layer.inkId)
    expect(s.layers[0].fontId).toBe(layer.fontId)
    expect(s.layers[0].contrastInkId).toBeNull()
    expect(s.paperId).toBe(defaultSettings().paperId)
    // ...while the valid ones beside them stay.
    expect(s.layers[1].inkId).toBe('blue')
    expect(s.layers[1].fontId).toBe('serif')
  })

  it('legacy-unknown-ids: extra keys on the photo go, and the photo stays', () => {
    const s = normalizeSettings(copy(unknownIds))
    expect(s.media).not.toBeNull()
    expect(s.media?.id).toBe('media-legacy-unknown')
    expect(keys(s.media!)).toEqual(keys(mediaTemplate()))
  })

  it('legacy-pre-split: opens with the default press (the lift is retired)', () => {
    const s = normalizeSettings(copy(preSplit))
    expect(s.press).toEqual(defaultSettings().press)
    expect(s).not.toHaveProperty('screenPitch')
  })
})

/* ── Verdict §4.1, one row per line ───────────────────────────────────── */

/**
 * The verdict's persistence table, as tests: each row a stored shape and what
 * it becomes. Rows arrive with the commit that removes their field.
 */
describe('verdict §4.1: what each removed field becomes', () => {
  const max = () => normalizeSettings(copy(maximal))
  const rawMax = maximal as unknown as Doc

  it('media.printed, inkId, contrast, lift, opacity: dropped — the photo shows as shot', () => {
    const raw = rawMax.media as Doc
    expect(raw.printed).toBe(true)
    const m = max().media as unknown as Doc
    for (const k of ['printed', 'inkId', 'contrast', 'lift', 'opacity']) expect(m).not.toHaveProperty(k)
    expect(m.id).toBe(raw.id)
  })

  it('media.scale below 1: 1, and the centre is pulled inside the cover travel', () => {
    expect((rawMax.media as Doc).scale).toBe(0.5)
    const m = max().media!
    expect(m.scale).toBe(1)
    // 4032x3024 on a 3:4 sheet at zoom 1 fits the height exactly: no vertical
    // travel, so the stored 0.62 comes back to the middle; 0.4 across is legal.
    expect(m.y).toBe(0.5)
    expect(m.x).toBe(0.4)
  })

  it('photoPress: dropped', () => {
    expect(rawMax).toHaveProperty('photoPress')
    expect(max()).not.toHaveProperty('photoPress')
  })

  it('paperAmount: the paper veil switch, on above one half', () => {
    expect(rawMax.paperAmount).toBe(0.3)
    expect(max().paperVeil).toBe(false)
    expect(max()).not.toHaveProperty('paperAmount')
    for (const [amount, veil] of [
      [1, true],
      [0.51, true],
      [0.5, false],
      [0, false],
      [undefined, true],
      ['lots', true],
    ] as const) {
      const doc = copy(defaultDoc) as unknown as Doc
      delete doc.paperVeil
      doc.paperAmount = amount
      expect(normalizeSettings(doc).paperVeil).toBe(veil)
    }
  })

  /* ── Type (1.3) ── */

  const stub: FontMeasure = (font, text) => 0.55 * font.px * [...text].length
  const maxWith = () => normalizeSettings(copy(maximal), { measure: stub })
  const rawLayers = rawMax.layers as Doc[]

  it('layer.caps: true — the text is uppercased once, whitespace unchanged', () => {
    expect(rawLayers[0].caps).toBe(true)
    expect(rawLayers[0].text).toBe('Print\nmachine')
    expect(max().layers[0].text).toBe('PRINT\nMACHINE')
    // caps false: the text stays exactly as typed.
    expect(rawLayers[3].caps).toBe(false)
    expect(max().layers[3].text).toBe('lowercase words')
  })

  it('layer.weight: Bold at 600 and above, regular below', () => {
    expect(rawLayers.map((l) => l.weight)).toEqual([300, 700, 600, 300])
    expect(max().layers.map((l) => l.bold)).toEqual([false, true, true, false])
  })

  it("layer.fontId 'rounded': Grotesk; the other faces stay", () => {
    expect(rawLayers.map((l) => l.fontId)).toEqual(['rounded', 'serif', 'mono', 'rounded'])
    expect(max().layers.map((l) => l.fontId)).toEqual(['grotesk', 'serif', 'mono', 'grotesk'])
  })

  it('layer.fitWidth: true — the fitted size, measured once on the converted layer', () => {
    const s = maxWith()
    const aspect = ASPECTS[s.aspect]
    for (const i of [0, 2, 3]) {
      expect(rawLayers[i].fitWidth).toBe(true)
      // fitSize of the layer as it now draws: after the case, face and weight
      // conversions, with nothing of the removed fields.
      expect(s.layers[i].size).toBeCloseTo(fitSize(s.layers[i], aspect, stub), 9)
    }
    // An unfitted layer keeps its size.
    expect(rawLayers[1].fitWidth).toBe(false)
    expect(s.layers[1].size).toBe(rawLayers[1].size)
  })

  it('the conversion order: case, face and weight are converted BEFORE the fit measures', () => {
    // Layer 4: caps off, lowercase, Rounded, weight 300, word spacing 0.5,
    // fitted. It converts to lowercase Grotesk regular, and its widest line —
    // measured through the converted layer — spans 0.92 of the sheet's width.
    const s = maxWith()
    const l = s.layers[3]
    expect([l.text, l.fontId, l.bold]).toEqual(['lowercase words', 'grotesk', false])
    const h = 1000
    const w = layoutText(l, h, (text, px) => stub({ stack: '', weight: 400, px }, text)).widest
    expect(w).toBeCloseTo(0.92 * ASPECTS[s.aspect] * h, 6)

    // A measure that can tell the difference: capitals and bold are wider, and
    // the Rounded stack measures as nothing at all. If the fit ran before any
    // of the other conversions it would measure the wrong text or face.
    const sensitive: FontMeasure = (font, text) => {
      if (font.stack.startsWith('ui-rounded')) return NaN
      const k = font.weight === 700 ? 1.1 : 1
      return font.px * k * [...text].reduce((a, ch) => a + (ch !== ch.toLowerCase() ? 0.7 : 0.5), 0)
    }
    const t = normalizeSettings(copy(maximal), { measure: sensitive })
    const aspect = ASPECTS[t.aspect]
    // caps first: the fit is of 'PRINT\nMACHINE', not of 'Print\nmachine'.
    expect(t.layers[0].size).toBeCloseTo(fitSize(t.layers[0], aspect, sensitive), 9)
    expect(t.layers[0].size).not.toBeCloseTo(fitSize({ ...t.layers[0], text: 'Print\nmachine' }, aspect, sensitive), 3)
    // weight first: layer 3 (weight 600) is measured bold.
    expect(t.layers[2].size).toBeCloseTo(fitSize(t.layers[2], aspect, sensitive), 9)
    expect(t.layers[2].size).not.toBeCloseTo(fitSize({ ...t.layers[2], bold: false }, aspect, sensitive), 3)
    // face first: layer 4 was Rounded, which this measure cannot measure.
    expect(Number.isFinite(t.layers[3].size)).toBe(true)
    expect(t.layers[3].size).toBeCloseTo(fitSize(t.layers[3], aspect, sensitive), 9)
  })

  it('layer.fitWidth without a measure (not in a browser): the stored size stays', () => {
    expect(max().layers[0].size).toBe(rawLayers[0].size)
  })

  it('layer.fitWidth: a fit above SIZE_MAX is stored at SIZE_MAX (the one size that shrinks)', () => {
    // The old fit was unclamped. One glyph on a square sheet fits at about
    // 1.67; it is stored at the ceiling and prints smaller than it did.
    const doc = copy(defaultDoc) as unknown as Doc
    doc.aspect = '1:1'
    ;(doc.layers as Doc[])[0] = { ...(doc.layers as Doc[])[0], text: 'A', fitWidth: true }
    expect(normalizeSettings(doc, { measure: stub }).layers[0].size).toBe(SIZE_MAX)
  })

  it('layer.typewriter, wordSpacing, justifyBy, soloAlign: dropped', () => {
    expect(rawLayers[0].typewriter).not.toBeNull()
    for (const l of maxWith().layers) {
      for (const k of ['typewriter', 'wordSpacing', 'justifyBy', 'soloAlign', 'caps', 'weight', 'fitWidth']) {
        expect(l).not.toHaveProperty(k)
      }
    }
  })
})
