#!/usr/bin/env node
/**
 * check-fonts: the bundled face can set what Print Machine prints.
 *
 *   node scripts/check-fonts.mjs        (in `npm run verify`)
 *
 * Poster is set in Tanklager Kompakt, bundled (src/assets/fonts/, README
 * "Fonts"). A face is a file someone may one day swap, and a display face
 * often draws only capitals, or joins letters with ligatures the press would
 * set as one glyph (the per-glyph layout in engine/text.ts places every
 * character on its own, so a ligature would never be asked for, but a face
 * that relies on one draws its letters badly alone: Border Studio's Jost was
 * the case). This reads the WOFF itself, with no font library: the header and
 * table directory, each table inflated (zlib) and checked against its
 * checksum, then `cmap` (formats 4 and 12, every Unicode subtable), `GSUB`'s
 * feature list and `name`. It fails unless:
 *
 *  - every printable ASCII character (U+0020 to U+007E) and what an iPhone
 *    keyboard types by default for quotes, dashes and the ellipsis
 *    (U+2018, U+2019, U+201C, U+201D, U+2013, U+2014, U+2026) maps to a
 *    glyph, but for the ones named in FALLS_BACK (Tanklager: `$`), which
 *    print in the phone's own face and are said to; a face that loses one
 *    more fails;
 *  - every lowercase letter maps to a glyph of its own, not its capital's
 *    (a capitals-only face maps both to one glyph). This is a cheap
 *    pre-check only: a face can draw a separate lowercase glyph that is a
 *    capital (Railroad Gothic does), so the real test is in the browser,
 *    where the ink of `o` is measured against `O` (verify-offline.mjs,
 *    `lowercaseVerdict` in face-checks.mjs);
 *  - GSUB offers none of liga, clig, calt, dlig, rlig.
 *
 * Then it builds four broken copies of the same face in memory (its
 * lowercase unmapped; the iPhone's apostrophe unmapped; its lowercase mapped
 * to the capitals; a `liga` feature added), written out as WOFF and read
 * back through the same path, and fails unless each one fails for its
 * reason: a check that cannot fail is not one.
 *
 *   node scripts/check-fonts.mjs other.woff       (another face: a WOFF, or a
 *       bare TrueType or CFF file, such as Border Studio's Railroad.ttf)
 *   node scripts/check-fonts.mjs --controls dir/  (also writes the four broken
 *       copies there, so each can be run on its own and seen to fail)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const controlsAt = args.includes('--controls') ? args[args.indexOf('--controls') + 1] : null
const named = args.filter((a, k) => a !== '--controls' && args[k - 1] !== '--controls')
const FACE = resolve(named[0] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../src/assets/fonts/Tanklager.woff'))

const UPPER = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const LOWER = [...'abcdefghijklmnopqrstuvwxyz']
/** What a plate's text can hold from a keyboard: every printable ASCII
 *  character, and what an iPhone's keyboard types by default for ' " - and
 *  ... (Smart Punctuation). A plate is free text, set a character at a time;
 *  a character the face does not map is set in the next face of Poster's
 *  stack, which is each phone's own. */
const TYPED = [...Array.from({ length: 0x7f - 0x20 }, (_, k) => String.fromCodePoint(0x20 + k)), ...'\u2018\u2019\u201c\u201d\u2013\u2014\u2026']
/** The typed characters the shipped face does not draw, named so that a face
 *  that loses one more fails: these print in the phone's own face (README
 *  "Fonts"). Tanklager Kompakt has no dollar sign. */
const FALLS_BACK = ['$']
/** Not typed on a phone's first keyboard, but likely: reported, not
 *  required. */
const LIKELY = [...'\u20ac\u00a3\u00a9\u2122']
const JOINING = ['liga', 'clig', 'calt', 'dlig', 'rlig']

const align4 = (n) => (n + 3) & ~3
const tagOf = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

/** The OpenType checksum: the table as big-endian uint32 words, padded with zeros, summed mod 2^32. */
function checksum(data) {
  const padded = Buffer.alloc(align4(data.length))
  data.copy(padded)
  let sum = 0
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0
  return sum
}

/** A table's checksum as its directory states it: `head`'s with its checkSumAdjustment counted as zero. */
function tableChecksum(tag, data) {
  if (tag !== 'head') return checksum(data)
  const copy = Buffer.from(data)
  copy.writeUInt32BE(0, 8)
  return checksum(copy)
}

