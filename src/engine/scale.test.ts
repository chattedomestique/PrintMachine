/**
 * The same print at every size.
 *
 * A saved print renders at the photo's own resolution (exportPlan.ts), so it
 * is drawn at many heights: the preview at 1000, the reference at 1800, a 12 MP
 * photo's export at 3780. Every quantity the press uses has to be a fraction of
 * the SHEET, not a count of pixels, or the larger file is a different print:
 * finer paper grain, smaller dust, a grain cell rounded to another size.
 *
 * The test for each field is the one the resolution audit used: its
 * correlation length, in pixels, must grow in step with the height (within
 * 15%). Below the reference height a field stops at one pixel — a raster
 * cannot hold less, and that is the preview's lower fidelity, not a different
 * print — so pixel-floored fields are held to it from the reference height up,
 * which is every height a print is saved at.
 *
 * At the reference height itself each fix reduces to the old constant: the
 * goldens at the end were recorded from the build before these fixes.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { applyMottle } from './ink.ts'
import { ditherField } from './dither.ts'
import { paperField } from './paper.ts'
import { cellNoiseAt, hash2D, type CellNoise } from './rng.ts'
import { tearNoise } from './rough.ts'
import { ensureCache, grainCell, printSheet, switchScreen, type ToneSource } from './render.ts'
import { paperById } from './inks.ts'
import { REFERENCE_HEIGHT } from './limits.ts'
import { defaultSettings, makeLayer, makeMedia } from '../state/defaults.ts'

/**
 * Correlation length down the sheet, in pixels: the lag at which the
 * autocorrelation falls through 1/e, interpolated between whole lags,
 * averaged over a dozen columns. Measured along the height because that is
 * the axis that grows: the fields are isotropic, and a tall, narrow slice
 * holds many cells of even the coarsest one.
 */
function corrLength(f: ArrayLike<number>, w: number, h: number): number {
  const cols = Array.from({ length: 12 }, (_, k) => Math.floor(((k + 0.5) * w) / 12))
  let total = 0
  for (const x of cols) {
    let mean = 0
    for (let y = 0; y < h; y++) mean += f[y * w + x]
    mean /= h
    let variance = 0
    for (let y = 0; y < h; y++) variance += (f[y * w + x] - mean) ** 2
    let prev = 1
    for (let lag = 1; lag < h / 2; lag++) {
      let c = 0
      for (let y = 0; y < h - lag; y++) c += (f[y * w + x] - mean) * (f[(y + lag) * w + x] - mean)
      c = ((c / variance) * h) / (h - lag)
      if (c < 1 / Math.E) {
        total += lag - 1 + (prev - 1 / Math.E) / (prev - c)
        break
      }
      prev = c
    }
  }
  return total / cols.length
}

/** Length over height, relative to the first height: 1 everywhere is linear. */
const growth = (lengths: number[], heights: number[]) => lengths.map((l, i) => l / lengths[0] / (heights[i] / heights[0]))

const LINEAR: readonly [number, number] = [0.85, 1.15]
const expectLinear = (ratios: number[]) => {
  for (const r of ratios) {
    expect(r).toBeGreaterThanOrEqual(LINEAR[0])
    expect(r).toBeLessThanOrEqual(LINEAR[1])
  }
}

const sha = (a: ArrayBufferView) =>
  createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex')

/** A narrow sheet: every field here depends on the HEIGHT for its scale, so a
 *  slice of the width is enough to measure it and keeps the test fast. */
const W = 300

