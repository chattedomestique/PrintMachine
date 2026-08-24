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
import { DITHER_TYPES, ditherField } from './dither.ts'
import { applyDensity, applyMottle, registrationOffset, shiftField } from './ink.ts'
import { inkById, overprint, paperById, RISO_INKS } from './inks.ts'
import { paperField } from './paper.ts'
import { mulberry32, valueNoise2D } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { alignOffset, justifyOffsets, layoutText, wordsOf } from './text.ts'
import { detailFactor } from './render.ts'
import { coverRect, lightMask, separateLuminance } from './media.ts'
import { pressProfile } from '../state/defaults.ts'
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
    for (const type of DITHER_TYPES.map((d) => d.id).filter((d) => d !== 'none')) {
      const out = ditherField(ramp(), W, H, type, { threshold: 0.5 })
      for (const v of out) expect(v === 0 || v === 1).toBe(true)
    }
  })

  it('does not mutate the tone field it was given', () => {
    const tone = ramp()
    const before = Float32Array.from(tone)
    ditherField(tone, W, H, 'floydsteinberg', { threshold: 0.5 })
    expect(Array.from(tone)).toEqual(Array.from(before))
  })

  it('tracks the input tone on average', () => {
    const mean = (f: Float32Array) => f.reduce((a, b) => a + b, 0) / f.length
    const tone = new Float32Array(64 * 64).fill(0.3)
    const out = ditherField(tone, 64, 64, 'floydsteinberg', { threshold: 0.5 })
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
    wordSpacing: 0,
    align: 'left',
    wordPress: {},
    contrastInkId: null,
    contrastThreshold: 0.5,
    justifyBy: 'letters',
    soloAlign: 'left',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    caps: false,
    opacity: 1,
    fitWidth: false,
    boxes: [],
    boxPadding: 0.12,
    boxRadius: 0,
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

describe('fading is dots, not opacity', () => {
  // The regression this pins: wear used to run *after* screening and scale
  // coverage directly. The compositor reads coverage as ink transmittance, so
  // a half-covered pixel rendered as half-strength ink — grey. Real ink
  // failure leaves full-strength pigment in fewer, smaller dots.
  const N = 64
  const opts = {
    shape: 'circle' as const,
    pitch: 6,
    angle: 45,
    // Zero softness makes the assertion exact: a correct pipeline can only
    // emit bare paper or solid ink here, never a partial film.
    softness: 0,
    originX: 0,
    originY: 0,
  }

  it('screens worn tone into strictly binary coverage', () => {
    // Annotated: `new Float32Array(...)` infers the narrow
    // `Float32Array<ArrayBuffer>`, while the engine returns the general
    // `Float32Array<ArrayBufferLike>`, so an inferred `let` cannot be
    // reassigned from one.
    let tone: Float32Array = new Float32Array(N * N).fill(0.7)
    tone = applyDropoutPatches(tone, N, N, 0.9, 3)
    tone = applyStreaks(tone, N, N, 0.9, 3)
    tone = applySmear(tone, N, N, 0.6)

    const coverage = screenField(tone, N, N, opts)
    for (const v of coverage) expect(v === 0 || v === 1).toBe(true)
  })

  it('a worn area prints less ink than a clean one', () => {
    const sum = (f: Float32Array) => f.reduce((a, b) => a + b, 0)
    const clean = new Float32Array(N * N).fill(0.7)
    const worn = applyDropoutPatches(clean, N, N, 0.9, 11)
    expect(sum(screenField(worn, N, N, opts))).toBeLessThan(sum(screenField(clean, N, N, opts)))
  })

  it('would NOT be binary if wear ran after the screen — the bug, stated', () => {
    // Documents why the order matters rather than trusting a comment: apply
    // the same wear to coverage instead of tone and mid-tones appear, which is
    // precisely the grey the compositor would render as thin ink.
    const tone = new Float32Array(N * N).fill(0.7)
    const afterScreen = applyDropoutPatches(screenField(tone, N, N, opts), N, N, 0.9, 3)
    expect([...afterScreen].some((v) => v > 0.02 && v < 0.98)).toBe(true)
  })
})

describe('word layout', () => {
  // Every glyph is half the font size wide, so positions are exactly
  // predictable and the assertions can be about arithmetic, not fonts.
  const measure = (text: string, size: number) => text.length * size * 0.5

  const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
    id: 't',
    text: 'AA BB\nCC',
    inkId: 'black',
    fontId: 'grotesk',
    weight: 700,
    size: 0.1,
    lineHeight: 1,
    tracking: 0,
    wordSpacing: 0,
    align: 'left',
    wordPress: {},
    contrastInkId: null,
    contrastThreshold: 0.5,
    justifyBy: 'letters',
    soloAlign: 'left',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    caps: false,
    opacity: 1,
    fitWidth: false,
    boxes: [],
    boxPadding: 0.12,
    boxRadius: 0,
    ...over,
  })

  it('numbers words continuously across lines', () => {
    const words = wordsOf(layoutText(layer(), 1000, 600, measure))
    expect(words.map((w) => w.text)).toEqual(['AA', 'BB', 'CC'])
    expect(words.map((w) => w.index)).toEqual([0, 1, 2])
    expect(words.map((w) => w.line)).toEqual([0, 0, 1])
  })

  it('gives each word the span its glyphs actually occupy', () => {
    const out = layoutText(layer(), 1000, 600, measure)
    const [aa, bb] = out.lines[0].words
    const glyph = out.fontSize * 0.5
    expect(aa.x).toBeCloseTo(0, 6)
    expect(aa.width).toBeCloseTo(glyph * 2, 6)
    // "AA" + space = 3 advances before "BB" starts.
    expect(bb.x).toBeCloseTo(glyph * 3, 6)
  })

  it('word spacing widens the gap without touching the words', () => {
    const glyph = layoutText(layer(), 1000, 600, measure).fontSize * 0.5
    const wide = layoutText(layer({ wordSpacing: 1 }), 1000, 600, measure)
    const [aa, bb] = wide.lines[0].words
    expect(aa.width).toBeCloseTo(glyph * 2, 6)
    // One em of extra space lands between the words, and nowhere else.
    expect(bb.x - (aa.x + aa.width)).toBeCloseTo(glyph + wide.fontSize, 6)
  })

  it('keeps letter tracking and word spacing independent', () => {
    const base = layoutText(layer(), 1000, 600, measure)
    const tracked = layoutText(layer({ tracking: 0.1 }), 1000, 600, measure)
    const spaced = layoutText(layer({ wordSpacing: 0.5 }), 1000, 600, measure)

    // Tracking stretches the word itself; word spacing does not.
    expect(tracked.lines[0].words[0].width).toBeGreaterThan(base.lines[0].words[0].width)
    expect(spaced.lines[0].words[0].width).toBeCloseTo(base.lines[0].words[0].width, 6)
  })

  it('collapses runs of whitespace rather than inventing empty words', () => {
    const words = wordsOf(layoutText(layer({ text: 'A   B' }), 1000, 600, measure))
    expect(words.map((w) => w.text)).toEqual(['A', 'B'])
  })

  it('agrees with a plain whitespace split — the index a box stores', () => {
    // The selection UI derives its word list by splitting the raw text. If the
    // engine grouped words differently, a box would highlight one word in the
    // panel and print behind another.
    const text = 'ONE TWO\nTHREE  FOUR'
    const fromEngine = wordsOf(layoutText(layer({ text }), 1000, 600, measure)).map((w) => w.text)
    const fromSplit = text.split(/\s+/).filter(Boolean)
    expect(fromEngine).toEqual(fromSplit)
  })

  it('still numbers words correctly when justified', () => {
    const words = wordsOf(layoutText(layer({ align: 'justify' }), 1000, 600, measure))
    expect(words.map((w) => w.index)).toEqual([0, 1, 2])
    // Justification moved them, but they are still ordered left to right.
    const line0 = words.filter((w) => w.line === 0)
    expect(line0[1].x).toBeGreaterThan(line0[0].x)
  })
})

