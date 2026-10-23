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
  LAYER_FIELDS,
  MEDIA_FIELDS,
  PRESS_FIELDS,
  SETTINGS_FIELDS,
  mediaTemplate,
  type Row,
} from './fields.ts'
import { normalizeSettings } from './normalize.ts'
import { fitSize, layoutText, type FontMeasure } from '../engine/text.ts'
import { SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX } from '../engine/limits.ts'
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
  }
  if (s.media) {
    const optional = MEDIA_FIELDS.filter((r) => r.optional).map((r) => r.key)
    expect(keys(s.media).filter((k) => !optional.includes(k))).toEqual(keys(makeMedia({ id: 'x', width: 1, height: 1 })))
  }
}

describe('the model is locked', () => {
  it('the press has exactly its six fields', () => {
    expect(keys(defaultSettings().press)).toEqual(['density', 'edge', 'method', 'misregistration', 'screenPitch', 'wear'])
  })

  it('a plate has exactly the fields of the model', () => {
    expect(keys(makeLayer())).toEqual(
      [
        'id',
        'text',
        'inkId',
        'fontId',
        'bold',
        'size',
        'lineHeight',
        'tracking',
        'rotation',
        'align',
        'x',
        'y',
        'contrastInkId',
        'contrastThreshold',
        'backing',
      ].sort(),
    )
  })

  it('a photo has exactly its placement (and one optional flag), and the document its seven fields', () => {
    expect(keys(makeMedia({ id: 'm', width: 1, height: 1 }))).toEqual(['height', 'id', 'scale', 'width', 'x', 'y'])
    // `native` marks a photo stored as imported; its absence marks an older
    // build's 2048 px copy, so no template may fill it in.
    expect(MEDIA_FIELDS.filter((r) => r.optional).map((r) => r.key)).toEqual(['native'])
    expect(keys(defaultSettings())).toEqual(['aspect', 'layers', 'media', 'paperId', 'paperVeil', 'press', 'seed'])
  })
})

describe('the schema matches the model', () => {
  it('lists exactly the fields of each template, at every level', () => {
    const d = defaultSettings()
    // Optional rows are the fields a template deliberately does not carry.
    const names = (rows: readonly Row[]) => rows.filter((r) => !r.optional).map((r) => r.key).sort()
    expect(names(SETTINGS_FIELDS)).toEqual(keys(d))
    expect(names(PRESS_FIELDS)).toEqual(keys(d.press))
    expect(names(LAYER_FIELDS)).toEqual(keys(makeLayer()))
    expect(names(MEDIA_FIELDS)).toEqual(keys(mediaTemplate()))
  })

  it('accepts every default as valid — normalising the defaults changes nothing', () => {
    const d = defaultSettings()
    expect(normalizeSettings(copy(d))).toEqual(d)
  })
})

/* ── Every schema row: valid, wrong type, out of range, unknown, null ─────── */

