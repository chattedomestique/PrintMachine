/**
 * The export's memory diet. An export at a photo's own
 * resolution is 11-17 MP, so every sheet-sized buffer is 45-67 MB of a
 * phone's memory. The steps that only change what is HELD must not change a
 * pixel; the ones that change pixels are made in the stages the preview
 * shares, and held to a bound.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { FbmSampler, ValueNoiseSampler, fbm2D, mulberry32, mulberryAt, valueNoise2D } from './rng.ts'
import { PaperSampler, paperField } from './paper.ts'
import {
  ensureCache,
  grainCell,
  makeWorkspace,
  maxWindow,
  plateGeometry,
  pressPlate,
  pressPlateBand,
  printSheet,
  printSheetSteps,
  sampledNoise,
  switchScreen,
  toneAsFloat,
  windowsFor,
  type ToneRows,
  type ToneSource,
} from './render.ts'
import { bandMask, groundLumaGrid, lumaCell, sampleLumaRows, splitInks, type LumaGrid } from './media.ts'
import { inkById, paperById } from './inks.ts'
import { screenField } from './screen.ts'
import { GrainStream, ditherField } from './dither.ts'
import { cutKnockoutRows } from './knockout.ts'
import { groundLuma, knockoutMask, shiftField } from './__tests__/reference.ts'
import { applyDensity, applyMottle, shiftRows } from './ink.ts'
import { blurInPlace } from './blur.ts'
import { roughenInPlace } from './rough.ts'
import { clampByte, compositeLayers } from './composite.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'
import type { PressProfile, PrintSettings } from './types.ts'

describe('step 1: an export reads its noise where it prints it, the same numbers as the arrays', () => {
  it("mulberryAt is mulberry32's n-th draw, read directly", () => {
    for (const seed of [0, 1, 12345, 12345 ^ 0x9e3779b9, -7, 0xffffffff]) {
      const r = mulberry32(seed)
      for (let n = 1; n <= 3000; n++) expect(mulberryAt(seed, n)).toBe(r())
    }
  })

  const shapes: [number, number, number, number, number][] = [
    // w, h, cell, seed, minCell
    [97, 61, 3, 12345, 1],
    [300, 200, 1.667, 7, 1],
    [300, 200, 6, -5, 2],
    [128, 300, 0.5, 99, 1],
    [800, 1000, 11.11, 12345 ^ 0x9e3779b9, 1],
  ]

  it('value noise and fbm, sampled in any order, equal the arrays bit for bit', () => {
    for (const [w, h, cell, seed, minCell] of shapes) {
      const field = valueNoise2D(w, h, cell, seed)
      const sampler = new ValueNoiseSampler(w, cell, seed)
      for (let k = 0; k < 20000; k++) {
        const x = (k * 7919) % w
        const y = (k * 104729) % h
        expect(sampler.at(x, y)).toBe(field[y * w + x])
      }
      const fbm = fbm2D(w, h, cell, 3, seed, minCell)
      const fs = new FbmSampler(w, cell, 3, seed, minCell)
      let differ = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fs.at(x, y) !== fbm[y * w + x]) differ++
      expect(differ).toBe(0)
    }
  })

  it('the paper, sampled a band at a time, equals the field', () => {
    for (const [w, h, scale] of [
      [144, 180, 0.1],
      [400, 500, 0.556],
      [300, 1800, 1],
      [240, 3600, 2],
    ] as const) {
      const opts = { rgb: paperById('natural').rgb, texture: 0.4, blotch: 0.5, seed: 12345, scale }
      const field = paperField(w, h, opts).shade
      const sampler = new PaperSampler(w, h, opts)
      const band = new Float32Array(37 * w)
      let differ = 0
      for (let y = 0; y < h; y += 37) {
        const y1 = Math.min(h, y + 37)
        sampler.rows(y, y1, band)
        for (let i = 0; i < (y1 - y) * w; i++) if (band[i] !== field[y * w + i]) differ++
      }
      expect(differ).toBe(0)
    }
  })

  it('a sheet printed from sampled noise is the sheet printed from the cache, byte for byte', () => {
    // Wear on (mottle and speckle read on inked pixels), a second ink over a
    // photo, a backing, halftone and grain.
    const w = 160
    const h = 200
    const ground = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const v = Math.round((255 * (i % w)) / (w - 1))
      ground.set([v, (v * 3) & 255, 255 - v, 255], i * 4)
    }
    const block = (y0: number, y1: number) => {
      const f = new Float32Array(w * h)
      for (let y = y0; y < y1; y++) for (let x = 10; x < w - 10; x++) f[y * w + x] = (x >> 2) % 3 ? 1 : 0.4
      return f
    }
    const tones = [block(20, 80), block(110, 170)]
    const src: ToneSource = {
      type: (l) => ({ field: tones[Number(l.id.slice(1))], fontSize: 14 }),
      backing: () => ({ field: block(100, 180), fontSize: 14 }),
    }
    for (const method of ['halftone', 'grain'] as const) {
      const s: PrintSettings = defaultSettings()
      s.press = { ...s.press, method, wear: 0.6, edge: 0.8 }
      s.media = makeMedia({ id: 'p', width: w, height: h })
      s.layers = [
        makeLayer({ id: 'p0', inkId: 'black', contrastInkId: 'white' }),
        makeLayer({ id: 'p1', inkId: 'fluorescentpink', backing: 'yellow' }),
      ]
      const cached = new Uint8ClampedArray(w * h * 4)
      const sampled = new Uint8ClampedArray(w * h * 4)
      printSheet(cached, s, ground, src, ensureCache(null, s, w, h), w, h)
      printSheet(sampled, s, ground, src, sampledNoise(s, w, h), w, h)
      expect(sampled).toEqual(cached)
    }
  })
})

describe('step 2: bytes where they hold the value (tone exact; coverage and masks within half a level)', () => {
  const w = 120
  const h = 90
  const ramp = (k = 1) => {
    const f = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = Math.min(1, ((x / (w - 1)) * (0.5 + y / h)) * k)
    return f
  }

  it('a glyph tone in bytes presses exactly as the float field it stands for', () => {
    // The raster's alpha byte b was read as b / 255 into float32; the press
    // now converts at the plate, to the same float32.
    const bytes = new Uint8Array(w * h)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256
    const floats = new Float32Array(w * h)
    for (let i = 0; i < floats.length; i++) floats[i] = bytes[i] / 255
    expect(toneAsFloat(bytes)).toEqual(floats)
    const s = defaultSettings()
    const noise = ensureCache(null, s, w, h)
    for (const method of ['halftone', 'grain'] as const) {
      const press = { ...s.press, method }
      const a = pressPlate({ field: bytes, fontSize: 20 }, 1, press, s.seed, noise, w, h)
      const b = pressPlate({ field: floats, fontSize: 20 }, 1, press, s.seed, noise, w, h)
      expect(a.coverage).toEqual(b.coverage)
      expect(a.roughened).toEqual(b.roughened)
    }
  })

  it('screen and grain write bytes that are the float coverage, rounded', () => {
    const tone = ramp()
    const opts = { pitch: 5.3, angle: 75, softness: 0.7, originX: 1.3, originY: -0.4 }
    const f = screenField(tone, w, h, opts)
    const b = screenField(tone, w, h, opts, new Uint8ClampedArray(w * h))
    for (let i = 0; i < f.length; i++) expect(b[i]).toBe(Math.round(f[i] * 255))
    for (const scale of [1, 2.5]) {
      const df = ditherField(tone, w, h, { scale })
      const db = ditherField(tone, w, h, { scale }, new Uint8ClampedArray(w * h))
      for (let i = 0; i < df.length; i++) expect(db[i]).toBe(df[i] * 255)
    }
  })

  it('the switch mask is hard, so the second-ink split is exact in bytes', () => {
    // A halftone switch screen has no softness and a grain is binary: the
    // mask is 0 or 255 and each half is the coverage or nothing.
    const lum = ramp()
    for (const method of ['halftone', 'grain'] as const) {
      const s = defaultSettings()
      s.press = { ...s.press, method }
      s.media = makeMedia({ id: 'p', width: w, height: h })
      s.layers = [makeLayer({ id: 'p0', inkId: 'black', contrastInkId: 'white' })]
      const ground = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) ground.set([lum[i] * 255, lum[i] * 255, lum[i] * 255, 255], i * 4)
      const tone = new Float32Array(w * h).fill(1)
      const plates = printSheet(new Uint8ClampedArray(w * h * 4), s, ground, { type: () => ({ field: tone, fontSize: 6 }), backing: () => ({ field: tone, fontSize: 6 }) }, ensureCache(null, s, w, h), w, h)
      const [onLight, onDark] = plates.map((p) => p.coverage)
      for (let i = 0; i < w * h; i++) {
        // One half carries all of it, the other none.
        expect(Math.min(onLight[i], onDark[i])).toBe(0)
      }
      // A byte mask cuts the photo exactly as the same mask in floats.
      const rough = ramp(1.4)
      const mask = new Uint8ClampedArray(w * h)
      for (let i = 0; i < mask.length; i++) mask[i] = onLight[i] > 0 ? 255 : 0
      const floatMask = Float32Array.from(mask, (v) => v / 255)
      const split = (light: Float32Array | Uint8ClampedArray) => ({ light, onLightLuma: 0.1, onDarkLuma: 0.9 })
      const p = { w, h, dx: 1.5, dy: -0.75 }
      expect(knockoutMask(rough, lum, { ...p, split: split(mask) })).toEqual(knockoutMask(rough, lum, { ...p, split: split(floatMask) }))
    }
  })

  it('a three-plate sheet with byte coverage is within 2 levels of the float one, mean under 0.05', () => {
    // The gate for keeping coverage in bytes: three overlapping plates of
    // type-like blocks at the default ink density, screened with the dot's
    // soft edge, over a photo and over paper, composited from floats and from
    // bytes.
    const blocks = (k: number) => {
      const f = new Float32Array(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inWord = (x + k * 13) % 29 < 19 && (y + k * 7) % 23 < 15
          f[y * w + x] = inWord ? 0.84 : 0
        }
      }
      return f
    }
    const plates = [0, 1, 2].map((k) =>
      screenField(blocks(k), w, h, { pitch: 4.7 + k, angle: [45, 75, 15][k], softness: 0.7, originX: k * 1.7, originY: k * 0.9 }),
    )
    const rgbs = [inkById('fluorescentpink').rgb, inkById('blue').rgb, inkById('yellow').rgb]
    const paper = paperField(w, h, { rgb: paperById('natural').rgb, texture: 0.4, blotch: 0.5, seed: 3 })
    const base = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) base.set([(i * 7) % 256, (i * 13) % 256, (i * 3) % 256, 255], i * 4)
    for (const ground of [undefined, base]) {
      const floats = new Uint8ClampedArray(w * h * 4)
      const bytes = new Uint8ClampedArray(w * h * 4)
      const p = ground ? { ...paper, base: ground, paperAmount: 1 } : paper
      compositeLayers(floats, w, h, p, plates.map((coverage, k) => ({ coverage, rgb: rgbs[k] })))
      compositeLayers(bytes, w, h, p, plates.map((f, k) => ({ coverage: Uint8ClampedArray.from(f, (v) => v * 255), rgb: rgbs[k] })))
      let max = 0
      let sum = 0
      for (let i = 0; i < floats.length; i++) {
        if (i % 4 === 3) continue
        const d = Math.abs(floats[i] - bytes[i])
        max = Math.max(max, d)
        sum += d
      }
      expect(max).toBeLessThanOrEqual(2)
      expect(sum / ((floats.length * 3) / 4)).toBeLessThan(0.05)
    }
  })
})

describe('step 3: every pass in place, in one workspace, to the same numbers', () => {
  const sha = (a: ArrayBufferView) =>
    createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex')
  const field = (w: number, h: number, k = 1) => {
    const f = new Float32Array(w * h)
    for (let i = 0; i < f.length; i++) f[i] = (((i * 2654435761) >>> 0) % 1000) / 1000 * k
    return f
  }

  it('shifting the whole sheet gives shiftField\'s field, for any offset either way', () => {
    const w = 37
    const h = 29
    for (const dx of [0, 0.4, -0.4, 1, -1, 2.7, -3.25, 0.999]) {
      for (const dy of [0, 0.3, -0.3, 1, -2, 4.6, -1.01]) {
        const src = field(w, h)
        const moved = shiftRows(src, w, 0, h, dx, dy, 0, h, new Float32Array(w * h))
        expect(sha(moved)).toBe(sha(shiftField(src, w, h, dx, dy)))
      }
    }
  })

  it('the blur and the tear give the same numbers whatever their reused buffers held, and density and wear in place give the fresh-array numbers', () => {
    // One workspace serves every plate, so the blur's scratch and spare come
    // to it holding the last plate's numbers. (Their exactness against the
    // fresh-array passes they replaced is the 48-plate golden below, pinned
    // before the change.)
    const w = 64
    const h = 48
    const tone = field(w, h)
    const fresh = () => [new Float32Array(w * h), new Float32Array(w * h)] as const
    const dirty = () => [field(w, h, 7), field(w, h, -3)] as const
    for (const r of [0, 0.005, 0.4, 1, 1.5, 2.25, 3.99, 4, 6.5, 12]) {
      const a = tone.slice()
      const b = tone.slice()
      blurInPlace(a, w, h, r, ...fresh())
      blurInPlace(b, w, h, r, ...dirty())
      expect(sha(b)).toBe(sha(a))
    }
    for (const opts of [
      { roughness: 0.55, scale: 1.3, bleed: 0.35, seed: 4 },
      { roughness: 1, scale: 5.5, bleed: 0, seed: 9 },
      { roughness: 0, scale: 2, bleed: 0.6, seed: 2 },
    ]) {
      const a = tone.slice()
      const b = tone.slice()
      roughenInPlace(a, w, h, opts, ...fresh())
      roughenInPlace(b, w, h, opts, ...dirty())
      expect(sha(b)).toBe(sha(a))
    }
    const d = tone.slice()
    expect(sha(applyDensity(d, 0.84, d))).toBe(sha(applyDensity(tone, 0.84)))
    const mottle = valueNoise2D(w, h, 8, 3)
    for (const detail of [1, 0.3]) {
      const m = tone.slice()
      applyMottle(m, mottle, { cell: 1, seed: 5 }, 0.6, 0.2, w, h, detail, m)
      expect(sha(m)).toBe(sha(applyMottle(tone, mottle, { cell: 1, seed: 5 }, 0.6, 0.2, w, h, detail)))
    }
  })

  it('a knockout cut into the running bytes (the whole sheet as one band) is knockoutMask, rounded, deepest cut kept', () => {
    const w = 50
    const h = 40
    const rough = field(w, h, 0.3)
    const lum = field(w, h)
    const light = Uint8ClampedArray.from(field(w, h), (v) => (v > 0.5 ? 255 : 0))
    const p = { w, h, dx: 1.6, dy: -0.7, split: { light, onLightLuma: 0.2, onDarkLuma: 0.8 } }
    const into = Uint8ClampedArray.from(field(w, h), (v) => v * 40)
    const expected = into.slice()
    const k = knockoutMask(rough, lum, p)
    for (let i = 0; i < k.length; i++) expected[i] = Math.max(expected[i], Math.round(k[i] * 255))
    cutKnockoutRows(into, 0, rough, 0, lum, { ...p, y0: 0, y1: h })
    expect(into).toEqual(expected)
  })

  it('pressPlate in a workspace presses what it pressed with fresh arrays (48 plates, pinned before the change)', () => {
    // Recorded at a6b6a24 (scratch golden3.ts): four sheet sizes (a fractional
    // tear blur, whole ones, one past the mixing range), halftone and grain,
    // three edge/wear settings, an unshifted and a misregistered plate. The
    // coverage, the torn tone and the offset, for each.
    const words = (w: number, h: number) => {
      const t = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inWord = x % 23 < 15 && y % 37 < 24 && x > 3 && x < w - 3
          t[y * w + x] = inWord ? ((x * 7 + y * 3) % 5 === 0 ? 128 : 255) : 0
        }
      }
      return t
    }
    const short = (a: ArrayBufferView) => sha(a).slice(0, 24)
    const lines: string[] = []
    for (const [w, h, fontSize] of [
      [150, 190, 30],
      [64, 1800, 288],
      [64, 1800, 72],
      [48, 2400, 400],
    ] as const) {
      const s = defaultSettings()
      const noise = ensureCache(null, s, w, h)
      const ws = makeWorkspace(h, w)
      for (const method of ['halftone', 'grain'] as const) {
        for (const [edge, wear] of [
          [0.55, 0.22],
          [0, 0.6],
          [1, 0],
        ]) {
          for (const index of [0, 1]) {
            const p = pressPlate({ field: words(w, h), fontSize }, index, { ...s.press, method, edge, wear }, s.seed, noise, w, h, ws)
            lines.push(`press ${w}x${h} f${fontSize} ${method} e${edge} w${wear} i${index}=${short(p.coverage)} ${short(p.roughened)} ${p.dx.toFixed(6)},${p.dy.toFixed(6)}`)
          }
        }
      }
    }
    expect(createHash('sha256').update(lines.join('\n')).digest('hex')).toBe('2a7563da5955c30fe47a6dde773a91e10c20869a444dbd3815100593fee7b00a')
  })
})

describe('step 4: nothing the canvas holds is held twice', () => {
  it('clampByte rounds as a byte store does, half to even', () => {
    const store = new Uint8ClampedArray(1)
    for (const v of [-3, -0.5, 0, 0.49, 0.5, 0.51, 1.5, 2.5, 3.5, 127.4999, 127.5, 128.5, 254.5, 254.6, 255, 300, NaN, Infinity]) {
      store[0] = v
      expect(clampByte(v)).toBe(store[0])
    }
    for (let k = 0; k < 20000; k++) {
      const v = ((k * 2654435761) % 300000) / 1000 - 10
      store[0] = v
      expect(clampByte(v)).toBe(store[0])
    }
  })

  it('a knockout applied as the ground is read prints what a cut copy of the ground printed', () => {
    const w = 64
    const h = 40
    const ground = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) ground.set([(i * 7) % 256, (i * 13) % 256, (i * 3) % 256, i % 9 ? 255 : 77], i * 4)
    const knockout = Uint8ClampedArray.from({ length: w * h }, (_, i) => (i * 37) % 256)
    const cut = ground.slice()
    for (let i = 0; i < w * h; i++) cut[i * 4 + 3] = cut[i * 4 + 3] * (1 - knockout[i] / 255)
    const paper = paperField(w, h, { rgb: paperById('natural').rgb, texture: 0.4, blotch: 0.5, seed: 2 })
    const layers = [{ coverage: Uint8ClampedArray.from({ length: w * h }, (_, i) => (i * 11) % 256), rgb: inkById('blue').rgb }]
    for (const paperAmount of [0, 1]) {
      const a = new Uint8ClampedArray(w * h * 4)
      const b = new Uint8ClampedArray(w * h * 4)
      compositeLayers(a, w, h, { ...paper, base: cut, paperAmount }, layers)
      compositeLayers(b, w, h, { ...paper, base: ground, knockout, paperAmount }, layers)
      expect(b).toEqual(a)
    }
  })

  it('a sheet printed band by band into one band buffer is the sheet printed whole', () => {
    const w = 90
    const h = 77
    const s = defaultSettings()
    s.media = makeMedia({ id: 'p', width: w, height: h })
    s.layers = [makeLayer({ id: 'p0', inkId: 'black', contrastInkId: 'white' }), makeLayer({ id: 'p1', backing: 'yellow' })]
    const ground = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) ground.set([(i * 5) % 256, (i * 9) % 256, (i * 2) % 256, 255], i * 4)
    const tone = new Float32Array(w * h).map((_, i) => ((i % w) > 10 && (i % w) < 70 ? 1 : 0))
    const src: ToneSource = { type: () => ({ field: tone, fontSize: 9 }), backing: () => ({ field: tone, fontSize: 9 }) }
    const whole = new Uint8ClampedArray(w * h * 4)
    printSheet(whole, s, ground, src, sampledNoise(s, w, h), w, h)
    for (const rows of [1, 10, 33, 77]) {
      const sheet = new Uint8ClampedArray(w * h * 4)
      const band = new Uint8ClampedArray(w * rows * 4)
      const steps = printSheetSteps({ band, rows, put: (y0, y1) => sheet.set(band.subarray(0, (y1 - y0) * w * 4), y0 * w * 4) }, s, ground, src, sampledNoise(s, w, h), w, h)
      while (!steps.next().done);
      expect(sheet).toEqual(whole)
    }
    // ...and the ground it was handed is untouched.
    const again = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) again.set([(i * 5) % 256, (i * 9) % 256, (i * 2) % 256, 255], i * 4)
    expect(ground).toEqual(again)
  })
})

describe('step 6: the ground\'s luminance on a small grid', () => {
  /** The grid read back at every pixel of the sheet. */
  const whole = (g: LumaGrid) => sampleLumaRows(g, 0, g.h, new Float32Array(g.w * g.h))
  /** The harness's test photo (a ramp with a zone plate in it), at sheet size. */
  const photo = (w: number, h: number) => {
    const d = new Uint8ClampedArray(w * h * 4)
    const cx = w / 2
    const cy = h / 2
    const k = Math.PI / (2 * Math.max(w, h))
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1)
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1)
        const r2 = (x - cx) ** 2 + (y - cy) ** 2
        const zone = r2 < (0.3 * h) ** 2 ? 0.5 + 0.5 * Math.cos(k * r2) : 0.5
        const l = Math.min(1, Math.max(0, 0.06 + 0.88 * u + (zone - 0.5) * 0.5))
        d.set([255 * Math.min(1, l * (0.9 + 0.2 * v)), 255 * l, 255 * Math.min(1, l * (1.1 - 0.2 * v)), 255], (y * w + x) * 4)
      }
    }
    return d
  }

  it('is the full-resolution luminance (groundLuma) exactly where the blur is small (one-pixel cells)', () => {
    const w = 90
    const h = 70
    const g = photo(w, h)
    for (const r of [2, 15.5, 31.9]) {
      expect(lumaCell(r)).toBe(1)
      expect(whole(groundLumaGrid(g, w, h, r))).toEqual(groundLuma(g, w, h, r))
    }
    expect(lumaCell(32)).toBe(2)
    expect(lumaCell(510)).toBe(31)
  })

  it('moves the switch and the knockout on under 1% of the pixels, and nothing else (the three conditions)', () => {
    // The default headline (90%) and the band captions live in (40%), on a
    // 1440x1800 sheet. For each: the luminance at full resolution and on the
    // grid; the second ink's split and knockout made from each, exactly as
    // printSheet makes them; the sheet printed from each.
    const w = 1440
    const h = 1800
    const ground = photo(w, h)
    const s = defaultSettings()
    const scale = h / 1800
    const words = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) words[y * w + x] = x % 41 < 30 && y % 53 < 36 ? 0.84 : 0
    const coverage = screenField(words, w, h, { pitch: 9, angle: 75, softness: 0.7, originX: 0, originY: 0 }, new Uint8ClampedArray(w * h))
    const paper = paperField(w, h, { rgb: paperById('natural').rgb, texture: 0.4, blotch: 0.5, seed: 1 })
    const split = splitInks(inkById('black').rgb, inkById('white').rgb)
    const sheet = (lum: Float32Array, threshold: number) => {
      const mask = screenField(bandMask(lum, threshold), w, h, switchScreen(1, s.press, s.seed, scale), new Uint8ClampedArray(w * h))
      const onDark = new Uint8ClampedArray(w * h)
      const onLight = new Uint8ClampedArray(w * h)
      for (let i = 0; i < w * h; i++) {
        onDark[i] = (coverage[i] * (255 - mask[i])) / 255
        onLight[i] = (coverage[i] * mask[i]) / 255
      }
      const knockout = new Uint8ClampedArray(w * h)
      cutKnockoutRows(knockout, 0, words, 0, lum, { w, h, dx: 1.4, dy: -2.2, split: { light: mask, onLightLuma: split.onLightLuma, onDarkLuma: split.onDarkLuma }, y0: 0, y1: h })
      const out = new Uint8ClampedArray(w * h * 4)
      compositeLayers(out, w, h, { ...paper, base: ground, knockout, paperAmount: 1 }, [
        { coverage: onLight, rgb: split.onLight },
        { coverage: onDark, rgb: split.onDark },
      ])
      return { mask, knockout, out }
    }
    for (const size of [0.09, 0.04]) {
      const r = size * h * 1.5
      const full = groundLuma(ground, w, h, r)
      const grid = groundLumaGrid(ground, w, h, r)
      expect(grid.cell).toBeGreaterThan(1)
      expect(grid.grid.length).toBeLessThanOrEqual((w * h) / 16)
      const reduced = whole(grid)
      let worst = 0
      for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(full[i] - reduced[i]))
      expect(worst).toBeLessThan(0.01)
      for (const threshold of [0.35, 0.5, 0.65]) {
        const a = sheet(full, threshold)
        const b = sheet(reduced, threshold)
        let flips = 0
        let elsewhere = 0
        for (let i = 0; i < w * h; i++) {
          const flipped = a.mask[i] !== b.mask[i] || a.knockout[i] !== b.knockout[i]
          if (flipped) {
            flips++
            continue
          }
          // (a) identical where neither the switch nor the knockout moved...
          for (let c = 0; c < 4; c++) elsewhere = Math.max(elsewhere, Math.abs(a.out[i * 4 + c] - b.out[i * 4 + c]))
        }
        expect(elsewhere).toBe(0) // ...(b) within 2 levels a fortiori
        // (c) and they move on under 1% of the pixels.
        expect(flips / (w * h)).toBeLessThan(0.01)
      }
    }
  }, 30_000)

  it('a grain switch mask keeps its ink density (error diffusion re-dithers the band where the inks mix)', () => {
    const w = 800
    const h = 1000
    const ground = photo(w, h)
    const r = 0.09 * h * 1.5
    const full = groundLuma(ground, w, h, r)
    const reduced = whole(groundLumaGrid(ground, w, h, r))
    const cell = grainCell(9, h / 1800)
    for (const threshold of [0.35, 0.5, 0.65]) {
      const a = ditherField(bandMask(full, threshold), w, h, { scale: cell }, new Uint8ClampedArray(w * h))
      const b = ditherField(bandMask(reduced, threshold), w, h, { scale: cell }, new Uint8ClampedArray(w * h))
      let ia = 0
      let ib = 0
      for (let i = 0; i < w * h; i++) {
        ia += a[i]
        ib += b[i]
      }
      expect(Math.abs(ib / ia - 1)).toBeLessThan(0.002)
    }
  })
})

