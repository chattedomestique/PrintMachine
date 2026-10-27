/**
 * The export planner: a saved print follows its photo, pixel for pixel,
 * whatever its size, framed or not. Nothing caps it but a JPEG's own edge
 * (65,535 px), which is said out loud in `limit`, with a PNG that has no such
 * edge.
 */

import { describe, expect, it } from 'vitest'

import { planExport, type ExportPlan, type PlanPhoto, type PlanSheet } from './exportPlan.ts'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { planSheet } from './export.ts'
import { layoutSheet, originalBorder, originalVisible, sheetAspect, type SheetSpec } from './frame.ts'
import { FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX, NO_PHOTO_HEIGHT, REFERENCE_HEIGHT } from './limits.ts'
import { SNAP_PX, areaOf, coverRect } from './media.ts'
import { groundRect, isNativeRect, outputSize } from './render.ts'
import { mulberry32 } from './rng.ts'
import { ASPECTS, type FrameSettings, type MediaLayer, type PrintSettings } from './types.ts'

const FIXED = Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]
const KEYS = [...FIXED, 'original'] as PrintSettings['aspect'][]
const SHEETS = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '2:3': 2 / 3 } as const
const photo = (width: number, height: number, scale = 1): PlanPhoto => ({ width, height, scale })
const dims = (p: { width: number; height: number }) => `${p.width}x${p.height}`

/** A fixed sheet of shape a, in Crop, unframed. */
const fixed = (a: number): PlanSheet => ({ aspect: a })
/** The photo's own (Original) sheet, unframed. */
const own = (p: { width: number; height: number }): PlanSheet => ({ aspect: sheetAspect({ aspect: 'original', media: p }), original: true })

const frame = (over: Partial<FrameSettings> = {}): FrameSettings => ({ width: 0, corners: 0, fill: 'photo', blur: 60, mode: 'crop', ...over })
const media = (p: PlanPhoto, x = 0.5, y = 0.5): MediaLayer => ({ id: 'p', width: p.width, height: p.height, scale: p.scale, x, y, native: true })
const spec = (aspect: PrintSettings['aspect'], m: MediaLayer, f: Partial<FrameSettings> = {}): SheetSpec => ({ aspect, media: m, frame: frame(f) })
/** The document's plan, as Save makes it (export.ts `planPrint`), in PNG (no JPEG edge). */
const planOf = (s: SheetSpec, opts: { maxHeight?: number } = {}) => planExport(planSheet(s), s.media, opts)

/**
 * The planner as c8c0910 had it, frozen here as the reference for every plan
 * that must not change: the height stepped from an estimate to the smallest
 * that covers at the zoom, the width round(height x aspect).
 */
function planBefore(a: number, p: PlanPhoto): { width: number; height: number } {
  const zoom = Math.max(1, p.scale)
  const lands = (h: number) => Math.round(h * a) * zoom >= p.width || h * zoom >= p.height
  let h = Math.ceil(Math.min(p.height, p.width / a) / zoom)
  while (!lands(h)) h++
  while (h > 1 && lands(h - 1)) h--
  h = Math.max(REFERENCE_HEIGHT, h)
  return { width: Math.round(h * a), height: h }
}

/**
 * What "lands" means, written out on its own: the sheet at long side L
 * (a landscape sheet's width, any other's height), its border rounded, and
 * the photo covering (Crop), contained in (Fit) or held by (Original) the
 * visible rectangle.
 */
function landsAt(rule: 'cover' | 'contain' | 'holds', a: number, width: number, p: PlanPhoto, L: number): boolean {
  const [w, h] = a > 1 ? [L, Math.max(1, Math.round(L / a))] : [Math.max(1, Math.round(L * a)), L]
  const b = Math.round(width * Math.max(w, h))
  const vw = w - 2 * b
  const vh = h - 2 * b
  if (vw <= 0 || vh <= 0) return false
  const z = Math.max(1, p.scale)
  if (rule === 'cover') return vw * z >= p.width || vh * z >= p.height
  if (rule === 'contain') return vw >= p.width && vh >= p.height
  const { vw: pw, vh: ph } = originalVisible(p.width, p.height)
  return vw * z >= pw && vh * z >= ph
}
const ruleOf = (s: SheetSpec) => (s.aspect === 'original' ? 'holds' : s.frame.mode === 'fit' ? 'contain' : 'cover')
const longSide = (plan: ExportPlan, a: number) => (a > 1 ? plan.width : plan.height)

/** What is wrong with a native plan's layout, or null: it must be the
 *  photo's own pixels, snapped, whole and covering the visible rectangle
 *  (Crop, Original), or exactly the photo's size inside its matte (Fit), and
 *  its border the plan's. */
