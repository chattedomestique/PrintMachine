/**
 * The sheet and its frame (frame.ts): the shape, the border, the three
 * rectangles and the photo's place, swept over random photos, sheets, zooms,
 * pans and widths with a fixed generator.
 */

import { describe, expect, it } from 'vitest'
import {
  borderPx,
  composeFrameRows,
  containRect,
  cornerCoverage,
  effectiveMode,
  fillRgba,
  isUnframed,
  layoutSheet,
  originalBorder,
  originalVisible,
  sheetAspect,
  visibleAspect,
  type FrameFill,
  type RowSampler,
  type SheetLayout,
  type SheetSpec,
} from './frame.ts'
import { clampByte, compositeLayers } from './composite.ts'
import { makeGround } from './__tests__/fields.ts'
import { FRAME_CORNER_DIV, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX } from './limits.ts'
import { SNAP_PX, areaOf, clampPan, coverRect, panBounds, snapRect, type Area, type DrawRect } from './media.ts'
import { isNativeRect, outputSize } from './render.ts'
import { mulberry32 } from './rng.ts'
import { ASPECTS, type FrameSettings, type MediaLayer, type PrintSettings } from './types.ts'
import { defaultSettings } from '../state/defaults.ts'
import { applySettings, type SettingsAction } from '../state/settingsReducer.ts'

const KEYS = [...Object.keys(ASPECTS), 'original'] as PrintSettings['aspect'][]
const NAMED = [
  [7728, 5152],
  [5152, 7728],
  [9504, 6336],
  [4032, 3024],
  [1, 1],
  [12000, 4000],
] as const

const frame = (over: Partial<FrameSettings> = {}): FrameSettings => ({ width: 0, corners: 0, fill: 'photo', blur: 60, mode: 'crop', ...over })
const photo = (width: number, height: number, over: Partial<MediaLayer> = {}): MediaLayer => ({ id: 'p', width, height, scale: 1, x: 0.5, y: 0.5, ...over })
const spec = (aspect: PrintSettings['aspect'], media: MediaLayer | null, f: Partial<FrameSettings> = {}): SheetSpec => ({ aspect, media, frame: frame(f) })

/** The sheet at a height, as the preview and the harness size it. */
const sheetAt = (s: SheetSpec, height: number) => outputSize(sheetAspect(s), height)

const inside = (r: Area, outer: Area) =>
  r.x0 >= outer.x0 && r.y0 >= outer.y0 && r.x0 + r.w <= outer.x0 + outer.w && r.y0 + r.h <= outer.y0 + outer.h
const covers = (p: DrawRect, a: Area, eps = 1e-6) =>
  p.dx <= a.x0 + eps && p.dy <= a.y0 + eps && p.dx + p.dw >= a.x0 + a.w - eps && p.dy + p.dh >= a.y0 + a.h - eps

describe('unframed, the layout is the sheet as it always was', () => {
  it("width 0, corners 0, Crop: the photo's rectangle is the cover fit of the whole sheet, snapped, as before the frame, for 500 random photos, sheets, zooms, pans and heights", () => {
    const rand = mulberry32(0x1a)
    const cases: [number, number][] = [...NAMED.map(([w, h]) => [w, h] as [number, number])]
    for (let i = 0; i < 500; i++) cases.push([1 + Math.floor(rand() * 12000), 1 + Math.floor(rand() * 12000)])
    for (const [mw, mh] of cases) {
      const m = photo(mw, mh, { scale: 1 + rand() * 3 * Number(rand() < 0.7), x: rand() * 1.4 - 0.2, y: rand() * 1.4 - 0.2 })
      const s = spec(KEYS[Math.floor(rand() * KEYS.length)], m)
      const height = 1 + Math.floor(rand() * 9000)
      const { w, h } = sheetAt(s, height)
      const l = layoutSheet(s, w, h)
      // The rule the sheet had: the cover of the w x h sheet at the placement, snapped.
      expect(l.photo).toEqual(snapRect(coverRect(m, areaOf(w, h), m), mw, mh, areaOf(w, h)))
      expect([l.border, l.visible, l.shown, l.radius]).toEqual([0, { x0: 0, y0: 0, w, h }, { x0: 0, y0: 0, w, h }, 0])
    }
  })

  it('without a photo there is no frame: the sheet, no photo, square, whatever is stored', () => {
    const l = layoutSheet(spec('4:5', null, { width: FRAME_WIDTH_MAX, corners: 1, mode: 'fit' }), 800, 1000)
    expect(l).toEqual({ w: 800, h: 1000, border: 0, visible: { x0: 0, y0: 0, w: 800, h: 1000 }, shown: { x0: 0, y0: 0, w: 800, h: 1000 }, photo: null, radius: 0 })
  })
})

