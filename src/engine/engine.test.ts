/**
 * Engine tests.
 *
 * The engine is framework-free maths, which makes it the only part of this app
 * that is both cheap to test and genuinely worth testing (playbook §12.1).
 * These target the non-obvious invariants — the null case, range guarantees,
 * the overprint model, and the layout maths — rather than chasing coverage.
 */

import { describe, expect, it } from 'vitest'

import { compositeLayers } from './composite.ts'
import { ditherField } from './dither.ts'
import { applyDensity, applyMottle, registrationOffset, shiftField } from './ink.ts'
import { inkById, overprint, paperById, RISO_INKS } from './inks.ts'
import { paperField } from './paper.ts'
import { mulberry32, valueNoise2D } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { alignOffset, layoutText } from './text.ts'
import type { TextLayer } from './types.ts'

const W = 24
const H = 24

const ramp = (): Float32Array => {
  const f = new Float32Array(W * H)
  for (let i = 0; i < f.length; i++) f[i] = (i % W) / (W - 1)
  return f
}

describe('composite — the subtractive overprint model', () => {
  it('leaves paper untouched where nothing is printed', () => {
    const out = new Uint8ClampedArray(W * H * 4)
    const paper = { shade: new Float32Array(W * H).fill(1), rgb: [242, 239, 230] as const }
    compositeLayers(out, W, H, paper, [
      { coverage: new Float32Array(W * H), rgb: [255, 72, 176], opacity: 1 },
    ])
    expect([out[0], out[1], out[2], out[3]]).toEqual([242, 239, 230, 255])
  })

  it('reproduces the ink colour exactly at full coverage on white', () => {
    const out = new Uint8ClampedArray(4)
    const paper = { shade: new Float32Array(1).fill(1), rgb: [255, 255, 255] as const }
    compositeLayers(out, 1, 1, paper, [
      { coverage: new Float32Array(1).fill(1), rgb: [255, 72, 176], opacity: 1 },
    ])
    expect([out[0], out[1], out[2]]).toEqual([255, 72, 176])
  })

  it('multiplies two inks where they overlap rather than replacing', () => {
    const out = new Uint8ClampedArray(4)
    const paper = { shade: new Float32Array(1).fill(1), rgb: [255, 255, 255] as const }
    const pink = [255, 72, 176] as const
    const blue = [0, 120, 191] as const
    compositeLayers(out, 1, 1, paper, [
      { coverage: new Float32Array(1).fill(1), rgb: blue, opacity: 1 },
      { coverage: new Float32Array(1).fill(1), rgb: pink, opacity: 1 },
    ])
    // Not the top layer, and matches the standalone overprint helper the UI
    // uses to preview the pairing — the two must not be able to drift apart.
    expect([out[0], out[1], out[2]]).not.toEqual([...pink])
    expect([out[0], out[1], out[2]]).toEqual(overprint(blue, pink))
  })

  it('always writes an opaque pixel — a print has no transparency', () => {
    const out = new Uint8ClampedArray(W * H * 4)
    compositeLayers(out, W, H, paperField(W, H, { rgb: [242, 239, 230], texture: 0.5, blotch: 0.5, seed: 7 }), [])
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255)
  })
})