function nativeLayoutFault(s: SheetSpec, plan: ExportPlan): string | null {
  const m = s.media!
  const l = layoutSheet(s, plan.width, plan.height)
  if (l.border !== plan.border) return `border ${l.border}, planned ${plan.border}`
  if (ruleOf(s) === 'contain') {
    const sh = l.shown
    if (sh.w !== m.width || sh.h !== m.height) return `shown ${sh.w}x${sh.h}`
    if (Math.min(sh.x0, sh.y0, plan.width - sh.x0 - sh.w, plan.height - sh.y0 - sh.h) < plan.border) return 'matte under the border'
    return null
  }
  const r = l.photo!
  const v = l.visible
  if (!isNativeRect(r, m.width, m.height)) return `drawn ${r.dw}x${r.dh} at (${r.dx}, ${r.dy})`
  if (!(r.dx <= v.x0 && r.dy <= v.y0 && r.dx + r.dw >= v.x0 + v.w && r.dy + r.dh >= v.y0 + v.h)) return 'does not cover the visible rectangle'
  return null
}
const expectNativeLayout = (s: SheetSpec, plan: ExportPlan, where: string) => expect(nativeLayoutFault(s, plan), where).toBeNull()

describe('a 12 MP photo exports at its own pixels', () => {
  it('gives each sheet the photo\'s own pixels, row for row', () => {
    expect(dims(planExport(fixed(SHEETS['4:5']), photo(4032, 3024)))).toBe('2419x3024')
    expect(dims(planExport(fixed(SHEETS['4:5']), photo(3024, 4032)))).toBe('3024x3780')
    expect(dims(planExport(fixed(SHEETS['2:3']), photo(3024, 4032)))).toBe('2688x4032')
    expect(dims(planExport(fixed(SHEETS['1:1']), photo(4032, 3024)))).toBe('3024x3024')
    expect(dims(planExport(fixed(SHEETS['2:3']), photo(4032, 3024)))).toBe('2016x3024')
    // Zoomed in, fewer of the photo's pixels land on the sheet.
    expect(dims(planExport(fixed(SHEETS['4:5']), photo(4032, 3024, 1.5)))).toBe('1613x2016')
  })

  it('is native on every sheet, either way up, the Original sheet included', () => {
    for (const p of [photo(4032, 3024), photo(3024, 4032)]) {
      for (const sheet of [...Object.values(SHEETS).map(fixed), own(p)]) {
        const plan = planExport(sheet, p)
        expect(plan.limit).toBe('native')
        expect(plan.upscale).toBeGreaterThanOrEqual(1)
        expect(plan.upscale).toBeLessThan(1 + 1 / plan.height)
      }
    }
    // On its own shape the sheet IS the photo.
    expect(dims(planExport(own(photo(4032, 3024)), photo(4032, 3024)))).toBe('4032x3024')
  })

  it('on an Original landscape sheet, the whole photo: 4032x3024, and 4096x2048 (a cover would trim a column at 2:1)', () => {
    expect(planExport(own(photo(4032, 3024)), photo(4032, 3024))).toMatchObject({ width: 4032, height: 3024, limit: 'native' })
    expect(planExport(own(photo(4096, 2048)), photo(4096, 2048))).toMatchObject({ width: 4096, height: 2048, limit: 'native' })
  })
})

