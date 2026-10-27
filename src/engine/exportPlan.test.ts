/**
 * The export planner: a saved print follows its photo, pixel for pixel,
 * whatever its size. Nothing caps it but a JPEG's own edge (65,535 px), which
 * is said out loud in `limit`, with a PNG that has no such edge.
 */

import { describe, expect, it } from 'vitest'

import { planExport, type PlanPhoto } from './exportPlan.ts'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NO_PHOTO_HEIGHT, REFERENCE_HEIGHT } from './limits.ts'
import { SNAP_PX, coverRect } from './media.ts'
import { groundRect } from './render.ts'
import { mulberry32 } from './rng.ts'
import { ASPECTS, type PrintSettings } from './types.ts'
import { sheetAspect } from './frame.ts'

const SHEETS = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '2:3': 2 / 3 } as const
const photo = (width: number, height: number, scale = 1): PlanPhoto => ({ width, height, scale })
const dims = (p: { width: number; height: number }) => `${p.width}x${p.height}`

describe('a 12 MP photo exports at its own pixels', () => {
  it('gives each sheet the photo\'s own pixels, row for row', () => {
    expect(dims(planExport(SHEETS['4:5'], photo(4032, 3024)))).toBe('2419x3024')
    expect(dims(planExport(SHEETS['4:5'], photo(3024, 4032)))).toBe('3024x3780')
    expect(dims(planExport(SHEETS['2:3'], photo(3024, 4032)))).toBe('2688x4032')
    expect(dims(planExport(SHEETS['1:1'], photo(4032, 3024)))).toBe('3024x3024')
    expect(dims(planExport(SHEETS['2:3'], photo(4032, 3024)))).toBe('2016x3024')
    // Zoomed in, fewer of the photo's pixels land on the sheet.
    expect(dims(planExport(SHEETS['4:5'], photo(4032, 3024, 1.5)))).toBe('1613x2016')
  })

  it('is native on every sheet, either way up, the Original sheet included', () => {
    for (const p of [photo(4032, 3024), photo(3024, 4032)]) {
      for (const a of [...Object.values(SHEETS), p.width / p.height]) {
        const plan = planExport(a, p)
        expect(plan.limit).toBe('native')
        expect(plan.upscale).toBeGreaterThanOrEqual(1)
        expect(plan.upscale).toBeLessThan(1 + 1 / plan.height)
      }
    }
    // On its own shape the sheet IS the photo.
    expect(dims(planExport(4032 / 3024, photo(4032, 3024)))).toBe('4032x3024')
  })

  it('takes a landscape sheet as a plain number', () => {
    expect(planExport(4 / 3, photo(4032, 3024))).toMatchObject({ width: 4032, height: 3024, limit: 'native' })
    expect(planExport(2, photo(4096, 2048))).toMatchObject({ width: 4096, height: 2048, limit: 'native' })
  })
})

