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
import { ensureCache, printSheet, sampledNoise, type ToneSource } from './render.ts'
import { paperById } from './inks.ts'
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