describe('no ceiling: a photo of any size exports at its own pixels', () => {
  it('a 24 MP iPhone photo (5712x4284): 3427x4284 on 4:5, and its own 5712x4284 on its own sheet', () => {
    const plan = planExport(fixed(SHEETS['4:5']), photo(5712, 4284))
    expect(plan).toMatchObject({ width: 3427, height: 4284, limit: 'native', nativeHeight: 4284 })
    expect(plan.width * plan.height).toBe(14_681_268)
    expect(planExport(own(photo(5712, 4284)), photo(5712, 4284))).toMatchObject({ width: 5712, height: 4284, limit: 'native', upscale: 1 })
    // Turned upright, on its own sheet and on 4:5.
    expect(dims(planExport(own(photo(4284, 5712)), photo(4284, 5712)))).toBe('4284x5712')
    expect(planExport(fixed(SHEETS['4:5']), photo(4284, 5712))).toMatchObject({ width: 4284, height: 5355, limit: 'native' })
  })

  it('a 40 MP photo (7728x5152): 7728x5152 on its own sheet, 4122x5152 on 4:5, 5152x5152 on 1:1; upright, 5152x7728 and 5152x6440', () => {
    const p = photo(7728, 5152)
    expect(planExport(own(p), p)).toMatchObject({ width: 7728, height: 5152, limit: 'native', upscale: 1 })
    expect(planExport(fixed(SHEETS['4:5']), p)).toMatchObject({ width: 4122, height: 5152, limit: 'native' })
    expect(planExport(fixed(SHEETS['1:1']), p)).toMatchObject({ width: 5152, height: 5152, limit: 'native' })
    expect(dims(planExport(own(photo(5152, 7728)), photo(5152, 7728)))).toBe('5152x7728')
    expect(dims(planExport(fixed(SHEETS['4:5']), photo(5152, 7728)))).toBe('5152x6440')
  })

  it('a 61 MP photo (9504x6336): 9504x6336 on its own sheet, 5069x6336 on 4:5, 6336x6336 on 1:1', () => {
    const p = photo(9504, 6336)
    expect(planExport(own(p), p)).toMatchObject({ width: 9504, height: 6336, limit: 'native' })
    expect(planExport(fixed(SHEETS['4:5']), p)).toMatchObject({ width: 5069, height: 6336, limit: 'native' })
    expect(planExport(fixed(SHEETS['1:1']), p)).toMatchObject({ width: 6336, height: 6336, limit: 'native' })
  })

  it('a 200 MP photo, and the widest and tallest Original sheets: native, past 4096 and past 16.8 MP alike', () => {
    expect(planExport(own(photo(16384, 12288)), photo(16384, 12288))).toMatchObject({ width: 16384, height: 12288, limit: 'native' })
    expect(planExport(fixed(1), photo(4097, 4097))).toMatchObject({ width: 4097, height: 4097, limit: 'native' })
    expect(planExport(own(photo(12000, 4000)), photo(12000, 4000))).toMatchObject({ width: 12000, height: 4000, limit: 'native' })
    // The whole photo, every row of it: c8c0910 planned 4000x11999 here (a
    // cover lands a row early on a sheet taller than 1:2) and trimmed one.
    expect(planExport(own(photo(4000, 12000)), photo(4000, 12000))).toMatchObject({ width: 4000, height: 12000, limit: 'native' })
  })

  it('a JPEG holds at most 65,535 px a side: past it, the largest JPEG, said; a PNG keeps the photo\'s size', () => {
    const p = photo(120_000, 40_000)
    const jpeg = planExport(own(p), p, { format: 'jpeg' })
    expect(jpeg).toMatchObject({ width: 65535, height: 21845, limit: 'format' })
    expect(jpeg.upscale!).toBeLessThan(1)
    expect(planExport(own(p), p, { format: 'png' })).toMatchObject({ width: 120_000, height: 40_000, limit: 'native' })
    expect(planExport(own(p), p)).toMatchObject({ width: 120_000, height: 40_000, limit: 'native' })
    // A tall one: the height binds.
    expect(planExport(own(photo(30_000, 90_000)), photo(30_000, 90_000), { format: 'jpeg' })).toMatchObject({ width: 21845, height: 65535, limit: 'format' })
    // At the edge exactly, it fits.
    expect(planExport(fixed(1), photo(65535, 65535), { format: 'jpeg' })).toMatchObject({ width: 65535, height: 65535, limit: 'native' })
  })

  it('the export ceiling is gone from the source: its constant is nowhere in src/', () => {
    // Spelled in two pieces, so this file is not a match itself.
    const name = new RegExp(`\\bMAX_${'AREA'}\\b`)
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(entry) && name.test(readFileSync(path, 'utf8'))) found.push(path)
      }
    }
    walk(join(import.meta.dirname, '..'))
    expect(found).toEqual([])
  })
})

describe('the floor and no photo', () => {
  it('never exports below the reference height: a small photo is enlarged, and says by how much', () => {
    const plan = planExport(fixed(SHEETS['4:5']), photo(1600, 1200))
    expect(plan).toMatchObject({ width: 1440, height: 1800, limit: 'floor', nativeHeight: 1200, border: 0 })
    expect(plan.upscale).toBeCloseTo(1.5, 12)
    // Zoomed far in, the native height drops below the floor too.
    expect(planExport(fixed(SHEETS['4:5']), photo(4032, 3024, 4))).toMatchObject({ width: 1440, height: 1800, limit: 'floor' })
  })

  it('a framed small photo is enlarged too, never shrunk, and its frame is the floor sheet\'s', () => {
    for (const s of [spec('original', media(photo(1600, 1200)), { width: FRAME_WIDTH_FIRST }), spec('4:5', media(photo(800, 600)), { width: 0.1, mode: 'fit' })]) {
      const plan = planOf(s)
      expect(plan.limit).toBe('floor')
      expect(plan.height).toBe(REFERENCE_HEIGHT)
      expect(plan.width).toBe(Math.round(REFERENCE_HEIGHT * sheetAspect(s)))
      expect(plan.border).toBe(Math.round(s.frame.width * Math.max(plan.width, plan.height)))
      expect(plan.upscale!).toBeGreaterThan(1)
    }
  })

  it('exports a print with no photo at NO_PHOTO_HEIGHT, and a frame round nothing is none', () => {
    for (const a of Object.values(SHEETS)) {
      for (const sheet of [fixed(a), { aspect: a, width: FRAME_WIDTH_MAX, mode: 'fit' as const }]) {
        expect(planExport(sheet, null)).toEqual({
          width: Math.round(NO_PHOTO_HEIGHT * a),
          height: NO_PHOTO_HEIGHT,
          border: 0,
          limit: 'none',
          nativeHeight: 0,
          upscale: null,
        })
      }
    }
  })

  it('makes a smaller copy only when asked, keeping the sheet and scaling the frame with it', () => {
    const plan = planExport(fixed(SHEETS['4:5']), photo(3024, 4032), { maxHeight: 2835 })
    expect(plan).toMatchObject({ width: 2268, height: 2835, limit: 'smaller' })
    // A cap above the plan changes nothing.
    expect(planExport(fixed(SHEETS['4:5']), photo(3024, 4032), { maxHeight: 9000 }).limit).toBe('native')
    const framed = planOf(spec('original', media(photo(7728, 5152)), { width: FRAME_WIDTH_FIRST }), { maxHeight: 3220 })
    expect(framed).toMatchObject({ width: 4508, height: 3220, border: 322, limit: 'smaller' })
  })

  it('refuses a sheet that is not one, and a frame that leaves nothing of it', () => {
    for (const a of [0, -1, NaN, Infinity]) expect(() => planExport(fixed(a), null)).toThrow(RangeError)
    expect(() => planExport({ aspect: 1 / 4, width: 0.16 }, photo(100, 100))).toThrow(Error)
  })
})