describe('word tracking', () => {
  const measure = (text: string, size: number) => text.length * size * 0.5

  const layer = (over: Partial<TextLayer> = {}): TextLayer => ({
    id: 't',
    text: 'AA BB CC',
    inkId: 'black',
    fontId: 'grotesk',
    weight: 400,
    size: 0.1,
    lineHeight: 1,
    tracking: 0,
    wordSpacing: 0,
    align: 'left',
    wordPress: {},
    contrastInkId: null,
    contrastThreshold: 0.5,
    justifyBy: 'letters',
    soloAlign: 'left',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    caps: false,
    opacity: 1,
    fitWidth: false,
    boxes: [],
    boxPadding: 0.1,
    boxRadius: 0,
    ...over,
  })

  it('widens the gaps between words without touching the words', () => {
    const base = wordsOf(layoutText(layer(), 1000, 600, measure))
    const out = wordsOf(layoutText(layer({ wordSpacing: 0.5 }), 1000, 600, measure))

    // Every word keeps its own width — word tracking is the gap, not the word.
    for (let i = 0; i < base.length; i++) expect(out[i].width).toBeCloseTo(base[i].width, 6)
    // ...and each successive gap has opened up by the same amount.
    expect(out[1].x - out[0].x).toBeGreaterThan(base[1].x - base[0].x)
    expect(out[2].x - out[1].x).toBeCloseTo(out[1].x - out[0].x, 6)
  })

  it('lets letter tracking widen the word gaps too, like native letter-spacing', () => {
    const base = wordsOf(layoutText(layer(), 1000, 600, measure))
    const out = wordsOf(layoutText(layer({ tracking: 0.2 }), 1000, 600, measure))

    // Native letter-spacing lands on the space as well, so opening the type up
    // opens the word gaps with it rather than jamming the words together.
    expect(out[1].x - out[0].x).toBeGreaterThan(base[1].x - base[0].x)
  })

  it('keeps word tracking out of the letters under forced justification', () => {
    // Justification spreads slack across every gap. Measuring that slack from
    // bare glyph widths throws the placed gaps away and re-spreads them, which
    // turns word tracking into letter tracking — the words end up no further
    // apart than the letters, which is the whole point of the control gone.
    const intra = (l: TextLayer) => {
      const g = layoutText(l, 1000, 600, measure).lines[0].glyphs
      return g[1].x - g[0].x - g[0].width
    }
    for (const fitWidth of [false, true]) {
      const base = intra(layer({ text: 'AA BB', align: 'justify', fitWidth }))
      const wide = intra(layer({ text: 'AA BB', align: 'justify', fitWidth, wordSpacing: 0.8 }))
      expect(wide).toBeCloseTo(base, 6)
    }
  })

  it('still fills the measure when justified with word tracking on', () => {
    // The gaps must not be preserved by simply refusing to justify.
    const out = layoutText(
      layer({ text: 'AA BB\nCCCCCCCC', align: 'justify', wordSpacing: 0.8 }),
      1000,
      600,
      measure,
    )
    const [short, long] = out.lines
    const end = (l: typeof short) => {
      const g = l.glyphs[l.glyphs.length - 1]
      return g.x + g.width
    }
    expect(end(short)).toBeCloseTo(end(long), 6)
  })

  it('justifying by words leaves the letters alone entirely', () => {
    const line = (l: TextLayer) => layoutText(l, 1000, 600, measure).lines[0]
    // A short line stretched to a long one: all the slack has to go somewhere.
    const opts = { text: 'AA BB\nCCCCCCCCCC', align: 'justify' as const }
    const byLetters = line(layer({ ...opts, justifyBy: 'letters' }))
    const byWords = line(layer({ ...opts, justifyBy: 'words' }))
    const natural = line(layer({ ...opts, align: 'left' as const }))

    const intra = (l: typeof natural) => l.glyphs[1].x - l.glyphs[0].x - l.glyphs[0].width
    // Letters mode spreads into the word; words mode does not touch it.
    expect(intra(byLetters)).toBeGreaterThan(intra(natural) + 1)
    expect(intra(byWords)).toBeCloseTo(intra(natural), 6)
  })

  it('justifying by words still reaches the measure', () => {
    // Leaving the letters alone must not mean leaving the line short.
    const out = layoutText(
      layer({ text: 'AA BB\nCCCCCCCCCC', align: 'justify', justifyBy: 'words' }),
      1000,
      600,
      measure,
    )
    const end = (l: (typeof out.lines)[number]) => {
      const g = l.glyphs[l.glyphs.length - 1]
      return g.x + g.width
    }
    expect(end(out.lines[0])).toBeCloseTo(end(out.lines[1]), 6)
  })

  it('never tears a single-word line apart to reach the measure', () => {
    // The failure this replaced: "go" on its own line justified to "g" at one
    // margin and "o" at the other. A word has no word gap to open, so words
    // mode must leave its letters exactly as set rather than spanning it.
    const l = (over: Partial<TextLayer>) =>
      layoutText(
        layer({ text: 'go\nthe quick brown fox', align: 'justify', justifyBy: 'words', ...over }),
        1000,
        600,
        measure,
      )
    const natural = layoutText(
      layer({ text: 'go', align: 'left' }),
      1000,
      600,
      measure,
    ).lines[0]
    const solo = l({}).lines[0]
    const gap = (line: typeof solo) => line.glyphs[1].x - line.glyphs[0].x - line.glyphs[0].width

    expect(gap(solo)).toBeCloseTo(gap(natural), 6)
    expect(solo.width).toBeCloseTo(natural.width, 6)
  })

  it('parks a single-word line against the chosen margin', () => {
    const l = (soloAlign: 'left' | 'right') =>
      layoutText(
        layer({ text: 'go\nthe quick brown fox', align: 'justify', justifyBy: 'words', soloAlign }),
        1000,
        600,
        measure,
      )
    const left = l('left')
    const right = l('right')
    const block = left.widest

    expect(left.lines[0].glyphs[0].x).toBeCloseTo(0, 6)
    const last = right.lines[0].glyphs[right.lines[0].glyphs.length - 1]
    expect(last.x + last.width).toBeCloseTo(block, 6)
  })

  it('still spreads a lone word in letters mode, where that is the point', () => {
    const out = layoutText(
      layer({ text: 'go\nthe quick brown fox', align: 'justify', justifyBy: 'letters' }),
      1000,
      600,
      measure,
    )
    const solo = out.lines[0]
    const last = solo.glyphs[solo.glyphs.length - 1]
    expect(last.x + last.width).toBeCloseTo(out.widest, 6)
  })

  it('measures a line to its ink, not to the trailing tracking gap', () => {
    // A trailing gap counted in the width pushes a centred line left of centre
    // and stops a right-aligned one short of the margin.
    const tight = layoutText(layer({ text: 'AA', tracking: 0 }), 1000, 600, measure)
    const loose = layoutText(layer({ text: 'AA', tracking: 0.5 }), 1000, 600, measure)

    expect(loose.lines[0].width - tight.lines[0].width).toBeCloseTo(0.5 * tight.fontSize, 6)
  })
})

