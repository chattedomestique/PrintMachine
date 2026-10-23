/**
 * Engine tests.
 *
 * The engine is framework-free maths, which makes it the only part of this app
 * that is both cheap to test and genuinely worth testing (playbook §12.1).
 * These target the non-obvious invariants — the null case, range guarantees,
 * the overprint model, and the layout maths — rather than chasing coverage.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { compositeLayers } from './composite.ts'
import { DITHER_TYPES, ditherField } from './dither.ts'
import { applyDensity, applyMottle, registrationOffset, shiftField } from './ink.ts'
import { contrastPartner, inkById, paperById, RISO_INKS } from './inks.ts'
import { paperField } from './paper.ts'
import { mulberry32, valueNoise2D } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { BACKING_PAD, FIT_WIDTH, alignOffset, fitSize, justifyOffsets, layoutText, lineRects, type FontMeasure } from './text.ts'
import {
  DRAFT_HEIGHT,
  PREVIEW_HEIGHT,
  REFERENCE_HEIGHT,
  detailFactor,
  ensureCache,
  outputSize,
  pressPlate,
} from './render.ts'
import { knockoutMask } from './knockout.ts'
import {
  bandMask,
  clampPan,
  coverRect,
  fromPanFraction,
  groundLuma,
  type InkRgb,
  panBounds,
  panFraction,
  splitInks,
} from './media.ts'
import { scribbleField, woodcutField } from './carve.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'
import { applySettings } from '../state/settingsReducer.ts'
import { SIZE_MAX, SIZE_MIN } from './limits.ts'
import { blurField } from './blur.ts'
import { roughenEdges } from './rough.ts'
import { applyDropoutPatches, applySmear, applyStreaks } from './misprint.ts'
import { ASPECTS, FONTS, type PrintSettings, type TextLayer } from './types.ts'

const W = 24
const H = 24

/**
 * The compositor's documented model, as a test-local oracle: transparent ink
 * at full coverage multiplies each channel of what is under it by its own.
 * Kept here, not in the app, because nothing in the app needs it.
 */