describe('native follows the photo (every photo, zoom and sheet)', () => {
  const photos = [photo(4032, 3024), photo(3024, 4032), photo(1000, 1000), photo(6000, 1200)]
  const zooms = [1, 1.5, 2.5, 4]
  const pans = [
    [0.5, 0.5],
    [0, 0],
    [1, 1],
    [0.2, 0.8],
  ] as const

  for (const [name, a] of Object.entries(SHEETS)) {
    it(`on ${name}: the photo is never sampled down, pan never matters, zoom never adds pixels`, () => {
      for (const p of photos) {
        let previous = Infinity
        for (const zoom of zooms) {
          const plan = planExport(fixed(a), { ...p, scale: zoom })
          const { width: W, height: H } = plan
          expect(H).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
          expect(W).toBe(Math.round(H * a))
          expect(H).toBeLessThanOrEqual(previous)
          previous = H

          const drawn = new Set<number>()
          for (const [x, y] of pans) {
            const r = coverRect(p, areaOf(W, H), { scale: zoom, x, y })
            drawn.add(r.dw)
            // Photo pixels per sheet pixel: at native, one, give or take less
            // than a pixel across the sheet; at the floor, fewer (enlarged).
            const density = p.width / r.dw
            if (plan.limit === 'native') {
              expect(density).toBeGreaterThan(1 - 1 / H)
              expect(density).toBeLessThanOrEqual(1)
            } else {
              expect(plan.limit).toBe('floor')
              expect(density).toBeLessThan(1)
            }
          }
          // Pan moves the photo, never its density.
          expect(drawn.size).toBe(1)
        }
      }
    })
  }
})

