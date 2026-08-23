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
import { alignOffset, justifyOffsets, layoutText } from './text.ts'
import { blurField } from './blur.ts'
import { roughenEdges } from './rough.ts'
import { applyDropoutPatches, applySmear, applyStreaks } from './misprint.ts'
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

describe('blur', () => {
  it('preserves a constant field — no edge rim from the window seed', () => {
    // The classic box-blur bug seeds the running sum from a negative index and
    // double-counts the edge sample, which shows up as a bright rim. On a
    // constant field any such error is immediately visible.
    const flat = new Float32Array(W * H).fill(0.4)
    const out = blurField(flat, W, H, 3)
    for (const v of out) expect(v).toBeCloseTo(0.4, 5)
  })

  it('conserves total mass to within rounding', () => {
    const f = ramp()
    const before = f.reduce((a, b) => a + b, 0)
    const after = blurField(f, W, H, 2).reduce((a, b) => a + b, 0)
    // Edge clamping redistributes slightly; a gross mismatch means a bug.
    expect(after / before).toBeGreaterThan(0.95)
    expect(after / before).toBeLessThan(1.05)
  })

  it('is a copy, not a reference, at radius 0', () => {
    const f = ramp()
    const out = blurField(f, W, H, 0)
    expect(out).not.toBe(f)
    expect(Array.from(out)).toEqual(Array.from(f))
  })
})

describe('rough edges', () => {
  const solidSquare = (): Float32Array => {
    const f = new Float32Array(W * H)
    for (let y = 6; y < H - 6; y++) for (let x = 6; x < W - 6; x++) f[y * W + x] = 1
    return f
  }

  it('is a no-op when both roughness and bleed are zero', () => {
    const f = solidSquare()
    expect(roughenEdges(f, W, H, { roughness: 0, scale: 3, bleed: 0, seed: 1 })).toBe(f)
  })

  it('never punches holes in the middle of a solid', () => {
    const out = roughenEdges(solidSquare(), W, H, { roughness: 1, scale: 3, bleed: 0, seed: 5 })
    // Well inside the square, ink must still be solid however torn the edge is.
    for (let y = 11; y < H - 11; y++) {
      for (let x = 11; x < W - 11; x++) expect(out[y * W + x]).toBe(1)
    }
  })

  it('leaves bare paper bare', () => {
    const out = roughenEdges(new Float32Array(W * H), W, H, {
      roughness: 1,
      scale: 3,
      bleed: 1,
      seed: 5,
    })
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('stays in range and actually moves the edge', () => {
    const src = solidSquare()
    const out = roughenEdges(src, W, H, { roughness: 0.8, scale: 3, bleed: 0.5, seed: 9 })
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(Array.from(out)).not.toEqual(Array.from(src))
  })

  it('bleed grows the shape rather than shrinking it', () => {
    const src = solidSquare()
    const sum = (f: Float32Array) => f.reduce((a, b) => a + b, 0)
    const bled = roughenEdges(src, W, H, { roughness: 0, scale: 2, bleed: 1, seed: 3 })
    expect(sum(bled)).toBeGreaterThan(sum(src))
  })
})

describe('misprints', () => {
  const inked = (): Float32Array => new Float32Array(W * H).fill(0.8)

  it('are all no-ops at zero', () => {
    const f = inked()
    expect(applyStreaks(f, W, H, 0, 1)).toBe(f)
    expect(applySmear(f, W, H, 0)).toBe(f)
    expect(applyDropoutPatches(f, W, H, 0, 1)).toBe(f)
  })

  it('keep coverage in range', () => {
    let f = applyStreaks(inked(), W, H, 1, 3)
    f = applySmear(f, W, H, 1)
    f = applyDropoutPatches(f, W, H, 1, 3)
    for (const v of f) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('streaks and patches only ever remove ink', () => {
    const src = inked()
    const streaked = applyStreaks(src, W, H, 1, 7)
    for (let i = 0; i < src.length; i++) expect(streaked[i]).toBeLessThanOrEqual(src[i] + 1e-6)
    const patched = applyDropoutPatches(src, W, H, 1, 7)
    for (let i = 0; i < src.length; i++) expect(patched[i]).toBeLessThanOrEqual(src[i] + 1e-6)
  })

  it('smear cannot invent ink on a blank sheet', () => {
    const out = applySmear(new Float32Array(W * H), W, H, 1)
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('smear trails downward, never upward', () => {
    // A single inked row: the drag must appear below it and nowhere above.
    const f = new Float32Array(W * H)
    for (let x = 0; x < W; x++) f[10 * W + x] = 1
    const out = applySmear(f, W, H, 1)
    for (let x = 0; x < W; x++) {
      expect(out[9 * W + x]).toBe(0)
      expect(out[12 * W + x]).toBeGreaterThan(0)
    }
  })
})

describe('forced justification', () => {
  it('makes every line exactly the target width', () => {
    const widths = [10, 20, 30]
    const xs = justifyOffsets(widths, 100)
    // Last glyph's right edge lands on the target.
    expect(xs[2] + widths[2]).toBeCloseTo(100, 6)
  })

  it('spaces every gap equally', () => {
    const widths = [10, 10, 10, 10]
    const xs = justifyOffsets(widths, 70)
    const gaps = [xs[1] - xs[0] - 10, xs[2] - xs[1] - 10, xs[3] - xs[2] - 10]
    for (const g of gaps) expect(g).toBeCloseTo(10, 6)
  })

  it('never returns a negative gap when justifying to the widest line', () => {
    // The bug this guards: targeting an arbitrary measure narrower than the
    // line pulls glyphs on top of each other and swallows word spaces. The
    // target must be the widest natural line, so slack is never negative.
    const lines = [[10, 10], [10, 10, 10], [40, 5]]
    const naturals = lines.map((l) => l.reduce((a, b) => a + b, 0))
    const target = Math.max(...naturals)
    for (const widths of lines) {
      const xs = justifyOffsets(widths, target)
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(widths[i - 1] - 1e-9)
      }
    }
  })

  it('leaves a single glyph where it is rather than scaling it', () => {
    expect(justifyOffsets([12], 500)).toEqual([0])
  })

  it('starts every line at the block origin', () => {
    expect(justifyOffsets([5, 5, 5], 60)[0]).toBe(0)
    expect(alignOffset(40, 100, 'justify')).toBe(0)
  })
})