const expectedOverprint = (
  bottom: readonly [number, number, number],
  top: readonly [number, number, number],
): [number, number, number] => [
  Math.round((bottom[0] * top[0]) / 255),
  Math.round((bottom[1] * top[1]) / 255),
  Math.round((bottom[2] * top[2]) / 255),
]

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
      { coverage: new Float32Array(W * H), rgb: [255, 72, 176] },
    ])
    expect([out[0], out[1], out[2], out[3]]).toEqual([242, 239, 230, 255])
  })

  it('reproduces the ink colour exactly at full coverage on white', () => {
    const out = new Uint8ClampedArray(4)
    const paper = { shade: new Float32Array(1).fill(1), rgb: [255, 255, 255] as const }
    compositeLayers(out, 1, 1, paper, [
      { coverage: new Float32Array(1).fill(1), rgb: [255, 72, 176] },
    ])
    expect([out[0], out[1], out[2]]).toEqual([255, 72, 176])
  })

  it('multiplies two inks where they overlap rather than replacing', () => {
    const out = new Uint8ClampedArray(4)
    const paper = { shade: new Float32Array(1).fill(1), rgb: [255, 255, 255] as const }
    const pink = [255, 72, 176] as const
    const blue = [0, 120, 191] as const
    compositeLayers(out, 1, 1, paper, [
      { coverage: new Float32Array(1).fill(1), rgb: blue },
      { coverage: new Float32Array(1).fill(1), rgb: pink },
    ])
    // Not the top layer: the product of the two, channel by channel.
    expect([out[0], out[1], out[2]]).not.toEqual([...pink])
    expect([out[0], out[1], out[2]]).toEqual(expectedOverprint(blue, pink))
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
    for (const type of DITHER_TYPES.map((d) => d.id)) {
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
    const out = applyMottle(cov, noise, speckle, 0.8, 0.5, W, H)
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
      W,
      H,
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
  const layer = (over: Partial<TextLayer> = {}): TextLayer =>
    makeLayer({ text: 'AB\nCDEF', fontId: 'grotesk', size: 0.1, lineHeight: 1, tracking: 0, align: 'left', ...over })

  // A stand-in for the browser: every glyph is exactly half the font size wide.
  const measure = (text: string, size: number) => text.length * size * 0.5

  it('sets the text exactly as typed — no case transform', () => {
    const out = layoutText(layer({ text: 'ab' }), 1000, measure)
    expect(out.lines[0].text).toBe('ab')
  })

  it('counts blank lines in the block height so stanza spacing survives', () => {
    const out = layoutText(layer({ text: 'A\n\nB' }), 1000, measure)
    expect(out.lines).toHaveLength(3)
    expect(out.blockHeight).toBeCloseTo(out.lineHeight * 3, 5)
  })

  it('aligns lines within the block', () => {
    expect(alignOffset(40, 100, 'left')).toBe(0)
    expect(alignOffset(40, 100, 'center')).toBe(30)
    expect(alignOffset(40, 100, 'right')).toBe(60)
  })

  it('lets letter tracking widen the word gaps too, like native letter-spacing', () => {
    // Glyph 3 is the first letter of the second word, after the space.
    const gap = (l: TextLayer) => {
      const g = layoutText(l, 1000, measure).lines[0].glyphs
      return g[3].x - (g[1].x + g[1].width)
    }
    // Native letter-spacing lands on the space as well, so opening the type up
    // opens the word gaps with it rather than jamming the words together.
    expect(gap(layer({ text: 'AA BB CC', tracking: 0.2 }))).toBeGreaterThan(gap(layer({ text: 'AA BB CC' })))
  })

  it('measures a line to its ink, not to the trailing tracking gap', () => {
    // A trailing gap counted in the width pushes a centred line left of centre
    // and stops a right-aligned one short of the margin.
    const tight = layoutText(layer({ text: 'AA', tracking: 0 }), 1000, measure)
    const loose = layoutText(layer({ text: 'AA', tracking: 0.5 }), 1000, measure)
    expect(loose.lines[0].width - tight.lines[0].width).toBeCloseTo(0.5 * tight.fontSize, 6)
  })
})

describe('fitSize — the one-shot Fit action', () => {
  // The browser stand-in the plan pins: width is 0.55 x size x characters,
  // read from the face's pixel size, so it is linear in size.
  const stub: FontMeasure = (font, text) => 0.55 * font.px * [...text].length
  const layer = (over: Partial<TextLayer> = {}): TextLayer =>
    makeLayer({ text: 'MACHINE', fontId: 'grotesk', tracking: 0, size: 0.1, ...over })
  const widest = (l: TextLayer, h: number) =>
    layoutText(l, h, (text, px) => stub({ stack: '', weight: 400, px }, text)).widest

  it('gives the size the plan pins: MACHINE on 4:5 is 0.92 x 0.8 / (0.55 x 7)', () => {
    expect(fitSize(layer(), 0.8, stub)).toBeCloseTo((0.92 * 0.8) / (0.55 * 7), 12)
  })

  it('makes the widest line span 0.92 of the sheet width, to within a pixel', () => {
    for (const [aspect, text] of [
      [0.8, 'PRINT\nMACHINE'],
      [1, 'A LONGER LINE\nSHORT'],
      [2 / 3, 'riso on a photo'],
      [0.75, 'x\nwide second line here'],
    ] as const) {
      const size = fitSize(layer({ text }), aspect, stub)
      for (const h of [1000, 1800, 3780]) {
        expect(Math.abs(widest(layer({ text, size }), h) - FIT_WIDTH * aspect * h)).toBeLessThan(1)
      }
    }
  })

  it('scales tracking with the type, so fitting does not change the letterfit', () => {
    const tracked = layer({ tracking: 0.1 })
    const size = fitSize(tracked, 0.8, stub)
    expect(Math.abs(widest({ ...tracked, size }, 1000) - FIT_WIDTH * 0.8 * 1000)).toBeLessThan(1)
    // ...and tracking makes the same text fit smaller, never larger.
    expect(size).toBeLessThan(fitSize(layer(), 0.8, stub))
  })

  it('clamps at both ends of the size range', () => {
    expect(fitSize(layer({ text: 'A' }), 1, stub)).toBe(SIZE_MAX)
    expect(fitSize(layer({ text: 'A'.repeat(400) }), 0.5, stub)).toBe(SIZE_MIN)
  })

  it('keeps the size when there is nothing to measure', () => {
    expect(fitSize(layer({ text: '', size: 0.07 }), 0.8, stub)).toBe(0.07)
  })

  it('measures the face it will draw: bold and the typeface reach the measure', () => {
    const seen: string[] = []
    const spy: FontMeasure = (font, text) => {
      seen.push(`${font.weight}|${font.stack.slice(0, 8)}`)
      return stub(font, text)
    }
    fitSize(layer({ bold: true, fontId: 'serif' }), 0.8, spy)
    expect(new Set(seen)).toEqual(new Set([`700|${FONTS.find((f) => f.id === 'serif')!.stack.slice(0, 8)}`]))
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

  it('preserves a constant field at fractional radii too', () => {
    // The fractional window adds two partial end samples and divides by a
    // fractional count. Get either wrong and a flat field stops being flat —
    // the same rim as the classic seeding bug, just harder to spot.
    const flat = new Float32Array(W * H).fill(0.4)
    for (const r of [0.35, 0.5, 1.2, 1.75, 2.5, 3.9]) {
      for (const v of blurField(flat, W, H, r)) expect(v).toBeCloseTo(0.4, 5)
    }
  })

  it('blurs by more the larger the radius, all the way through the fractions', () => {
    // The whole point of a fractional radius: a tear asked for at two-thirds of
    // a pixel has to land between no tear and a whole one, not on one of them.
    // Measured as how far a step edge has spread, which is what the threshold
    // downstream is cutting.
    const step = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) step[y * W + x] = x < W / 2 ? 0 : 1
    const spread = (r: number) => {
      const b = blurField(step, W, H, r)
      let n = 0
      for (let x = 0; x < W; x++) if (b[(H >> 1) * W + x] > 0.02 && b[(H >> 1) * W + x] < 0.98) n++
      return n
    }
    const widths = [0, 0.5, 1, 1.5, 2, 3].map(spread)
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1])
    expect(widths[widths.length - 1]).toBeGreaterThan(widths[0])
  })

  it('matches the whole-number blur when the fraction is zero', () => {
    // The fractional path must be a generalisation, not a replacement — an
    // integer radius has to come out exactly as it always did.
    const f = ramp()
    const a = blurField(f, W, H, 2)
    const b = blurField(f, W, H, 2.0)
    expect(Array.from(a)).toEqual(Array.from(b))
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

describe('justify — one rule per line', () => {
  const measure = (text: string, size: number) => text.length * size * 0.5
  const layer = (over: Partial<TextLayer> = {}): TextLayer =>
    makeLayer({ fontId: 'grotesk', size: 0.1, lineHeight: 1, tracking: 0, align: 'justify', ...over })
  const end = (l: { glyphs: { x: number; width: number }[] }) => {
    const g = l.glyphs[l.glyphs.length - 1]
    return g.x + g.width
  }
  const intra = (l: { glyphs: { x: number; width: number }[] }, k = 0) =>
    l.glyphs[k + 1].x - l.glyphs[k].x - l.glyphs[k].width

  it('a line with a space opens only its word gaps: the words keep their shapes', () => {
    const text = 'AA BB\nCCCCCCCCCC'
    const justified = layoutText(layer({ text }), 1000, measure).lines[0]
    const natural = layoutText(layer({ text, align: 'left' }), 1000, measure).lines[0]
    // Inside a word nothing moved...
    expect(intra(justified, 0)).toBeCloseTo(intra(natural, 0), 6)
    expect(intra(justified, 3)).toBeCloseTo(intra(natural, 3), 6)
    // ...and the gap round the space took all the slack.
    expect(intra(justified, 1) + intra(justified, 2)).toBeGreaterThan(intra(natural, 1) + intra(natural, 2) + 1)
  })

  it('a line with no space spreads its letters — the solid poster stack', () => {
    const out = layoutText(layer({ text: 'GO\nTHE QUICK BROWN FOX' }), 1000, measure)
    const solo = out.lines[0]
    const natural = layoutText(layer({ text: 'GO', align: 'left' }), 1000, measure).lines[0]
    expect(intra(solo)).toBeGreaterThan(intra(natural) + 1)
    expect(end(solo)).toBeCloseTo(out.widest, 6)
  })

  it('every line ends at the widest line, whatever it holds', () => {
    const out = layoutText(layer({ text: 'PRINT\nMACHINE\nA B\nTHE QUICK BROWN FOX\nX' }), 1000, measure)
    for (const line of out.lines) {
      // A one-glyph line has no gap to open and stays where it is.
      if (line.glyphs.length > 1) expect(end(line)).toBeCloseTo(out.widest, 6)
    }
  })

  it('the default stack justifies: PRINT and MACHINE both span the block', () => {
    const out = layoutText(layer({ text: 'PRINT\nMACHINE' }), 1000, measure)
    expect(end(out.lines[0])).toBeCloseTo(end(out.lines[1]), 6)
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
  const SOURCES = [
    { width: 4032, height: 3024 }, // landscape phone photo
    { width: 3024, height: 4032 }, // portrait
    { width: 1000, height: 1000 }, // square
    { width: 6000, height: 1200 }, // panorama
    { width: 40, height: 900 }, // absurdly tall
  ]
  const covers = (r: { dx: number; dy: number; dw: number; dh: number }, w: number, h: number) =>
    r.dx <= 1e-9 && r.dx + r.dw >= w - 1e-9 && r.dy <= 1e-9 && r.dy + r.dh >= h - 1e-9

  it('never stretches, at any zoom, position or source aspect', () => {
    // The guarantee the whole feature rests on. Asserted as "the scale factor
    // is identical on both axes" rather than by eyeballing a render, because
    // a squash of a few percent is invisible in a thumbnail and obvious in a
    // print.
    for (const src of SOURCES) {
      for (const scale of [1, 1.7, 2.5, 4]) {
        for (const [x, y] of [[0.5, 0.5], [0, 0], [1, 1], [0.2, 0.8]]) {
          const r = coverRect(src, SHEET.w, SHEET.h, { scale, x, y })
          expect(r.dw / r.dh).toBeCloseTo(src.width / src.height, 6)
        }
      }
    }
  })

  it('covers the sheet at zoom 1, leaving no bare paper', () => {
    // Cover, not contain: a full-bleed print should not have letterbox bars.
    for (const src of SOURCES) {
      const r = coverRect(src, SHEET.w, SHEET.h, { scale: 1, x: 0.5, y: 0.5 })
      expect(covers(r, SHEET.w, SHEET.h)).toBe(true)
      // ...and exactly fills one axis: zoom 1 crops only the overflow.
      expect(Math.min(r.dw - SHEET.w, r.dh - SHEET.h)).toBeCloseTo(0, 6)
    }
  })

  it('centres on the given point and zooms about it, inside the travel', () => {
    const src = { width: 2000, height: 1000 }
    const centred = coverRect(src, SHEET.w, SHEET.h, { scale: 2, x: 0.5, y: 0.5 })
    expect(centred.dx + centred.dw / 2).toBeCloseTo(SHEET.w / 2, 6)
    expect(centred.dy + centred.dh / 2).toBeCloseTo(SHEET.h / 2, 6)

    const moved = coverRect(src, SHEET.w, SHEET.h, { scale: 2, x: 0.25, y: 0.75 })
    expect(moved.dx + moved.dw / 2).toBeCloseTo(SHEET.w * 0.25, 6)
    expect(moved.dy + moved.dh / 2).toBeCloseTo(SHEET.h * 0.75, 6)

    // Zooming keeps the centre put rather than growing from a corner.
    const bigger = coverRect(src, SHEET.w, SHEET.h, { scale: 4, x: 0.25, y: 0.75 })
    expect(bigger.dx + bigger.dw / 2).toBeCloseTo(moved.dx + moved.dw / 2, 6)
    expect(bigger.dw).toBeCloseTo(moved.dw * 2, 6)
  })

  it('never uncovers the sheet, whatever placement it is handed', () => {
    // Cover is enforced where the sheet is drawn, so no stored placement — a
    // pan that was legal on another sheet shape, a zoom below 1 from an old
    // build, a garbage position — can print a bare strip.
    const rnd = mulberry32(2024)
    for (let i = 0; i < 400; i++) {
      const src = SOURCES[i % SOURCES.length]
      const w = 200 + Math.floor(rnd() * 900)
      const h = 200 + Math.floor(rnd() * 900)
      const place = { scale: rnd() * 5, x: rnd() * 8 - 4, y: rnd() * 8 - 4 }
      expect(covers(coverRect(src, w, h, place), w, h)).toBe(true)
    }
  })

  it('clampPan keeps zoom at least 1 and the photo over the whole sheet', () => {
    const rnd = mulberry32(7)
    for (let i = 0; i < 200; i++) {
      const src = SOURCES[i % SOURCES.length]
      const media = { ...src, scale: rnd() * 5, x: rnd() * 6 - 3, y: rnd() * 6 - 3 }
      const c = clampPan(media, SHEET.w, SHEET.h)
      expect(c.scale).toBeGreaterThanOrEqual(1)
      // Drawn from the clamped placement with NO further correction: the
      // stored value itself is honest.
      const { dw, dh } = coverRect(src, SHEET.w, SHEET.h, { scale: c.scale, x: 0.5, y: 0.5 })
      const dx = c.x * SHEET.w - dw / 2
      const dy = c.y * SHEET.h - dh / 2
      expect(dx <= 1e-9 && dx + dw >= SHEET.w - 1e-9).toBe(true)
      expect(dy <= 1e-9 && dy + dh >= SHEET.h - 1e-9).toBe(true)
    }
  })

  it('leaves a placement that already covers exactly as it was', () => {
    const media = { width: 4032, height: 3024, scale: 2, x: 0.41, y: 0.58 }
    expect(clampPan(media, SHEET.w, SHEET.h)).toEqual(media)
  })

  it('has no travel on an axis the photo exactly fits', () => {
    // A landscape photo on a portrait sheet fits the height at zoom 1.
    const b = panBounds({ width: 4032, height: 3024, scale: 1 }, SHEET.w, SHEET.h)
    expect(b.yLo).toBe(0.5)
    expect(b.yHi).toBe(0.5)
    expect(b.xLo).toBeLessThan(0.5)
    expect(b.xHi).toBeGreaterThan(0.5)
  })

  it('states position as a fraction of the travel: 0 shows the left edge, 1 the right', () => {
    const m = { width: 4032, height: 3024, scale: 1.5 }
    for (const axis of ['x', 'y'] as const) {
      const b = panBounds(m, SHEET.w, SHEET.h)
      const left = fromPanFraction(m, SHEET.w, SHEET.h, axis, 0)
      const right = fromPanFraction(m, SHEET.w, SHEET.h, axis, 1)
      // 0: the photo's left (top) edge sits on the trim.
      const r0 = coverRect(m, SHEET.w, SHEET.h, { scale: m.scale, x: axis === 'x' ? left : 0.5, y: axis === 'y' ? left : 0.5 })
      expect(axis === 'x' ? r0.dx : r0.dy).toBeCloseTo(0, 6)
      // 1: its right (bottom) edge does.
      const r1 = coverRect(m, SHEET.w, SHEET.h, { scale: m.scale, x: axis === 'x' ? right : 0.5, y: axis === 'y' ? right : 0.5 })
      expect(axis === 'x' ? r1.dx + r1.dw : r1.dy + r1.dh).toBeCloseTo(axis === 'x' ? SHEET.w : SHEET.h, 6)
      expect(axis === 'x' ? [b.xHi, b.xLo] : [b.yHi, b.yLo]).toEqual([left, right])
      // Round trip.
      for (const f of [0, 0.25, 0.5, 0.9, 1]) {
        const pos = fromPanFraction(m, SHEET.w, SHEET.h, axis, f)
        expect(panFraction({ ...m, x: pos, y: pos }, SHEET.w, SHEET.h, axis)).toBeCloseTo(f, 9)
      }
    }
    // No travel on an axis: the middle, whatever is asked.
    const fit = { width: 4032, height: 3024, scale: 1 }
    expect(panFraction({ ...fit, x: 0.5, y: 0.5 }, SHEET.w, SHEET.h, 'y')).toBe(0.5)
    expect(fromPanFraction(fit, SHEET.w, SHEET.h, 'y', 0)).toBe(0.5)
  })

  it('random aspect switches, pans and zooms never leave the stored photo uncovering the sheet', () => {
    // Through the reducer, because that is what writes the stored placement:
    // pan to the side on one sheet shape, switch to another, and the value
    // that was legal before has to be pulled back, not left to the renderer.
    const rnd = mulberry32(99)
    const aspects = Object.keys(ASPECTS) as PrintSettings['aspect'][]
    for (const src of SOURCES) {
      let s = applySettings(defaultSettings(), {
        type: 'setMedia',
        media: makeMedia({ id: 'p', ...src }),
      })
      for (let step = 0; step < 60; step++) {
        const r = rnd()
        if (r < 0.35) s = applySettings(s, { type: 'patch', patch: { aspect: aspects[Math.floor(rnd() * aspects.length)] } })
        else if (r < 0.7) s = applySettings(s, { type: 'patchMedia', patch: { x: rnd() * 4 - 1.5, y: rnd() * 4 - 1.5 } })
        else s = applySettings(s, { type: 'patchMedia', patch: { scale: rnd() * 5 } })
        const m = s.media!
        // A fixed point of the clamp, in the units the reducer works in...
        expect(clampPan(m, ASPECTS[s.aspect], 1)).toEqual(m)
        // ...and covering a real sheet in pixels.
        const W = ASPECTS[s.aspect] * 1000
        const H = 1000
        expect(m.scale).toBeGreaterThanOrEqual(1)
        const { dw, dh } = coverRect(m, W, H, { scale: m.scale, x: 0.5, y: 0.5 })
        expect(m.x * W - dw / 2).toBeLessThanOrEqual(1e-6)
        expect(m.x * W + dw / 2).toBeGreaterThanOrEqual(W - 1e-6)
        expect(m.y * H - dh / 2).toBeLessThanOrEqual(1e-6)
        expect(m.y * H + dh / 2).toBeGreaterThanOrEqual(H - 1e-6)
      }
    }
  })
})

describe('photo as the printing ground', () => {
  it('leaves the composite untouched when there is no photo', () => {
    // The new code path must be exactly inert for every existing document.
    const n = 4
    const shade = new Float32Array(n).fill(0.9)
    const paper = { shade, rgb: [250, 245, 235] as const }
    const plates = [{ coverage: new Float32Array(n).fill(0.5), rgb: [255, 0, 128] as const }]

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
    const ink = [{ coverage: new Float32Array(1).fill(1), rgb: [0, 0, 255] as const }]

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
    // reading colour without alpha printed a black border round a photo that
    // had merely been moved — the bug that shipped in the first cut. Panning
    // is clamped to cover now, but knockouts and transparent PNGs still take
    // this path.
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

  it('lets paper back through where the ground is part transparent', () => {
    // The path a knockout takes (the photo's alpha goes down under the second
    // ink) and the one a transparent PNG's own transparency takes.
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
    const m = bandMask(groundLuma(splitPhoto(), W, H, 0), 0.5)
    // Sampled away from the boundary, where the soft band deliberately blends.
    expect(m[0]).toBe(0)
    expect(m[W - 1]).toBe(1)
  })

  it('treats bare paper as light, so type off the photo keeps its first ink', () => {
    // Transparent ground is uncovered sheet. Reading it as dark would flip the
    // ink to the contrast colour over plain paper, which is backwards.
    const px = new Uint8ClampedArray(W * H * 4) // all zero: transparent black
    const m = bandMask(groundLuma(px, W, H, 0), 0.5)
    for (let i = 0; i < W * H; i++) expect(m[i]).toBe(1)
  })

  it('spreads the changeover over the blur, not over a value band', () => {
    // A glyph straddling the edge must not change colour halfway through a
    // stem, so the transition has to occupy real distance. That distance comes
    // from the blur — the width of the *value* band only decides how much of
    // the blur's ramp is spent in between, and widening that instead is what
    // put every line of type over water in the mixed zone at once. So the
    // property is that a wider blur buys a wider transition.
    const width = (radius: number) =>
      [...bandMask(groundLuma(splitPhoto(), W, H, radius), 0.5)].slice(0, W).filter((v) => v > 0.02 && v < 0.98)
        .length
    expect(width(0)).toBe(0)
    expect(width(3)).toBeGreaterThan(width(0))
  })

  it('picks the ink that reads, whichever field it was typed into', () => {
    // The bug this exists to catch: assigning by slot rather than by weight.
    // White type with black as its second ink printed white on the sky and
    // black on the water — the switch ran and every line stayed unreadable.
    const white: InkRgb = [255, 255, 255]
    const black: InkRgb = [12, 12, 12]

    for (const [a, b] of [
      [white, black],
      [black, white],
    ] as const) {
      const s = splitInks(a, b)
      expect(s.onLight).toEqual(black)
      expect(s.onDark).toEqual(white)
      expect(s.onLightLuma).toBeLessThan(s.onDarkLuma)
    }
  })

  it('keeps the given order when two inks weigh the same', () => {
    const a: InkRgb = [200, 0, 0]
    const s = splitInks(a, [200, 0, 0])
    expect(s.onLight).toEqual(a)
    expect(s.onDark).toEqual(a)
  })

  it('reads the photo blurred, so a sparkle does not flip one letter', () => {
    // Glitter on water is the same value as white ink and about the size of a
    // letter. Read raw it decides light-or-dark differently inside a single
    // word; the eye judges a word against the shape behind it, not a speck.
    const N = 32 // large enough that the blur's edge handling is not the result
    const px = new Uint8ClampedArray(N * N * 4)
    for (let i = 0; i < N * N; i++) {
      const v = i % 2 === 0 ? 0 : 255 // alternating: mean 0.5, no large shape
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v
      px[i * 4 + 3] = 255
    }
    const raw = groundLuma(px, N, N, 0)
    const soft = groundLuma(px, N, N, 4)
    // Sampled inside the border: a clamped-edge blur sees a truncated window
    // there, which is a property of the sheet edge and not of the sparkle.
    const spread = (f: Float32Array) => {
      let lo = 1
      let hi = 0
      for (let y = 12; y < N - 12; y++) {
        for (let x = 12; x < N - 12; x++) {
          const v = f[y * N + x]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      return hi - lo
    }
    expect(spread(raw)).toBeGreaterThan(0.9)
    expect(spread(soft)).toBeLessThan(0.1)
  })

  it('cuts the photo away only where the ink is lighter than the ground', () => {
    // Ink multiplies down: it can darken what it lands on and never lighten
    // it. So the stencil hole belongs under the ink that cannot print, and
    // tying it to the dark half of the mask instead only happens to be right
    // when the second ink is the light one.
    const need = (inkLuma: number, groundLuma: number) => (inkLuma > groundLuma ? 1 : 0)
    expect(need(1, 0.2)).toBe(1) // white on a shadow: must be cut
    expect(need(0.05, 0.2)).toBe(0) // black on a shadow: overprints fine
    expect(need(0.05, 0.9)).toBe(0) // black on a highlight: overprints fine
    expect(need(0.8, 0.7)).toBe(1) // pale ink on a slightly darker highlight
  })

  it('splits one pass into two inks that sum back to the original coverage', () => {
    // The split is a partition, not a duplication: doubling the ink laid down
    // would darken every glyph the moment the second ink was switched on.
    const mask = bandMask(groundLuma(splitPhoto(), W, H, 2), 0.5)
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
      { coverage: photo, rgb: [0, 0, 0] as const },
      { coverage: onDark, rgb: [255, 255, 255] as const },
    ])
    // Paper survives, so a light ink printed here actually reads.
    expect(out[0]).toBeGreaterThan(200)
  })
})

describe('the first photo', () => {
  const photoLayer = () => makeMedia({ id: 'photo', width: 100, height: 100 })

  it('gives every pass a second ink, because one ink cannot cross a photograph', () => {
    const before = applySettings(defaultSettings(), { type: 'setMedia', media: photoLayer() })
    for (const l of before.layers) expect(l.contrastInkId).not.toBeNull()
  })

  it('leaves a second ink already chosen alone', () => {
    const start = defaultSettings()
    start.layers = start.layers.map((l) => ({ ...l, contrastInkId: 'yellow' }))
    const after = applySettings(start, { type: 'setMedia', media: photoLayer() })
    for (const l of after.layers) expect(l.contrastInkId).toBe('yellow')
  })

  it('does not re-seed when the photo is swapped', () => {
    // Only the *first* photo is a default. Clearing the second ink deliberately
    // and then changing pictures must not put it back.
    const one = applySettings(defaultSettings(), { type: 'setMedia', media: photoLayer() })
    const off = { ...one, layers: one.layers.map((l) => ({ ...l, contrastInkId: null })) }
    const two = applySettings(off, { type: 'setMedia', media: photoLayer() })
    for (const l of two.layers) expect(l.contrastInkId).toBeNull()
  })

  it('picks a partner that actually differs in weight from the ink', () => {
    const weight = (id: string) => {
      const [r, g, b] = inkById(id).rgb
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    }
    for (const id of ['white', 'black', 'fluorescentpink', 'yellow', 'midnight']) {
      expect(Math.abs(weight(contrastPartner(id)) - weight(id))).toBeGreaterThan(0.4)
    }
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

describe('draft rendering', () => {
  it('is the same picture at lower fidelity, not a different one', () => {
    // Rendering smaller while a control moves is only safe because every
    // spatial quantity is expressed against REFERENCE_HEIGHT. If the draft had
    // a different aspect the preview would jump shape on every drag.
    for (const aspect of ['1:1', '4:5', '3:4', '2:3'] as const) {
      const draft = outputSize(aspect, DRAFT_HEIGHT)
      const full = outputSize(aspect, PREVIEW_HEIGHT)
      expect(draft.w / draft.h).toBeCloseTo(full.w / full.h, 2)
    }
  })

  it('is enough smaller to be worth switching to', () => {
    // The press is a dozen full-image passes per plate, so its cost goes with
    // the pixel count. A draft that is not several times cheaper buys nothing
    // and only costs a second cache.
    const draft = outputSize('4:5', DRAFT_HEIGHT)
    const full = outputSize('4:5', PREVIEW_HEIGHT)
    const ratio = (full.w * full.h) / (draft.w * draft.h)
    expect(ratio).toBeGreaterThan(4)
  })

  it('never reaches the export, which always renders at reference height', () => {
    const exported = outputSize('4:5')
    expect(exported.h).toBe(REFERENCE_HEIGHT)
    expect(exported.h).toBeGreaterThan(PREVIEW_HEIGHT)
  })
})

describe('woodcut and scribble', () => {
  const W = 48
  const H = 48
  const solid = () => new Float32Array(W * H).fill(1)
  const ramp = () => {
    const f = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = x / (W - 1)
    return f
  }
  const opts = { pitch: 8, angle: 30, roughness: 0.5, seed: 7 }

  it('never inks outside the shape', () => {
    // Both are fills, not effects layered over the sheet. Ink appearing where
    // the tone was zero would print marks in the margins.
    const tone = new Float32Array(W * H)
    for (let i = 0; i < 100; i++) tone[i] = 1
    for (const f of [woodcutField(tone, W, H, opts), scribbleField(tone, W, H, opts)]) {
      for (let i = 100; i < f.length; i++) expect(f[i]).toBe(0)
    }
  })

  it('stays in range', () => {
    for (const f of [woodcutField(ramp(), W, H, opts), scribbleField(ramp(), W, H, opts)]) {
      for (const v of f) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('breaks a solid area up rather than flooding it', () => {
    // If a solid shape comes back solid, the grooves and strokes are not
    // happening and the method is a no-op wearing a name.
    for (const f of [woodcutField(solid(), W, H, opts), scribbleField(solid(), W, H, opts)]) {
      const inked = [...f].filter((v) => v > 0.5).length
      expect(inked).toBeGreaterThan(0)
      expect(inked).toBeLessThan(f.length)
    }
  })

  it('lays more ink where the tone is darker', () => {
    // The mark has to track the artwork, or it is a texture pasted on top.
    for (const make of [woodcutField, scribbleField]) {
      const f = make(ramp(), W, H, opts)
      const left = [...f].filter((_, i) => i % W < W / 4).reduce((a, b) => a + b, 0)
      const right = [...f].filter((_, i) => i % W >= (W * 3) / 4).reduce((a, b) => a + b, 0)
      expect(right).toBeGreaterThan(left)
    }
  })

  it('is deterministic for a seed, so the export matches the preview', () => {
    const a = woodcutField(ramp(), W, H, opts)
    const b = woodcutField(ramp(), W, H, opts)
    expect([...a]).toEqual([...b])
    const c = woodcutField(ramp(), W, H, { ...opts, seed: 8 })
    expect([...a]).not.toEqual([...c])
  })
})

describe('detail scaling reaches the wear, not just the screen', () => {
  const W = 64
  const H = 64

  it('makes the blotch finer for small type instead of leaving it sheet-sized', () => {
    // The gap that made "edge tear at 1%" look like it did nothing: the tear,
    // the screen and the registration all scaled to the type while the wear
    // stayed sized for the sheet. At export size the blotch cell is about the
    // height of a small letter, so it stops texturing the ink and starts
    // deleting chunks of the letterform — and no amount of turning the tear
    // down touches it.
    const cov = new Float32Array(W * H).fill(0.9)
    const noise = valueNoise2D(W, H, 16, 5)
    const speckle = new Float32Array(W * H).fill(1)

    const coarse = applyMottle(cov, noise, speckle, 0.8, 0, W, H, 1)
    const fine = applyMottle(cov, noise, speckle, 0.8, 0, W, H, 0.25)

    // Finer means the value changes more often from pixel to pixel along a row.
    const flips = (f: Float32Array) => {
      let n = 0
      for (let x = 1; x < W; x++) if (Math.abs(f[x] - f[x - 1]) > 0.01) n++
      return n
    }
    expect(flips(fine)).toBeGreaterThan(flips(coarse))
  })

  it('is exactly the old behaviour at full detail', () => {
    // Poster type must be untouched by this — the whole point is that the wear
    // was right for big type all along.
    const cov = new Float32Array(W * H).fill(0.7)
    const noise = valueNoise2D(W, H, 8, 3)
    const speckle = valueNoise2D(W, H, 1, 4)
    const a = applyMottle(cov, noise, speckle, 0.5, 0.2, W, H, 1)
    const b = applyMottle(cov, noise, speckle, 0.5, 0.2, W, H)
    expect([...a]).toEqual([...b])
  })

  it('shrinks dropout patches with the type as well', () => {
    // A patch sized for a poster is wider than a whole word of body copy, so
    // it swallows the line rather than reading as ink that failed.
    const cov = new Float32Array(W * H).fill(1)
    const coarse = applyDropoutPatches(cov, W, H, 0.8, 11, 1)
    const fine = applyDropoutPatches(cov, W, H, 0.8, 11, 0.25)
    const flips = (f: Float32Array) => {
      let n = 0
      for (let x = 1; x < W; x++) if (Math.abs(f[x] - f[x - 1]) > 0.01) n++
      return n
    }
    expect(flips(fine)).toBeGreaterThanOrEqual(flips(coarse))
  })

  it('still leaves bare paper bare at any detail', () => {
    for (const d of [1, 0.5, 0.22]) {
      const out = applyMottle(
        new Float32Array(W * H),
        valueNoise2D(W, H, 4, 1),
        valueNoise2D(W, H, 1, 2),
        0.8,
        0.1,
        W,
        H,
        d,
      )
      expect(out.every((v) => v === 0)).toBe(true)
    }
  })
})

describe('the press hands its outline to the knockout', () => {
  it('pressPlate returns the very roughened field and offset a knockout under it needs', () => {
    // The knockout used to roughen the tone a second time, with the same input,
    // seed and parameters as the plate's own call — a full blur pass for a
    // field already in memory. It now takes the plate's own.
    const w = 96
    const h = 120
    const s = defaultSettings()
    const tone = new Float32Array(w * h)
    for (let y = 30; y < 90; y++) for (let x = 20; x < 76; x++) tone[y * w + x] = 1
    const cache = ensureCache(null, s, w, h)
    const fontSize = h * 0.12
    const index = 1
    const out = pressPlate({ field: tone, fontSize }, index, s.press, s.seed, cache, w, h)

    const scale = h / REFERENCE_HEIGHT
    const detail = detailFactor(fontSize, h)
    const own = roughenEdges(tone, w, h, {
      roughness: s.press.roughness,
      scale: s.press.roughScale * scale * detail,
      bleed: s.press.bleed * detail,
      seed: s.seed ^ (index * 0x9e3779b9),
    })
    expect([...out.roughened]).toEqual([...own])
    expect({ dx: out.dx, dy: out.dy }).toEqual(
      registrationOffset(s.seed, index, s.press.misregistration * scale * Math.sqrt(detail)),
    )
    // ...and it did not touch the cached tone it was given.
    expect(tone[0]).toBe(0)
    expect(tone[40 * w + 40]).toBe(1)
  })
})

describe('knockoutMask', () => {
  /** A fixed 300 px synthetic case: soft-edged discs and bars as the plate's
   *  roughened tone, a luminance ramp with a bright bump as the ground. */
  const N = 300
  const synthetic = () => {
    const tone = new Float32Array(N * N)
    const lum = new Float32Array(N * N)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x
        const d = Math.hypot(x - 90, y - 110)
        const disc = Math.min(1, Math.max(0, (40 - d) / 3))
        const bar = y > 180 && y < 240 && x > 40 && x < 270 ? 1 : 0
        const edge = Math.min(1, Math.max(0, (x - 150) / 4)) * (y > 60 && y < 160 ? 1 : 0)
        tone[i] = Math.max(disc, bar, edge * (x < 260 ? 1 : 0))
        lum[i] = Math.min(1, x / N + 0.4 * Math.exp(-((x - 220) ** 2 + (y - 200) ** 2) / 900))
      }
    }
    return { tone, lum, light: bandMask(lum, 0.5) }
  }
  const sha = (f: Float32Array) =>
    createHash('sha256').update(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)).digest('hex')

  it('is a golden on a fixed synthetic case (pinned: later work must keep it)', () => {
    const { tone, lum, light } = synthetic()
    const split = knockoutMask(tone, lum, {
      w: N,
      h: N,
      dx: 2.37,
      dy: -1.61,
      split: { light, onLightLuma: 0.2, onDarkLuma: 0.9 },
    })
    const block = knockoutMask(tone, null, { w: N, h: N, dx: -3.2, dy: 1.75 })
    expect(sha(split)).toBe(KNOCKOUT_GOLDEN.split)
    expect(sha(block)).toBe(KNOCKOUT_GOLDEN.block)
  })

  it('cuts a solid hole, not the anti-aliased skirt, and travels with the plate', () => {
    const w = 20
    const h = 10
    const tone = new Float32Array(w * h)
    for (let y = 2; y < 8; y++) for (let x = 5; x < 10; x++) tone[y * w + x] = x === 5 ? 0.5 : 1
    const k = knockoutMask(tone, null, { w, h, dx: 3, dy: 0 })
    // A 0.5 edge pixel is a whole hole; the field moved three pixels.
    expect(k[4 * w + 8]).toBe(1)
    expect(k[4 * w + 5]).toBe(0)
    expect(k[4 * w + 12]).toBe(1)
  })

  it('with a split, cuts only where the ink chosen there is lighter than the ground', () => {
    const tone = new Float32Array(4).fill(1)
    const lum = new Float32Array([0.1, 0.1, 0.95, 0.95])
    const light = new Float32Array([0, 1, 0, 1])
    const k = knockoutMask(tone, lum, {
      w: 4,
      h: 1,
      dx: 0,
      dy: 0,
      split: { light, onLightLuma: 0.05, onDarkLuma: 0.9 },
    })
    // Dark ground: the light ink (on the dark half of the mask) needs a hole;
    // the dark ink does not. Light ground: neither ink is lighter than it.
    expect([...k]).toEqual([1, 0, 0, 0])
  })
})

describe('the plate\'s own ink as its second ink (what Opaque became)', () => {
  // Ported from the trial's render check (pm/judge-opaque.mjs) to pure stages:
  // pink type in a solid band across a dark half and a light half of a photo.
  const w = 120
  const h = 60
  const pink = inkById('fluorescentpink').rgb
  const ground = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = ((x * 7919 + y * 104729) % 23) - 11
      const v = (x < w / 2 ? 30 : 225) + n
      const o = (y * w + x) * 4
      ground[o] = ground[o + 1] = ground[o + 2] = v
      ground[o + 3] = 255
    }
  }
  const tone = new Float32Array(w * h)
  for (let y = 15; y < 45; y++) for (let x = 6; x < w - 6; x++) tone[y * w + x] = 0.5
  const screen = (f: Float32Array) =>
    screenField(f, w, h, { shape: 'circle', pitch: 5, angle: 45, softness: 0, originX: 0, originY: 0 })
  const coverage = screen(tone)
  const groundLum = groundLuma(ground, w, h, 4)
  const light = screen(bandMask(groundLum, 0.5))
  const paper = { shade: new Float32Array(w * h).fill(1), rgb: [255, 255, 255] as const }

  const sameInk = () => {
    const split = splitInks(pink, pink)
    const onLight = new Float32Array(w * h)
    const onDark = new Float32Array(w * h)
    for (let i = 0; i < coverage.length; i++) {
      onLight[i] = coverage[i] * light[i]
      onDark[i] = coverage[i] * (1 - light[i])
    }
    const k = knockoutMask(tone, groundLum, {
      w,
      h,
      dx: 0,
      dy: 0,
      split: { light, onLightLuma: split.onLightLuma, onDarkLuma: split.onDarkLuma },
    })
    const cut = new Uint8ClampedArray(ground)
    for (let i = 0; i < k.length; i++) cut[i * 4 + 3] = cut[i * 4 + 3] * (1 - k[i])
    const out = new Uint8ClampedArray(w * h * 4)
    compositeLayers(out, w, h, { ...paper, base: cut, paperAmount: 0 }, [
      { coverage: onLight, rgb: split.onLight },
      { coverage: onDark, rgb: split.onDark },
    ])
    return out
  }

  /** What Opaque drew: the ink lerped over the photo by coverage. */
  const opaqueReference = () => {
    const out = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const c = coverage[i]
      for (let ch = 0; ch < 3; ch++) out[i * 4 + ch] = ground[i * 4 + ch] * (1 - c) + pink[ch] * c
      out[i * 4 + 3] = 255
    }
    return out
  }

  const pinkShare = (img: Uint8ClampedArray, x0: number, x1: number) => {
    let n = 0
    let hits = 0
    for (let y = 20; y < 40; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4
        n++
        if (img[o] > 170 && img[o + 1] < 130 && img[o + 2] > 100) hits++
      }
    }
    return (100 * hits) / n
  }

  it('keeps the ink readable over the dark half, as Opaque did, within 5 points', () => {
    const same = pinkShare(sameInk(), 12, 50)
    const opaque = pinkShare(opaqueReference(), 12, 50)
    expect(opaque).toBeGreaterThan(20)
    expect(Math.abs(same - opaque)).toBeLessThanOrEqual(5)
    // Plain transparent pink over the dark half is not readable at all.
    const plain = new Uint8ClampedArray(w * h * 4)
    compositeLayers(plain, w, h, { ...paper, base: ground, paperAmount: 0 }, [{ coverage, rgb: pink }])
    expect(pinkShare(plain, 12, 50)).toBe(0)
  })

  it('is the ordinary transparent overprint over the light half', () => {
    const same = sameInk()
    const plain = new Uint8ClampedArray(w * h * 4)
    compositeLayers(plain, w, h, { ...paper, base: ground, paperAmount: 0 }, [{ coverage, rgb: pink }])
    for (let y = 0; y < h; y++) {
      for (let x = w / 2 + 8; x < w; x++) {
        const o = (y * w + x) * 4
        expect([same[o], same[o + 1], same[o + 2]]).toEqual([plain[o], plain[o + 1], plain[o + 2]])
      }
    }
  })
})

describe('backing', () => {
  const measure = (text: string, size: number) => text.length * size * 0.5

  it('is one block per line with ink, read off the layout, padded 0.12 em', () => {
    const layer = makeLayer({ text: 'AB\n\nCDEF', size: 0.1, lineHeight: 1, tracking: 0, align: 'center' })
    const layout = layoutText(layer, 1000, measure)
    const rects = lineRects(layout, layer.align, -layout.widest / 2, 0)
    // The blank line gets no block.
    expect(rects).toHaveLength(2)
    const pad = BACKING_PAD * layout.fontSize
    expect(rects[0].w).toBeCloseTo(layout.lines[0].width + 2 * pad, 6)
    expect(rects[1].w).toBeCloseTo(layout.lines[2].width + 2 * pad, 6)
    // Centred like the glyphs it sits behind.
    expect(rects[0].x + rects[0].w / 2).toBeCloseTo(rects[1].x + rects[1].w / 2, 6)
    // The third line sits two line heights below the first.
    expect(rects[1].y - rects[0].y).toBeCloseTo(2 * layout.lineHeight, 6)
  })

  it('knocks the photo back to paper under itself: ink on paper, not ink on black', () => {
    const w = 10
    const h = 4
    const black = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) black[i * 4 + 3] = 255
    const block = new Float32Array(w * h)
    for (let y = 1; y < 3; y++) for (let x = 2; x < 8; x++) block[y * w + x] = 1
    const k = knockoutMask(block, null, { w, h, dx: 0, dy: 0 })
    const cut = new Uint8ClampedArray(black)
    for (let i = 0; i < k.length; i++) cut[i * 4 + 3] = cut[i * 4 + 3] * (1 - k[i])
    const yellow = inkById('yellow').rgb
    const paper = { shade: new Float32Array(w * h).fill(1), rgb: [250, 246, 236] as const }
    const out = new Uint8ClampedArray(w * h * 4)
    compositeLayers(out, w, h, { ...paper, base: cut, paperAmount: 1 }, [{ coverage: block, rgb: yellow }])
    const inside = (1 * w + 4) * 4
    expect([out[inside], out[inside + 1], out[inside + 2]]).toEqual(expectedOverprint(paper.rgb, yellow))
    // Outside the block the photo is still there.
    expect(out[0]).toBe(0)
  })

  it('is overprinted by the type into a third colour', () => {
    const paper = { shade: new Float32Array(1).fill(1), rgb: [255, 255, 255] as const }
    const back = inkById('yellow').rgb
    const type = inkById('fluorescentpink').rgb
    const out = new Uint8ClampedArray(4)
    compositeLayers(out, 1, 1, paper, [
      { coverage: new Float32Array(1).fill(1), rgb: back },
      { coverage: new Float32Array(1).fill(1), rgb: type },
    ])
    const want = expectedOverprint(back, type)
    for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - want[c])).toBeLessThanOrEqual(2)
  })
})

/** Pinned hashes of knockoutMask on the synthetic case above. */
const KNOCKOUT_GOLDEN = {
  split: 'e1e0a65032399b0bfed8c5b2c0b57f3c821f3203348d5ce76ae52d40d3a4c229',
  block: 'ff6947ade8218fd8789c6b617b49d2bd7ac3c96268ef8ae5eb2c38738a57b0cb',
}