describe("the sheet's shape", () => {
  it('a fixed key is its ratio, framed or not', () => {
    for (const key of Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]) {
      for (const width of [0, 0.05, FRAME_WIDTH_MAX]) expect(sheetAspect(spec(key, photo(4032, 3024), { width }))).toBe(ASPECTS[key])
    }
  })

  it("unframed Original is exactly the photo's shape clamped to 1:3..3:1, as before the frame", () => {
    // The rule the sheet had: a = mw / mh, held inside [1/3, 3].
    const before = (mw: number, mh: number) => {
      const a = mw / mh
      return a < 1 / 3 ? 1 / 3 : a > 3 ? 3 : a
    }
    const rand = mulberry32(0x2b)
    const sizes: [number, number][] = [[3, 1], [1, 3], [3001, 1000], [1000, 3001], [2999, 1000], [6000, 1200], [1200, 6000], [1, 1]]
    for (let i = 0; i < 20000; i++) sizes.push([1 + Math.floor(rand() * 20000), 1 + Math.floor(rand() * 20000)])
    for (const [mw, mh] of sizes) {
      expect(sheetAspect(spec('original', photo(mw, mh)))).toBe(before(mw, mh))
      expect(sheetAspect({ aspect: 'original', media: photo(mw, mh) })).toBe(before(mw, mh))
    }
    expect(sheetAspect(spec('original', null, { width: 0.1 }))).toBe(4 / 5)
  })

  it('framed Original is the photo plus the border round it: 7728x5152 at the first width is 9016x6440', () => {
    expect(originalBorder(7728, 5152, FRAME_WIDTH_FIRST)).toBe(644)
    expect(sheetAspect(spec('original', photo(7728, 5152), { width: FRAME_WIDTH_FIRST }))).toBe(9016 / 6440)
    expect(sheetAspect(spec('original', photo(5152, 7728), { width: FRAME_WIDTH_FIRST }))).toBe(6440 / 9016)
    // Border Studio's free sheet: 150 px round an 1800x1200 photo.
    expect(originalBorder(1800, 1200, 150 / 2100)).toBe(150)
  })

  it('the border is the smallest whole fixed point, for 300 photo sizes and every width to the widest in steps of 0.005', () => {
    const rand = mulberry32(0x3c)
    for (let i = 0; i < 300; i++) {
      const { vw, vh } = originalVisible(1 + Math.floor(rand() * 12000), 1 + Math.floor(rand() * 12000))
      const L = Math.max(vw, vh)
      for (let k = 0; k <= 32; k++) {
        const width = k * 0.005
        const b = originalBorder(vw, vh, width)
        expect(b).toBe(Math.round(width * (L + 2 * b)))
        let smaller = -1
        for (let c = 0; c < b && smaller < 0; c++) if (Math.round(width * (L + 2 * c)) === c) smaller = c
        expect(smaller, `${vw}x${vh} at ${width}`).toBe(-1)
        // ...and it is the border the sheet's own rule gives on that sheet.
        expect(borderPx(width, vw + 2 * b, vh + 2 * b)).toBe(b)
      }
    }
  })

  it('a panorama is cut to 3:1 whatever the width, so a frame never changes the crop', () => {
    for (const [mw, mh] of [
      [12000, 2000],
      [16000, 2000],
    ]) {
      expect(originalVisible(mw, mh)).toEqual({ vw: 6000, vh: 2000 })
      const at = (width: number) => {
        const s = spec('original', photo(mw, mh), { width })
        const b = originalBorder(6000, 2000, width)
        const l = layoutSheet(s, 6000 + 2 * b, 2000 + 2 * b)
        return { left: l.photo!.dx - l.visible.x0, top: l.photo!.dy - l.visible.y0, w: l.photo!.dw, h: l.photo!.dh }
      }
      for (const width of [0.001, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) expect(at(width)).toEqual(at(0))
    }
    expect(originalVisible(2000, 16000)).toEqual({ vw: 2000, vh: 6000 })
  })
})

describe('the visible rectangle', () => {
  it("its shape does not depend on the sheet's size: the unrounded inset at any height is visibleAspect", () => {
    for (const key of Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]) {
      for (const width of [0, 0.02, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) {
        const s = spec(key, photo(4032, 3024), { width })
        for (const H of [300, 1000, 1800]) {
          const W = H * ASPECTS[key]
          const b = width * Math.max(W, H)
          expect((W - 2 * b) / (H - 2 * b)).toBeCloseTo(visibleAspect(s), 9)
        }
      }
    }
  })

  it("on Original it is the photo's own (clamped) shape, and unframed it is the sheet's for every key", () => {
    expect(visibleAspect(spec('original', photo(7728, 5152), { width: FRAME_WIDTH_FIRST }))).toBe(7728 / 5152)
    expect(visibleAspect(spec('original', photo(12000, 2000), { width: 0.1 }))).toBe(3)
    for (const key of KEYS) {
      const s = spec(key, photo(5152, 7728))
      expect(visibleAspect(s)).toBe(sheetAspect(s))
    }
    // A frame round nothing is ignored.
    expect(visibleAspect(spec('4:5', null, { width: 0.1 }))).toBe(4 / 5)
  })

  it('is the sheet inset by the border on every side', () => {
    const l = layoutSheet(spec('4:5', photo(4032, 3024), { width: 0.1 }), 800, 1000)
    expect([l.border, l.visible]).toEqual([100, { x0: 100, y0: 100, w: 600, h: 800 }])
  })
})

