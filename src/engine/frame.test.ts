/**
 * The sheet and its frame (frame.ts): the shape, the border, the three
 * rectangles and the photo's place, swept over random photos, sheets, zooms,
 * pans and widths with a fixed generator.
 */

import { describe, expect, it } from 'vitest'
import {
  borderPx,
  containRect,
  effectiveMode,
  layoutSheet,
  originalBorder,
  originalVisible,
  sheetAspect,
  visibleAspect,
  type SheetSpec,
} from './frame.ts'
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