describe('screen', () => {
  it('never produces coverage outside [0,1]', () => {
    for (const shape of ['circle', 'square', 'line', 'ellipse', 'cross', 'diamond'] as const) {
      const cov = screenField(ramp(), W, H, {
        shape,
        pitch: 5,
        angle: 37,
        softness: 0.7,
        originX: 2.4,
        originY: -1.1,
      })
      for (const v of cov) expect(v).toBeGreaterThanOrEqual(0)
      for (const v of cov) expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('prints nothing from a zero tone field — the null case is truly null', () => {
    const cov = screenField(new Float32Array(W * H), W, H, {
      shape: 'circle',
      pitch: 6,
      angle: 45,
      softness: 0.7,
      originX: 0,
      originY: 0,
    })
    expect(cov.every((v) => v === 0)).toBe(true)
  })

  it('lays down more ink as tone rises', () => {
    const total = (tone: number) => {
      const f = new Float32Array(W * H).fill(tone)
      return screenField(f, W, H, {
        shape: 'circle',
        pitch: 6,
        angle: 45,
        softness: 0.7,
        originX: 0,
        originY: 0,
      }).reduce((a, b) => a + b, 0)
    }
    expect(total(0.25)).toBeLessThan(total(0.5))
    expect(total(0.5)).toBeLessThan(total(0.9))
  })

  it('gives adjacent plates different angles so their screens beat', () => {
    expect(defaultAngle(0)).not.toBe(defaultAngle(1))
    expect(defaultAngle(1)).not.toBe(defaultAngle(2))
    // Wraps rather than running off the end of the table.
    expect(defaultAngle(4)).toBe(defaultAngle(0))
  })
})

describe('dither', () => {
  it('produces a strictly binary field for every diffusing algorithm', () => {
    for (const type of ['atkinson', 'floydsteinberg', 'bayer', 'threshold'] as const) {
      const out = ditherField(ramp(), W, H, type, 0.5)
      for (const v of out) expect(v === 0 || v === 1).toBe(true)
    }
  })

  it('does not mutate the tone field it was given', () => {
    const tone = ramp()
    const before = Float32Array.from(tone)
    ditherField(tone, W, H, 'floydsteinberg', 0.5)
    expect(Array.from(tone)).toEqual(Array.from(before))
  })

  it('tracks the input tone on average', () => {
    const mean = (f: Float32Array) => f.reduce((a, b) => a + b, 0) / f.length
    const tone = new Float32Array(64 * 64).fill(0.3)
    const out = ditherField(tone, 64, 64, 'floydsteinberg', 0.5)
    expect(mean(out)).toBeGreaterThan(0.2)
    expect(mean(out)).toBeLessThan(0.4)
  })
})

describe('ink', () => {
  it('caps tone at the density ceiling — riso ink never reaches solid', () => {
    const out = applyDensity(new Float32Array(8).fill(1), 0.84, 1)
    for (const v of out) expect(v).toBeCloseTo(0.84, 6)
  })

  it('keeps mottled coverage in range even at extreme settings', () => {
    const cov = new Float32Array(W * H).fill(0.9)
    const noise = valueNoise2D(W, H, 4, 99)
    const speckle = valueNoise2D(W, H, 1, 7)
    const out = applyMottle(cov, noise, speckle, 0.8, 0.5)
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0)
    for (const v of out) expect(v).toBeLessThanOrEqual(1)
  })

  it('leaves bare paper bare — mottle cannot invent ink', () => {
    const out = applyMottle(
      new Float32Array(W * H),
      valueNoise2D(W, H, 4, 1),
      valueNoise2D(W, H, 1, 2),
      0.8,
      0.1,
    )
    expect(out.every((v) => v === 0)).toBe(true)
  })

  describe('shiftField', () => {
    it('is the identity for a zero offset', () => {
      const src = ramp()
      expect(Array.from(shiftField(src, W, H, 0, 0))).toEqual(Array.from(src))
    })

    it('translates by whole pixels exactly', () => {
      const src = ramp()
      const out = shiftField(src, W, H, 3, 0)
      for (let y = 0; y < H; y++) {
        for (let x = 3; x < W; x++) {
          expect(out[y * W + x]).toBeCloseTo(src[y * W + (x - 3)], 5)
        }
      }
    })

    it('reveals bare paper rather than smearing the edge pixel', () => {
      // A field that is solid everywhere: if the edge were clamped, shifting
      // would keep it solid. Uncovered rows must come back empty instead.
      const solid = new Float32Array(W * H).fill(1)
      const out = shiftField(solid, W, H, 0, 4)
      for (let x = 0; x < W; x++) expect(out[x]).toBe(0)
      expect(out[6 * W]).toBe(1)
    })

    it('never returns a value outside the source range', () => {
      const out = shiftField(ramp(), W, H, -2.7, 3.4)
      for (const v of out) expect(v).toBeGreaterThanOrEqual(0)
      for (const v of out) expect(v).toBeLessThanOrEqual(1)
    })
  })

  describe('registrationOffset', () => {
    it('leaves the first plate as the registration reference', () => {
      expect(registrationOffset(123, 0, 20)).toEqual({ dx: 0, dy: 0 })
    })

    it('never exceeds the requested amount', () => {
      for (let seed = 0; seed < 40; seed++) {
        for (let plate = 1; plate < 5; plate++) {
          const { dx, dy } = registrationOffset(seed, plate, 6)
          expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(6 + 1e-9)
        }
      }
    })

    it('is deterministic, so the export matches the preview', () => {
      expect(registrationOffset(42, 2, 5)).toEqual(registrationOffset(42, 2, 5))
    })

    it('gives different plates different offsets', () => {
      expect(registrationOffset(42, 1, 5)).not.toEqual(registrationOffset(42, 2, 5))
    })
  })
})

describe('paper', () => {
  it('is perfectly flat when both texture controls are zero', () => {
    const { shade } = paperField(W, H, { rgb: [242, 239, 230], texture: 0, blotch: 0, seed: 3 })
    expect(shade.every((v) => v === 1)).toBe(true)
  })

  it('stays within a plausible shading range at full strength', () => {
    const { shade } = paperField(W, H, { rgb: [242, 239, 230], texture: 1, blotch: 1, seed: 3 })
    for (const v of shade) {
      expect(v).toBeGreaterThan(0.75)
      expect(v).toBeLessThan(1.25)
    }
  })
})

describe('rng', () => {
  it('is reproducible from a seed', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    for (let i = 0; i < 20; i++) expect(a()).toBe(b())
  })

  it('stays in [0,1)', () => {
    const r = mulberry32(11)
    for (let i = 0; i < 500; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('text layout', () => {
  const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
    id: 't',
    text: 'AB\nCDEF',
    inkId: 'black',
    fontId: 'grotesk',
    weight: 700,
    size: 0.1,
    lineHeight: 1,
    tracking: 0,
    align: 'left',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    caps: false,
    opacity: 1,
    fitWidth: false,
    ...over,
  })

  // A stand-in for the browser: every glyph is exactly half the font size wide.
  const measure = (text: string, size: number) => text.length * size * 0.5

  it('scales the block so its widest line fills the target width', () => {
    const out = layoutText(layer({ fitWidth: true }), 1000, 600, measure)
    expect(out.widest).toBeCloseTo(600, 5)
  })

  it('scales tracking with the type, so fitting does not change the letterfit', () => {
    const plain = layoutText(layer({ tracking: 0.1 }), 1000, 600, measure)
    const fitted = layoutText(layer({ tracking: 0.1, fitWidth: true }), 1000, 600, measure)
    expect(fitted.tracking / fitted.fontSize).toBeCloseTo(plain.tracking / plain.fontSize, 6)
  })

  it('uppercases before measuring when caps is on', () => {
    const out = layoutText(layer({ text: 'ab', caps: true }), 1000, 600, measure)
    expect(out.lines[0].text).toBe('AB')
  })

  it('counts blank lines in the block height so stanza spacing survives', () => {
    const out = layoutText(layer({ text: 'A\n\nB' }), 1000, 600, measure)
    expect(out.lines).toHaveLength(3)
    expect(out.blockHeight).toBeCloseTo(out.lineHeight * 3, 5)
  })

  it('aligns lines within the block', () => {
    expect(alignOffset(40, 100, 'left')).toBe(0)
    expect(alignOffset(40, 100, 'center')).toBe(30)
    expect(alignOffset(40, 100, 'right')).toBe(60)
  })
})

describe('ink table', () => {
  it('has unique ids so a persisted setting resolves to one ink', () => {
    expect(new Set(RISO_INKS.map((i) => i.id)).size).toBe(RISO_INKS.length)
  })

  it('falls back rather than throwing on an id from an older build', () => {
    expect(inkById('a-colour-that-was-removed')).toBe(RISO_INKS[0])
    expect(paperById('nonexistent').id).toBe('natural')
  })

  it('stores every channel as a byte', () => {
    for (const ink of RISO_INKS) {
      for (const c of ink.rgb) {
        expect(Number.isInteger(c)).toBe(true)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })
})