describe('the same print at every size: each texture grows with the sheet', () => {
  it('paper fibre: its grain is sized to the sheet, finest octave included', () => {
    // Was a 3 px cell whose finest octave stopped at 1 px on every sheet:
    // correlation length 2.0 px at 900, 1800 and 3600 alike.
    const heights = [900, 1800, 3600]
    const lengths = heights.map((h) => {
      const { shade } = paperField(W, h, { rgb: [255, 255, 255], texture: 1, blotch: 0, seed: 12345, scale: h / REFERENCE_HEIGHT })
      return corrLength(shade, W, h)
    })
    expectLinear(growth(lengths, heights))
  })

  it('the render cache builds that fibre, and the mottle and the paper cloud were already sized to the sheet', () => {
    const heights = [900, 1800, 3600]
    const s = { ...defaultSettings(), paperId: 'natural' }
    const caches = heights.map((h) => ensureCache(null, s, W, h))
    expectLinear(growth(caches.map((c, i) => corrLength(c.mottle, W, heights[i])), heights))
    // The cloud's cell is a fifth of the sheet's SHORTER side, so it is
    // measured on whole sheets (4:5), not a slice.
    const sheets = [450, 900, 1800]
    const cloud = sheets.map((h) => {
      const w = Math.round(h * 0.8)
      return corrLength(paperField(w, h, { rgb: [255, 255, 255], texture: 0, blotch: 1, seed: 5, scale: h / REFERENCE_HEIGHT }).shade, w, h)
    })
    expectLinear(growth(cloud, sheets))
    // The cache's fibre is the scaled one: at the reference height, the same
    // field paperField makes with scale 1.
    const ref = ensureCache(null, s, W, REFERENCE_HEIGHT).paper.shade
    const direct = paperField(W, REFERENCE_HEIGHT, { rgb: paperById('natural').rgb, texture: 0.4, blotch: 0.5, seed: s.seed, scale: 1 }).shade
    expect(sha(ref)).toBe(sha(direct))
  })

  it('speckle: a speck is a pixel at the reference height and grows with the sheet', () => {
    // Was one value of a seeded stream per PIXEL, so dust was half the size on
    // a sheet twice as tall (and a different pattern). A raster cannot draw a
    // speck under a pixel, so below the reference height it stays one pixel.
    const field = (h: number) => {
      const noise = ensureCache(null, defaultSettings(), W, h).speckle
      const f = new Float32Array(W * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) f[y * W + x] = cellNoiseAt(noise, x, y)
      return { f, noise }
    }
    const heights = [1800, 3600, 7200]
    const fields = heights.map(field)
    expect(fields.map((f) => f.noise.cell)).toEqual([1, 2, 4])
    expectLinear(growth(fields.map(({ f }, i) => corrLength(f, W, heights[i])), heights))
    expect(field(900).noise.cell).toBe(1)
  })

  it('speckle drops out the share of the ink it is asked to, at every size (within 1.5%)', () => {
    // Flat ink, no mottle: every pixel the dropout takes is left at 15%. Each
    // case holds enough specks that 1.5% is over three standard deviations of
    // the count (the default 0.012 needs millions, so it runs on one-pixel
    // specks; larger specks are the same draw, cell for cell).
    const n = 2000
    const cov = new Float32Array(n * n).fill(0.8)
    const mottle = new Float32Array(n * n).fill(0.5)
    for (const [cell, dropouts] of [
      [1, [0.012, 0.05, 0.2]],
      [2, [0.05, 0.2]],
      [3.5, [0.2]],
    ] as const) {
      for (const dropout of dropouts) {
        const out = applyMottle(cov, mottle, { cell, seed: 0x85ebca6b ^ 12345 }, 0, dropout, n, n)
        let dropped = 0
        for (const v of out) if (v < 0.5) dropped++
        expect(Math.abs(dropped / out.length / dropout - 1)).toBeLessThan(0.015)
      }
    }
  })

  it('the speck hash is white: uniform, and unrelated to its neighbours', () => {
    const bins = new Array(10).fill(0)
    let lag = 0
    let sq = 0
    const n = 400
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = hash2D(i, j, 7)
        bins[Math.floor(v * 10)]++
        const c = v - 0.5
        sq += c * c
        lag += c * (hash2D(i + 1, j, 7) - 0.5) + c * (hash2D(i, j + 1, 7) - 0.5)
      }
    }
    for (const b of bins) expect(Math.abs(b / (n * n) - 0.1)).toBeLessThan(0.004)
    expect(Math.abs(lag / (2 * sq))).toBeLessThan(0.01)
    // Read in any order, from any cell size: a value belongs to its cell.
    const noise: CellNoise = { cell: 2.5, seed: 3 }
    expect(cellNoiseAt(noise, 7.4, 2)).toBe(cellNoiseAt(noise, 5, 0))
    expect(cellNoiseAt(noise, 7.6, 2)).not.toBe(cellNoiseAt(noise, 5, 0))
  })

  it('the tear wander grows with the sheet, on small type as well as poster type', () => {
    // pressPlate asks for a tear of 3 px x scale x detail. On the smallest type
    // (detail 0.22-0.25) the fine octave sits at the one-pixel floor at the
    // reference height, and stays within the band from there up.
    for (const [detail, heights] of [
      [1, [900, 1800, 3600]],
      [0.25, [1800, 3600, 7200]],
      [0.22, [1800, 3600, 7200]],
    ] as const) {
      const lengths = heights.map((h) => {
        const noise = tearNoise(W, 3 * (h / REFERENCE_HEIGHT) * detail, 99)
        const f = new Float32Array(W * h)
        for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) f[y * W + x] = noise.at(x, y)
        return corrLength(f, W, h)
      })
      expectLinear(growth(lengths, [...heights]))
    }
  })

  it("the switch mask's screen: pitch and origin are sheet fractions", () => {
    // The origin was a fixed seed % 7, seed % 5 pixels: a smaller fraction of
    // a cell on every larger sheet, so the mask's dots moved against the plate's.
    const press = defaultSettings().press
    const at = (s: number) => switchScreen(1, press, 12345, s)
    for (const s of [0.5, 2, 4]) {
      expect(at(s).originX).toBeCloseTo(at(1).originX * s, 12)
      expect(at(s).originY).toBeCloseTo(at(1).originY * s, 12)
      expect(at(s).pitch).toBeCloseTo(at(1).pitch * s, 12)
    }
    // ...and at the reference height they are the old constants.
    expect(at(1)).toEqual({ pitch: 9, angle: 75, softness: 0, originX: 12345 % 7, originY: 12345 % 5 })
  })
})

