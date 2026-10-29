/**
 * The frame through the render's two entry points: the preview (renderPrint,
 * the ground composed in place) and the export (renderPrintAsync, the ground
 * framed a band at a time), with 2D contexts that hand back a known photo.
 * The ground each hands the compositor is captured: the same bytes from
 * both, the fill outside the photo, Paper while the fill's input is absent,
 * and the photo drawn at the one layout's rectangle in both.
 */

import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ w: 0, h: 0, base: null as Uint8ClampedArray | null }))
vi.mock('./composite.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./composite.ts')>()
  return {
    ...real,
    compositeLayers: (...args: Parameters<typeof real.compositeLayers>) => {
      const [, w, h, paper, , y0 = 0, y1 = h, , rowBase = 0] = args
      // Rows [y0, y1) of the ground, held from rowBase on, into a sheet.
      if (paper.base && seen.w === w && seen.h === h) {
        seen.base ??= new Uint8ClampedArray(w * h * 4)
        seen.base.set(paper.base.subarray((y0 - rowBase) * w * 4, (y1 - rowBase) * w * 4), y0 * w * 4)
      }
      return real.compositeLayers(...args)
    },
  }
})

import { layoutSheet, sheetAspect, fillFor, type FrameInputs } from './frame.ts'
import { frostField, frostSampler } from './frost.ts'
import { FROST_FIELD_LONG } from './limits.ts'
import { makeFrameSource } from './__tests__/fields.ts'
import { outputSize, renderPrint, renderPrintAsync } from './render.ts'
import type { PrintSettings } from './types.ts'
import { defaultSettings, makeMedia } from '../state/defaults.ts'

/** The photo a canvas hands back: opaque, a pattern of each pixel's place
 *  on that canvas. The preview's canvas and the export's one tile are both
 *  the sheet, so the two read the same pixels at the same places. */
const photoAt = (x: number, y: number) => [(x * 3 + y) & 255, (x ^ y) & 255, (y * 5) & 255, 255]

function fakeContext() {
  const drawn: number[][] = []
  const canvas = { width: 0, height: 0 }
  const ctx = {
    canvas,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    clearRect: () => {},
    drawImage: (_m: unknown, ...r: number[]) => void drawn.push(r),
    getImageData: (x0: number, y0: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(photoAt(x0 + x, y0 + y), (y * w + x) * 4)
      return { data }
    },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn }
}

const palette = { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' }
const framed = (over: Partial<PrintSettings['frame']>, aspect: PrintSettings['aspect'] = '4:5'): PrintSettings => ({
  ...defaultSettings(),
  aspect,
  layers: [],
  // Not at its own pixels at the heights below: drawn resampled, as the
  // preview draws every photo.
  media: makeMedia({ id: 'p', width: 4000, height: 3000, scale: 1.3, x: 0.4, y: 0.6, palette }),
  frame: { width: 0.08, corners: 1, fill: 'muted', blur: 60, mode: 'crop', ...over },
})
const decoded = { width: 1000, height: 750 } as unknown as CanvasImageSource

/** The ground the compositor was handed, and where the photo was drawn. */
async function groundOf(s: PrintSettings, height: number, inputs: FrameInputs, entry: 'preview' | 'export') {
  const { w, h } = outputSize(sheetAspect(s), height)
  Object.assign(seen, { w, h, base: null })
  const out = fakeContext()
  const scratch = fakeContext()
  if (entry === 'preview') renderPrint(out.ctx, scratch.ctx, s, { current: null }, null, height, decoded, inputs)
  else await renderPrintAsync(out.ctx, scratch.ctx, s, height, decoded, inputs)
  const base = seen.base!
  Object.assign(seen, { w: 0, h: 0, base: null })
  return { base, w, h, drawn: scratch.drawn }
}

const px = (b: Uint8ClampedArray, w: number, x: number, y: number) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]