/** Read a bare TrueType or CFF file (an sfnt): its flavor and its tables, each checked. */
function readSfnt(buf) {
  const flavor = tagOf(buf, 0)
  const n = buf.readUInt16BE(4)
  const tables = new Map()
  for (let k = 0; k < n; k++) {
    const at = 12 + 16 * k
    const tag = tagOf(buf, at)
    const offset = buf.readUInt32BE(at + 8)
    const length = buf.readUInt32BE(at + 12)
    if (offset + length > buf.length) throw new Error(`table ${tag} runs past the end of the file`)
    const data = Buffer.from(buf.subarray(offset, offset + length))
    if (tableChecksum(tag, data) !== buf.readUInt32BE(at + 4)) throw new Error(`table ${tag} fails its checksum`)
    tables.set(tag, data)
  }
  return { flavor, tables }
}

/** Read a WOFF 1.0 file: its flavor and its tables, each inflated and checked. Throws on a malformed file. */
function readWoff(buf) {
  if (buf.length >= 12 && ['OTTO', 'true', '\0\x01\0\0'].includes(tagOf(buf, 0))) return readSfnt(buf)
  if (buf.length < 44 || tagOf(buf, 0) !== 'wOFF') throw new Error('not a WOFF 1.0 file, nor a TrueType or CFF one')
  if (buf.readUInt32BE(8) !== buf.length) throw new Error(`header says ${buf.readUInt32BE(8)} bytes, the file is ${buf.length}`)
  const flavor = tagOf(buf, 4)
  const n = buf.readUInt16BE(12)
  const tables = new Map()
  for (let k = 0; k < n; k++) {
    const at = 44 + 20 * k
    const tag = tagOf(buf, at)
    const offset = buf.readUInt32BE(at + 4)
    const compLength = buf.readUInt32BE(at + 8)
    const origLength = buf.readUInt32BE(at + 12)
    const origChecksum = buf.readUInt32BE(at + 16)
    if (offset + compLength > buf.length) throw new Error(`table ${tag} runs past the end of the file`)
    const stored = buf.subarray(offset, offset + compLength)
    const data = compLength < origLength ? inflateSync(stored) : Buffer.from(stored)
    if (data.length !== origLength) throw new Error(`table ${tag} inflates to ${data.length} bytes, not ${origLength}`)
    if (tableChecksum(tag, data) !== origChecksum) throw new Error(`table ${tag} fails its checksum`)
    tables.set(tag, data)
  }
  return { flavor, tables }
}

/** Write tables as a WOFF 1.0 file (each compressed where that is smaller), for the broken controls. */
function writeWoff(flavor, tables) {
  const tags = [...tables.keys()].sort()
  const entries = tags.map((tag) => {
    const data = tables.get(tag)
    const packed = deflateSync(data)
    return { tag, data, stored: packed.length < data.length ? packed : data }
  })
  const dirEnd = 44 + 20 * entries.length
  let at = dirEnd
  const placed = entries.map((e) => {
    const offset = at
    at += align4(e.stored.length)
    return { ...e, offset }
  })
  const out = Buffer.alloc(at)
  out.write('wOFF', 0, 'latin1')
  out.write(flavor, 4, 'latin1')
  out.writeUInt32BE(at, 8)
  out.writeUInt16BE(entries.length, 12)
  out.writeUInt32BE(12 + 16 * entries.length + entries.reduce((s, e) => s + align4(e.data.length), 0), 16)
  out.writeUInt16BE(1, 20)
  placed.forEach((e, k) => {
    const d = 44 + 20 * k
    out.write(e.tag, d, 'latin1')
    out.writeUInt32BE(e.offset, d + 4)
    out.writeUInt32BE(e.stored.length, d + 8)
    out.writeUInt32BE(e.data.length, d + 12)
    out.writeUInt32BE(tableChecksum(e.tag, e.data), d + 16)
    e.stored.copy(out, e.offset)
  })
  return out
}

/** Code point -> glyph id, from every Unicode subtable of format 4 or 12 (later subtables do not override). */
function readCmap(cmap) {
  const map = new Map()
  const set = (cp, gid) => {
    if (gid !== 0 && !map.has(cp)) map.set(cp, gid)
  }
  const count = cmap.readUInt16BE(2)
  let read = 0
  for (let k = 0; k < count; k++) {
    const platform = cmap.readUInt16BE(4 + 8 * k)
    const encoding = cmap.readUInt16BE(6 + 8 * k)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode) continue
    const at = cmap.readUInt32BE(8 + 8 * k)
    const format = cmap.readUInt16BE(at)
    if (format === 4) {
      const segs = cmap.readUInt16BE(at + 6) / 2
      const ends = at + 14
      const starts = ends + 2 * segs + 2
      const deltas = starts + 2 * segs
      const ranges = deltas + 2 * segs
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(ends + 2 * s)
        const start = cmap.readUInt16BE(starts + 2 * s)
        const delta = cmap.readInt16BE(deltas + 2 * s)
        const range = cmap.readUInt16BE(ranges + 2 * s)
        for (let c = start; c <= end && c !== 0xffff; c++) {
          if (range === 0) set(c, (c + delta) & 0xffff)
          else {
            const g = cmap.readUInt16BE(ranges + 2 * s + range + 2 * (c - start))
            set(c, g === 0 ? 0 : (g + delta) & 0xffff)
          }
        }
      }
      read++
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(at + 12)
      for (let g = 0; g < groups; g++) {
        const base = at + 16 + 12 * g
        const start = cmap.readUInt32BE(base)
        const end = cmap.readUInt32BE(base + 4)
        const first = cmap.readUInt32BE(base + 8)
        for (let c = start; c <= end; c++) set(c, first + (c - start))
      }
      read++
    }
  }
  if (read === 0) throw new Error('cmap has no Unicode subtable of format 4 or 12')
  return map
}

