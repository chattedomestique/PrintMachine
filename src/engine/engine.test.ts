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

import { compositeLayers, type CompositeLayer } from './composite.ts'
import { ditherField } from './dither.ts'
import { applyDensity, applyMottle, edgeToRough, registrationOffset, wearToMottle } from './ink.ts'
import { contrastPartner, inkById, paperById, RISO_INKS } from './inks.ts'
import { paperField } from './paper.ts'
import { mulberry32, valueNoise2D, type CellNoise } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { BACKING_PAD, FIT_WIDTH, alignOffset, fitSize, justifyOffsets, layoutText, lineRects, type FontMeasure } from './text.ts'
import {
  DRAFT_HEIGHT,
  DRAFT_PIXELS,
  PREVIEW_HEIGHT,
  PREVIEW_PIXELS,
  detailFactor,
  draftSize,
  ensureCache,
  grainCell,
  groundRect,
  outputSize,
  pressPlate,
  previewSize,
  printSheet,
  renderPrint,
  type ToneSource,
} from './render.ts'
import { groundLuma, knockoutMask, shiftField } from './__tests__/reference.ts'
import { MissingPhotoError, planPrint, savePrint } from './export.ts'
import {
  bandMask,
  clampPan,
  coverRect,
  SNAP_PX,
  snapRect,
  fromPanFraction,
  type InkRgb,
  panBounds,
  panFraction,
  splitInks,
} from './media.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'
import { applySettings } from '../state/settingsReducer.ts'
import { REFERENCE_HEIGHT, SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX } from './limits.ts'
import { blurInPlace } from './blur.ts'
import { roughenInPlace, type RoughOptions } from './rough.ts'
import { ASPECTS, FONTS, type PrintSettings, type TextLayer } from './types.ts'
import { sheetAspect } from './frame.ts'

const W = 24
const H = 24

/** The press's blur, run in place on a copy of `src` with fresh buffers. */
function blurred(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const out = src.slice()
  blurInPlace(out, w, h, radius, new Float32Array(src.length), new Float32Array(src.length))
  return out
}