describe('the grain: an exact cell, the same density at every size', () => {
  it('rides the screen size and the sheet unrounded: a third of the pitch, times the scale', () => {
    expect(grainCell(9, 1)).toBe(3)
    expect(grainCell(9, 0.56)).toBeCloseTo(1.68, 12)
    expect(grainCell(9, 2.1)).toBeCloseTo(6.3, 12)
    // Never finer than a pixel.
    expect(grainCell(3, 0.25)).toBe(1)
  })

  it('maps pixel x to cell floor(x / cell), the same way down and up', () => {
    // A tone that is exactly 1 or 0 per cell dithers to itself, so the output
    // shows which cell each pixel was averaged into and painted from.
    for (const cell of [1.68, 2.5, 3, 6.3]) {
      const w = 61
      const h = 37
      const cellOf = (x: number, y: number) => (Math.floor(x / cell) + Math.floor(y / cell)) % 2
      const tone = new Float32Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tone[y * w + x] = cellOf(x, y)
      const out = ditherField(tone, w, h, { scale: cell })
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(out[y * w + x]).toBe(cellOf(x, y))
    }
  })

  it('prints the same density at twice the height (within 5%)', () => {
    // Error diffusion is chaotic, so two sizes are never the same dots; they
    // must be the same amount of ink, cell for cell.
    const make = (h: number) => {
      const w = Math.round(h * 0.8)
      const tone = new Float32Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tone[y * w + x] = 0.05 + 0.9 * (x / (w - 1)) * (0.6 + 0.4 * (y / (h - 1)))
      const out = ditherField(tone, w, h, { scale: grainCell(9, h / REFERENCE_HEIGHT) })
      // Ink in each fifth of the sheet, left to right.
      const bands = new Array(5).fill(0)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bands[Math.floor((x * 5) / w)] += out[y * w + x]
      return bands.map((b) => b / (w * h / 5))
    }
    for (const [a, b] of [
      [600, 1200],
      [900, 1800],
    ]) {
      const small = make(a)
      const big = make(b)
      small.forEach((v, i) => expect(Math.abs(big[i] / v - 1)).toBeLessThan(0.05))
    }
  })
})