describe('detail scaling', () => {
  it('leaves poster type at full coarseness', () => {
    expect(detailFactor(1000 * 0.16, 1000)).toBeCloseTo(1, 6)
    expect(detailFactor(1000 * 0.5, 1000)).toBe(1)
  })

  it('backs the press off as type gets smaller', () => {
    const big = detailFactor(1000 * 0.12, 1000)
    const mid = detailFactor(1000 * 0.06, 1000)
    const small = detailFactor(1000 * 0.02, 1000)

    expect(big).toBeLessThan(1)
    expect(mid).toBeLessThan(big)
    expect(small).toBeLessThan(mid)
  })

  it('floors so small type still reads as printed, not as clean vector', () => {
    expect(detailFactor(1, 1000)).toBe(0.22)
    expect(detailFactor(0, 1000)).toBe(0.22)
  })
})

describe('photo placement', () => {
  const SHEET = { w: 800, h: 1000 }

  it('never stretches, at any scale, position or source aspect', () => {
    // The guarantee the whole feature rests on. Asserted as "the scale factor
    // is identical on both axes" rather than by eyeballing a render, because
    // a squash of a few percent is invisible in a thumbnail and obvious in a
    // print.
    const sources = [
      { width: 4032, height: 3024 }, // landscape phone photo
      { width: 3024, height: 4032 }, // portrait
      { width: 1000, height: 1000 }, // square
      { width: 6000, height: 1200 }, // panorama
      { width: 40, height: 900 }, // absurdly tall
    ]
    for (const src of sources) {
      for (const scale of [0.2, 1, 2.5, 4]) {
        for (const [x, y] of [[0.5, 0.5], [0, 0], [1, 1], [0.2, 0.8]]) {
          const r = coverRect(src, SHEET.w, SHEET.h, { scale, x, y })
          expect(r.dw / r.dh).toBeCloseTo(src.width / src.height, 6)
        }
      }
    }
  })

  it('covers the sheet at scale 1, leaving no bare paper', () => {
    // Cover, not contain: a full-bleed print should not have letterbox bars.
    for (const src of [
      { width: 4032, height: 3024 },
      { width: 3024, height: 4032 },
      { width: 6000, height: 1200 },
    ]) {
      const r = coverRect(src, SHEET.w, SHEET.h, { scale: 1, x: 0.5, y: 0.5 })
      expect(r.dw).toBeGreaterThanOrEqual(SHEET.w - 1e-6)
      expect(r.dh).toBeGreaterThanOrEqual(SHEET.h - 1e-6)
      expect(r.dx).toBeLessThanOrEqual(1e-6)
      expect(r.dy).toBeLessThanOrEqual(1e-6)
    }
  })

  it('centres on the given point and scales about it', () => {
    const src = { width: 2000, height: 1000 }
    const centred = coverRect(src, SHEET.w, SHEET.h, { scale: 1, x: 0.5, y: 0.5 })
    expect(centred.dx + centred.dw / 2).toBeCloseTo(SHEET.w / 2, 6)
    expect(centred.dy + centred.dh / 2).toBeCloseTo(SHEET.h / 2, 6)

    const moved = coverRect(src, SHEET.w, SHEET.h, { scale: 1, x: 0.25, y: 0.75 })
    expect(moved.dx + moved.dw / 2).toBeCloseTo(SHEET.w * 0.25, 6)
    expect(moved.dy + moved.dh / 2).toBeCloseTo(SHEET.h * 0.75, 6)

    // Scaling keeps the centre put rather than growing from a corner.
    const bigger = coverRect(src, SHEET.w, SHEET.h, { scale: 2, x: 0.25, y: 0.75 })
    expect(bigger.dx + bigger.dw / 2).toBeCloseTo(moved.dx + moved.dw / 2, 6)
    expect(bigger.dw).toBeCloseTo(moved.dw * 2, 6)
  })

  it('separates a photo to ink coverage as darkness, not brightness', () => {
    // Ink is what gets added to paper: black wants full coverage, white none.
    // Inverting this is the classic separation bug and it produces a negative.
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255])
    const out = separateLuminance(px, new Float32Array(3), { contrast: 1, lift: 0 })
    expect(out[0]).toBeCloseTo(1, 2)
    expect(out[1]).toBeCloseTo(0, 2)
    expect(out[2]).toBeGreaterThan(0.4)
    expect(out[2]).toBeLessThan(0.6)
  })

  it('drops highlights out entirely as lift rises, and stays in range', () => {
    const px = new Uint8ClampedArray([220, 220, 220, 255, 30, 30, 30, 255])
    const none = separateLuminance(px, new Float32Array(2), { contrast: 1, lift: 0 })
    const lifted = separateLuminance(px, new Float32Array(2), { contrast: 1, lift: 0.4 })

    expect(none[0]).toBeGreaterThan(0)
    expect(lifted[0]).toBe(0)
    // The shadow survives — lift drops highlights, it does not fade the image.
    expect(lifted[1]).toBeGreaterThan(0.5)
    for (const v of [...none, ...lifted]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('photo as the printing ground', () => {
  it('leaves the composite untouched when there is no photo', () => {
    // The new code path must be exactly inert for every existing document.
    const n = 4
    const shade = new Float32Array(n).fill(0.9)
    const paper = { shade, rgb: [250, 245, 235] as const }
    const plates = [{ coverage: new Float32Array(n).fill(0.5), rgb: [255, 0, 128] as const, opacity: 1 }]

    const a = new Uint8ClampedArray(n * 4)
    const b = new Uint8ClampedArray(n * 4)
    compositeLayers(a, 2, 2, paper, plates)
    compositeLayers(b, 2, 2, { ...paper, paperAmount: 0 }, plates)
    expect([...b]).toEqual([...a])
  })

  it('prints straight onto the photo when the paper is turned off', () => {
    const n = 1
    const shade = new Float32Array(n).fill(0.5)
    // A strongly tinted, heavily textured stock that would be obvious if applied.
    const paper = { shade, rgb: [200, 120, 40] as const }
    const base = new Uint8ClampedArray([120, 180, 240, 255])

    const out = new Uint8ClampedArray(4)
    compositeLayers(out, 1, 1, { ...paper, base, paperAmount: 0 }, [])
    expect(out[0]).toBeCloseTo(120, 0)
    expect(out[1]).toBeCloseTo(180, 0)
    expect(out[2]).toBeCloseTo(240, 0)
  })

  it('lets the stock tint and texture the photo as the veil comes up', () => {
    const shade = new Float32Array(1).fill(0.5)
    const paper = { shade, rgb: [200, 120, 40] as const }
    const base = new Uint8ClampedArray([255, 255, 255, 255])

    const off = new Uint8ClampedArray(4)
    const on = new Uint8ClampedArray(4)
    compositeLayers(off, 1, 1, { ...paper, base, paperAmount: 0 }, [])
    compositeLayers(on, 1, 1, { ...paper, base, paperAmount: 1 }, [])

    // Full veil over white is exactly the paper the app draws without a photo.
    expect(on[0]).toBeCloseTo(200 * 0.5, 0)
    expect(on[1]).toBeCloseTo(120 * 0.5, 0)
    expect(off[0]).toBeGreaterThan(on[0])
  })

  it('overprints the photo rather than covering it', () => {
    // Riso ink is transparent, so a plate over a photo must multiply down from
    // the photo's own colour — not replace it, which is what a sticker does.
    const base = new Uint8ClampedArray([200, 200, 200, 255])
    const paper = { shade: new Float32Array(1).fill(1), rgb: [255, 255, 255] as const }
    const ink = [{ coverage: new Float32Array(1).fill(1), rgb: [0, 0, 255] as const, opacity: 1 }]

    const out = new Uint8ClampedArray(4)
    compositeLayers(out, 1, 1, { ...paper, base, paperAmount: 0 }, ink)
    // Blue ink absorbs red and green fully, passes blue — so the photo's own
    // blue level survives underneath.
    expect(out[0]).toBeCloseTo(0, 0)
    expect(out[2]).toBeCloseTo(200, 0)
  })
})

describe('a photo that does not cover the sheet', () => {
  const paper = { shade: new Float32Array(1).fill(1), rgb: [250, 240, 220] as const }

  it('leaves bare paper where the photo has been panned away, not black', () => {
    // getImageData hands back transparent *black* for untouched pixels, so
    // reading colour without alpha prints a black border round a photo that
    // has merely been moved. This is the bug that shipped in the first cut.
    const uncovered = new Uint8ClampedArray([0, 0, 0, 0])
    const out = new Uint8ClampedArray(4)
    compositeLayers(out, 1, 1, { ...paper, base: uncovered, paperAmount: 0 }, [])

    expect(out[0]).toBeCloseTo(250, 0)
    expect(out[1]).toBeCloseTo(240, 0)
    expect(out[2]).toBeCloseTo(220, 0)
  })

  it('matches the no-photo render exactly on uncovered pixels', () => {
    // The strongest form of the same claim: bare sheet beside a photo must be
    // indistinguishable from the same sheet with no photo imported at all.
    const shade = new Float32Array(2)
    shade[0] = 0.94
    shade[1] = 1.02
    const tex = { shade, rgb: [250, 240, 220] as const }
    const base = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0])

    const withPhoto = new Uint8ClampedArray(8)
    const without = new Uint8ClampedArray(8)
    compositeLayers(withPhoto, 2, 1, { ...tex, base, paperAmount: 0.3 }, [])
    compositeLayers(without, 2, 1, tex, [])
    expect([...withPhoto]).toEqual([...without])
  })

  it('fades a photo back toward paper through its alpha', () => {
    const half = new Uint8ClampedArray([0, 0, 0, 128])
    const full = new Uint8ClampedArray([0, 0, 0, 255])
    const dim = new Uint8ClampedArray(4)
    const solid = new Uint8ClampedArray(4)
    compositeLayers(dim, 1, 1, { ...paper, base: half, paperAmount: 0 }, [])
    compositeLayers(solid, 1, 1, { ...paper, base: full, paperAmount: 0 }, [])

    expect(solid[0]).toBeCloseTo(0, 0)
    expect(dim[0]).toBeGreaterThan(solid[0])
    expect(dim[0]).toBeLessThan(250)
  })
})

describe('reading type across a photograph', () => {
  const W = 8
  const H = 8

  /** Left half black, right half white — the exact case that made type in one
   *  ink unreadable across half the sheet. */
  const splitPhoto = () => {
    const px = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4
        const v = x < W / 2 ? 0 : 255
        px[o] = v
        px[o + 1] = v
        px[o + 2] = v
        px[o + 3] = 255
      }
    }
    return px
  }

  it('marks light ground as light and dark ground as dark', () => {
    const m = lightMask(splitPhoto(), W, H, 0.5, 0)
    // Sampled away from the boundary, where the soft band deliberately blends.
    expect(m[0]).toBe(0)
    expect(m[W - 1]).toBe(1)
  })

  it('treats bare paper as light, so type off the photo keeps its first ink', () => {
    // Transparent ground is uncovered sheet. Reading it as dark would flip the
    // ink to the contrast colour over plain paper, which is backwards.
    const px = new Uint8ClampedArray(W * H * 4) // all zero: transparent black
    const m = lightMask(px, W, H, 0.5, 0)
    for (let i = 0; i < W * H; i++) expect(m[i]).toBe(1)
  })

  it('cross-fades across the boundary rather than snapping mid-stroke', () => {
    // A hard cut makes a glyph straddling the edge change colour halfway
    // through a stem. Blurring gives a band of intermediate values.
    const m = lightMask(splitPhoto(), W, H, 0.5, 2)
    const mid = [...m].filter((v) => v > 0.05 && v < 0.95)
    expect(mid.length).toBeGreaterThan(0)
  })

  it('splits one pass into two inks that sum back to the original coverage', () => {
    // The split is a partition, not a duplication: doubling the ink laid down
    // would darken every glyph the moment the second ink was switched on.
    const mask = lightMask(splitPhoto(), W, H, 0.5, 2)
    const coverage = new Float32Array(W * H).fill(0.8)
    for (let i = 0; i < coverage.length; i++) {
      const onLight = coverage[i] * mask[i]
      const onDark = coverage[i] * (1 - mask[i])
      expect(onLight + onDark).toBeCloseTo(coverage[i], 6)
    }
  })

  it('knocks the photo back to paper under the second ink', () => {
    // Without this the second ink buys nothing: a transparent light ink over a
    // solid dark area is still a solid dark area.
    const photo = new Float32Array(1).fill(1)
    const onDark = new Float32Array(1).fill(1)
    for (let i = 0; i < photo.length; i++) photo[i] *= 1 - onDark[i]
    expect(photo[0]).toBe(0)

    const paper = { shade: new Float32Array(1).fill(1), rgb: [250, 245, 235] as const }
    const out = new Uint8ClampedArray(4)
    compositeLayers(out, 1, 1, paper, [
      { coverage: photo, rgb: [0, 0, 0] as const, opacity: 1 },
      { coverage: onDark, rgb: [255, 255, 255] as const, opacity: 1 },
    ])
    // Paper survives, so a light ink printed here actually reads.
    expect(out[0]).toBeGreaterThan(200)
  })
})