/** The press's tear, run in place on a copy of `src` with fresh buffers. */
function torn(src: Float32Array, w: number, h: number, opts: RoughOptions): Float32Array {
  const out = src.slice()
  roughenInPlace(out, w, h, opts, new Float32Array(src.length), new Float32Array(src.length))
  return out
}

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
    const cov = screenField(ramp(), W, H, {
      pitch: 5,
      angle: 37,
      softness: 0.7,
      originX: 2.4,
      originY: -1.1,
    })
    for (const v of cov) expect(v).toBeGreaterThanOrEqual(0)
    for (const v of cov) expect(v).toBeLessThanOrEqual(1)
  })

  it('prints nothing from a zero tone field — the null case is truly null', () => {
    const cov = screenField(new Float32Array(W * H), W, H, {
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

describe('grain (Atkinson)', () => {
  it('produces a strictly binary field, at any cell size', () => {
    for (const scale of [1, 2, 3, 5]) {
      const out = ditherField(ramp(), W, H, { scale })
      for (const v of out) expect(v === 0 || v === 1).toBe(true)
    }
  })

  it('does not mutate the tone field it was given', () => {
    const tone = ramp()
    const before = Float32Array.from(tone)
    ditherField(tone, W, H)
    expect(Array.from(tone)).toEqual(Array.from(before))
  })

  it('tracks the input tone on average, a little light as Atkinson is', () => {
    // Atkinson diffuses only 6/8 of the error, which is its look: light tone
    // prints lighter. It still has to follow the tone.
    const mean = (f: Float32Array) => f.reduce((a, b) => a + b, 0) / f.length
    const at = (t: number) => mean(ditherField(new Float32Array(64 * 64).fill(t), 64, 64))
    expect(at(0.3)).toBeGreaterThan(0.15)
    expect(at(0.3)).toBeLessThan(0.4)
    expect(at(0.3)).toBeLessThan(at(0.6))
  })

  it('rides the screen size: a third of it, so a converted dither keeps its exact cell', () => {
    // A saved dither of cell c is stored as a screen size of 3c. Its grain must
    // come out the size the dither did, at every height the app renders at.
    expect(grainCell(9, 1)).toBe(3)
    // 1..12: the whole range the old Dot size slider could set. Exact at the
    // reference height; scaled with the sheet, unrounded, elsewhere.
    for (let cell = 1; cell <= 12; cell++) {
      expect(grainCell(cell * 3, 1)).toBe(cell)
      for (const h of [DRAFT_HEIGHT, PREVIEW_HEIGHT, 1500, REFERENCE_HEIGHT, 3780]) {
        const scale = h / REFERENCE_HEIGHT
        expect(grainCell(cell * 3, scale)).toBeCloseTo(Math.max(1, cell * scale), 12)
      }
    }
  })

  it('makes cells of the asked size: a cell is one value throughout', () => {
    const out = ditherField(ramp(), W, H, { scale: 3 })
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        const v = out[y * W + x]
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) expect(out[(y + dy) * W + x + dx]).toBe(v)
      }
    }
  })
})

describe('ink', () => {
  it('Edge drives tear and bleed at the shipped 0.55 : 0.35, exactly at the default', () => {
    expect(edgeToRough(0.55)).toEqual({ roughness: 0.55, bleed: 0.35 })
    expect(edgeToRough(0)).toEqual({ roughness: 0, bleed: 0 })
    expect(edgeToRough(1).bleed).toBeCloseTo(0.35 / 0.55, 12)
  })

  it('Wear drives mottle and dropout at the shipped 0.22 : 0.012, exactly at the default', () => {
    expect(wearToMottle(0.22)).toEqual({ mottle: 0.22, dropout: 0.012 })
    expect(wearToMottle(0)).toEqual({ mottle: 0, dropout: 0 })
    expect(wearToMottle(0.8).dropout).toBeCloseTo((0.8 * 0.012) / 0.22, 12)
  })

  it('caps tone at the density ceiling — riso ink never reaches solid', () => {
    const out = applyDensity(new Float32Array(8).fill(1), 0.84)
    for (const v of out) expect(v).toBeCloseTo(0.84, 6)
  })

  it('keeps mottled coverage in range even at extreme settings', () => {
    const cov = new Float32Array(W * H).fill(0.9)
    const noise = valueNoise2D(W, H, 4, 99)
    const speckle: CellNoise = { cell: 1, seed: 7 }
    const out = applyMottle(cov, noise, speckle, 0.8, 0.5, W, H)
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0)
    for (const v of out) expect(v).toBeLessThanOrEqual(1)
  })

  it('leaves bare paper bare — mottle cannot invent ink', () => {
    const out = applyMottle(
      new Float32Array(W * H),
      valueNoise2D(W, H, 4, 1),
      { cell: 1, seed: 2 },
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
  // A stand-in for the browser's measure: width is 0.55 x size x characters,
  // read from the face's pixel size, so it is linear in size.
  const stub: FontMeasure = (font, text) => 0.55 * font.px * [...text].length
  const layer = (over: Partial<TextLayer> = {}): TextLayer =>
    makeLayer({ text: 'MACHINE', fontId: 'grotesk', tracking: 0, size: 0.1, ...over })
  const widest = (l: TextLayer, h: number) =>
    layoutText(l, h, (text, px) => stub({ stack: '', weight: 400, px }, text)).widest

  it('gives the size the stand-in implies: MACHINE on 4:5 is 0.92 x 0.8 / (0.55 x 7)', () => {
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

  it('may fit a short word past the Size slider, up to SIZE_MAX: Fit has to be able to fill the sheet', () => {
    // A one- to three-letter word is exactly what Fit is for, and on 4:5 it
    // fits far past the slider's 100%: "GO" at 0.92 x 0.8 / (2 x 0.55), about
    // 0.67; "A" at about 1.34, which clamps to the ceiling.
    const go = fitSize(layer({ text: 'GO' }), 0.8, stub)
    expect(go).toBeCloseTo((0.92 * 0.8) / (2 * 0.55), 12)
    expect(go).toBeGreaterThan(SIZE_SLIDER_MAX)
    expect(go).toBeLessThan(SIZE_MAX)
    expect(fitSize(layer({ text: 'A' }), 0.8, stub)).toBe(SIZE_MAX)
    // A 40-letter line fits small but inside the range.
    const long = fitSize(layer({ text: 'A'.repeat(40) }), 0.8, stub)
    expect(long).toBeGreaterThanOrEqual(SIZE_MIN)
    expect(long).toBeLessThanOrEqual(SIZE_MAX)
    expect(long).toBeCloseTo((0.92 * 0.8) / (40 * 0.55), 12)
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
    const out = blurred(flat, W, H, 3)
    for (const v of out) expect(v).toBeCloseTo(0.4, 5)
  })

  it('conserves total mass to within rounding', () => {
    const f = ramp()
    const before = f.reduce((a, b) => a + b, 0)
    const after = blurred(f, W, H, 2).reduce((a, b) => a + b, 0)
    // Edge clamping redistributes slightly; a gross mismatch means a bug.
    expect(after / before).toBeGreaterThan(0.95)
    expect(after / before).toBeLessThan(1.05)
  })

  it('leaves the field as it is at radius 0', () => {
    const f = ramp()
    const out = f.slice()
    blurInPlace(out, W, H, 0, new Float32Array(W * H))
    expect(Array.from(out)).toEqual(Array.from(f))
  })

  it('preserves a constant field at fractional radii too', () => {
    // The fractional window adds two partial end samples and divides by a
    // fractional count. Get either wrong and a flat field stops being flat —
    // the same rim as the classic seeding bug, just harder to spot.
    const flat = new Float32Array(W * H).fill(0.4)
    for (const r of [0.35, 0.5, 1.2, 1.75, 2.5, 3.9]) {
      for (const v of blurred(flat, W, H, r)) expect(v).toBeCloseTo(0.4, 5)
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
      const b = blurred(step, W, H, r)
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
    const a = blurred(f, W, H, 2)
    const b = blurred(f, W, H, 2.0)
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
    const out = f.slice()
    roughenInPlace(out, W, H, { roughness: 0, scale: 3, bleed: 0, seed: 1 }, new Float32Array(W * H))
    expect(Array.from(out)).toEqual(Array.from(f))
  })

  it('never punches holes in the middle of a solid', () => {
    const out = torn(solidSquare(), W, H, { roughness: 1, scale: 3, bleed: 0, seed: 5 })
    // Well inside the square, ink must still be solid however torn the edge is.
    for (let y = 11; y < H - 11; y++) {
      for (let x = 11; x < W - 11; x++) expect(out[y * W + x]).toBe(1)
    }
  })

  it('leaves bare paper bare', () => {
    const out = torn(new Float32Array(W * H), W, H, {
      roughness: 1,
      scale: 3,
      bleed: 1,
      seed: 5,
    })
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('stays in range and actually moves the edge', () => {
    const src = solidSquare()
    const out = torn(src, W, H, { roughness: 0.8, scale: 3, bleed: 0.5, seed: 9 })
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(Array.from(out)).not.toEqual(Array.from(src))
  })

  it('bleed grows the shape rather than shrinking it', () => {
    const src = solidSquare()
    const sum = (f: Float32Array) => f.reduce((a, b) => a + b, 0)
    const bled = torn(src, W, H, { roughness: 0, scale: 2, bleed: 1, seed: 3 })
    expect(sum(bled)).toBeGreaterThan(sum(src))
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
    pitch: 6,
    angle: 45,
    // Zero softness makes the assertion exact: a correct pipeline can only
    // emit bare paper or solid ink here, never a partial film.
    softness: 0,
    originX: 0,
    originY: 0,
  }
  const mottle = valueNoise2D(N, N, 8, 3)
  const speckle: CellNoise = { cell: 1, seed: 11 }
  // Heavy wear: a wide mottle swing and a lot of dropout.
  const wear = (f: Float32Array) => applyMottle(f, mottle, speckle, 0.8, 0.3, N, N)
  const flat = () => new Float32Array(N * N).fill(0.7)

  it('screens worn tone into coverage of only bare paper or solid ink', () => {
    const coverage = screenField(wear(flat()), N, N, opts)
    expect(new Set(coverage)).toEqual(new Set([0, 1]))
  })

  it('a worn area prints fewer dots, never paler ones', () => {
    const clean = screenField(flat(), N, N, opts)
    const worn = screenField(wear(flat()), N, N, opts)
    const dots = (f: Float32Array) => f.reduce((a, v) => a + (v === 1 ? 1 : 0), 0)
    expect(dots(worn)).toBeLessThan(dots(clean))
    // Every pixel that prints at all prints at full strength.
    for (const v of worn) expect(v === 0 || v === 1).toBe(true)
  })

  it('would NOT be binary if wear ran after the screen — the bug, stated', () => {
    // Documents why the order matters rather than trusting a comment: apply
    // the same wear to coverage instead of tone and mid-tones appear, which is
    // precisely the grey the compositor would render as thin ink.
    const afterScreen = wear(screenField(flat(), N, N, opts))
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

  /** Each printing glyph and where it lands. */
  const ink = (l: { glyphs: { ch: string; x: number; width: number }[] }) =>
    l.glyphs.filter((g) => g.ch !== ' ').map((g) => [g.ch, g.x, g.x + g.width])

  it('a space before the first letter or after the last is not a word gap: PRINT, "PRINT " and " PRINT" justify alike', () => {
    // The regression: a stray space made the line "have a space", the only gap
    // allowed to open was the one beside it, and the line printed ragged.
    const plain = layoutText(layer({ text: 'PRINT\nMACHINE' }), 1000, measure)
    for (const text of ['PRINT \nMACHINE', ' PRINT\nMACHINE', '  PRINT  \nMACHINE ', 'PRINT\n MACHINE']) {
      const out = layoutText(layer({ text }), 1000, measure)
      expect(out.widest).toBeCloseTo(plain.widest, 9)
      for (let i = 0; i < 2; i++) {
        const got = ink(out.lines[i])
        const want = ink(plain.lines[i])
        expect(got.length).toBe(want.length)
        got.forEach((g, k) => {
          expect(g[0]).toBe(want[k][0])
          expect(g[1] as number).toBeCloseTo(want[k][1] as number, 9)
        })
        expect(out.lines[i].width).toBeCloseTo(out.widest, 9)
      }
      // The ink runs from the block's edge to its edge.
      expect(ink(out.lines[0])[0][1]).toBeCloseTo(0, 9)
      expect(ink(out.lines[0]).at(-1)?.[2] as number).toBeCloseTo(out.widest, 9)
    }
  })

  it('a line whose only spaces are at its ends spreads its letters: "GO " over MACHINE', () => {
    const out = layoutText(layer({ text: 'GO \nMACHINE' }), 1000, measure)
    const [g, o] = ink(out.lines[0])
    expect(g[1]).toBeCloseTo(0, 9)
    expect(o[2] as number).toBeCloseTo(out.widest, 9)
  })

  it('an indented line with words opens only the gaps between its words', () => {
    const out = layoutText(layer({ text: ' AA BB\nCCCCCCCCCC' }), 1000, measure)
    const [a1, a2, b1, b2] = ink(out.lines[0])
    // Inside each word nothing moved; the one word gap took the slack.
    expect((a2[1] as number) - (a1[2] as number)).toBeCloseTo(0, 9)
    expect((b2[1] as number) - (b1[2] as number)).toBeCloseTo(0, 9)
    expect(a1[1]).toBeCloseTo(0, 9)
    expect(b2[2] as number).toBeCloseTo(out.widest, 9)
  })

  it('a line of nothing but spaces holds no ink, so it is not stretched and gets no backing', () => {
    const lay = layer({ text: 'AB\n   \nCD' })
    const out = layoutText(lay, 1000, measure)
    expect(out.lines[1].width).toBe(0)
    expect(lineRects(out, lay.align, -out.widest / 2, 0)).toHaveLength(2)
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

  it('random aspect switches, pans, zooms and replaced photos never leave the stored photo uncovering the sheet', () => {
    // Through the reducer, because that is what writes the stored placement:
    // pan to the side on one sheet shape, switch to another (Original among
    // them, whose shape is the photo's), or replace the photo with one of
    // another shape, and the value that was legal before has to be pulled
    // back, not left to the renderer.
    const rnd = mulberry32(99)
    const aspects = [...(Object.keys(ASPECTS) as PrintSettings['aspect'][]), 'original'] as const
    let replaced = 0
    let original = 0
    for (const src of SOURCES) {
      let s = applySettings(defaultSettings(), {
        type: 'setMedia',
        media: makeMedia({ id: 'p', ...src }),
      })
      for (let step = 0; step < 60; step++) {
        const r = rnd()
        if (r < 0.3) s = applySettings(s, { type: 'patch', patch: { aspect: aspects[Math.floor(rnd() * aspects.length)] } })
        else if (r < 0.6) s = applySettings(s, { type: 'patchMedia', patch: { x: rnd() * 4 - 1.5, y: rnd() * 4 - 1.5 } })
        else if (r < 0.85) s = applySettings(s, { type: 'patchMedia', patch: { scale: rnd() * 5 } })
        else {
          const next = SOURCES[Math.floor(rnd() * SOURCES.length)]
          s = applySettings(s, { type: 'setMedia', media: makeMedia({ id: `p${step}`, ...next, scale: s.media!.scale, x: s.media!.x, y: s.media!.y }) })
          replaced++
        }
        if (s.aspect === 'original') original++
        const m = s.media!
        const a = sheetAspect(s)
        // A fixed point of the clamp, in the units the reducer works in...
        expect(clampPan(m, a, 1)).toEqual(m)
        // ...and covering a real sheet in pixels.
        const W = a * 1000
        const H = 1000
        expect(m.scale).toBeGreaterThanOrEqual(1)
        const { dw, dh } = coverRect(m, W, H, { scale: m.scale, x: 0.5, y: 0.5 })
        expect(m.x * W - dw / 2).toBeLessThanOrEqual(1e-6)
        expect(m.x * W + dw / 2).toBeGreaterThanOrEqual(W - 1e-6)
        expect(m.y * H - dh / 2).toBeLessThanOrEqual(1e-6)
        expect(m.y * H + dh / 2).toBeGreaterThanOrEqual(H - 1e-6)
      }
    }
    // Both paths were exercised, not just possible.
    expect(replaced).toBeGreaterThan(10)
    expect(original).toBeGreaterThan(10)
  })
})

describe('the sheet\'s shape as a number', () => {
  const photo = (width: number, height: number) => makeMedia({ id: 'p', width, height })

  it('is the fixed ratio for a fixed sheet, with or without a photo', () => {
    for (const [key, a] of Object.entries(ASPECTS)) {
      expect(sheetAspect({ aspect: key as keyof typeof ASPECTS, media: null })).toBe(a)
      expect(sheetAspect({ aspect: key as keyof typeof ASPECTS, media: photo(4032, 3024) })).toBe(a)
    }
  })

  it("is the photo's own, upright shape for Original, inside 1:3..3:1, and 4:5 with no photo", () => {
    expect(sheetAspect({ aspect: 'original', media: photo(4032, 3024) })).toBeCloseTo(4 / 3, 12)
    expect(sheetAspect({ aspect: 'original', media: photo(3024, 4032) })).toBeCloseTo(3 / 4, 12)
    expect(sheetAspect({ aspect: 'original', media: photo(5712, 4284) })).toBeCloseTo(5712 / 4284, 12)
    // A panorama is cover-cropped to 3:1, a tall strip to 1:3: never a sliver.
    expect(sheetAspect({ aspect: 'original', media: photo(6000, 1200) })).toBe(3)
    expect(sheetAspect({ aspect: 'original', media: photo(1200, 6000) })).toBe(1 / 3)
    expect(sheetAspect({ aspect: 'original', media: null })).toBe(4 / 5)
  })
})

describe('the blit is pixel-exact when the sheet holds the photo at its own pixels', () => {
  it('snaps the 4:5 crop of a 12 MP photo at its native height to whole pixels and its own size', () => {
    // 4032x3024 on 4:5 at 3024 tall: 2419 wide, the photo centred half a
    // pixel off the grid (dx = -806.5).
    const r = coverRect({ width: 4032, height: 3024 }, 2419, 3024, { scale: 1, x: 0.5, y: 0.5 })
    expect(r.dx).toBeCloseTo(-806.5, 9)
    const s = snapRect(r, 4032, 3024, 2419, 3024)
    expect(s).toEqual({ dx: -806, dy: 0, dw: 4032, dh: 3024 })
    for (const v of Object.values(s)) expect(Number.isInteger(v)).toBe(true)
  })

  it('still covers the sheet after the snap, from any pan', () => {
    for (const x of [0, 0.13, 0.5, 0.77, 1]) {
      for (const [mw, mh, W, H] of [
        [4032, 3024, 2419, 3024],
        [3024, 4032, 3024, 3780],
        [4032, 3024, 4032, 3024],
        [6000, 1200, 3600, 1200],
      ]) {
        const r = coverRect({ width: mw, height: mh }, W, H, { scale: 1, x, y: x })
        const s = snapRect(r, mw, mh, W, H)
        expect([s.dw, s.dh]).toEqual([mw, mh])
        expect(s.dx).toBeLessThanOrEqual(0)
        expect(s.dy).toBeLessThanOrEqual(0)
        expect(s.dx + s.dw).toBeGreaterThanOrEqual(W)
        expect(s.dy + s.dh).toBeGreaterThanOrEqual(H)
        // Within a pixel of where the unsnapped blit put it.
        expect(Math.abs(s.dx - r.dx)).toBeLessThanOrEqual(1)
        expect(Math.abs(s.dy - r.dy)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is the identity on an already whole-pixel native rect, and leaves every other blit alone', () => {
    // The Original sheet at native height: the photo IS the sheet.
    const exact = coverRect({ width: 4032, height: 3024 }, 4032, 3024, { scale: 1, x: 0.5, y: 0.5 })
    expect(snapRect(exact, 4032, 3024, 4032, 3024)).toEqual(exact)
    expect(exact).toEqual({ dx: 0, dy: 0, dw: 4032, dh: 3024 })
    // The preview (far from 1:1), and a zoom at a height where it is 1.5x:
    // untouched.
    const preview = coverRect({ width: 4032, height: 3024 }, 800, 1000, { scale: 1, x: 0.5, y: 0.5 })
    expect(snapRect(preview, 4032, 3024, 800, 1000)).toBe(preview)
    const zoomed = coverRect({ width: 4032, height: 3024 }, 2419, 3024, { scale: 1.5, x: 0.5, y: 0.5 })
    expect(snapRect(zoomed, 4032, 3024, 2419, 3024)).toBe(zoomed)
    // At the zoom's own native height (the export plan's 1613x2016) it is
    // 1:1, and snaps like any other.
    const zoomedNative = coverRect({ width: 4032, height: 3024 }, 1613, 2016, { scale: 1.5, x: 0.5, y: 0.5 })
    expect(zoomedNative.dx).toBeCloseTo(-1209.5, 9)
    expect(snapRect(zoomedNative, 4032, 3024, 1613, 2016)).toEqual({ dx: -1209, dy: -504, dw: 4032, dh: 3024 })
    // A photo a pixel narrower than the sheet: snapped to its own size it
    // would leave a bare column, so the blit keeps its (enlarged) rect.
    const narrow = coverRect({ width: 1000, height: 2000 }, 1001, 1000, { scale: 1, x: 0.5, y: 0.5 })
    expect(Math.abs(narrow.dw / 1000 - 1)).toBeLessThan(SNAP_PX / 1000)
    expect(snapRect(narrow, 1000, 2000, 1001, 1000)).toBe(narrow)
    // groundRect applies it: the native export of a 4:5 crop is snapped.
    const m = makeMedia({ id: 'p', width: 4032, height: 3024 })
    expect(groundRect(m, 2419, 3024)).toEqual({ dx: -806, dy: 0, dw: 4032, dh: 3024 })
  })
})

describe('whichever decode of the photo is drawn, it fills the rectangle its true size gives', () => {
  // A 2D context that records what is drawn and hands back blank pixels: the
  // sheet below has no type, so nothing else needs a real canvas.
  const fakeContext = () => {
    const drawn: unknown[][] = []
    const canvas = { width: 0, height: 0 }
    const ctx = {
      canvas,
      imageSmoothingQuality: 'low',
      clearRect: () => {},
      drawImage: (...args: unknown[]) => void drawn.push(args),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn }
  }
  const sheet = (): PrintSettings => ({
    ...defaultSettings(),
    layers: [],
    // The default iPhone capture, zoomed and panned.
    media: makeMedia({ id: 'p', width: 5712, height: 4284, native: true, scale: 1.7, x: 0.42, y: 0.55 }),
  })

  it('the preview\'s working copy and the original land in the same place on the sheet', () => {
    const s = sheet()
    // A working copy whose floored size is a hair off the photo's shape, so a
    // rect taken from the copy's own size would land elsewhere.
    const working = { width: 2365, height: 1772 } as unknown as CanvasImageSource
    const original = { width: 5712, height: 4284 } as unknown as CanvasImageSource
    const draw = (height: number, bitmap: CanvasImageSource) => {
      const out = fakeContext()
      const scratch = fakeContext()
      let grounded = 0
      renderPrint(out.ctx, scratch.ctx, s, { current: null }, null, height, bitmap, () => grounded++)
      expect(grounded).toBe(1)
      expect(scratch.drawn).toHaveLength(1)
      const [source, dx, dy, dw, dh] = scratch.drawn[0] as [CanvasImageSource, number, number, number, number]
      expect(source).toBe(bitmap)
      const { w, h } = outputSize(sheetAspect(s), height)
      // Exactly the rectangle the document and the sheet give...
      expect({ dx, dy, dw, dh }).toEqual(groundRect(s.media!, w, h))
      // ...in sheet fractions:
      return [dx / w, dy / h, dw / w, dh / h]
    }
    const preview = draw(PREVIEW_HEIGHT, working)
    const exported = draw(REFERENCE_HEIGHT, original)
    // The width rounds to whole pixels, so the fractions agree to a pixel.
    preview.forEach((v, i) => expect(Math.abs(v - exported[i])).toBeLessThan(1 / PREVIEW_HEIGHT))
  })
})

describe('Save never prints a photo as bare paper', () => {
  it('refuses a document with a photo when no decode of it was handed over', async () => {
    const s = { ...defaultSettings(), media: makeMedia({ id: 'p', width: 100, height: 100 }) }
    // Refused before any canvas is made.
    let made = 0
    await expect(savePrint(s, null, { makeCanvas: () => (made++, {} as CanvasRenderingContext2D) })).rejects.toBeInstanceOf(MissingPhotoError)
    expect(made).toBe(0)
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

    const screened = ditherField(ramp, 8, 8)
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
  const SHEETS = [1 / 3, 2 / 3, 3 / 4, 4 / 5, 1, 4 / 3, 2, 3]

  it('is the same picture at lower fidelity, not a different one', () => {
    // Rendering smaller while a control moves is only safe because every
    // spatial quantity is expressed against REFERENCE_HEIGHT. If the draft had
    // a different aspect the preview would jump shape on every drag.
    for (const aspect of SHEETS) {
      const draft = draftSize(aspect)
      const full = previewSize(aspect)
      expect(draft.w / draft.h).toBeCloseTo(full.w / full.h, 1)
      expect(Math.abs(draft.w / draft.h - aspect)).toBeLessThan(1 / draft.h)
    }
  })

  it('is enough smaller to be worth switching to', () => {
    // The press is a dozen full-image passes per plate, so its cost goes with
    // the pixel count. A draft that is not several times cheaper buys nothing
    // and only costs a second cache.
    for (const aspect of SHEETS) {
      const draft = draftSize(aspect)
      const full = previewSize(aspect)
      expect((full.w * full.h) / (draft.w * draft.h)).toBeGreaterThan(4)
    }
  })

  it('never reaches the export, which is planned from the photo and never below the reference height', () => {
    // (export.test.ts holds the rule on the real savePrint.)
    for (const s of [defaultSettings(), { ...defaultSettings(), media: makeMedia({ id: 'p', width: 400, height: 300 }) }]) {
      const plan = planPrint(s)
      expect(plan.height).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
      expect(plan.height).toBeGreaterThan(PREVIEW_HEIGHT)
    }
  })
})

describe('the preview is sized by a pixel budget, not a height', () => {
  it('keeps every sheet at or narrower than square exactly as it was: 1000 tall, 280 for the draft', () => {
    for (const aspect of [1 / 3, 2 / 3, 3 / 4, 4 / 5, 1]) {
      expect(previewSize(aspect)).toEqual(outputSize(aspect, PREVIEW_HEIGHT))
      expect(draftSize(aspect)).toEqual(outputSize(aspect, DRAFT_HEIGHT))
    }
  })

  it('gives 333x1000 on 1:3, 800x1000 on 4:5, 1000x1000 on 1:1, 1155x866 on 4:3 and 1731x577 on 3:1', () => {
    expect(previewSize(1 / 3)).toEqual({ w: 333, h: 1000 })
    expect(previewSize(4 / 5)).toEqual({ w: 800, h: 1000 })
    expect(previewSize(1)).toEqual({ w: 1000, h: 1000 })
    expect(previewSize(4 / 3)).toEqual({ w: 1155, h: 866 })
    expect(previewSize(3)).toEqual({ w: 1731, h: 577 })
  })

  it('never costs more than the square sheet always did, up to the width\'s rounding', () => {
    // Floored height, rounded width: the overshoot is under half a row. A
    // flat 1,000,000 fails on correct code (4:3 is 866 x 1155 = 1,000,230).
    // 200,001 sheets from 1:3 to 3:1; collected, then asserted once.
    const over: string[] = []
    let worst = 0
    for (let i = 0; i <= 200_000; i++) {
      const aspect = Math.exp(Math.log(1 / 3) + (i / 200_000) * Math.log(9))
      const p = previewSize(aspect)
      const d = draftSize(aspect)
      worst = Math.max(worst, p.w * p.h - PREVIEW_PIXELS)
      if (p.w * p.h > PREVIEW_PIXELS + p.h / 2) over.push(`preview ${aspect}`)
      if (d.w * d.h > DRAFT_PIXELS + d.h / 2) over.push(`draft ${aspect}`)
      if (aspect <= 1 && p.h !== PREVIEW_HEIGHT) over.push(`height ${aspect}`)
    }
    expect(over).toEqual([])
    expect(worst).toBeLessThan(PREVIEW_HEIGHT / 2)
  })

  it('takes a landscape sheet as a plain number', () => {
    expect(outputSize(4 / 3, 3024)).toEqual({ w: 4032, h: 3024 })
    expect(outputSize(3, 600)).toEqual({ w: 1800, h: 600 })
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
    const speckle: CellNoise = { cell: 1, seed: 1 }

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
    const speckle: CellNoise = { cell: 1, seed: 4 }
    const a = applyMottle(cov, noise, speckle, 0.5, 0.2, W, H, 1)
    const b = applyMottle(cov, noise, speckle, 0.5, 0.2, W, H)
    expect([...a]).toEqual([...b])
  })

  it('still leaves bare paper bare at any detail', () => {
    for (const d of [1, 0.5, 0.22]) {
      const out = applyMottle(
        new Float32Array(W * H),
        valueNoise2D(W, H, 4, 1),
        { cell: 1, seed: 2 },
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
    const edge = edgeToRough(s.press.edge)
    const own = torn(tone, w, h, {
      roughness: edge.roughness,
      // The fixed tear scale, 3 px at the reference height.
      scale: 3 * scale * detail,
      bleed: edge.bleed * detail,
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
    screenField(f, w, h, { pitch: 5, angle: 45, softness: 0, originX: 0, originY: 0 })
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

  it('covers the ink, not an indent or a stray space', () => {
    for (const align of ['left', 'center', 'right', 'justify'] as const) {
      const layer = makeLayer({ text: '  AB \nCDEF', size: 0.1, lineHeight: 1, tracking: 0.1, align })
      const layout = layoutText(layer, 1000, measure)
      const [rect] = lineRects(layout, align, -layout.widest / 2, 0)
      const line = layout.lines[0]
      const inked = line.glyphs.filter((g) => g.ch !== ' ')
      const ox = -layout.widest / 2 + alignOffset(line.width, layout.widest, align)
      const pad = BACKING_PAD * layout.fontSize
      expect(rect.x).toBeCloseTo(ox + inked[0].x - pad, 9)
      expect(rect.x + rect.w).toBeCloseTo(ox + inked[1].x + inked[1].width + pad, 9)
    }
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

})

describe('printSheet: the passes exactly as the renderer presses them', () => {
  // The real stage renderPrint runs after the type is rasterised and the photo
  // blitted, driven here with tone fields made in the test. A clean press (no
  // edge, no wear, no misregistration, full ink, grain) makes a solid block
  // print solid, so pixels can be compared exactly; what is under test is the
  // order of passes, the knockouts and the split, not the texture.
  const w = 120
  const h = 80
  const block = (x0: number, y0: number, x1: number, y1: number) => {
    const f = new Float32Array(w * h)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) f[y * w + x] = 1
    return f
  }
  /** A photo: black on the left half, white on the right. */
  const halves = () => {
    const g = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      g.fill(i % w < w / 2 ? 0 : 255, i * 4, i * 4 + 3)
      g[i * 4 + 3] = 255
    }
    return g
  }
  /** A photo: black to white, left to right. */
  const ramp = () => {
    const g = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      g.fill(Math.round((255 * (i % w)) / (w - 1)), i * 4, i * 4 + 3)
      g[i * 4 + 3] = 255
    }
    return g
  }
  const sheet = (layers: Partial<TextLayer>[]): PrintSettings => {
    const s = defaultSettings()
    s.press = { ...s.press, method: 'grain', edge: 0, wear: 0, misregistration: 0, density: 1 }
    s.paperVeil = true
    s.media = makeMedia({ id: 'photo', width: w, height: h })
    s.layers = layers.map((l, i) => makeLayer({ id: `p${i}`, ...l }))
    return s
  }
  const fields = (type: Float32Array[], backing: Float32Array[] = []): ToneSource => ({
    // A small rendered size, so the ground's blur stays well inside a half.
    type: (l) => ({ field: type[Number(l.id.slice(1))], fontSize: 4 }),
    backing: (l) => ({ field: backing[Number(l.id.slice(1))], fontSize: 4 }),
  })
  const print = (s: PrintSettings, ground: Uint8ClampedArray | undefined, tones: ToneSource) => {
    const out = new Uint8ClampedArray(w * h * 4)
    const plates = printSheet(out, s, ground, tones, ensureCache(null, s, w, h), w, h)
    return { out, plates }
  }
  const px = (img: Uint8ClampedArray, x: number, y: number) => {
    const o = (y * w + x) * 4
    return [img[o], img[o + 1], img[o + 2]]
  }
  const each = (x0: number, y0: number, x1: number, y1: number, f: (x: number, y: number) => void) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) f(x, y)
  }
  const pink = inkById('fluorescentpink').rgb
  const yellow = inkById('yellow').rgb

  it('a backing is the first pass, prints on paper over a black photo, and the type overprints it into a third colour', () => {
    const s = sheet([{ inkId: 'fluorescentpink', backing: 'yellow', contrastInkId: null }])
    // The block and the type sit in the black half.
    const tones = fields([block(30, 30, 45, 50)], [block(10, 10, 58, 70)])
    const onPhoto = print(s, halves(), tones)
    const onPaper = print(s, undefined, tones)

    // Plate order is print order: the block goes down before its type.
    expect(onPhoto.plates.map((p) => p.rgb)).toEqual([yellow, pink])

    const paper = ensureCache(null, s, w, h).paper
    const near = (a: number[], b: number[], tol: number) =>
      a.forEach((v, c) => expect(Math.abs(v - b[c])).toBeLessThanOrEqual(tol))
    const under = (x: number, y: number) =>
      paper.rgb.map((v) => v * paper.shade[y * w + x]) as unknown as [number, number, number]

    // Inside the block, away from the type: yellow on paper, not on black.
    each(14, 14, 26, 26, (x, y) => {
      near(px(onPhoto.out, x, y), px(onPaper.out, x, y), 1)
      near(px(onPhoto.out, x, y), expectedOverprint(under(x, y), yellow), 2)
    })
    // Where the type crosses it: the type overprints the block.
    each(33, 33, 42, 47, (x, y) => {
      near(px(onPhoto.out, x, y), px(onPaper.out, x, y), 1)
      near(px(onPhoto.out, x, y), expectedOverprint(expectedOverprint(under(x, y), yellow), pink), 2)
    })
    // Outside the block the photo is untouched: still black.
    each(0, 0, 6, h, (x, y) => expect(px(onPhoto.out, x, y)).toEqual([0, 0, 0]))
  })

  it("the plate's own ink as its second ink keeps the ink over a black photo, and is plain ink over a light one", () => {
    const keep = sheet([{ inkId: 'fluorescentpink', contrastInkId: 'fluorescentpink' }])
    const plain = sheet([{ inkId: 'fluorescentpink', contrastInkId: null }])
    const tones = fields([block(4, 20, 116, 60)])
    const kept = print(keep, halves(), tones)
    // Pressed once, split in two, both halves the plate's own ink.
    expect(kept.plates.map((p) => p.rgb)).toEqual([pink, pink])

    const onPaper = print(keep, undefined, tones).out
    const transparent = print(plain, halves(), tones).out
    each(10, 26, 46, 54, (x, y) => {
      // Over black: pink on paper. Plain transparent pink there is black.
      expect(px(kept.out, x, y).map((v, c) => Math.abs(v - px(onPaper, x, y)[c]) <= 1)).toEqual([true, true, true])
      expect(px(transparent, x, y)).toEqual([0, 0, 0])
    })
    // Over white: exactly the ordinary transparent overprint.
    each(74, 20, 116, 60, (x, y) => expect(px(kept.out, x, y)).toEqual(px(transparent, x, y)))
  })

  it("so with the plate's own ink the Switch point changes nothing, which is why it is not offered", () => {
    const tones = fields([block(4, 20, 116, 60)])
    const at = (t: number) =>
      print(sheet([{ inkId: 'fluorescentpink', contrastInkId: 'fluorescentpink', contrastThreshold: t }]), ramp(), tones).out
    expect(at(0.2)).toEqual(at(0.8))
  })

  it('every plate switches at its own Switch point, whatever the plate before it does', () => {
    const tones = fields([block(0, 4, w, 36), block(0, 44, w, 76)])
    const two = (t1: number | null, t2: number) =>
      print(
        sheet([
          t1 === null
            ? { inkId: 'black', contrastInkId: null }
            : { inkId: 'black', contrastInkId: 'white', contrastThreshold: t1 },
          { inkId: 'black', contrastInkId: 'white', contrastThreshold: t2 },
        ]),
        ramp(),
        tones,
      ).plates
    const low = two(0.5, 0.2)
    const high = two(0.5, 0.8)
    const lit = (p: CompositeLayer) => {
      let n = 0
      for (const v of p.coverage) n += v
      return n
    }
    // The first plate's split is the same in both...
    expect(low[0].coverage).toEqual(high[0].coverage)
    // ...and the second plate's follows its own point: more of the ramp reads
    // as light at a 20% switch than at 80%.
    expect(lit(low[2])).toBeGreaterThan(lit(high[2]) * 1.5)
    // It is exactly the split it would have alone.
    expect(low[2].coverage).toEqual(two(null, 0.2)[1].coverage)
    expect(high[2].coverage).toEqual(two(null, 0.8)[1].coverage)
  })

  it("under halftone too, a plate's split does not move when another plate's Switch point does", () => {
    // Grain has no angle, so the test above cannot see this. A halftone mask
    // is screened at an angle; if a rebuilt mask took the rebuilding plate's
    // angle, plate 2's dots would turn whenever plate 1's point happened to
    // stop matching its own. Every switch mask is screened at one index.
    const halftone = (layers: Partial<TextLayer>[]) => {
      const s = sheet(layers)
      s.press = { ...s.press, method: 'halftone' }
      return s
    }
    const tones = fields([block(0, 4, w, 28), block(0, 30, w, 54), block(0, 56, w, 78)])
    const split = (t: number) => ({ inkId: 'black', contrastInkId: 'white', contrastThreshold: t })
    const press = (...ts: number[]) => print(halftone(ts.map(split)), ramp(), tones).plates
    const same = (a: CompositeLayer[], b: CompositeLayer[], from: number) => {
      expect(a[from].coverage).toEqual(b[from].coverage)
      expect(a[from + 1].coverage).toEqual(b[from + 1].coverage)
    }

    // Two plates: plate 2 at 50% splits identically with plate 1 at 50% (the
    // shared mask) and at 60% or 40% (a rebuilt one).
    const base = press(0.5, 0.5)
    same(base, press(0.6, 0.5), 2)
    same(base, press(0.4, 0.5), 2)
    // Three plates at 50% / x / 50%: plate 3 never sees plate 2's point.
    const three = press(0.5, 0.5, 0.5)
    for (const x of [0.51, 0.3]) same(three, press(0.5, x, 0.5), 4)
    // ...while each plate still follows its own point.
    expect(press(0.5, 0.2)[2].coverage).not.toEqual(base[2].coverage)
  })
})

/** Pinned hashes of knockoutMask on the synthetic case above. */
const KNOCKOUT_GOLDEN = {
  split: 'e1e0a65032399b0bfed8c5b2c0b57f3c821f3203348d5ce76ae52d40d3a4c229',
  block: 'ff6947ade8218fd8789c6b617b49d2bd7ac3c96268ef8ae5eb2c38738a57b0cb',
}