/** A document in which every row is reachable: one with a photo. */
function reachable(): Doc {
  const d = copy(defaultSettings()) as unknown as Doc
  // Zoomed, so the photo can travel on both axes and a valid position is not
  // pulled back by the cover rule.
  d.media = makeMedia({ id: 'photo', width: 4032, height: 3024, scale: 4 })
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
          // Below the floor but still a value: a photo's size and a type size
          // refuse zero and less outright (tested on their own rows).
          const below = isMediaIdentity || row.positive ? lo / 2 : lo - 1
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

  it('treats a stored "__proto__" key as data: nothing is inherited from it', () => {
    const doc = JSON.parse(
      '{"layers":[{"__proto__":{"caps":true,"text":"from the prototype","backing":"yellow"},"text":"kept"}],' +
        '"__proto__":{"seed":7}}',
    )
    const s = normalizeSettings(doc)
    expect(s.layers[0].text).toBe('kept')
    expect(s.layers[0].backing).toBeNull()
    expect(s.seed).toBe(defaultSettings().seed)
    expect(({} as Record<string, unknown>).caps).toBeUndefined()
  })

  it('keeps a photo\'s native flag when stored, and never invents one', () => {
    const doc = reachable()
    ;(doc.media as Doc).native = true
    expect(normalizeSettings(doc).media?.native).toBe(true)
    for (const bad of [undefined, 'yes', 1, null]) {
      const d = reachable()
      ;(d.media as Doc).native = bad
      expect(normalizeSettings(d).media).not.toHaveProperty('native')
    }
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
      // A dither's cell becomes the grain's screen size.
      press: ['method', 'screenPitch'],
      media: ['scale', 'x', 'y'],
      // caps uppercases the text, Rounded becomes Grotesk, and a fitted
      // layer's size is re-measured (only with a measure; none here); opaque
      // and worded boxes decide the second ink.
      layer: ['text', 'fontId', 'size', 'contrastInkId'],
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

  it('media.opacity 0: photo opacity is cut, so a hidden photo shows, as shot', () => {
    // Stated, not fixed, like a plate at opacity 0: the old renderer drew the
    // photo at its opacity, so at 0 it was invisible; the photo is the ground
    // now and has no opacity. The README's "Saved prints keep opening" names
    // this exception.
    const d = copy(defaultDoc) as unknown as Doc
    d.media = { id: 'm', width: 300, height: 200, scale: 1, x: 0.5, y: 0.5, opacity: 0, printed: false }
    const s = normalizeSettings(d)
    expect(s.media).toEqual(makeMedia({ id: 'm', width: 300, height: 200 }))
    expect(s.media).not.toHaveProperty('opacity')
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

  it('layer.fitWidth: a short word fits past the slider and keeps that size — no shrink', () => {
    // "GO" on 4:5 fits at about 0.68 ("680%"): above the Size slider's 100%,
    // below SIZE_MAX, so it converts to exactly the unclamped fit, as it did
    // before the slider was remapped (the ceiling did not move).
    const doc = copy(defaultDoc) as unknown as Doc
    const raw = (doc.layers as Doc[])[0]
    Object.assign(raw, { text: 'GO', fitWidth: true })
    expect([doc.aspect, raw.tracking]).toEqual(['4:5', -0.02])
    const size = normalizeSettings(doc, { measure: stub }).layers[0].size
    // Stub: 0.55 em a glyph, and one tracking gap between the two.
    expect(size).toBeCloseTo((0.92 * 0.8) / (2 * 0.55 - 0.02), 12)
    expect(size).toBeGreaterThan(SIZE_SLIDER_MAX)
    expect(size).toBeLessThan(SIZE_MAX)
  })

  it('layer.fitWidth: a fit above SIZE_MAX is stored at SIZE_MAX (the one size that shrinks)', () => {
    // The old fit was unclamped. One glyph on a square sheet fits at about
    // 1.67; it is stored at the ceiling and prints smaller than it did.
    const doc = copy(defaultDoc) as unknown as Doc
    doc.aspect = '1:1'
    ;(doc.layers as Doc[])[0] = { ...(doc.layers as Doc[])[0], text: 'A', fitWidth: true }
    expect(normalizeSettings(doc, { measure: stub }).layers[0].size).toBe(SIZE_MAX)
  })

  it('layer.size: every valid saved size stays; only corrupt ones are repaired', () => {
    // The stored unit and the ceiling did not move with the Size slider's new
    // display, so a saved 0.8 still prints at 0.8 (it reads "800%" and pins
    // the thumb). Only what no build could store is repaired: past the
    // ceiling is clamped, below the floor is lifted, and zero, negative, NaN
    // or not a number is the default.
    const sized = (size: unknown) => {
      const d = copy(defaultDoc) as unknown as Doc
      Object.assign((d.layers as Doc[])[1], { size })
      return normalizeSettings(d).layers[1].size
    }
    expect(sized(0.8)).toBe(0.8)
    expect(sized(0.2)).toBe(0.2)
    expect(sized(1.5)).toBe(SIZE_MAX)
    expect(sized(0.005)).toBe(SIZE_MIN)
    for (const bad of [NaN, 0, -1, 'x', Infinity, null]) expect(sized(bad)).toBe(makeLayer().size)
    expect(makeLayer().size).toBe(0.04)
  })

  it('layer.typewriter, wordSpacing, justifyBy, soloAlign: dropped', () => {
    expect(rawLayers[0].typewriter).not.toBeNull()
    for (const l of maxWith().layers) {
      for (const k of ['typewriter', 'wordSpacing', 'justifyBy', 'soloAlign', 'caps', 'weight', 'fitWidth']) {
        expect(l).not.toHaveProperty(k)
      }
    }
  })

  /* ── Plates (1.4) ── */

  it('layer.opaque with a photo and no second ink: the plate\'s own ink as its second ink', () => {
    // Layer 1: opaque, no second ink, no worded box, and the document has a
    // photo — it keeps its colour over dark ground the riso way.
    expect([rawLayers[0].opaque, rawLayers[0].contrastInkId]).toEqual([true, null])
    expect(max().layers[0].contrastInkId).toBe(max().layers[0].inkId)
    // Layer 3: opaque with a second ink already chosen keeps the chosen one.
    expect([rawLayers[2].opaque, rawLayers[2].contrastInkId]).toEqual([true, 'white'])
    expect(max().layers[2].contrastInkId).toBe('white')
  })

  it('layer.opaque without a photo: nothing to keep it readable over, so nothing changes', () => {
    const d = copy(defaultDoc) as unknown as Doc
    ;(d.layers as Doc[])[0].opaque = true
    expect(normalizeSettings(d).layers[0].contrastInkId).toBeNull()
  })

  it('layer.boxes with words: a backing in the first worded box\'s ink, which wins over the second ink', () => {
    // Layer 2: boxes [yellow, words 1-2], [green, no words] and second ink white.
    expect(max().layers[1].backing).toBe('yellow')
    expect(max().layers[1].contrastInkId).toBeNull()
    // Layer 3: only an empty box — no backing.
    expect(max().layers[2].backing).toBeNull()
    // Layer 4: opaque AND a worded box. Opaque converts first (same-ink second
    // ink), then the box takes the plate, so it ends with the backing only.
    expect(max().layers[3].backing).toBe('blue')
    expect(max().layers[3].contrastInkId).toBeNull()
  })

  it('a box in an ink no build knows is no backing, and leaves the second ink', () => {
    const d = copy(defaultDoc) as unknown as Doc
    ;(d.layers as Doc[])[0].contrastInkId = 'black'
    ;(d.layers as Doc[])[0].boxes = [{ id: 'b', words: [0], inkId: 'ultraviolet', opacity: 1 }]
    const s = normalizeSettings(d)
    expect(s.layers[0].backing).toBeNull()
    expect(s.layers[0].contrastInkId).toBe('black')
  })

  it('a box that never printed (opacity 0, or on a plate at opacity 0) is no backing, and leaves the second ink', () => {
    // The old renderer skipped a box at `opacity <= 0` and a whole plate at
    // `opacity <= 0`, so neither box reached the sheet.
    const hiddenBox = copy(defaultDoc) as unknown as Doc
    ;(hiddenBox.layers as Doc[])[0].contrastInkId = 'white'
    ;(hiddenBox.layers as Doc[])[0].boxes = [{ id: 'b', words: [0], inkId: 'yellow', opacity: 0 }]
    const hid = normalizeSettings(copy(hiddenBox)).layers[0]
    expect([hid.backing, hid.contrastInkId]).toEqual([null, 'white'])
    // The first box that DID print sets the backing.
    ;(hiddenBox.layers as Doc[])[0].boxes = [
      { id: 'b', words: [0], inkId: 'yellow', opacity: 0 },
      { id: 'c', words: [0], inkId: 'teal', opacity: 0.5 },
    ]
    expect(normalizeSettings(hiddenBox).layers[0].backing).toBe('teal')
    // A worded, visible box on a hidden plate never printed either.
    const hiddenPlate = copy(defaultDoc) as unknown as Doc
    Object.assign((hiddenPlate.layers as Doc[])[0], {
      opacity: 0,
      contrastInkId: 'white',
      boxes: [{ id: 'b', words: [0], inkId: 'yellow', opacity: 1 }],
    })
    const s = normalizeSettings(hiddenPlate)
    expect([s.layers[0].backing, s.layers[0].contrastInkId]).toEqual([null, 'white'])
  })

  it('a box whose word numbers the text no longer has never printed: no backing, and the second ink stays', () => {
    // The old renderer drew a box behind a placed word only if the box held
    // that word's number, and word numbers never followed text edits. A box
    // on word 5 of "PRINT" (one word) drew nothing.
    const onText = (text: string, words: unknown[]) => {
      const d = copy(defaultDoc) as unknown as Doc
      Object.assign((d.layers as Doc[])[0], {
        text,
        contrastInkId: 'white',
        boxes: [{ id: 'b', words, inkId: 'yellow', opacity: 1 }],
      })
      const l = normalizeSettings(d).layers[0]
      return [l.backing, l.contrastInkId]
    }
    expect(onText('PRINT', [5])).toEqual([null, 'white'])
    // Not numbers at all, or not whole, or negative: nothing matched them.
    expect(onText('PRINT', ['x'])).toEqual([null, 'white'])
    expect(onText('PRINT', ['0'])).toEqual([null, 'white'])
    expect(onText('PRINT', [0.5, -1])).toEqual([null, 'white'])
    // One number that still exists is enough.
    expect(onText('PRINT', [0, 9])).toEqual(['yellow', null])
    // Words are numbered on across lines, split at spaces and tabs only.
    expect(onText('PRINT\nMACHINE', [1])).toEqual(['yellow', null])
    expect(onText('PRINT\nMACHINE', [2])).toEqual([null, 'white'])
    expect(onText('A  B\tC\n\nD', [3])).toEqual(['yellow', null])
    expect(onText('A  B\tC\n\nD', [4])).toEqual([null, 'white'])
    // A box that did not print does not hide a later one that did.
    const d = copy(defaultDoc) as unknown as Doc
    Object.assign((d.layers as Doc[])[0], {
      text: 'PRINT',
      boxes: [
        { id: 'b', words: [7], inkId: 'yellow', opacity: 1 },
        { id: 'c', words: [0], inkId: 'teal', opacity: 1 },
      ],
    })
    expect(normalizeSettings(d).layers[0].backing).toBe('teal')
  })

  it('layer.opacity 0: plate opacity is cut, so a hidden plate prints at full strength', () => {
    // Stated, not fixed: the verdict cut plate opacity (#17) and there is no
    // other way to hide a plate, while dropping it would destroy work. The
    // README's "Saved prints keep opening" names this exception.
    const d = copy(defaultDoc) as unknown as Doc
    ;(d.layers as Doc[])[1].opacity = 0
    const s = normalizeSettings(d)
    expect(s.layers).toHaveLength(2)
    expect(s.layers[1].text).toBe((defaultDoc as unknown as { layers: { text: string }[] }).layers[1].text)
    expect(s.layers[1]).not.toHaveProperty('opacity')
  })

  it('a stored backing survives a load, and a document holding both keeps the backing', () => {
    const d = copy(defaultDoc) as unknown as Doc
    ;(d.layers as Doc[])[1].backing = 'teal'
    expect(normalizeSettings(copy(d)).layers[1].backing).toBe('teal')
    ;(d.layers as Doc[])[1].contrastInkId = 'white'
    const s = normalizeSettings(d)
    expect([s.layers[1].backing, s.layers[1].contrastInkId]).toEqual(['teal', null])
  })

  it('layer.wordPress, opacity, boxPadding, boxRadius, boxes, opaque: dropped', () => {
    for (const l of max().layers) {
      for (const k of ['wordPress', 'opacity', 'boxPadding', 'boxRadius', 'boxes', 'opaque']) {
        expect(l).not.toHaveProperty(k)
      }
    }
  })

  it('a document over the plate budget keeps every plate', () => {
    // Four plates in legacy-maximal, one more than the budget allows to ADD.
    expect(rawLayers).toHaveLength(4)
    expect(max().layers).toHaveLength(4)
  })

  /* ── Press (1.5) ── */

  const rawPress = rawMax.press as Doc

  it("press.method 'dither' (any algorithm): Grain, its cell carried over as the screen size", () => {
    expect([rawPress.method, rawPress.ditherType, rawPress.ditherScale]).toEqual(['dither', 'jarvis', 4])
    expect(max().press.method).toBe('grain')
    // Grain cell = screen size / 3, so a 4 px dither cell is a 12 px screen.
    expect(max().press.screenPitch).toBe(12)
    // Every cell the old Dot size slider could set (1..12) converts exactly,
    // so the grain prints at the size it did; the engine test pins the cell
    // at every render height.
    for (let cell = 1; cell <= 12; cell++) {
      const d = copy(defaultDoc) as unknown as Doc
      Object.assign(d.press as Doc, { method: 'dither', ditherScale: cell })
      expect(normalizeSettings(d).press.screenPitch).toBe(cell * 3)
    }
    // Past anything a control could set, it is clamped into the range.
    const d = copy(defaultDoc) as unknown as Doc
    Object.assign(d.press as Doc, { method: 'dither', ditherScale: 40 })
    expect(normalizeSettings(d).press.screenPitch).toBe(36)
  })

  it("press.method 'woodcut' or 'scribble': Halftone", () => {
    for (const method of ['woodcut', 'scribble']) {
      const d = copy(defaultDoc) as unknown as Doc
      ;(d.press as Doc).method = method
      const s = normalizeSettings(d)
      expect(s.press.method).toBe('halftone')
      // The halftone keeps the screen size it had.
      expect(s.press.screenPitch).toBe((defaultDoc as unknown as { press: { screenPitch: number } }).press.screenPitch)
    }
  })

  it('press.roughness / bleed / mottle / dropout: the Edge and Wear amounts', () => {
    expect([rawPress.roughness, rawPress.mottle]).toEqual([0.8, 0.4])
    expect([max().press.edge, max().press.wear]).toEqual([0.8, 0.4])
    // A shipped default press converts to the shipped edge and film exactly.
    const d = normalizeSettings(copy(defaultDoc))
    expect([d.press.edge, d.press.wear]).toEqual([0.55, 0.22])
    // Wear past its range is clamped.
    const heavy = copy(defaultDoc) as unknown as Doc
    ;(heavy.press as Doc).mottle = 1
    expect(normalizeSettings(heavy).press.wear).toBe(0.8)
  })

  it('press.density, misregistration and screen size are carried as they were', () => {
    expect([max().press.density, max().press.misregistration]).toEqual([rawPress.density, rawPress.misregistration])
  })

  it('every other press field, and paper tooth and cloud: dropped', () => {
    expect(keys(max().press)).toEqual(['density', 'edge', 'method', 'misregistration', 'screenPitch', 'wear'])
    expect(max()).not.toHaveProperty('paperTexture')
    expect(max()).not.toHaveProperty('paperBlotch')
  })

  /* ── The sheet ── */

  it('aspect: unchanged', () => {
    expect(rawMax.aspect).toBe('3:4')
    expect(max().aspect).toBe('3:4')
  })
})

