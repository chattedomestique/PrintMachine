/**
 * The export's memory diet (plan WP2.7). An export at a photo's own
 * resolution is 11-17 MP, so every sheet-sized buffer is 45-67 MB of a
 * phone's memory. The steps that only change what is HELD must not change a
 * pixel; the ones that change pixels are made in the stages the preview
 * shares, and held to a bound.
 */

import { describe, expect, it } from 'vitest'

import { FbmSampler, ValueNoiseSampler, fbm2D, mulberry32, mulberryAt, valueNoise2D } from './rng.ts'
import { PaperSampler, paperField } from './paper.ts'
import { ensureCache, pressPlate, printSheet, sampledNoise, toneAsFloat, type ToneSource } from './render.ts'
import { inkById, paperById } from './inks.ts'
import { screenField } from './screen.ts'
import { ditherField } from './dither.ts'
import { knockoutMask } from './knockout.ts'
import { compositeLayers } from './composite.ts'
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