describe('the frame through the preview and the export', () => {
  for (const [name, s] of [
    ['Crop, round, Muted', framed({})],
    ['Fit, round, Comp', framed({ mode: 'fit', fill: 'comp', width: 0.12 })],
    ['Original, Deep', framed({ fill: 'deep', corners: 0.4 }, 'original')],
  ] as const) {
    it(`${name}: the same ground from both entry points, drawn at the one layout's rectangle, the fill outside the photo`, async () => {
      const height = 400
      const preview = await groundOf(s, height, { palette }, 'preview')
      const exported = await groundOf(s, height, { palette }, 'export')
      const { w, h } = preview
      const l = layoutSheet(s, w, h)
      // The photo is drawn at the layout's rectangle by both, once each.
      expect(preview.drawn).toEqual([[l.photo!.dx, l.photo!.dy, l.photo!.dw, l.photo!.dh]])
      expect(exported.drawn).toEqual(preview.drawn)
      expect(Buffer.from(exported.base).equals(Buffer.from(preview.base))).toBe(true)
      // Outside the photo, the fill; well inside it, the photo's own pixels.
      const fill = [...fillFor(s, { palette }, w, h).flat!]
      expect(fill[3]).toBe(255)
      expect(px(preview.base, w, 0, 0)).toEqual(fill)
      expect(px(preview.base, w, w - 1, h - 1)).toEqual(fill)
      const cx = l.shown.x0 + (l.shown.w >> 1)
      const cy = l.shown.y0 + (l.shown.h >> 1)
      // Just above the photo's middle: the border, or in Fit the matte.
      expect(px(preview.base, w, cx, l.shown.y0 - 1)).toEqual(fill)
      expect(px(preview.base, w, cx, cy)).toEqual(photoAt(cx, cy))
    })
  }

  it('with the fill\'s input absent the frame is Paper (alpha 0), and with it the fill: nothing else differs', async () => {
    const s = framed({ fill: 'photo' })
    for (const entry of ['preview', 'export'] as const) {
      const without = await groundOf(s, 300, {}, entry)
      const withIt = await groundOf(s, 300, { palette }, entry)
      const { w, h } = without
      const l = layoutSheet(s, w, h)
      let border = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inside = x >= l.shown.x0 && x < l.shown.x0 + l.shown.w && y >= l.shown.y0 && y < l.shown.y0 + l.shown.h
          if (inside) continue
          expect(px(without.base, w, x, y)).toEqual([0, 0, 0, 0])
          expect(px(withIt.base, w, x, y)).toEqual([0x28, 0x96, 0xc8, 255])
          border++
        }
      }
      expect(border).toBeGreaterThan(0)
      // Away from the corners the photo is the same either way.
      const cx = l.shown.x0 + (l.shown.w >> 1)
      expect(px(without.base, w, cx, l.shown.y0 + 40)).toEqual(px(withIt.base, w, cx, l.shown.y0 + 40))
    }
  })

  it('unframed, the ground is the photo as it always was: nothing composed', async () => {
    const s = framed({ width: 0, corners: 0 })
    const g = await groundOf(s, 300, { palette }, 'preview')
    for (const [x, y] of [[0, 0], [g.w - 1, g.h - 1], [17, 113]]) expect(px(g.base, g.w, x, y)).toEqual(photoAt(x, y))
  })
})

describe('fillFor: the choice, looked up', () => {
  const s = (fill: PrintSettings['frame']['fill']) => framed({ fill })
  const fillOf = (d: PrintSettings, inputs: FrameInputs) => fillFor(d, inputs, 400, 320)
  it('Paper is bare paper; a photo colour is its hex, opaque, or Paper until the palette is there; Frosted is Paper until its field is', () => {
    expect(fillOf(s('paper'), { palette }).flat).toEqual([0, 0, 0, 0])
    expect(fillOf(s('photo'), { palette }).flat).toEqual([0x28, 0x96, 0xc8, 255])
    expect(fillOf(s('deep'), { palette }).flat).toEqual([0x15, 0x22, 0x28, 255])
    expect(fillOf(s('muted'), { palette }).flat).toEqual([0x90, 0xb1, 0xc1, 255])
    expect(fillOf(s('comp'), { palette }).flat).toEqual([0xcb, 0x71, 0x2e, 255])
    for (const fill of ['photo', 'deep', 'muted', 'comp', 'frosted'] as const) expect(fillOf(s(fill), {}).flat).toEqual([0, 0, 0, 0])
    expect(fillOf(s('frosted'), { palette }).flat).toEqual([0, 0, 0, 0])
  })

  it("Frosted is its field, sampled over the sheet; a field made for another blur or another sheet shape is not there (Paper)", () => {
    const d = framed({ fill: 'frosted', blur: 120 })
    const field = frostField(makeFrameSource(300, 200, 3), sheetAspect(d), FROST_FIELD_LONG, 120)
    const f = fillOf(d, { frost: field })
    expect(f.flat).toBeNull()
    const row = new Uint8ClampedArray(400 * 4)
    f.row(10, 0, 400, row, 0)
    const want = new Uint8ClampedArray(400 * 4)
    frostSampler(field, 400, 320)(10, 0, 400, want, 0)
    expect(row).toEqual(want)
    expect(row[3]).toBe(255)
    expect(fillOf({ ...d, frame: { ...d.frame, blur: 121 } }, { frost: field }).flat).toEqual([0, 0, 0, 0])
    expect(fillOf({ ...d, aspect: '1:1' }, { frost: field }).flat).toEqual([0, 0, 0, 0])
  })
})

describe('Frosted through the preview and the export', () => {
  it('the same ground from both entry points, the border sampled from the field, the photo untouched', async () => {
    const s = framed({ fill: 'frosted', blur: 200, corners: 0.6 }, 'original')
    const frost = frostField(makeFrameSource(320, 240, 9), sheetAspect(s), FROST_FIELD_LONG, 200)
    const preview = await groundOf(s, 360, { frost }, 'preview')
    const exported = await groundOf(s, 360, { frost }, 'export')
    expect(Buffer.from(exported.base).equals(Buffer.from(preview.base))).toBe(true)
    const { w, h } = preview
    const l = layoutSheet(s, w, h)
    const sample = frostSampler(frost, w, h)
    const row = new Uint8ClampedArray(w * 4)
    for (const y of [0, l.shown.y0 >> 1, h - 1]) {
      sample(y, 0, w, row, 0)
      expect(Buffer.from(preview.base.subarray(y * w * 4, (y + 1) * w * 4)).equals(Buffer.from(row))).toBe(true)
    }
    const cx = l.shown.x0 + (l.shown.w >> 1)
    const cy = l.shown.y0 + (l.shown.h >> 1)
    expect(px(preview.base, w, cx, cy)).toEqual(photoAt(cx, cy))
    // Without its field: Paper.
    const without = await groundOf(s, 360, {}, 'preview')
    expect(px(without.base, w, 0, 0)).toEqual([0, 0, 0, 0])
  })
})