/** A cmap of one format 4 subtable (3, 1) holding `map` (BMP only): a segment per code point. */
function writeCmap(map) {
  const cps = [...map.keys()].filter((c) => c < 0xffff).sort((a, b) => a - b)
  const segs = cps.length + 1
  const sub = Buffer.alloc(16 + 8 * segs)
  sub.writeUInt16BE(4, 0)
  sub.writeUInt16BE(sub.length, 2)
  sub.writeUInt16BE(2 * segs, 6)
  const pow = 2 ** Math.floor(Math.log2(segs))
  sub.writeUInt16BE(2 * pow, 8)
  sub.writeUInt16BE(Math.log2(pow), 10)
  sub.writeUInt16BE(2 * segs - 2 * pow, 12)
  const ends = 14
  const starts = ends + 2 * segs + 2
  const deltas = starts + 2 * segs
  ;[...cps, 0xffff].forEach((c, s) => {
    sub.writeUInt16BE(c, ends + 2 * s)
    sub.writeUInt16BE(c, starts + 2 * s)
    sub.writeUInt16BE(c === 0xffff ? 1 : (map.get(c) - c) & 0xffff, deltas + 2 * s)
  })
  const head = Buffer.alloc(12)
  head.writeUInt16BE(1, 2)
  head.writeUInt16BE(3, 4)
  head.writeUInt16BE(1, 6)
  head.writeUInt32BE(12, 8)
  return Buffer.concat([head, sub])
}

/** GSUB's feature tags (empty when the face has no GSUB). */
function readFeatures(gsub) {
  if (!gsub) return []
  const list = gsub.readUInt16BE(6)
  const count = gsub.readUInt16BE(list)
  return Array.from({ length: count }, (_, k) => tagOf(gsub, list + 2 + 6 * k))
}

/** A GSUB 1.0 with no scripts and no lookups whose feature list is `tags`: only the tags are read. */
function writeGsub(tags) {
  const scripts = 10 // a ScriptList of none
  const list = 12 // the FeatureList: its records, then one empty Feature table each
  const features = list + 2 + 6 * tags.length
  const lookups = features + 4 * tags.length // a LookupList of none
  const out = Buffer.alloc(lookups + 2)
  out.writeUInt16BE(1, 0)
  out.writeUInt16BE(scripts, 4)
  out.writeUInt16BE(list, 6)
  out.writeUInt16BE(lookups, 8)
  out.writeUInt16BE(tags.length, list)
  tags.forEach((tag, k) => {
    out.write(tag, list + 2 + 6 * k, 'latin1')
    out.writeUInt16BE(features + 4 * k - list, list + 6 + 6 * k)
  })
  return out
}

/** A `name` record (Windows English first, else Macintosh Roman), or ''. */
function readName(name, id) {
  if (!name) return ''
  const count = name.readUInt16BE(2)
  const strings = name.readUInt16BE(4)
  let mac = ''
  for (let k = 0; k < count; k++) {
    const r = 6 + 12 * k
    if (name.readUInt16BE(r + 6) !== id) continue
    const platform = name.readUInt16BE(r)
    const lang = name.readUInt16BE(r + 4)
    const bytes = name.subarray(strings + name.readUInt16BE(r + 10), strings + name.readUInt16BE(r + 10) + name.readUInt16BE(r + 8))
    if (platform === 3 && lang === 0x409) return Buffer.from(bytes).swap16().toString('utf16le')
    if (platform === 1 && !mac) mac = bytes.toString('latin1')
  }
  return mac
}

