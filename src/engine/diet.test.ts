/**
 * The export's memory diet (plan WP2.7). An export at a photo's own
 * resolution is 11-17 MP, so every sheet-sized buffer is 45-67 MB of a
 * phone's memory. The steps that only change what is HELD must not change a
 * pixel; the ones that change pixels are made in the stages the preview
 * shares, and held to a bound.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { FbmSampler, ValueNoiseSampler, fbm2D, mulberry32, mulberryAt, valueNoise2D } from './rng.ts'
import { PaperSampler, paperField } from './paper.ts'
import { ensureCache, grainCell, makeWorkspace, pressPlate, printSheet, printSheetSteps, sampledNoise, switchScreen, toneAsFloat, type ToneSource } from './render.ts'
import { bandMask, groundLuma, groundLumaGrid, lumaCell, sampleLuma, splitInks } from './media.ts'
import { inkById, paperById } from './inks.ts'
import { screenField } from './screen.ts'
import { ditherField } from './dither.ts'
import { cutKnockout } from './knockout.ts'
import { knockoutMask, shiftField } from './__tests__/reference.ts'
import { applyDensity, applyMottle, shiftInPlace } from './ink.ts'
import { blurInPlace } from './blur.ts'
import { roughenInPlace } from './rough.ts'
import { clampByte, compositeLayers } from './composite.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'
import type { PrintSettings } from './types.ts'

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
    // The audit's gate (s7 item 7): three overlapping plates of type-like
    // blocks at the default ink density, screened with the dot's soft edge,
    // over a photo and over paper, composited from floats and from bytes.
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

  it('shifting in place gives shiftField\'s field, for any offset either way', () => {
    const w = 37
    const h = 29
    for (const dx of [0, 0.4, -0.4, 1, -1, 2.7, -3.25, 0.999]) {
      for (const dy of [0, 0.3, -0.3, 1, -2, 4.6, -1.01]) {
        const src = field(w, h)
        const inPlace = src.slice()
        shiftInPlace(inPlace, w, h, dx, dy)
        expect(sha(inPlace)).toBe(sha(shiftField(src, w, h, dx, dy)))
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

  it('a knockout cut straight into the running bytes is knockoutMask, rounded, deepest cut kept', () => {
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
    cutKnockout(into, rough.slice(), lum, p)
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
      const ws = makeWorkspace(w * h)
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

  it('is groundLuma exactly where the blur is small (one-pixel cells)', () => {
    const w = 90
    const h = 70
    const g = photo(w, h)
    for (const r of [2, 15.5, 31.9]) {
      expect(lumaCell(r)).toBe(1)
      expect(sampleLuma(groundLumaGrid(g, w, h, r), new Float32Array(w * h))).toEqual(groundLuma(g, w, h, r))
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
      cutKnockout(knockout, words.slice(), lum, { w, h, dx: 1.4, dy: -2.2, split: { light: mask, onLightLuma: split.onLightLuma, onDarkLuma: split.onDarkLuma } })
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
      const reduced = sampleLuma(grid, new Float32Array(w * h))
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
    const reduced = sampleLuma(groundLumaGrid(ground, w, h, r), new Float32Array(w * h))
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