describe('Original and Crop: the photo covers the visible rectangle', () => {
  it("at the photo's own size, the visible rectangle IS the photo, at every width", () => {
    const rand = mulberry32(0x4d)
    const sizes: [number, number][] = NAMED.map(([w, h]) => [w, h] as [number, number])
    for (let i = 0; i < 300; i++) sizes.push([1 + Math.floor(rand() * 9000), 1 + Math.floor(rand() * 9000)])
    for (const [mw, mh] of sizes) {
      const { vw, vh } = originalVisible(mw, mh)
      for (const width of [0, 0.01, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) {
        const b = originalBorder(vw, vh, width)
        const l = layoutSheet(spec('original', photo(mw, mh), { width }), vw + 2 * b, vh + 2 * b)
        const where = `${mw}x${mh} at ${width}`
        expect(l.border, where).toBe(b)
        expect(l.visible, where).toEqual({ x0: b, y0: b, w: vw, h: vh })
        const p = l.photo!
        expect(isNativeRect(p, mw, mh), where).toBe(true)
        expect(covers(p, l.visible), where).toBe(true)
        if (vw === mw && vh === mh) expect(p, where).toEqual({ dx: b, dy: b, dw: mw, dh: mh })
      }
    }
  })

  it('the photo is never stretched: one scale on both axes, at four heights and on 20,000 random photos', () => {
    const rand = mulberry32(0x5e)
    const check = (m: MediaLayer, width: number, height: number) => {
      const s = spec('original', m, { width })
      const { w, h } = sheetAt(s, height)
      const p = layoutSheet(s, w, h).photo!
      expect(Math.abs(p.dw / m.width - p.dh / m.height)).toBeLessThan(1e-9 * Math.max(1, p.dw / m.width))
    }
    for (const H of [280, 1000, 1800, 3600]) for (const width of [0, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) check(photo(7728, 5152), width, H)
    for (let i = 0; i < 20000; i++) {
      const mh = 100 + Math.floor(rand() * 8000)
      const mw = Math.max(1, Math.round(mh * Math.exp((rand() * 2 - 1) * Math.log(3))))
      check(photo(mw, mh, { scale: 1 + rand() * 3, x: rand(), y: rand() }), rand() * FRAME_WIDTH_MAX, 100 + Math.floor(rand() * 4000))
    }
  })

  it("Original is always Crop: a stored 'fit' keeps the zoom and the pan", () => {
    for (const width of [0, FRAME_WIDTH_FIRST]) {
      const m = photo(4032, 3024, { scale: 2, x: 0.3, y: 0.6 })
      const fit = spec('original', m, { width, mode: 'fit' })
      const crop = spec('original', m, { width, mode: 'crop' })
      expect(effectiveMode(fit)).toBe('crop')
      const { w, h } = sheetAt(fit, 1000)
      const l = layoutSheet(fit, w, h)
      expect(l).toEqual(layoutSheet(crop, w, h))
      // Zoomed 2x on the cover fit of the visible rectangle.
      expect(l.photo!.dw).toBeCloseTo(2 * Math.max(l.visible.w / 4032, l.visible.h / 3024) * 4032, 6)
    }
    expect(effectiveMode(spec('4:5', photo(1, 1), { mode: 'fit' }))).toBe('fit')
  })
})

describe('Fit: the whole photo inside the visible rectangle', () => {
  it('is inside it, matted by at least the border, centred, at one scale, for every fixed sheet, width and 200 photos', () => {
    const rand = mulberry32(0x6f)
    for (let i = 0; i < 200; i++) {
      const m = photo(1 + Math.floor(rand() * 9000), 1 + Math.floor(rand() * 9000), { scale: 3, x: 0.1, y: 0.9 })
      for (const key of Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]) {
        for (const width of [0, 0.02, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) {
          const s = spec(key, m, { width, mode: 'fit' })
          const { w, h } = sheetAt(s, 200 + Math.floor(rand() * 3000))
          const l = layoutSheet(s, w, h)
          const sh = l.shown
          const where = `${m.width}x${m.height} on ${key} at ${width}: ${w}x${h}`
          expect(inside(sh, l.visible), where).toBe(true)
          expect(Math.min(sh.x0, sh.y0, w - sh.x0 - sh.w, h - sh.y0 - sh.h), where).toBeGreaterThanOrEqual(l.border)
          // Centred to the pixel, and bound by one side of the visible rectangle.
          expect(Math.abs(sh.x0 - l.visible.x0 - (l.visible.x0 + l.visible.w - sh.x0 - sh.w)), where).toBeLessThanOrEqual(1)
          expect(Math.abs(sh.y0 - l.visible.y0 - (l.visible.y0 + l.visible.h - sh.y0 - sh.h)), where).toBeLessThanOrEqual(1)
          expect(sh.w === l.visible.w || sh.h === l.visible.h, where).toBe(true)
          // One scale: the other side is the binding side times the photo's shape, rounded.
          if (sh.w === l.visible.w) expect(Math.abs(sh.h - (sh.w * m.height) / m.width), where).toBeLessThanOrEqual(0.5 + 1e-9)
          else expect(Math.abs(sh.w - (sh.h * m.width) / m.height), where).toBeLessThanOrEqual(0.5 + 1e-9)
          // The photo's rectangle is the shown one; the zoom and pan are not read.
          expect(l.photo, where).toEqual({ dx: sh.x0, dy: sh.y0, dw: sh.w, dh: sh.h })
        }
      }
    }
  })

  it("is exactly the photo's size where one side of the visible rectangle is", () => {
    const rand = mulberry32(0x70)
    for (let i = 0; i < 2000; i++) {
      const mw = 1 + Math.floor(rand() * 9000)
      const mh = 1 + Math.floor(rand() * 9000)
      const extra = Math.floor(rand() * 3000)
      const b = Math.floor(rand() * 500)
      expect(containRect(mw, mh, { x0: b, y0: b, w: mw, h: mh + extra })).toMatchObject({ x0: b, w: mw, h: mh })
      expect(containRect(mw, mh, { x0: b, y0: b, w: mw + extra, h: mh })).toMatchObject({ y0: b, w: mw, h: mh })
    }
  })

  it("lays out Border Studio's Fit cases as it did: 1140x760 at (150, 520) on 4:5, 713x475 at (150, 663) on 9:16, radius 29.6875", () => {
    const m = photo(1800, 1200)
    const four = layoutSheet(spec('4:5', m, { width: 150 / 1800, mode: 'fit' }), 1440, 1800)
    expect(four.shown).toEqual({ x0: 150, y0: 520, w: 1140, h: 760 })
    const nine = layoutSheet(spec('9:16', m, { width: 150 / 1800, mode: 'fit', corners: 0.5 }), 1013, 1800)
    expect(nine.shown).toEqual({ x0: 150, y0: 663, w: 713, h: 475 })
    expect(nine.radius).toBe(29.6875)
  })
})

describe('the corners', () => {
  it("are rounded on the shown rectangle: Corners x its shorter side / 8, not rounded to a pixel", () => {
    const l = layoutSheet(spec('original', photo(1800, 1200), { width: 150 / 2100, corners: 1 }), 2100, 1500)
    expect(l.radius).toBe(1200 / FRAME_CORNER_DIV)
    const fit = layoutSheet(spec('1:1', photo(1800, 1200), { width: 0.1, corners: 0.3, mode: 'fit' }), 1000, 1000)
    expect(fit.radius).toBe((0.3 * Math.min(fit.shown.w, fit.shown.h)) / FRAME_CORNER_DIV)
    expect(fit.shown.h).toBeLessThan(fit.visible.h)
  })
})

describe('the photo is placed on the visible rectangle', () => {
  it('covers it, never uncovers it, on every sheet, width and zoom, for 200 photos at random pans', () => {
    const rand = mulberry32(0x81)
    let checked = 0
    for (let i = 0; i < 200; i++) {
      const mw = 1 + Math.floor(rand() * 9000)
      const mh = 1 + Math.floor(rand() * 9000)
      for (const key of KEYS) {
        for (const width of [0, 0.02, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) {
          for (const zoom of [1, 1.5, 4]) {
            const s = spec(key, photo(mw, mh, { scale: zoom, x: rand() * 2 - 0.5, y: rand() * 2 - 0.5 }), { width })
            const { w, h } = sheetAt(s, 200 + Math.floor(rand() * 4000))
            const l = layoutSheet(s, w, h)
            expect(covers(l.photo!, l.visible), `${mw}x${mh} on ${key} at ${width}, ${zoom}`).toBe(true)
            checked++
          }
        }
      }
    }
    expect(checked).toBe(200 * KEYS.length * 12)
  })

  it('a stored pan stays inside the travel of the visible rectangle through 200 random edits, frame and sheet changes among them', () => {
    const rand = mulberry32(0x82)
    const sizes = [[4032, 3024], [3024, 4032], [12000, 2000], [1000, 1000], [5152, 7728]]
    let s = applySettings(defaultSettings(), { type: 'setMedia', media: photo(4032, 3024) })
    const seen = new Set<string>()
    for (let step = 0; step < 200; step++) {
      const r = rand()
      let action: SettingsAction
      if (r < 0.25) action = { type: 'patchFrame', patch: { width: rand() < 0.2 ? 0 : rand() * FRAME_WIDTH_MAX, mode: rand() < 0.5 ? 'crop' : 'fit' } }
      else if (r < 0.45) action = { type: 'patch', patch: { aspect: KEYS[Math.floor(rand() * KEYS.length)] } }
      else if (r < 0.7) action = { type: 'patchMedia', patch: { x: rand() * 4 - 1.5, y: rand() * 4 - 1.5 } }
      else if (r < 0.9) action = { type: 'patchMedia', patch: { scale: rand() * 5 } }
      else {
        const [w, h] = sizes[Math.floor(rand() * sizes.length)]
        action = { type: 'setMedia', media: { ...photo(w, h), id: `p${step}`, scale: s.media!.scale, x: s.media!.x, y: s.media!.y } }
      }
      s = applySettings(s, action)
      seen.add(action.type)
      const m = s.media!
      const area = areaOf(visibleAspect(s), 1)
      const b = panBounds(m, area)
      expect(clampPan(m, area), `step ${step}`).toEqual(m)
      expect(m.x >= b.xLo && m.x <= b.xHi && m.y >= b.yLo && m.y <= b.yHi, `step ${step}`).toBe(true)
    }
    expect([...seen].sort()).toEqual(['patch', 'patchFrame', 'patchMedia', 'setMedia'])
  })

  it('snaps a rectangle within SNAP_PX of 1:1 to the photo\'s own size at a whole offset still covering the area, or leaves it only when the photo cannot cover it', () => {
    const rand = mulberry32(0x83)
    let snapped = 0
    let left = 0
    for (let i = 0; i < 4000; i++) {
      const area: Area = { x0: Math.floor(rand() * 400), y0: Math.floor(rand() * 400), w: 200 + Math.floor(rand() * 6000), h: 200 + Math.floor(rand() * 6000) }
      // A photo about the area's size: a pixel or two either way on each axis.
      const scale = 1 + rand() * 0.05 * Number(rand() < 0.5)
      const mw = Math.max(1, Math.round(area.w / scale) + Math.floor(rand() * 5) - 2)
      const mh = Math.max(1, Math.round(area.h / scale) + Math.floor(rand() * 5) - 2)
      const r = coverRect({ width: mw, height: mh }, area, { scale, x: rand(), y: rand() })
      if (Math.abs(r.dw / mw - 1) >= SNAP_PX / Math.min(area.w, area.h)) continue
      const out = snapRect(r, mw, mh, area)
      if (mw >= area.w && mh >= area.h) {
        expect(isNativeRect(out, mw, mh)).toBe(true)
        expect(covers(out, area, 0)).toBe(true)
        snapped++
      } else {
        expect(out).toBe(r)
        left++
      }
    }
    expect(snapped).toBeGreaterThan(500)
    expect(left).toBeGreaterThan(100)
  })

  it('Original at zoom 2 has travel, and keeps its zoom when a frame is added', () => {
    const m = photo(4032, 3024, { scale: 2, x: 0.3, y: 0.6 })
    for (const width of [0, FRAME_WIDTH_FIRST]) {
      const s = spec('original', m, { width })
      const area = areaOf(visibleAspect(s), 1)
      const b = panBounds(m, area)
      expect(b.xHi - b.xLo).toBeGreaterThan(0.9)
      expect(clampPan(m, area)).toEqual(m)
      const { w, h } = sheetAt(s, 1800)
      const l = layoutSheet(s, w, h)
      const cover = Math.max(l.visible.w / 4032, l.visible.h / 3024) * 4032
      expect(l.photo!.dw / cover).toBeCloseTo(2, 9)
      // The pan is a fraction of the visible rectangle: the same part shows.
      expect((l.visible.x0 + 0.3 * l.visible.w - l.photo!.dx) / l.photo!.dw).toBeCloseTo(0.5, 9)
    }
  })
})

// ---------------------------------------------------------------------------
// The framed ground: the photo where the layout shows it, the fill elsewhere.

/** A fill that varies across the sheet, opaque: a function of (x, y) only. */
const gradient: RowSampler = (y, x0, x1, out, o) => {
  for (let x = x0; x < x1; x++) {
    const p = o + (x - x0) * 4
    out[p] = (x * 7 + y) & 255
    out[p + 1] = (y * 3) & 255
    out[p + 2] = (x ^ y) & 255
    out[p + 3] = 255
  }
}
const FILLS: [string, FrameFill][] = [
  ['Paper', fillRgba(null)],
  ['a colour', fillRgba('#2896c8')],
  ['a sampled fill', fillRgba(gradient)],
]

/** The whole sheet composed at once, out of place. */
function composedWhole(l: SheetLayout, fill: FrameFill, ground: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(l.w * l.h * 4)
  composeFrameRows(l, fill, ground, 0, l.h, out)
  return out
}

/** The sheet composed in bands of `B` rows, as the press asks for it: each
 *  band handed only the ground's rows that meet `shown` (a NEW array of
 *  exactly those rows, so a read past them is undefined, not a neighbour),
 *  none when none do. */
function composedInBands(l: SheetLayout, fill: FrameFill, ground: Uint8ClampedArray, B: number): Uint8ClampedArray {
  const stride = l.w * 4
  const whole = new Uint8ClampedArray(l.h * stride)
  for (let y0 = 0; y0 < l.h; y0 += B) {
    const y1 = Math.min(l.h, y0 + B)
    const a = Math.max(y0, l.shown.y0)
    const b = Math.min(y1, l.shown.y0 + l.shown.h)
    const src = b > a ? ground.slice(a * stride, b * stride) : null
    const band = new Uint8ClampedArray((y1 - y0) * stride)
    composeFrameRows(l, fill, src, y0, y1, band, a)
    whole.set(band, y0 * stride)
  }
  return whole
}

/** Fourteen framed layouts: Original, Crop and Fit; square and round
 *  corners; narrow and widest frames; zoomed. */
const LAYOUTS: [string, SheetSpec, number][] = [
  ['Original, narrow', spec('original', photo(600, 400), { width: 0.01 }), 300],
  ['Original, widest, round', spec('original', photo(400, 600), { width: FRAME_WIDTH_MAX, corners: 1 }), 320],
  ['Original at 150%, round', spec('original', photo(600, 400, { scale: 1.5, x: 0.4, y: 0.6 }), { width: FRAME_WIDTH_FIRST, corners: 0.5 }), 300],
  ['Original panorama, round', spec('original', photo(1200, 200), { width: 0.05, corners: 1 }), 150],
  ['Crop 4:5, narrow', spec('4:5', photo(600, 400), { width: 0.01 }), 300],
  ['Crop 4:5, widest, round', spec('4:5', photo(600, 400), { width: FRAME_WIDTH_MAX, corners: 1 }), 300],
  ['Crop 16:9 zoomed, round', spec('16:9', photo(600, 400, { scale: 2, x: 0.3, y: 0.7 }), { width: FRAME_WIDTH_FIRST, corners: 0.3 }), 200],
  ['Crop 3:2 at 400%', spec('3:2', photo(500, 500, { scale: 4, x: 0.9, y: 0.1 }), { width: FRAME_WIDTH_MAX }), 200],
  ['Crop 1:1, corners only', spec('1:1', photo(600, 400), { corners: 1 }), 250],
  ['Fit 4:5, narrow', spec('4:5', photo(600, 400), { width: 0.01, mode: 'fit' }), 300],
  ['Fit 4:5, widest, round', spec('4:5', photo(600, 400), { width: FRAME_WIDTH_MAX, corners: 1, mode: 'fit' }), 300],
  ['Fit 9:16, round', spec('9:16', photo(600, 400), { width: 1 / 12, corners: 0.5, mode: 'fit' }), 320],
  ['Fit 16:9 portrait photo, widest', spec('16:9', photo(400, 600), { width: FRAME_WIDTH_MAX, mode: 'fit' }), 200],
  ['Fit 1:1 unframed, round', spec('1:1', photo(400, 600), { corners: 1, mode: 'fit' }), 250],
]

describe('the framed ground (composeFrameRows)', () => {
  it('fourteen framed layouts, three fills: bands of 1, 7, 97 and the whole sheet compose the same bytes', { timeout: 60_000 }, () => {
    for (const [name, s, height] of LAYOUTS) {
      const { w, h } = sheetAt(s, height)
      const l = layoutSheet(s, w, h)
      expect(isUnframed(l), name).toBe(false)
      const ground = makeGround(w, h, 7)
      for (const [fname, fill] of FILLS) {
        const whole = composedWhole(l, fill, ground)
        for (const B of [1, 7, 97, h]) expect(Buffer.from(composedInBands(l, fill, ground, B)).equals(Buffer.from(whole)), `${name}, ${fname}, bands of ${B}`).toBe(true)
      }
    }
  })

  it('composed in place (the preview) is composed out of place, byte for byte', () => {
    for (const [name, s, height] of LAYOUTS) {
      const { w, h } = sheetAt(s, height)
      const l = layoutSheet(s, w, h)
      const ground = makeGround(w, h, 11)
      for (const [fname, fill] of FILLS) {
        const inPlace = ground.slice()
        composeFrameRows(l, fill, inPlace, 0, h, inPlace)
        expect(Buffer.from(inPlace).equals(Buffer.from(composedWhole(l, fill, ground))), `${name}, ${fname}`).toBe(true)
      }
    }
  })

  it('a band wholly outside the photo is the fill and never reads the ground', () => {
    const s = spec('4:5', photo(600, 400), { width: FRAME_WIDTH_MAX, mode: 'fit' })
    const { w, h } = sheetAt(s, 300)
    const l = layoutSheet(s, w, h)
    const out = new Uint8ClampedArray(l.shown.y0 * w * 4)
    composeFrameRows(l, fillRgba('#152228'), null, 0, l.shown.y0, out)
    for (let i = 0; i < out.length; i += 4) expect([...out.subarray(i, i + 4)]).toEqual([0x15, 0x22, 0x28, 255])
    expect(() => composeFrameRows(l, fillRgba(null), null, 0, l.shown.y0 + 1, new Uint8ClampedArray((l.shown.y0 + 1) * w * 4))).toThrow(/no ground/)
  })

  it('Fit: every pixel outside the photo IS the fill, an opaque colour and Paper alike, and the corners are on the photo, not the frame', () => {
    const s = spec('4:5', photo(600, 400), { width: FRAME_WIDTH_FIRST, corners: 1, mode: 'fit' })
    const { w, h } = sheetAt(s, 400)
    const l = layoutSheet(s, w, h)
    // The photo is contained: the matte shows above and below it.
    expect(l.shown.y0).toBeGreaterThan(l.visible.y0 + 10)
    // A ground that is opaque everywhere, so the matte cannot be its alpha.
    const ground = makeGround(w, h, 3).fill(255, 0)
    for (let i = 3; i < ground.length; i += 4) ground[i] = 255
    for (const [hex, px] of [['#90b1c1', [0x90, 0xb1, 0xc1, 255]], [null, [0, 0, 0, 0]]] as const) {
      const out = composedWhole(l, fillRgba(hex), ground)
      const { x0, y0, w: sw, h: sh } = l.shown
      let outside = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (x >= x0 && x < x0 + sw && y >= y0 && y < y0 + sh) continue
          const p = (y * w + x) * 4
          if (out[p] !== px[0] || out[p + 1] !== px[1] || out[p + 2] !== px[2] || out[p + 3] !== px[3]) throw new Error(`(${x}, ${y}) is not the fill`)
          outside++
        }
      }
      expect(outside).toBe(w * h - sw * sh)
      // The photo's own corner pixel is mostly cut away (its alpha over Paper
      // is its coverage); the visible rectangle's corner is matte.
      const at = (x: number, y: number) => [...out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]
      expect(cornerCoverage(l.radius, 0, 0)).toBeLessThan(0.5)
      if (hex === null) expect(at(x0, y0)[3]).toBe(clampByte(cornerCoverage(l.radius, 0, 0) * 255))
      expect(at(l.visible.x0, l.visible.y0)).toEqual([...px])
      // Away from the corners the photo is there, untouched.
      const mid = ((y0 + (sh >> 1)) * w + x0 + (sw >> 1)) * 4
      expect([...out.subarray(mid, mid + 4)]).toEqual([...ground.subarray(mid, mid + 4)])
    }
  })

  it('away from the corners and the border, every pixel of an opaque photo is its own bytes (1e5 random pixels, every layout)', () => {
    const rand = mulberry32(0x2c)
    let checked = 0
    for (const [name, s, height] of LAYOUTS) {
      const { w, h } = sheetAt(s, height)
      const l = layoutSheet(s, w, h)
      const ground = makeGround(w, h, 5)
      for (let i = 3; i < ground.length; i += 4) ground[i] = 255
      const out = composedWhole(l, fillRgba(gradient), ground)
      const patch = Math.ceil(l.radius)
      const { x0, y0, w: sw, h: sh } = l.shown
      for (let k = 0; k < 7200; k++) {
        const x = x0 + Math.floor(rand() * sw)
        const y = y0 + Math.floor(rand() * sh)
        const inCorner = Math.min(x - x0, x0 + sw - 1 - x) < patch && Math.min(y - y0, y0 + sh - 1 - y) < patch
        if (inCorner) continue
        const p = (y * w + x) * 4
        expect([...out.subarray(p, p + 4)], `${name} (${x}, ${y})`).toEqual([...ground.subarray(p, p + 4)])
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1e5 * 0.95)
  })

  it('isUnframed: only the whole sheet with square corners leaves the ground alone', () => {
    const at = (s: SheetSpec) => {
      const { w, h } = sheetAt(s, 300)
      return isUnframed(layoutSheet(s, w, h))
    }
    expect(at(spec('4:5', photo(600, 400)))).toBe(true)
    expect(at(spec('original', photo(600, 400, { scale: 2 })))).toBe(true)
    expect(at(spec('original', photo(600, 400), { mode: 'fit' }))).toBe(true)
    expect(at(spec('4:5', null, { width: FRAME_WIDTH_MAX, corners: 1, mode: 'fit' }))).toBe(true)
    expect(at(spec('4:5', photo(600, 400), { width: 0.01 }))).toBe(false)
    expect(at(spec('4:5', photo(600, 400), { corners: 0.01 }))).toBe(false)
    expect(at(spec('4:5', photo(600, 400), { mode: 'fit' }))).toBe(false)
  })

  it('fills: Paper is alpha 0, a colour is opaque, a sampler is read where it is pressed', () => {
    expect(fillRgba(null).flat).toEqual([0, 0, 0, 0])
    expect(fillRgba('#d2463c').flat).toEqual([0xd2, 0x46, 0x3c, 255])
    expect(fillRgba(gradient).flat).toBeNull()
    expect(() => fillRgba('red')).toThrow()
    const row = new Uint8ClampedArray(37 * 4)
    fillRgba('#00a4be').row(5, 3, 40, row, 0)
    for (let i = 0; i < row.length; i += 4) expect([...row.subarray(i, i + 4)]).toEqual([0, 0xa4, 0xbe, 255])
  })
})

/** Adaptive Simpson, at least 2^minDepth pieces, to `eps`. */
function integrate(f: (t: number) => number, a: number, b: number, eps: number, minDepth = 4): number {
  const rec = (a: number, b: number, fa: number, fm: number, fb: number, whole: number, eps: number, depth: number): number => {
    const m = (a + b) / 2
    const flm = f((a + m) / 2)
    const frm = f((m + b) / 2)
    const left = ((m - a) / 6) * (fa + 4 * flm + fm)
    const right = ((b - m) / 6) * (fm + 4 * frm + fb)
    const delta = left + right - whole
    if (depth > 50 || (depth >= minDepth && Math.abs(delta) <= 15 * eps)) return left + right + delta / 15
    return rec(a, m, fa, flm, fm, left, eps / 2, depth + 1) + rec(m, b, fm, frm, fb, right, eps / 2, depth + 1)
  }
  const fa = f(a)
  const fb = f(b)
  const fm = f((a + b) / 2)
  return rec(a, b, fa, fm, fb, ((b - a) / 6) * (fa + 4 * fm + fb), eps, 0)
}

/** The reference: what the corner's curve cuts from pixel (x, y), integrated
 *  numerically from its definition (y < (sqrt r - sqrt t)^2 for t in
 *  [0, r]), column by column. Not the engine's closed form. */
function referenceCoverage(r: number, x: number, y: number): number {
  const sr = Math.sqrt(r)
  const cut = (t: number) => (t >= r ? 0 : Math.min(1, Math.max(0, (sr - Math.sqrt(t)) ** 2 - y)))
  return 1 - integrate(cut, x, x + 1, 1e-11)
}

/** The nearest half-integer's distance: a byte there may round either way. */
const nearHalf = (v: number) => Math.abs(v - Math.floor(v) - 0.5)

describe('the rounded corner (cornerCoverage)', () => {
  it('matches the numerically integrated curve to 1e-6 at radii 3, 50, 300 and 644, and composes to the same alpha byte but within 1e-3 of a half', { timeout: 60_000 }, () => {
    for (const r of [3, 50, 300, 644]) {
      const patch = Math.ceil(r)
      // The photo, opaque white, over Paper: a composed pixel's alpha is its
      // coverage. A sheet just wide enough for the four corners' patches.
      const side = 2 * patch + 2
      const l: SheetLayout = { w: side, h: side, border: 0, visible: areaOf(side, side), shown: areaOf(side, side), photo: { dx: 0, dy: 0, dw: side, dh: side }, radius: r }
      const rows = patch + 1
      const ground = new Uint8ClampedArray(rows * side * 4).fill(255)
      const out = new Uint8ClampedArray(rows * side * 4)
      composeFrameRows(l, fillRgba(null), ground, 0, rows, out)
      let partial = 0
      let skipped = 0
      for (let y = 0; y < patch; y++) {
        for (let x = 0; x < patch; x++) {
          const c = cornerCoverage(r, x, y)
          const ref = referenceCoverage(r, x, y)
          if (Math.abs(c - ref) > 1e-6) throw new Error(`r ${r} (${x}, ${y}): ${c} against ${ref}`)
          if (c > 0 && c < 1) partial++
          if (nearHalf(ref * 255) < 1e-3) {
            skipped++
            continue
          }
          const alpha = out[(y * side + x) * 4 + 3]
          if (alpha !== clampByte(ref * 255)) throw new Error(`r ${r} (${x}, ${y}): byte ${alpha}, the reference's ${clampByte(ref * 255)}`)
        }
      }
      expect(partial).toBeGreaterThan(r)
      expect(skipped).toBeLessThan(partial / 100 + 2)
    }
  })

  it('grows along the diagonal, is the same in all four corners, and is 1 everywhere at radius 0', () => {
    for (const r of [3, 50, 300, 644]) {
      let last = -1
      for (let k = 0; k <= Math.ceil(r); k++) {
        const c = cornerCoverage(r, k, k)
        expect(c).toBeGreaterThanOrEqual(last)
        last = c
      }
      expect(last).toBe(1)
    }
    for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) expect(cornerCoverage(0, x, y)).toBe(1)
    // Mirror images, composed: an opaque photo over a colour.
    const side = 300
    const l: SheetLayout = { w: side, h: side + 40, border: 0, visible: areaOf(side, side + 40), shown: { x0: 20, y0: 30, w: side - 50, h: side - 20 }, photo: null, radius: 31.3 }
    const ground = new Uint8ClampedArray(l.w * l.h * 4)
    for (let i = 0; i < ground.length; i += 4) ground.set([250, 240, 10, 255], i)
    const out = composedWhole(l, fillRgba('#281615'), ground)
    const { x0, y0, w: sw, h: sh } = l.shown
    const px = (x: number, y: number) => [...out.subarray((y * l.w + x) * 4, (y * l.w + x) * 4 + 4)]
    let rounded = 0
    for (let j = 0; j < 33; j++) {
      for (let i = 0; i < 33; i++) {
        const tl = px(x0 + i, y0 + j)
        expect(px(x0 + sw - 1 - i, y0 + j)).toEqual(tl)
        expect(px(x0 + i, y0 + sh - 1 - j)).toEqual(tl)
        expect(px(x0 + sw - 1 - i, y0 + sh - 1 - j)).toEqual(tl)
        if (tl[0] !== 250) rounded++
      }
    }
    expect(rounded).toBeGreaterThan(100)
  })
})

describe('straight alpha: the ground is never premultiplied', () => {
  /** A sheet whose photo is all of it but a 3-pixel border, its corners of
   *  radius r. */
  const layoutWith = (r: number): SheetLayout => ({ w: 120, h: 120, border: 3, visible: { x0: 3, y0: 3, w: 114, h: 114 }, shown: { x0: 3, y0: 3, w: 114, h: 114 }, photo: null, radius: r })
  /** A corner pixel's coverage nearest one half. */
  const halfPixel = (r: number) => {
    let best = { x: 0, y: 0, c: 1 }
    for (let y = 0; y < Math.ceil(r); y++) for (let x = 0; x < Math.ceil(r); x++) if (Math.abs(cornerCoverage(r, x, y) - 0.5) < Math.abs(best.c - 0.5)) best = { x, y, c: cornerCoverage(r, x, y) }
    return best
  }

  it('a white photo pixel half covered over Paper keeps its colour, its alpha is its coverage, and it prints white, not grey', () => {
    const r = 114 / 8
    const l = layoutWith(r)
    const { x, y, c } = halfPixel(r)
    expect(Math.abs(c - 0.5)).toBeLessThan(0.02)
    const ground = new Uint8ClampedArray(l.w * l.h * 4).fill(255)
    const out = composedWhole(l, fillRgba(null), ground)
    const p = ((l.shown.y0 + y) * l.w + l.shown.x0 + x) * 4
    expect([...out.subarray(p, p + 4)]).toEqual([255, 255, 255, clampByte(c * 255)])
    // Through the compositor, veil off, on white paper with no shade: white.
    const printed = new Uint8ClampedArray(l.w * l.h * 4)
    compositeLayers(printed, l.w, l.h, { shade: new Float32Array(l.w * l.h).fill(1), rgb: [255, 255, 255], base: out, paperAmount: 0 }, [])
    expect([...printed.subarray(p, p + 3)]).toEqual([255, 255, 255])
  })

  it('a transparent photo pixel shows the fill, not black; an opaque one at half coverage is the two blended once', () => {
    const r = 114 / 8
    const l = layoutWith(r)
    const { x, y, c } = halfPixel(r)
    const ground = new Uint8ClampedArray(l.w * l.h * 4)
    for (let i = 0; i < ground.length; i += 4) ground.set([200, 100, 50, 255], i)
    const hole = ((l.shown.y0 + 17) * l.w + l.shown.x0 + 17) * 4
    ground.set([0, 0, 0, 0], hole)
    const out = composedWhole(l, fillRgba('#204060'), ground)
    expect([...out.subarray(hole, hole + 4)]).toEqual([0x20, 0x40, 0x60, 255])
    const p = ((l.shown.y0 + y) * l.w + l.shown.x0 + x) * 4
    const mix = (P: number, F: number) => clampByte(c * P + (1 - c) * F)
    expect([...out.subarray(p, p + 4)]).toEqual([mix(200, 0x20), mix(100, 0x40), mix(50, 0x60), 255])
  })
})