describe('unframed, the plan is the one it was, but where it was wrong', () => {
  it('on every portrait and square sheet, at every zoom: exactly c8c0910\'s, for 4000 random photos', () => {
    const rand = mulberry32(0x0c8c)
    const sheets = FIXED.filter((k) => ASPECTS[k] <= 1).map((k) => ASPECTS[k])
    for (let i = 0; i < 4000; i++) {
      const p = photo(Math.round(200 + rand() * 9800), Math.round(200 + rand() * 9800), rand() < 0.3 ? 1 : 1 + rand() * 3)
      for (const a of sheets) expect(dims(planExport(fixed(a), p)), `${dims(p)} at ${p.scale} on ${a}`).toBe(dims(planBefore(a, p)))
    }
  })

  it('on Original at 100%: exactly c8c0910\'s for every photo less tall than 1:2; taller, the row it trimmed comes back', () => {
    const rand = mulberry32(0x0c8d)
    let taller = 0
    for (let i = 0; i < 4000; i++) {
      const mw = Math.round(200 + rand() * 9800)
      const mh = Math.round(200 + rand() * 9800)
      const p = photo(mw, mh)
      const plan = planExport(own(p), p)
      const before = planBefore(own(p).aspect, p)
      if (mh < 2 * mw) expect(dims(plan), dims(p)).toBe(dims(before))
      else if (mh <= 3 * mw && mh >= REFERENCE_HEIGHT) {
        // Taller than 1:2: c8c0910 planned one row short of the photo.
        expect(dims(plan), dims(p)).toBe(dims(p))
        expect(before.height, dims(p)).toBe(mh - 1)
        taller++
      }
    }
    expect(taller).toBeGreaterThan(100)
  })

  it('on Original zoomed past 100%: within 2 px a side of c8c0910\'s, larger only where its sheet did not hold the zoomed photo, never larger where it did', () => {
    // c8c0910 covered (one side at 1:1 was enough); the Original rule HOLDS
    // the part of the photo the zoom shows, on both sides. Where c8c0910's
    // sheet held it too, stepping the long side may find a pixel smaller;
    // where it fell a row or a column short, the sheet grows to hold it.
    // Both are the photo's own pixels.
    const named: [number, number, number, string, string][] = [
      [4730, 6159, 2, '2365x3079', '2365x3080'],
      [3024, 4032, 1.08, '2800x3733', '2801x3734'],
      [3024, 4032, 1.4, '2160x2880', '2161x2881'],
      [7500, 4203, 2, '3751x2102', '3750x2102'],
      [4032, 3024, 1.1, '3667x2750', '3666x2750'],
      [7728, 5152, 1.05, '7361x4907', '7360x4907'],
    ]
    for (const [mw, mh, z, before, now] of named) {
      const p = photo(mw, mh, z)
      expect(dims(planBefore(own(p).aspect, p)), `${dims(p)} at ${z}`).toBe(before)
      expect(dims(planExport(own(p), p)), `${dims(p)} at ${z}`).toBe(now)
    }
    const rand = mulberry32(0x200)
    const cases: PlanPhoto[] = []
    for (let i = 0; i < 4000; i++) cases.push(photo(600 + Math.floor(rand() * 9000), 600 + Math.floor(rand() * 9000), 1 + (1 + Math.floor(rand() * 300)) / 100))
    for (const [w, h] of [[4032, 3024], [5712, 4284], [7728, 5152], [9504, 6336], [8064, 6048], [6000, 4000]]) {
      for (let z = 101; z <= 400; z += 3) cases.push(photo(w, h, z / 100), photo(h, w, z / 100))
    }
    let larger = 0
    let smaller = 0
    for (const p of cases) {
      const where = `${dims(p)} at ${p.scale}`
      const a = own(p).aspect
      const plan = planExport(own(p), p)
      const before = planBefore(a, p)
      const { vw, vh } = originalVisible(p.width, p.height)
      const holds = (w: number, h: number) => w * p.scale >= vw && h * p.scale >= vh
      const dw = plan.width - before.width
      const dh = plan.height - before.height
      expect(Math.max(Math.abs(dw), Math.abs(dh)), where).toBeLessThanOrEqual(2)
      // A native c8c0910 plan stays native (a floor may become native, at
      // the floor's height or a pixel or two from it).
      if (before.height > REFERENCE_HEIGHT) expect(plan.limit, where).toBe('native')
      if (plan.limit !== 'native') continue
      expect(holds(plan.width, plan.height), where).toBe(true)
      expectNativeLayout(spec('original', media(p)), plan, where)
      if (holds(before.width, before.height)) {
        expect(dw <= 0 && dh <= 0, where).toBe(true)
        if (dw || dh) smaller++
      } else {
        expect(dw >= 0 && dh >= 0 && dw + dh > 0, where).toBe(true)
        larger++
      }
    }
    // Both happen, often: a change that moves these plans further fails above.
    expect(larger).toBeGreaterThan(500)
    expect(smaller).toBeGreaterThan(50)
  })
})

describe('every plan, over 2000 random photos, sheets and zooms', () => {
  it('keeps the sheet, never reduces a photo, and is native or at the floor', () => {
    const rand = mulberry32(0x5eed)
    for (let i = 0; i < 2000; i++) {
      const a = Math.exp((rand() * 2 - 1) * Math.log(3)) // 1/3 .. 3
      const p = photo(Math.round(200 + rand() * 9800), Math.round(200 + rand() * 9800), 1 + rand() * 3)
      const plan = planExport(fixed(a), p)
      const { width: W, height: H } = plan
      expect(H).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
      expect(['native', 'floor']).toContain(plan.limit)
      expect(plan.upscale!).toBeGreaterThanOrEqual(1)
      if (plan.limit !== 'native' || a <= 1) {
        // Height-driven (the floor) or a portrait sheet's long axis: the
        // width is round(height x aspect)...
        expect(W).toBe(Math.round(H * a))
      }
      if (plan.limit === 'native') {
        expect(H).toBe(plan.nativeHeight)
        // ...and nothing smaller lands: a pixel less on the long axis samples
        // the photo down.
        const L = longSide(plan, a)
        expect(landsAt('cover', a, 0, p, L)).toBe(true)
        expect(landsAt('cover', a, 0, p, L - 1)).toBe(false)
      }
    }
  })
})