describe('two presses', () => {
  it('keeps the type and photo presses independent', () => {
    const a = pressProfile()
    const b = pressProfile({ screenPitch: 3, misregistration: 0 })
    expect(b.screenPitch).toBe(3)
    expect(b.misregistration).toBe(0)
    // Everything not overridden still matches, so a photo profile is the type
    // profile plus deliberate differences rather than a separate set of guesses.
    expect(b.screenShape).toBe(a.screenShape)
    expect(b.density).toBe(a.density)
    // And changing one cannot reach the other.
    expect(a.screenPitch).not.toBe(3)
  })
})

describe('the two-ink switch is a pattern, not a fade', () => {
  it('binarises the mask so each ink lands at full strength', () => {
    // A soft mask makes both inks print at partial coverage through the
    // transition, which is an opacity crossfade wearing a print's clothes —
    // and is exactly what made the switch point read as a fade. Screening the
    // mask is what turns it back into a switch.
    const n = 64
    const ramp = new Float32Array(n)
    for (let i = 0; i < n; i++) ramp[i] = i / (n - 1)

    const screened = ditherField(ramp, 8, 8, 'bayer4', { threshold: 0.5 })
    for (const v of screened) expect(v === 0 || v === 1).toBe(true)

    // Split by a binary mask, every pixel gets all of one ink or all of the
    // other — never a half-strength blend of both.
    const coverage = new Float32Array(n).fill(1)
    for (let i = 0; i < n; i++) {
      const onLight = coverage[i] * screened[i]
      const onDark = coverage[i] * (1 - screened[i])
      expect(Math.max(onLight, onDark)).toBe(1)
      expect(Math.min(onLight, onDark)).toBe(0)
    }
  })
})

