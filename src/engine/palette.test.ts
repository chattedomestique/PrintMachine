/**
 * The palette (palette.ts): Border Studio's port, held to Border Studio's own
 * hex on Border Studio's own sample, and the four colours' rules.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { framePalette, hexToHsl, hslHex, hslToRgb, rgbToHex, rgbToHsl } from './palette.ts'
import { mulberry32 } from './rng.ts'
import { paletteSamples } from './__tests__/paletteSamples.ts'
import borderStudio from './__fixtures__/palettes-597ce7a.json'

const refs = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../scripts/parity-borders/refs.json'), 'utf8')) as {
  borders_sha: string
  photos: { id: string; sample: [number, number, number][]; hex: Record<'photo' | 'deep' | 'muted' | 'comp', string> }[]
}

/** [r, g, b] pixels as the RGBA bytes the palette reads, opaque. */
const rgbaOf = (px: readonly (readonly number[])[], alpha = 255) => Uint8ClampedArray.from(px.flatMap(([r, g, b]) => [r, g, b, alpha]))

/** A photo of one colour, n pixels. */
const flat = (rgb: readonly number[], n = 400) => rgbaOf(Array.from({ length: n }, () => rgb))

describe("the port: Border Studio's sample in, Border Studio's hex out", () => {
  it('reads the references it is held to', () => {
    expect(refs.borders_sha.startsWith('597ce7a')).toBe(true)
    expect(refs.photos.map((p) => p.id)).toEqual(['block-land', 'block-port'])
    for (const p of refs.photos) expect(p.sample.length).toBeGreaterThan(1000)
  })

  for (const p of refs.photos) {
    it(`${p.id}: Photo, Deep, Muted and Comp are Border Studio's exactly`, () => {
      // The sample Border Studio's own sampler took (alpha >= 125 kept), and
      // the four hex its buildBorderSuggestions keyed from it: compared by id.
      expect(framePalette(rgbaOf(p.sample))).toEqual(p.hex)
    })
  }

  it('the two photos key two different heroes (the port is tested twice, not once)', () => {
    expect(refs.photos[0].hex.photo).not.toBe(refs.photos[1].hex.photo)
  })

  // The block photos are flat colour, which a median cut splits the same
  // way whatever its depth or weights. These look like photographs (a sky's
  // gradient, subjects, noise, a grey scene with a cast, a dark one, pastel)
  // and Border Studio's own palette.js keyed each (the fixture says how).
  it("photograph-like samples: every colour is Border Studio's exactly", () => {
    const samples = paletteSamples()
    expect(borderStudio.borders_sha).toBe(refs.borders_sha)
    expect(samples.map((s) => s.name)).toEqual(borderStudio.samples.map((s) => s.name))
    const differ = samples.filter((s, i) => JSON.stringify(framePalette(s.rgba)) !== JSON.stringify(borderStudio.samples[i].hex))
    expect(differ.map((s) => s.name)).toEqual([])
    // The grey scenes take their hue from the undertone (a hero under
    // saturation 6), so that path is held too.
    const greyHeroes = borderStudio.samples.filter((s) => s.name.startsWith('grey-cast'))
    expect(greyHeroes.length).toBeGreaterThan(0)
  })
})