describe('the native search finds the smallest sheet that lands [brute force]', () => {
  it('Brute force: for 2000 photos under 6000 px, sheets, widths, modes and zooms, the plan is the first size that lands, scanning from 1', () => {
    const rand = mulberry32(0xb007)
    let differ = 0
    for (let i = 0; i < 2000; i++) {
      const p = photo(200 + Math.floor(rand() * 5800), 200 + Math.floor(rand() * 5800), rand() < 0.4 ? 1 : 1 + rand() * 3)
      const key = KEYS[Math.floor(rand() * KEYS.length)]
      const width = [0, 0.0005, 0.001, 0.01, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX][Math.floor(rand() * 6)]
      const s = spec(key, media(p), { width, mode: rand() < 0.5 ? 'crop' : 'fit' })
      const a = sheetAspect(s)
      const plan = planExport(planSheet(s), p)
      let truth = 1
      while (!landsAt(ruleOf(s), a, width, p, truth)) truth++
      // The native sheet's height, whatever the plan became (native, or the
      // floor above it), and its long side when the plan is native.
      const truthHeight = a > 1 ? Math.max(1, Math.round(truth / a)) : truth
      if (plan.nativeHeight !== truthHeight || (plan.limit === 'native' && longSide(plan, a) !== truth)) differ++
    }
    expect(differ).toBe(0)
  })

  it('with a border, landing is not monotone, and the plan is still the smallest: 1:1, 8248x6671 at 0.16, Crop', () => {
    const p = photo(8248, 6671)
    expect([9809, 9810, 9811].map((L) => landsAt('cover', 1, 0.16, p, L))).toEqual([true, false, true])
    const plan = planExport({ aspect: 1, width: 0.16 }, p)
    expect(plan.height).toBeLessThanOrEqual(9809)
    expect(plan.limit).toBe('native')
    expectNativeLayout(spec('1:1', media(p), { width: 0.16 }), plan, '8248x6671 on 1:1 at 0.16')
  })
})