describe('at the reference height, nothing but the speckle moved (pins re-recorded on purpose since, see below)', () => {
  // Recorded from the build before these fixes (f04ac1b).
  const ramp = (w: number, h: number) => {
    const f = new Float32Array(w * h)
    for (let i = 0; i < f.length; i++) f[i] = ((i % w) / (w - 1)) * 0.8 + 0.1 * Math.sin(i / w)
    return f
  }

  it('paper: the same field', () => {
    const paper = paperField(144, 1800, { rgb: paperById('natural').rgb, texture: 0.4, blotch: 0.5, seed: 12345 })
    expect(sha(paper.shade)).toBe('9eb7e0b0c6ffa56347fcba245deb6e7ab6699262daa0f113ae92b132c89854c9')
  })

  it('grain at a whole-number cell: the same dots', () => {
    expect(sha(ditherField(ramp(97, 61), 97, 61, { scale: 2 }))).toBe('2931f4555eb896725dff09a528f2360b6ff74aeccc7adf4fac98977176ee09c2')
    expect(sha(ditherField(ramp(97, 61), 97, 61, { scale: 3 }))).toBe('8644eae8d5b2858fb28abfec7c9b32a8faf9f14ba68a8251210285622ee8a5f9')
    expect(sha(ditherField(ramp(97, 61), 97, 61, { scale: 5 }))).toBe('158bebffee6752b7c1a0bf46ea43d24aa5d5748ed78b6fad80ae72fc38cbc06f')
  })

  it('a whole sheet with no wear (so no speckle): a second ink over a ramp and a backed plate, halftone and grain', () => {
    // printSheet at 1800 tall: paper, the tear, the screen, the grain at its
    // 3 px cell and the switch mask's screen origin, all as before.
    const w = 96
    const h = REFERENCE_HEIGHT
    const ground = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const v = Math.round(255 * ((i % w) / (w - 1)))
      ground[i * 4] = v
      ground[i * 4 + 1] = (v + ((i / w) | 0)) & 255
      ground[i * 4 + 2] = 255 - v
      ground[i * 4 + 3] = 255
    }
    const block = (y0: number, y1: number) => {
      const f = new Float32Array(w * h)
      for (let y = y0; y < y1; y++) for (let x = 8; x < w - 8; x++) f[y * w + x] = 1
      return f
    }
    // Recorded on f04ac1b, before the scale fixes, and re-pinned since on
    // purpose, twice, by the memory diet (diet.test.ts):
    //  - step 2, coverage in bytes: the halftone moved by at most one level
    //    (mean 0.004; was 4cf552fa5d93...), the binary grain not at all;
    //  - step 6, the ground's luminance on a grid (cell 11 px here): the
    //    second ink's switch and knockout moved where the blurred luminance
    //    sits on a threshold — on this ramp a 96 px slice is near one across
    //    its whole width, so the halftone moved on its switch line (mean 0.86
    //    levels; was 91ec7d3c70ac...) and the grain, whose switch is error
    //    diffusion, re-dithered its mixing band (mean 26 levels; was
    //    6190f55942d1...). diet.test.ts holds the change to under 1% of the
    //    pixels on a photo.
    const golden = {
      halftone: '752362932025fa77362061bcf991e6af0d01776be5cf5779714a3f678b2cc12d',
      grain: 'b3743f23fe93a28ab4df05bb855c8a5b8435f921630118e4ac76ac808351b456',
    }
    for (const method of ['halftone', 'grain'] as const) {
      const s = defaultSettings()
      s.press = { ...s.press, method, wear: 0 }
      s.media = makeMedia({ id: 'p', width: w, height: h })
      s.layers = [
        makeLayer({ id: 'p0', inkId: 'black', contrastInkId: 'white', contrastThreshold: 0.5 }),
        makeLayer({ id: 'p1', inkId: 'fluorescentpink', backing: 'yellow' }),
      ]
      const tones = [block(200, 700), block(900, 1500)]
      const src: ToneSource = {
        type: (l) => ({ field: tones[Number(l.id.slice(1))], fontSize: 120 }),
        backing: () => ({ field: block(850, 1550), fontSize: 120 }),
      }
      const img = new Uint8ClampedArray(w * h * 4)
      printSheet(img, s, ground, src, ensureCache(null, s, w, h), w, h)
      expect(sha(img)).toBe(golden[method])
    }
  })
})