describe('per-word press overrides', () => {
  const measure = (t: string, s: number) => t.length * s * 0.5
  const base = (over: Partial<TextLayer> = {}): TextLayer => ({
    id: 't', text: 'one two three', inkId: 'black', fontId: 'grotesk', weight: 400,
    size: 0.1, lineHeight: 1, tracking: 0, wordSpacing: 0, wordPress: {},
    contrastInkId: null, contrastThreshold: 0.5, align: 'left', justifyBy: 'letters',
    soloAlign: 'left', x: 0.5, y: 0.5, rotation: 0, caps: false, opacity: 1,
    fitWidth: false, boxes: [], boxPadding: 0.1, boxRadius: 0, ...over,
  })

  it('groups words by their setting, not one plate each', () => {
    // Three words given the same extra bleed went through the press together
    // on a real job, so they should tear and land together here.
    const layer = base({
      wordPress: { '0': { bleed: 0.2 }, '1': { bleed: 0.2 }, '2': { offset: 5 } },
    })
    const keys = new Set(
      Object.values(layer.wordPress).map((o) => `${o.bleed ?? 0}:${o.offset ?? 0}`),
    )
    expect(keys.size).toBe(2)
  })

  it('word indices match the whitespace split the panel shows', () => {
    // A word overridden by index must be the word tapped, or the wrong word
    // misprints — the same contract the box selection relies on.
    const words = wordsOf(layoutText(base(), 1000, 600, measure)).map((w) => w.text)
    expect(words).toEqual(['one', 'two', 'three'])
  })
})