describe('an Original sheet keeps the whole photo', () => {
  it('Original keeps the whole photo: at 100%, at every width, the plan is the photo and its border, (vw + 2b) x (vh + 2b)', () => {
    const rand = mulberry32(0x0419)
    const sizes: [number, number][] = [[4000, 12000], [12000, 4000], [12000, 2000], [16000, 2000], [2268, 4032], [7728, 5152], [5152, 7728], [2048, 4096], [4096, 2048]]
    for (let i = 0; i < 300; i++) sizes.push([200 + Math.floor(rand() * 9000), 200 + Math.floor(rand() * 9000)])
    let checked = 0
    for (const [mw, mh] of sizes) {
      const { vw, vh } = originalVisible(mw, mh)
      for (const width of [0, 0.01, FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX]) {
        const s = spec('original', media(photo(mw, mh)), { width })
        const plan = planOf(s)
        const b = originalBorder(vw, vh, width)
        if (vh + 2 * b < REFERENCE_HEIGHT) continue
        const where = `${mw}x${mh} at ${width}`
        expect(plan, where).toMatchObject({ width: vw + 2 * b, height: vh + 2 * b, border: b, limit: 'native' })
        const l = layoutSheet(s, plan.width, plan.height)
        expect(l.visible, where).toEqual({ x0: b, y0: b, w: vw, h: vh })
        if (vw === mw && vh === mh) expect(l.photo, where).toEqual({ dx: b, dy: b, dw: vw, dh: vh })
        else expectNativeLayout(s, plan, where)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('the first width on the owner\'s 40 MP photo: 9016x6440 (58.1 MP) Original, 6440x9016 upright, 9016x9016 on 1:1 Fit', () => {
    const land = media(photo(7728, 5152))
    expect(planOf(spec('original', land, { width: FRAME_WIDTH_FIRST }))).toMatchObject({ width: 9016, height: 6440, border: 644, limit: 'native' })
    expect(planOf(spec('original', media(photo(5152, 7728)), { width: FRAME_WIDTH_FIRST }))).toMatchObject({ width: 6440, height: 9016, border: 644, limit: 'native' })
    expect(planOf(spec('1:1', land, { width: FRAME_WIDTH_FIRST, mode: 'fit' }))).toMatchObject({ width: 9016, height: 9016, border: 644, limit: 'native' })
  })

  it('Fit and wide frames add pixels, and say so in the plan: the sizes of the frame plan\'s table', () => {
    const port = media(photo(5152, 7728))
    const sixtyOne = media(photo(9504, 6336))
    const size = (s: SheetSpec) => dims(planOf(s))
    expect(size(spec('9:16', port, { width: FRAME_WIDTH_FIRST, mode: 'fit' }))).toBe('6906x12277')
    expect(size(spec('3:2', port, { width: FRAME_WIDTH_FIRST, mode: 'fit' }))).toBe('14754x9836')
    expect(size(spec('16:9', port, { width: FRAME_WIDTH_FIRST, mode: 'fit' }))).toBe('18414x10358')
    expect(size(spec('16:9', port, { width: FRAME_WIDTH_MAX, mode: 'fit' }))).toBe('31864x17924')
    expect(size(spec('original', sixtyOne, { width: FRAME_WIDTH_MAX }))).toBe('13976x10808')
    expect(size(spec('1:1', sixtyOne, { width: FRAME_WIDTH_MAX, mode: 'fit' }))).toBe('13976x13976')
    expect(size(spec('9:16', sixtyOne, { width: FRAME_WIDTH_MAX, mode: 'fit' }))).toBe('22044x39189')
  })

  it('zoomed to 150% with a frame, still native, and smaller than at 100%', () => {
    const at = (scale: number) => planOf(spec('original', media(photo(7728, 5152, scale)), { width: FRAME_WIDTH_FIRST }))
    const zoomed = at(1.5)
    expect(zoomed.limit).toBe('native')
    expect(zoomed.width * zoomed.height).toBeLessThan(at(1).width * at(1).height)
    expectNativeLayout(spec('original', media(photo(7728, 5152, 1.5)), { width: FRAME_WIDTH_FIRST }), zoomed, '7728x5152 at 150%')
  })
})

describe('every native plan is drawn at the photo\'s own pixels (the snap covers the planner)', () => {
  /** Plan the photo on the sheet and draw it as the press does: a native
   *  plan must put the photo at its own size, at a whole-pixel offset,
   *  covering the sheet. Returns whether the plan was native. */
  function drawnNative(mw: number, mh: number, key: PrintSettings['aspect'], zoom: number, x: number, y: number): boolean {
    const s = spec(key, media(photo(mw, mh, zoom), x, y))
    const plan = planOf(s)
    if (plan.limit !== 'native') return false
    const r = groundRect(s, plan.width, plan.height)
    const where = `${mw}x${mh} on ${key} at ${zoom} -> ${dims(plan)}`
    expect([r.dw, r.dh], where).toEqual([mw, mh])
    expect(Number.isInteger(r.dx) && Number.isInteger(r.dy), where).toBe(true)
    expect(r.dx <= 0 && r.dy <= 0 && r.dx + mw >= plan.width && r.dy + mh >= plan.height, where).toBe(true)
    return true
  }

  it('for real camera, phone and screen sizes, either way up, on every sheet, at every zoom from 100% to 400% in 1% steps', () => {
    const sizes = [
      [4032, 3024], [5712, 4284], [8064, 6048], [4032, 2268], [5712, 3213], [6000, 4000], [3024, 3024],
      [1920, 1080], [1179, 2556], [1290, 2796], [3840, 2160], [8000, 3000],
    ]
    let native = 0
    for (const [w, h] of sizes) {
      for (const [mw, mh] of w === h ? [[w, h]] : [[w, h], [h, w]]) {
        for (const key of KEYS) {
          for (let z = 100; z <= 400; z++) if (drawnNative(mw, mh, key, z / 100, 0.5, 0.5)) native++
        }
      }
    }
    // Before SNAP_PX took the sheet's short side, 85 of these were planned
    // native and drawn resampled (a 2268x4032 photo on its own sheet at 113%
    // among them: 1.0005, a third of its finest detail lost).
    expect(native).toBeGreaterThan(16000)
  })

  it('for 4000 random photos, sheets, zooms and pans', () => {
    const rand = mulberry32(0x5eed)
    let native = 0
    for (let i = 0; i < 4000; i++) {
      const mw = Math.round(600 + rand() * 11400)
      const mh = Math.round(600 + rand() * 11400)
      const key = KEYS[Math.floor(rand() * KEYS.length)]
      const zoom = rand() < 0.3 ? 1 : 1 + rand() * 3
      if (drawnNative(mw, mh, key, zoom, rand(), rand())) native++
    }
    expect(native).toBeGreaterThan(1000)
  })

  it('zoomed past 100%, on any aspect: the planner\'s own 2000 random photos, aspects (1:3 to 3:1) and zooms above 100%, at four pans', () => {
    const rand = mulberry32(0x5eed)
    let native = 0
    for (let i = 0; i < 2000; i++) {
      const a = Math.exp((rand() * 2 - 1) * Math.log(3))
      const p = photo(Math.round(200 + rand() * 9800), Math.round(200 + rand() * 9800), 1 + rand() * 3)
      const plan = planExport(fixed(a), p)
      if (plan.limit !== 'native') continue
      native++
      for (const [x, y] of [[0.5, 0.5], [0, 0], [1, 1], [0.3, 0.8]]) {
        const r = groundRect(spec('1:1', media(p, x, y)), plan.width, plan.height)
        const where = `${dims(p)} at ${p.scale} on a = ${a} -> ${dims(plan)}`
        expect([r.dw, r.dh], where).toEqual([p.width, p.height])
        expect(Number.isInteger(r.dx) && Number.isInteger(r.dy), where).toBe(true)
      }
    }
    expect(native).toBeGreaterThan(400)
  })

  it('exactly 100% on every sheet, the landscape ones too (the long axis is stepped, so their width lands)', () => {
    const rand = mulberry32(0x100)
    let native = 0
    for (let i = 0; i < 4000; i++) {
      const mw = Math.round(600 + rand() * 11400)
      const mh = Math.round(600 + rand() * 11400)
      for (const key of KEYS) if (drawnNative(mw, mh, key, 1, rand(), rand())) native++
    }
    expect(native).toBeGreaterThan(10000)
  })

  it('a fixed landscape sheet whose width binds is native at 100%: 3001x2251 on 3:2 is 3001x2001 (c8c0910 planned 3002x2001, resampled)', () => {
    const p = photo(3001, 2251)
    const plan = planExport(fixed(3 / 2), p)
    expect(plan).toMatchObject({ width: 3001, height: 2001, limit: 'native' })
    expect(groundRect(spec('3:2', media(p)), plan.width, plan.height)).toEqual({ dx: 0, dy: -125, dw: 3001, dh: 2251 })
  })

  it('needs the short side: the 2268x4032 case lands outside a tolerance taken over the height', () => {
    const s = spec('original', media(photo(2268, 4032, 1.13)))
    const plan = planOf(s)
    expect(plan).toMatchObject({ width: 2008, height: 3569, limit: 'native' })
    const over = plan.upscale! - 1
    expect(over).toBeGreaterThan(1.5 / plan.height)
    expect(over).toBeLessThan(SNAP_PX / Math.min(plan.width, plan.height))
    expect(groundRect(s, plan.width, plan.height)).toEqual({ dx: -131, dy: -232, dw: 2268, dh: 4032 })
  })
})

describe('every sheet, frame, mode and zoom: a native plan is laid out native, and nothing smaller lands', () => {
  it('9 fixed sheets in Crop and Fit and Original, widths {0, 0.01, 0.0714, 0.16}, zooms {1, 1.37, 1.5, 4}, 300 photos and the named ones', { timeout: 60_000 }, () => {
    const rand = mulberry32(0x5ee9)
    const faults: string[] = []
    const sizes: [number, number][] = [[7728, 5152], [5152, 7728], [9504, 6336], [4032, 3024], [12000, 4000], [12000, 2000], [16000, 2000]]
    for (let i = 0; i < 300; i++) sizes.push([200 + Math.floor(rand() * 9000), 200 + Math.floor(rand() * 9000)])
    let native = 0
    for (const [mw, mh] of sizes) {
      for (const width of [0, 0.01, 0.0714, FRAME_WIDTH_MAX]) {
        for (const zoom of [1, 1.37, 1.5, 4]) {
          const docs = [
            spec('original', media(photo(mw, mh, zoom)), { width }),
            ...FIXED.map((k) => spec(k, media(photo(mw, mh, zoom)), { width })),
            // Fit reads no zoom: once per photo and width.
            ...(zoom === 1 ? FIXED.map((k) => spec(k, media(photo(mw, mh)), { width, mode: 'fit' })) : []),
          ]
          for (const s of docs) {
            const plan = planOf(s)
            if (plan.limit !== 'native') continue
            const a = sheetAspect(s)
            const where = `${mw}x${mh} at ${zoom} on ${s.aspect} ${ruleOf(s)} at ${width} -> ${dims(plan)}`
            const fault = nativeLayoutFault(s, plan)
            if (fault) faults.push(`${where}: ${fault}`)
            const L = longSide(plan, a)
            const K = width > 0 ? Math.min(1000, Math.ceil(1 / width)) : 1
            for (let k = 1; k <= K && L - k >= 1; k++) if (landsAt(ruleOf(s), a, width, s.media!, L - k)) faults.push(`${where}: ${L - k} lands`)
            native++
          }
        }
      }
    }
    expect(faults).toEqual([])
    expect(native).toBeGreaterThan(35000)
  })

  it('the harness works in heights: every height-driven plan and every portrait native plan is outputSize of its height', () => {
    const rand = mulberry32(0x0ac0)
    let exempt = 0
    for (let i = 0; i < 3000; i++) {
      const key = KEYS[Math.floor(rand() * KEYS.length)]
      const s = spec(key, media(photo(200 + Math.floor(rand() * 9000), 200 + Math.floor(rand() * 9000), rand() < 0.5 ? 1 : 1 + rand() * 3)), {
        width: rand() < 0.3 ? 0 : rand() * FRAME_WIDTH_MAX,
        mode: rand() < 0.5 ? 'crop' : 'fit',
      })
      const a = sheetAspect(s)
      for (const plan of [planOf(s), planOf(s, { maxHeight: 1000 + Math.floor(rand() * 2000) })]) {
        if (plan.limit === 'native' && a > 1) {
          exempt++
          continue
        }
        expect(outputSize(a, plan.height).w).toBe(plan.width)
      }
    }
    expect(exempt).toBeGreaterThan(100)
    // Exempt, and why: a landscape native plan steps its width, and
    // round(round(W / a) x a) is not always W past 2:1 (a = 2.5, W = 4499).
    expect(Math.round(Math.round(4499 / 2.5) * 2.5)).not.toBe(4499)
  })
})