describe('a plate pressed in bands: every band height gives the bytes the whole sheet gets', { timeout: 60_000 }, () => {
  /** Glyph-like tone: soft-edged ellipses of many sizes over the sheet, as
   *  alpha bytes. */
  function tone(w: number, h: number, seed: number): Uint8Array {
    const t = new Uint8Array(w * h)
    const rand = mulberry32(seed)
    for (let k = 0; k < 60; k++) {
      const cx = rand() * w
      const cy = rand() * h
      const r = 4 + rand() * rand() * 160
      const ar = 0.3 + rand() * 1.5
      for (let y = Math.max(0, Math.floor(cy - r * ar - 2)); y < Math.min(h, cy + r * ar + 2); y++) {
        for (let x = Math.max(0, Math.floor(cx - r - 2)); x < Math.min(w, cx + r + 2); x++) {
          const d = Math.hypot(x - cx, (y - cy) / ar) - r
          t[y * w + x] = Math.max(t[y * w + x], Math.round(Math.max(0, Math.min(1, 0.5 - d)) * 255))
        }
      }
    }
    return t
  }

  /** The tone, handed out a window at a time as a NEW array of exactly the
   *  rows asked for (a read past them is a NaN), recording what was asked. */
  function exactRows(field: Uint8Array | Float32Array, w: number, asked?: [number, number][]): ToneRows {
    return {
      rows: (a, b) => {
        asked?.push([a, b])
        return field.slice(a * w, b * w)
      },
    }
  }

  const base = (over: Partial<PressProfile> = {}): PressProfile => ({
    method: 'halftone',
    screenPitch: 9,
    density: 0.84,
    misregistration: 5,
    edge: 0.55,
    wear: 0.22,
    ...over,
  })

  /** The nine presses: [name, press, plate index, font size at 2630 px]. */
  const PRESSES: [string, PressProfile, number, number][] = [
    ['halftone, plate 2, big type', base(), 1, 280],
    ['halftone, plate 1 (never moves), small type (detail < 1)', base(), 0, 30],
    ['halftone, misregistration 30, plate 3', base({ misregistration: 30 }), 2, 90],
    ['halftone, screen 36, plate 4', base({ screenPitch: 36 }), 3, 120],
    ['grain, plate 2', base({ method: 'grain' }), 1, 280],
    ['grain at screen 36, misregistration 30, plate 3', base({ method: 'grain', screenPitch: 36, misregistration: 30 }), 2, 90],
    ['grain at screen 3 (cell 1), small type', base({ method: 'grain', screenPitch: 3 }), 1, 40],
    ['edge 0 (no tear), wear 0.8', base({ edge: 0, wear: 0.8 }), 1, 100],
    ['edge 1, wear 0', base({ edge: 1, wear: 0 }), 1, 200],
  ]

  /** Press one plate whole and in bands of B; count the coverage bytes and
   *  the shifted torn floats (what a knockout under it reads) that differ. */
  function compare(press: PressProfile, index: number, fontSize: number, w: number, h: number, bands: number[], seed = 42) {
    const s = defaultSettings()
    s.seed = seed
    const noise = sampledNoise(s, w, h)
    const field = tone(w, h, 11 + index)
    const whole = pressPlate({ field, fontSize }, index, press, seed, noise, w, h)
    const knock = shiftField(whole.roughened, w, h, whole.dx, whole.dy)
    const geometry = plateGeometry(press, { fontSize, index }, seed, h)
    const results: string[] = []
    const windows: Record<number, number> = {}
    for (const B of bands) {
      const rows = maxWindow([{ geometry, cuts: true }], B, h)
      windows[B] = rows
      const ws = makeWorkspace(rows, w)
      const grain = geometry.grain ? new GrainStream(w, h, geometry.cell) : undefined
      const out = new Uint8ClampedArray(Math.min(B, h) * w)
      const moved = new Float32Array(Math.min(B, h) * w)
      let cov = 0
      let kn = 0
      for (let y0 = 0; y0 < h; y0 += B) {
        const y1 = Math.min(h, y0 + B)
        const r = pressPlateBand({ rows: exactRows(field, w), fontSize }, index, press, seed, noise, w, h, { y0, y1 }, ws, out, { cuts: true, grain })
        expect(r.dx).toBe(whole.dx)
        expect(r.dy).toBe(whole.dy)
        for (let i = 0; i < (y1 - y0) * w; i++) if (r.coverage[i] !== whole.coverage[y0 * w + i]) cov++
        const m = shiftRows(r.torn, w, r.tornRow0, h, r.dx, r.dy, y0, y1, moved.subarray(0, (y1 - y0) * w))
        for (let i = 0; i < (y1 - y0) * w; i++) if (m[i] !== knock[y0 * w + i]) kn++
      }
      results.push(`${B}:${cov}/${kn}`)
    }
    return { results, windows }
  }

  const clean = (bands: number[]) => bands.map((B) => `${B}:0/0`)

  for (const [name, press, index, fontSize] of PRESSES) {
    it(`${name}: 520x2630 (scale 1.46) in bands of 16 to the whole sheet`, () => {
      const bands = [16, 97, 301, 512, 541, 2630]
      expect(compare(press, index, fontSize, 520, 2630, bands).results).toEqual(clean(bands))
    })
    it(`${name}: a small sheet in bands of 1 and 3`, () => {
      // Bands of one row repeat the halo for every row, so they run on a
      // small sheet: 160x620, the type scaled with it.
      const bands = [1, 3, 620]
      expect(compare(press, index, Math.max(4, Math.round((fontSize * 620) / 2630)), 160, 620, bands).results).toEqual(clean(bands))
    })
  }

  it('a narrow sheet 6336 tall (scale 3.52): the default press and grain at 36', () => {
    const bands = [97, 541, 6336]
    expect(compare(base(), 1, 600, 120, 6336, bands).results).toEqual(clean(bands))
    expect(compare(base({ method: 'grain', screenPitch: 36, misregistration: 30 }), 2, 300, 120, 6336, bands).results).toEqual(clean(bands))
  })

  it('the true worst halo: detail 1, grain at 36, misregistration 30, edge 1, wear 0.8, on 260x6336', () => {
    // Type at 0.16 of the height or more is detail 1: the tear at 3 x 3.52 =
    // 10.56 px (reach 10), |dy| up to 30 x 3.52 = 105.6, the grain cell 42.24.
    const worst = base({ method: 'grain', screenPitch: 36, misregistration: 30, edge: 1, wear: 0.8 })
    const bands = [7, 97, 271, 541, 6336]
    for (const index of [1, 3]) {
      const r = compare(worst, index, 0.16 * 6336, 260, 6336, bands)
      expect(r.results).toEqual(clean(bands))
      // The largest window, bands of 541: 728 rows (the band, the tear's
      // three passes, the shift of dy -78.8 or +30.1 for plates 2 and 3 at
      // this seed, and the grain's alignment and look-ahead).
      expect(r.windows[541]).toBe(728)
    }
  }, 120_000)

  it('asks for exactly the glyph rows windowsFor declares, and each end row of them is needed', () => {
    // Random presses (seeded). Sufficient: the press asks for those rows and
    // no others, and the bands it presses from them are the whole sheet's
    // (the tests above). Necessary, end by end: the first and the last glyph
    // row each change a torn row the band hands back (what its wear and its
    // knockout read) when their values change. Real values, not a NaN: a NaN
    // in the blur's running sum never leaves it, so it would reach the torn
    // rows from a row however far above them, and pass for a window much
    // wider than needed. A changed value enters the sum and leaves it again
    // 2r + 1 rows on, so it reaches only the rows the blur really carries it
    // to: a glyph window one row wider than needed would show no change.
    const rand = mulberry32(2024)
    const w = 96
    const h = 1400
    const checked = { first: 0, last: 0 }
    const changed = { first: 0, last: 0 }
    const clone = (g: GrainStream | undefined) => (g ? (Object.assign(Object.create(Object.getPrototypeOf(g)), structuredClone({ ...g })) as GrainStream) : undefined)
    for (let k = 0; k < 12; k++) {
      const press = base({
        method: rand() < 0.5 ? 'grain' : 'halftone',
        screenPitch: 3 + Math.floor(rand() * 34),
        misregistration: Math.floor(rand() * 31),
        edge: 0.2 + rand() * 0.8,
        wear: rand() * 0.8,
      })
      const index = 1 + Math.floor(rand() * 3)
      const fontSize = 20 + rand() * 300
      const seed = Math.floor(rand() * 1e6)
      const s = defaultSettings()
      s.seed = seed
      const noise = sampledNoise(s, w, h)
      // Slanted stripes, as alpha bytes: every row crosses edges the tear's
      // threshold moves, so a changed end row can show. (On the ellipses
      // above, most rows of this narrow sheet are solid ink, where a change
      // two rows away leaves the tear at 1.)
      const fx = 0.2 + rand() * 0.3
      const fy = 0.05 + rand() * 0.2
      const field = toneAsFloat(Uint8Array.from({ length: w * h }, (_, i) => Math.round((0.5 + 0.5 * Math.sin((i % w) * fx + Math.floor(i / w) * fy)) * 255)))
      const geometry = plateGeometry(press, { fontSize, index }, seed, h)
      const B = 64 + Math.floor(rand() * 200)
      const ws = makeWorkspace(maxWindow([{ geometry, cuts: true }], B, h), w)
      const out = new Uint8ClampedArray(B * w)
      const rows = geometry.grain ? new GrainStream(w, h, geometry.cell).rows : undefined
      const grain = geometry.grain ? new GrainStream(w, h, geometry.cell) : undefined
      for (let y0 = 0; y0 < h; y0 += B) {
        const y1 = Math.min(h, y0 + B)
        const win = windowsFor({ y0, y1 }, geometry, h, true, rows)
        // The torn rows this band hands back, from a tone; on a copy of the
        // stream so the real one runs on in order.
        const tornOf = (f: Float32Array) => {
          const r = pressPlateBand({ rows: exactRows(f, w), fontSize }, index, press, seed, noise, w, h, { y0, y1 }, makeWorkspace(win.glyph.b - win.glyph.a + B, w), new Uint8ClampedArray(B * w), { cuts: true, grain: clone(grain) })
          return r.torn.slice((win.torn.a - r.tornRow0) * w, (win.torn.b - r.tornRow0) * w)
        }
        const asIs = win.glyph.b > win.glyph.a ? tornOf(field) : null
        for (const end of ['first', 'last'] as const) {
          const row = end === 'first' ? win.glyph.a : win.glyph.b - 1
          // At the sheet's own edge a window cannot be shorter.
          if (!asIs || (end === 'first' && row === 0) || (end === 'last' && row === h - 1)) continue
          const other = field.slice()
          for (let i = row * w; i < (row + 1) * w; i++) other[i] = 1 - other[i]
          checked[end]++
          if (tornOf(other).some((v, i) => v !== asIs[i])) changed[end]++
        }
        const asked: [number, number][] = []
        pressPlateBand({ rows: exactRows(field, w, asked), fontSize }, index, press, seed, noise, w, h, { y0, y1 }, ws, out, { cuts: true, grain })
        expect(asked).toEqual(win.glyph.b > win.glyph.a ? [[win.glyph.a, win.glyph.b]] : [])
      }
    }
    // Each end changes the torn rows in every band. A window one row too
    // wide at an end would show it in none.
    expect(checked.first).toBeGreaterThan(50)
    expect(checked.last).toBeGreaterThan(50)
    expect(changed).toEqual(checked)
  }, 60_000)
})
