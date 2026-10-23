/**
 * The export planner: a saved print follows its photo, pixel for pixel, and
 * only the export canvas's area ceiling can bring it below its photo — said
 * out loud in `limit`.
 */

import { describe, expect, it } from 'vitest'

import { planExport, type PlanPhoto } from './exportPlan.ts'
import { MAX_AREA, NO_PHOTO_HEIGHT, REFERENCE_HEIGHT } from './limits.ts'
import { coverRect } from './media.ts'
import { mulberry32 } from './rng.ts'

const SHEETS = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '2:3': 2 / 3 } as const
const photo = (width: number, height: number, scale = 1): PlanPhoto => ({ width, height, scale })
const dims = (p: { width: number; height: number }) => `${p.width}x${p.height}`

describe('a 12 MP photo exports at its own pixels', () => {
  it('gives the audit table, row for row', () => {
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

describe('a 24 MP photo (the default iPhone capture, 5712x4284) is never reduced to fit an edge', () => {
  it('exports at its native 3427x4284 on a 4:5 sheet: 14.7 MP, under the ceiling, not capped', () => {
    const plan = planExport(SHEETS['4:5'], photo(5712, 4284))
    expect(plan).toMatchObject({ width: 3427, height: 4284, limit: 'native', nativeHeight: 4284 })
    expect(plan.width * plan.height).toBe(14_681_268)
  })

  it('on its own Original sheet, exports at the area ceiling and says so: 4729x3547', () => {
    const plan = planExport(5712 / 4284, photo(5712, 4284))
    expect(plan).toMatchObject({ width: 4729, height: 3547, limit: 'ceiling', nativeHeight: 4284 })
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_AREA)
    // The share of the photo's pixels that fit: about 0.83 a side, 68.5% in all.
    expect(plan.upscale).toBeCloseTo(3547 / 4284, 3)
    // The same photo turned upright, on its own sheet and on 4:5.
    expect(dims(planExport(4284 / 5712, photo(4284, 5712)))).toBe('3547x4729')
    expect(planExport(SHEETS['4:5'], photo(4284, 5712))).toMatchObject({ width: 3663, height: 4579, limit: 'ceiling' })
  })
})

describe('the ceiling is an area, floored', () => {
  it('lets a 4096-square photo through at exactly the area, and caps one pixel more', () => {
    const at = planExport(1, photo(4096, 4096))
    expect(at).toMatchObject({ width: 4096, height: 4096, limit: 'native' })
    expect(at.width * at.height).toBe(MAX_AREA)
    expect(planExport(1, photo(4097, 4097))).toMatchObject({ width: 4096, height: 4096, limit: 'ceiling' })
  })

  it('has no edge cap: the widest and the tallest sheets go past 4096 on their long side', () => {
    const wide = planExport(3, photo(9000, 3000))
    expect(wide).toMatchObject({ width: 7092, height: 2364, limit: 'ceiling' })
    // 1:3: sqrt(MAX_AREA x 3) floors to 7094, whose rounded width (2365)
    // would overshoot the area by 94 px; the height is walked down to 7093.
    const tall = planExport(1 / 3, photo(3000, 9000))
    expect(tall).toMatchObject({ width: 2364, height: 7093, limit: 'ceiling' })
    for (const p of [wide, tall]) expect(p.width * p.height).toBeLessThanOrEqual(MAX_AREA)
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

describe('native follows the photo (the audit matrix)', () => {
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
          expect(W * H).toBeLessThanOrEqual(MAX_AREA)
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
  it('is within the area, keeps the sheet, and only reduces a photo at the ceiling', () => {
    const rand = mulberry32(0x5eed)
    for (let i = 0; i < 2000; i++) {
      const a = Math.exp((rand() * 2 - 1) * Math.log(3)) // 1/3 .. 3
      const p = photo(Math.round(200 + rand() * 9800), Math.round(200 + rand() * 9800), 1 + rand() * 3)
      const plan = planExport(a, p)
      const { width: W, height: H } = plan
      expect(W * H).toBeLessThanOrEqual(MAX_AREA)
      expect(W).toBe(Math.round(H * a))
      expect(H).toBeGreaterThanOrEqual(Math.min(REFERENCE_HEIGHT, Math.floor(Math.sqrt(MAX_AREA / a)) - 1))
      if (plan.limit === 'ceiling') expect(plan.upscale!).toBeLessThan(1)
      else expect(plan.upscale!).toBeGreaterThanOrEqual(1)
      if (plan.limit === 'native') {
        expect(H).toBe(plan.nativeHeight)
        // ...and the smallest such height: one row less samples the photo down.
        const below = Math.max(Math.round((H - 1) * a) / p.width, (H - 1) / p.height) * p.scale
        expect(below).toBeLessThan(1)
      }
    }
  })
})