describe('no ceiling: a photo of any size exports at its own pixels', () => {
  it('a 24 MP iPhone photo (5712x4284): 3427x4284 on 4:5, and its own 5712x4284 on its own sheet', () => {
    const plan = planExport(SHEETS['4:5'], photo(5712, 4284))
    expect(plan).toMatchObject({ width: 3427, height: 4284, limit: 'native', nativeHeight: 4284 })
    expect(plan.width * plan.height).toBe(14_681_268)
    expect(planExport(5712 / 4284, photo(5712, 4284))).toMatchObject({ width: 5712, height: 4284, limit: 'native', upscale: 1 })
    // Turned upright, on its own sheet and on 4:5.
    expect(dims(planExport(4284 / 5712, photo(4284, 5712)))).toBe('4284x5712')
    expect(planExport(SHEETS['4:5'], photo(4284, 5712))).toMatchObject({ width: 4284, height: 5355, limit: 'native' })
  })

  it('a 40 MP photo (7728x5152): 7728x5152 on its own sheet, 4122x5152 on 4:5, 5152x5152 on 1:1; upright, 5152x7728 and 5152x6440', () => {
    const p = photo(7728, 5152)
    expect(planExport(7728 / 5152, p)).toMatchObject({ width: 7728, height: 5152, limit: 'native', upscale: 1 })
    expect(planExport(SHEETS['4:5'], p)).toMatchObject({ width: 4122, height: 5152, limit: 'native' })
    expect(planExport(SHEETS['1:1'], p)).toMatchObject({ width: 5152, height: 5152, limit: 'native' })
    expect(dims(planExport(5152 / 7728, photo(5152, 7728)))).toBe('5152x7728')
    expect(dims(planExport(SHEETS['4:5'], photo(5152, 7728)))).toBe('5152x6440')
  })

  it('a 61 MP photo (9504x6336): 9504x6336 on its own sheet, 5069x6336 on 4:5, 6336x6336 on 1:1', () => {
    const p = photo(9504, 6336)
    expect(planExport(9504 / 6336, p)).toMatchObject({ width: 9504, height: 6336, limit: 'native' })
    expect(planExport(SHEETS['4:5'], p)).toMatchObject({ width: 5069, height: 6336, limit: 'native' })
    expect(planExport(SHEETS['1:1'], p)).toMatchObject({ width: 6336, height: 6336, limit: 'native' })
  })

  it('a 200 MP photo, and the widest and tallest Original sheets: native, past 4096 and past 16.8 MP alike', () => {
    expect(planExport(16384 / 12288, photo(16384, 12288))).toMatchObject({ width: 16384, height: 12288, limit: 'native' })
    expect(planExport(1, photo(4097, 4097))).toMatchObject({ width: 4097, height: 4097, limit: 'native' })
    expect(planExport(3, photo(12000, 4000))).toMatchObject({ width: 12000, height: 4000, limit: 'native' })
    // (The width binds there: 11,999 rows already make it 4000 wide.)
    expect(planExport(1 / 3, photo(4000, 12000))).toMatchObject({ width: 4000, height: 11999, limit: 'native' })
  })

  it('a JPEG holds at most 65,535 px a side: past it, the largest JPEG, said; a PNG keeps the photo\'s size', () => {
    const p = photo(120_000, 40_000)
    const jpeg = planExport(3, p, { format: 'jpeg' })
    expect(jpeg).toMatchObject({ width: 65535, height: 21845, limit: 'format' })
    expect(jpeg.upscale!).toBeLessThan(1)
    expect(planExport(3, p, { format: 'png' })).toMatchObject({ width: 120_000, height: 40_000, limit: 'native' })
    expect(planExport(3, p)).toMatchObject({ width: 120_000, height: 40_000, limit: 'native' })
    // A tall one: the height binds.
    expect(planExport(1 / 3, photo(30_000, 90_000), { format: 'jpeg' })).toMatchObject({ width: 21845, height: 65535, limit: 'format' })
    // At the edge exactly, it fits.
    expect(planExport(1, photo(65535, 65535), { format: 'jpeg' })).toMatchObject({ width: 65535, height: 65535, limit: 'native' })
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
    const plan = planExport(SHEETS['4:5'], photo(1600, 1200))
    expect(plan).toMatchObject({ width: 1440, height: 1800, limit: 'floor', nativeHeight: 1200 })
    expect(plan.upscale).toBeCloseTo(1.5, 12)
    // Zoomed far in, the native height drops below the floor too.
    expect(planExport(SHEETS['4:5'], photo(4032, 3024, 4))).toMatchObject({ width: 1440, height: 1800, limit: 'floor' })
  })

  it('exports a print with no photo at NO_PHOTO_HEIGHT', () => {
    for (const a of Object.values(SHEETS)) {
      const plan = planExport(a, null)
      expect(plan).toEqual({
        width: Math.round(NO_PHOTO_HEIGHT * a),
        height: NO_PHOTO_HEIGHT,
        limit: 'none',
        nativeHeight: 0,
        upscale: null,
      })
    }
  })

  it('makes a smaller copy only when asked, keeping the sheet', () => {
    const plan = planExport(SHEETS['4:5'], photo(3024, 4032), { maxHeight: 2835 })
    expect(plan).toMatchObject({ width: 2268, height: 2835, limit: 'smaller' })
    // A cap above the plan changes nothing.
    expect(planExport(SHEETS['4:5'], photo(3024, 4032), { maxHeight: 9000 }).limit).toBe('native')
  })

  it('refuses a sheet that is not one', () => {
    for (const a of [0, -1, NaN, Infinity]) expect(() => planExport(a, null)).toThrow(RangeError)
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
          const plan = planExport(a, { ...p, scale: zoom })
          const { width: W, height: H } = plan
          expect(H).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
          expect(W).toBe(Math.round(H * a))
          expect(H).toBeLessThanOrEqual(previous)
          previous = H

          const drawn = new Set<number>()
          for (const [x, y] of pans) {
            const r = coverRect(p, W, H, { scale: zoom, x, y })
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

describe('every plan, over 2000 random photos, sheets and zooms', () => {
  it('keeps the sheet, never reduces a photo, and is native or at the floor', () => {
    const rand = mulberry32(0x5eed)
    for (let i = 0; i < 2000; i++) {
      const a = Math.exp((rand() * 2 - 1) * Math.log(3)) // 1/3 .. 3
      const p = photo(Math.round(200 + rand() * 9800), Math.round(200 + rand() * 9800), 1 + rand() * 3)
      const plan = planExport(a, p)
      const { width: W, height: H } = plan
      expect(W).toBe(Math.round(H * a))
      expect(H).toBeGreaterThanOrEqual(REFERENCE_HEIGHT)
      expect(['native', 'floor']).toContain(plan.limit)
      expect(plan.upscale!).toBeGreaterThanOrEqual(1)
      if (plan.limit === 'native') {
        expect(H).toBe(plan.nativeHeight)
        // ...and the smallest such height: one row less samples the photo down.
        const below = Math.max(Math.round((H - 1) * a) / p.width, (H - 1) / p.height) * p.scale
        expect(below).toBeLessThan(1)
      }
    }
  })
})

describe('every native plan is drawn at the photo\'s own pixels (the snap covers the planner)', () => {
  // The sheets the app makes: the four fixed ones and the photo's own. The
  // landscape twins (aspect.ts) are in the document but no control makes one,
  // and at 100% a fixed landscape sheet whose width binds is not covered (the
  // pinned case below).
  const KEYS: PrintSettings['aspect'][] = [
    ...(Object.keys(ASPECTS) as (keyof typeof ASPECTS)[]).filter((k) => ASPECTS[k] <= 1),
    'original',
  ]

  /** Plan the photo on the sheet and draw it as the press does: a native
   *  plan must put the photo at its own size, at a whole-pixel offset,
   *  covering the sheet. Returns whether the plan was native. */
  function drawnNative(mw: number, mh: number, key: PrintSettings['aspect'], zoom: number, x: number, y: number): boolean {
    const media = { id: 'p', width: mw, height: mh, scale: zoom, x, y, native: true }
    const plan = planExport(sheetAspect({ aspect: key, media }), media)
    if (plan.limit !== 'native') return false
    const r = groundRect(media, plan.width, plan.height)
    const where = `${mw}x${mh} on ${key} at ${zoom} -> ${dims(plan)}`
    expect([r.dw, r.dh], where).toEqual([mw, mh])
    expect(Number.isInteger(r.dx) && Number.isInteger(r.dy), where).toBe(true)
    expect(r.dx <= 0 && r.dy <= 0 && r.dx + mw >= plan.width && r.dy + mh >= plan.height, where).toBe(true)
    return true
  }

  it('for real camera, phone and screen sizes, either way up, at every zoom from 100% to 400% in 1% steps', () => {
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
    expect(native).toBeGreaterThan(9000)
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
    // Aspects the app does not make (a landscape sheet narrower than its
    // photo) at zooms over 100%, where the zoomed photo overhangs the sheet on
    // both axes, so the snap has travel either way. At exactly 100% a fixed
    // landscape sheet is NOT covered: see the next test.
    const rand = mulberry32(0x5eed)
    let native = 0
    for (let i = 0; i < 2000; i++) {
      const a = Math.exp((rand() * 2 - 1) * Math.log(3))
      const p = photo(Math.round(200 + rand() * 9800), Math.round(200 + rand() * 9800), 1 + rand() * 3)
      const plan = planExport(a, p)
      if (plan.limit !== 'native') continue
      native++
      for (const [x, y] of [[0.5, 0.5], [0, 0], [1, 1], [0.3, 0.8]]) {
        const r = groundRect({ id: 'p', ...p, x, y }, plan.width, plan.height)
        const where = `${dims(p)} at ${p.scale} on a = ${a} -> ${dims(plan)}`
        expect([r.dw, r.dh], where).toEqual([p.width, p.height])
        expect(Number.isInteger(r.dx) && Number.isInteger(r.dy), where).toBe(true)
      }
    }
    expect(native).toBeGreaterThan(400)
  })

  it('exactly 100% on every sheet the app makes: the four fixed sheets (none wider than 1:1) and Original', () => {
    const rand = mulberry32(0x100)
    let native = 0
    for (let i = 0; i < 4000; i++) {
      const mw = Math.round(600 + rand() * 11400)
      const mh = Math.round(600 + rand() * 11400)
      for (const key of KEYS) if (drawnNative(mw, mh, key, 1, rand(), rand())) native++
    }
    expect(native).toBeGreaterThan(5000)
  })

  it('is not claimed for a fixed landscape sheet at 100%, which the app does not make: its width can overshoot the photo', () => {
    // Where a sheet wider than 1:1 binds on its WIDTH, the planner's widths step
    // by up to ceil(a) px a row, so at 100% the smallest height that lands 1:1
    // can make the sheet a pixel or two wider than the photo. Drawn at its own
    // size the photo would not cover it, so snapRect rightly keeps the cover
    // fit: a resample by about one part in 3000, under a `native` label. A
    // fixed landscape sheet would need the planner to fit its width to the
    // photo's first. This test pins the case so that adding one cannot miss it.
    const p = photo(3001, 2251)
    const plan = planExport(3 / 2, p)
    expect(plan).toMatchObject({ width: 3002, height: 2001, limit: 'native' })
    const r = groundRect({ id: 'p', ...p, x: 0.5, y: 0.5 }, plan.width, plan.height)
    expect(r.dw).toBe(3002)
    expect(r.dh).toBeCloseTo(2251.75, 2)
    expect(Number.isInteger(r.dy)).toBe(false)
  })

  it('needs the short side: the 2268x4032 case lands outside a tolerance taken over the height', () => {
    const media = { id: 'p', width: 2268, height: 4032, scale: 1.13, x: 0.5, y: 0.5 }
    const plan = planExport(sheetAspect({ aspect: 'original', media }), media)
    expect(plan).toMatchObject({ width: 2008, height: 3569, limit: 'native' })
    const over = plan.upscale! - 1
    expect(over).toBeGreaterThan(1.5 / plan.height)
    expect(over).toBeLessThan(SNAP_PX / Math.min(plan.width, plan.height))
    expect(groundRect(media, plan.width, plan.height)).toEqual({ dx: -131, dy: -232, dw: 2268, dh: 4032 })
  })
})