/** Everything wrong with a face for Print Machine's press, and what it holds. */
function checkFace(bytes) {
  const { flavor, tables } = readWoff(bytes)
  for (const tag of ['cmap', 'name', 'maxp']) if (!tables.has(tag)) throw new Error(`no ${tag} table`)
  const map = readCmap(tables.get('cmap'))
  const features = readFeatures(tables.get('GSUB'))
  const problems = []
  const gid = (ch) => map.get(ch.codePointAt(0)) ?? 0
  const missing = TYPED.filter((ch) => gid(ch) === 0 && !FALLS_BACK.includes(ch))
  if (missing.length) problems.push(`unmapped: ${missing.join(' ')}`)
  const shared = LOWER.filter((ch) => gid(ch) !== 0 && gid(ch) === gid(ch.toUpperCase()))
  if (shared.length) problems.push(`lowercase drawn with its capital's glyph: ${shared.join(' ')}`)
  const joining = features.filter((t) => JOINING.includes(t))
  if (joining.length) problems.push(`joining features in GSUB: ${[...new Set(joining)].join(' ')}`)
  return {
    problems,
    flavor,
    tables,
    map,
    features,
    glyphs: tables.get('maxp').readUInt16BE(4),
    family: readName(tables.get('name'), 1),
    version: readName(tables.get('name'), 5),
    copyright: readName(tables.get('name'), 0),
    licence: readName(tables.get('name'), 13),
  }
}

let failed = false
const bytes = readFileSync(FACE)
const face = checkFace(bytes)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
console.log(`check-fonts: ${FACE.startsWith(ROOT + '/') ? FACE.slice(ROOT.length + 1) : FACE} (${bytes.length} B, ${face.flavor === 'OTTO' ? 'CFF' : 'TrueType'} outlines)`)
console.log(`  ${face.family}, ${face.version}; ${face.glyphs} glyphs, ${face.map.size} code points mapped`)
console.log(`  GSUB features: ${face.features.length ? [...new Set(face.features)].join(' ') : 'none'}`)
console.log(`  ${face.copyright}`)
if (face.licence) console.log(`  ${face.licence.split('\n')[0]}`)
if (face.problems.length) {
  failed = true
  for (const p of face.problems) console.error(`  FAIL ${p}`)
} else {
  console.log(`  every printable ASCII character and ${TYPED.slice(0x7f - 0x20).join(' ')} mapped, but for ${FALLS_BACK.join(' ')}; lowercase its own glyphs; no ${JOINING.join(' ')}: ok`)
}
const fallback = [...FALLS_BACK, ...LIKELY].filter((ch) => (face.map.get(ch.codePointAt(0)) ?? 0) === 0)
console.log(`  set in the phone's own face (not in this one): ${fallback.join(' ') || 'nothing typed'}`)

// The controls: the same face broken three ways, written and read back.
const lowerless = new Map([...face.map].filter(([cp]) => !LOWER.includes(String.fromCodePoint(cp))))
const capitals = new Map([...face.map].map(([cp, g]) => [cp, LOWER.includes(String.fromCodePoint(cp)) ? face.map.get(String.fromCodePoint(cp).toUpperCase().codePointAt(0)) : g]))
const apostropheless = new Map([...face.map].filter(([cp]) => cp !== 0x2019))
const CONTROLS = [
  { name: 'its lowercase unmapped', file: 'lowercase-unmapped', swap: { cmap: writeCmap(lowerless) }, expect: /^unmapped: a b c/ },
  { name: "the iPhone's apostrophe unmapped", file: 'apostrophe-unmapped', swap: { cmap: writeCmap(apostropheless) }, expect: /^unmapped: \u2019$/ },
  { name: 'its lowercase set in the capitals', file: 'lowercase-as-capitals', swap: { cmap: writeCmap(capitals) }, expect: /^lowercase drawn with its capital's glyph: a b c/ },
  { name: 'a liga feature', file: 'liga', swap: { GSUB: writeGsub([...face.features, 'liga']) }, expect: /^joining features in GSUB: liga$/ },
]
if (controlsAt) mkdirSync(controlsAt, { recursive: true })
for (const c of CONTROLS) {
  const tables = new Map(face.tables)
  for (const [tag, data] of Object.entries(c.swap)) tables.set(tag, data)
  const written = writeWoff(face.flavor, tables)
  if (controlsAt) writeFileSync(join(controlsAt, `${c.file}.woff`), written)
  const broken = checkFace(written)
  const caught = broken.problems.some((p) => c.expect.test(p))
  if (!caught) failed = true
  console.log(`  control, ${c.name}: ${caught ? 'fails, as it must' : `NOT caught (${broken.problems.join('; ') || 'no problems'})`}`)
}

if (failed) {
  console.error('check-fonts: FAIL')
  process.exit(1)
}
console.log('check-fonts: ok')