describe('the four colours', () => {
  it('the same sample gives the same hex, every time', () => {
    const rng = mulberry32(7)
    const px = Array.from({ length: 84 * 56 }, () => [Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)])
    const a = framePalette(rgbaOf(px))
    expect(framePalette(rgbaOf(px))).toEqual(a)
    expect(Object.keys(a ?? {})).toEqual(['photo', 'deep', 'muted', 'comp'])
    for (const hex of Object.values(a ?? {})) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('a photo of one colour is that colour as Photo, when its lightness is inside 22..78', () => {
    const rng = mulberry32(11)
    let tried = 0
    while (tried < 300) {
      const rgb = [Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)]
      const [, , l] = rgbToHsl(rgb[0], rgb[1], rgb[2])
      if (l < 22 || l > 78) continue
      tried++
      expect(framePalette(flat(rgb))?.photo).toBe(rgbToHex(rgb[0], rgb[1], rgb[2]))
    }
  })

  it('Deep is darker than Photo (lightness 12 against at least 22)', () => {
    const rng = mulberry32(3)
    for (let i = 0; i < 300; i++) {
      const p = framePalette(flat([Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)]))!
      expect(hexToHsl(p.deep).l).toBeLessThan(hexToHsl(p.photo).l)
      expect(hexToHsl(p.deep).l).toBeCloseTo(12, 0)
    }
  })

  it("Muted's lightness, read back from its hex, is 66 within 0.25 (each channel is rounded)", () => {
    let worst = 0
    for (let h = 0; h < 360; h += 7) {
      for (let s = 0; s <= 100; s += 3) {
        const p = framePalette(flat(hslToRgb(h, s, 50)))!
        worst = Math.max(worst, Math.abs(hexToHsl(p.muted).l - 66))
      }
    }
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThanOrEqual(0.25)
  })

  it("Comp lands on roughly the opposite hue of the photo's colour", () => {
    for (const hex of ['#c9622c', '#2a3d66', '#123c2a', '#f4c24e', '#2896c8', '#d2463c']) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      const p = framePalette(flat([r, g, b]))!
      const turn = (((hexToHsl(p.comp).h - hexToHsl(p.photo).h) % 360) + 360) % 360
      // OKLCH and HSL hues differ, but about half a turn.
      expect(Math.abs(turn - 180)).toBeLessThan(60)
    }
  })

  it('a near-grey hero over a tinted photo takes its hue from the undertone, not 0', () => {
    // Mostly a mid grey with a slight blue cast (saturation under 6), a
    // little strong blue: the grey is the hero, the blue is the undertone.
    const grey = Array.from({ length: 900 }, () => [120, 122, 130])
    const blue = Array.from({ length: 100 }, () => [30, 60, 200])
    const p = framePalette(rgbaOf([...grey, ...blue]))!
    expect(hexToHsl(p.deep).h).toBeGreaterThan(200)
    expect(hexToHsl(p.deep).h).toBeLessThan(250)
    // A truly grey photo has a grey undertone, and hue 0 is right for it.
    const g = framePalette(flat([128, 128, 128]))!
    expect(hexToHsl(g.deep).h).toBe(0)
  })

  it('a pixel with alpha under 125 is not part of the colour (a transparent PNG does not key black)', () => {
    const red = Array.from({ length: 300 }, () => [210, 70, 60])
    // A cyan more saturated than the red: counted, it would be the hero.
    const cyan = Array.from({ length: 700 }, () => [20, 200, 230])
    const redOnly = framePalette(rgbaOf(red))
    expect(framePalette(Uint8ClampedArray.from([...rgbaOf(red), ...rgbaOf(cyan, 100)]))).toEqual(redOnly)
    expect(framePalette(Uint8ClampedArray.from([...rgbaOf(red), ...rgbaOf(cyan, 125)]))).not.toEqual(redOnly)
    // A transparent PNG's clear pixels read back black at alpha 0: skipped.
    const black = Array.from({ length: 700 }, () => [0, 0, 0])
    expect(framePalette(Uint8ClampedArray.from([...rgbaOf(red), ...rgbaOf(black, 0)]))).toEqual(redOnly)
    // Nothing opaque enough: no colour at all.
    expect(framePalette(rgbaOf(black, 0))).toBeNull()
  })

  it('all four, always, even when two are the same hex (Border Studio dropped the later one)', () => {
    // A hero at saturation 12 and lightness 66 is its own Muted.
    let found = 0
    for (let h = 0; h < 360; h += 5) {
      const rgb = hslToRgb(h, 12, 66)
      const p = framePalette(flat(rgb))!
      if (p.photo !== p.muted) continue
      found++
      expect(Object.keys(p)).toEqual(['photo', 'deep', 'muted', 'comp'])
    }
    expect(found).toBeGreaterThan(10)
  })
})

// Border Studio's colour-maths tests (palette.test.js at 597ce7a), for the
// conversions the four colours go through. Its re-roll tests are not
// ported: the re-roll is cut.
describe('rgb <-> hsl', () => {
  it('maps the primaries to canonical HSL', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 100, 50])
    expect(rgbToHsl(0, 255, 0)).toEqual([120, 100, 50])
    expect(rgbToHsl(0, 0, 255)).toEqual([240, 100, 50])
  })

  it('has zero saturation for greys (hue is irrelevant)', () => {
    const [, s, l] = rgbToHsl(128, 128, 128)
    expect(s).toBe(0)
    expect(Math.round(l)).toBe(50)
  })

  it('round-trips rgb -> hsl -> rgb within 1 LSB', () => {
    const samples = [
      [201, 98, 44],
      [42, 61, 102],
      [18, 60, 42],
      [244, 194, 78],
      [0, 0, 0],
      [255, 255, 255],
      [7, 200, 133],
      [130, 20, 210],
    ]
    for (const [r, g, b] of samples) {
      const [h, s, l] = rgbToHsl(r, g, b)
      const [r2, g2, b2] = hslToRgb(h, s, l)
      expect(Math.abs(r2 - r)).toBeLessThanOrEqual(1)
      expect(Math.abs(g2 - g)).toBeLessThanOrEqual(1)
      expect(Math.abs(b2 - b)).toBeLessThanOrEqual(1)
    }
  })

  it('wraps hue modulo 360 (0 === 360 === -360)', () => {
    expect(hslToRgb(360, 100, 50)).toEqual(hslToRgb(0, 100, 50))
    expect(hslToRgb(-360, 100, 50)).toEqual(hslToRgb(0, 100, 50))
    expect(hslToRgb(390, 80, 40)).toEqual(hslToRgb(30, 80, 40))
  })

  it('clamps lightness extremes to black and white', () => {
    expect(hslToRgb(200, 50, 0)).toEqual([0, 0, 0])
    expect(hslToRgb(200, 50, 100)).toEqual([255, 255, 255])
  })

  it('formats and clamps channels to a 6-digit hex', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000')
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff')
    expect(rgbToHex(201, 98, 44)).toBe('#c9622c')
    expect(rgbToHex(-5, 300, 128)).toBe('#00ff80')
  })

  it('hexToHsl -> hslHex is identity for representable colours', () => {
    for (const hex of ['#c9622c', '#2a3d66', '#123c2a', '#f4c24e', '#000000', '#ffffff']) {
      const { h, s, l } = hexToHsl(hex)
      expect(hslHex(h, s, l)).toBe(hex)
    }
  })
})
