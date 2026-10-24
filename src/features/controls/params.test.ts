/**
 * The dock's parameter tables: every default a double-tap resets to is the
 * default document's own (the test that stops `def` drifting), every range is
 * the schema's, and every readout is formatted as the style guide asks (a true
 * minus sign, a fixed unit per setting).
 */

import { describe, expect, it } from 'vitest'
import { makeLayer, makeMedia, pressProfile } from '../../state/defaults.ts'
import { LAYER_FIELDS, MEDIA_FIELDS, PRESS_FIELDS, type Row } from '../../state/fields.ts'
import { SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX } from '../../engine/limits.ts'
import { committedValue, draftOf, nudge, rangeText, type Param } from '../../ui/param.ts'
import {
  MINUS,
  NO_TRAVEL,
  degrees,
  ems,
  frameParams,
  percent,
  pixels,
  placeParams,
  pressParams,
  screenParam,
  sizeParam,
  spaceParams,
  switchPointParam,
} from './params.ts'

const noop = () => undefined
const layer = makeLayer()
const press = pressProfile()

const typeTable = (): Param[] => [sizeParam(layer, noop), ...spaceParams(layer, noop), ...placeParams(layer, noop), switchPointParam(layer, noop)]
const pressTable = (): Param[] => [screenParam(press, noop), ...pressParams(press, noop)]

const range = (rows: readonly Row[], key: string) => {
  const r = rows.find((row) => row.key === key)!
  return [r.min, r.max]
}

describe('every default is the default document\'s', () => {
  it('a plate\'s settings reset to a new plate\'s values (makeLayer)', () => {
    const fresh = makeLayer() as unknown as Record<string, number>
    for (const p of typeTable()) expect(p.def, p.key).toBe(fresh[p.key])
  })

  it('the press resets to the press a new document pulls with', () => {
    const fresh = pressProfile() as unknown as Record<string, number>
    for (const p of pressTable()) expect(p.def, p.key).toBe(fresh[p.key])
  })

  it('the photo resets to how an import places it: 100%, centred (half its travel)', () => {
    const media = makeMedia({ id: 'p', width: 4032, height: 3024, scale: 2, x: 0.3, y: 0.6 })
    const [zoom, x, y] = frameParams(media, 4 / 5, noop)
    expect(zoom.def).toBe(makeMedia({ id: 'q', width: 1, height: 1 }).scale)
    expect(x.def).toBeCloseTo(0.5, 12)
    expect(y.def).toBeCloseTo(0.5, 12)
  })

  it('every default sits inside its slider, so a reset never pins the thumb', () => {
    for (const p of [...typeTable(), ...pressTable()]) {
      expect(p.def, p.key).toBeGreaterThanOrEqual(p.trackMin)
      expect(p.def, p.key).toBeLessThanOrEqual(p.trackMax)
    }
  })
})

describe('every range is the schema\'s, so a saved value can always be nudged and typed', () => {
  it('a plate', () => {
    for (const p of typeTable()) {
      expect([p.min, p.max], p.key).toEqual(range(LAYER_FIELDS, p.key))
      expect(p.trackMin, p.key).toBeGreaterThanOrEqual(p.min)
      expect(p.trackMax, p.key).toBeLessThanOrEqual(p.max)
    }
  })

  it('the press and the zoom', () => {
    for (const p of pressTable()) expect([p.min, p.max], p.key).toEqual(range(PRESS_FIELDS, p.key))
    const [zoom] = frameParams(makeMedia({ id: 'p', width: 4032, height: 3024 }), 4 / 5, noop)
    expect([zoom.min, zoom.max]).toEqual(range(MEDIA_FIELDS, 'scale'))
  })
})

describe('the settings with two ranges', () => {
  it('Size: the slider 10% to 100% in 1% steps (90 positions), the setting 10% to 1200%, a tenth of the sheet reads 100%', () => {
    const p = sizeParam({ ...layer, size: 0.1 }, noop)
    expect([p.trackMin, p.trackMax, p.min, p.max]).toEqual([SIZE_MIN, SIZE_SLIDER_MAX, SIZE_MIN, SIZE_MAX])
    expect(Math.round((p.trackMax - p.trackMin) / p.step)).toBe(90)
    expect(p.format(0.1)).toBe('100%')
    expect(rangeText(p)).toBe('10% to 1200%')
    expect(draftOf({ ...p, value: 0.05 })).toBe('50')
    expect(committedValue(p, '240')).toBe(0.24)
    expect(nudge({ ...p, value: 0.24 }, -1)).toBe(0.239)
  })

  it('Rotation: the slider ±45°, the setting ±180°; Position: the slider 0 to 100%, the setting −30% to 130%', () => {
    const [rot, x, y] = placeParams(layer, noop)
    expect([rot.trackMin, rot.trackMax, rot.min, rot.max]).toEqual([-45, 45, -180, 180])
    expect(rangeText(rot)).toBe(`${MINUS}180° to 180°`)
    for (const p of [x, y]) {
      expect([p.trackMin, p.trackMax, p.min, p.max]).toEqual([0, 1, -0.3, 1.3])
      expect(rangeText(p)).toBe(`${MINUS}30% to 130%`)
      expect(committedValue(p, '50')).toBe(0.5)
    }
  })

  it('Screen size: the slider stops at 24 px; a converted grain up to 36 keeps its value', () => {
    const p = screenParam({ ...press, screenPitch: 30 }, noop)
    expect([p.trackMax, p.max]).toEqual([24, 36])
    expect(nudge(p, -1)).toBe(29.5)
  })
})

describe('the photo\'s position is a fraction of the travel it has', () => {
  it('centred, 0.5; at an edge, 0 or 1; moving it writes the centre that fraction stands for', () => {
    const media = makeMedia({ id: 'p', width: 4032, height: 3024 })
    const changes: unknown[] = []
    const [, x, y] = frameParams(media, 4 / 5, (patch) => changes.push(patch))
    expect(x.value).toBeCloseTo(0.5, 12)
    expect(x.unavailable).toBeUndefined()
    // A landscape photo on a 4:5 sheet fills its height: no travel up and down.
    expect(y.unavailable).toBe(NO_TRAVEL)
    x.onChange(0, { discrete: true })
    const left = (changes[0] as { x: number }).x
    expect(left).toBeGreaterThan(0.5)
    const [, x2] = frameParams({ ...media, x: left }, 4 / 5, noop)
    expect(x2.value).toBeCloseTo(0, 12)
  })

  it('on its own sheet at 100% the photo cannot move, and both positions say why', () => {
    const media = makeMedia({ id: 'p', width: 4032, height: 3024 })
    const [, x, y] = frameParams(media, 4032 / 3024, noop)
    expect([x.unavailable, y.unavailable]).toEqual([NO_TRAVEL, NO_TRAVEL])
    const [, xz, yz] = frameParams({ ...media, scale: 1.5 }, 4032 / 3024, noop)
    expect([xz.unavailable, yz.unavailable]).toEqual([undefined, undefined])
  })
})

describe('readouts', () => {
  it('a signed value uses the true minus sign U+2212, never a hyphen', () => {
    expect(degrees(-4)).toBe('−4°')
    expect(degrees(-4.4)).toBe('−4°')
    expect(degrees(0)).toBe('0°')
    expect(degrees(12)).toBe('12°')
    expect(percent(-0.3)).toBe('−30%')
    expect(ems(-0.02)).toBe('−0.020 em')
    expect(ems(0.04)).toBe('+0.040 em')
    expect(ems(0)).toBe('0.000 em')
    // Every setting that can go below zero says so with the true sign.
    const signedOnes = [...typeTable(), ...pressTable()].filter((p) => p.min < 0)
    expect(signedOnes.map((p) => p.key)).toEqual(['tracking', 'rotation', 'x', 'y'])
    for (const p of signedOnes) {
      expect(p.format(p.min), p.key).toContain(MINUS)
      expect(p.format(p.min), p.key).not.toContain('-')
    }
  })

  it('a fixed unit per setting', () => {
    const units: Record<string, string> = {
      size: '%', lineHeight: '', tracking: ' em', rotation: '°', x: '%', y: '%', contrastThreshold: '%',
      screenPitch: ' px', density: '%', misregistration: ' px', edge: '%', wear: '%',
    }
    for (const p of [...typeTable(), ...pressTable()]) {
      const unit = units[p.key]
      expect(unit, p.key).toBeDefined()
      for (const v of [p.min, p.def, p.max]) {
        const s = p.format(v)
        if (unit) expect(s.endsWith(unit), `${p.key} ${s}`).toBe(true)
        else expect(s, p.key).toMatch(/^\d+\.\d\d$/)
      }
    }
    expect(pixels(1)(9)).toBe('9.0 px')
    expect(sizeParam({ ...layer, size: 0.24 }, noop).format(0.24)).toBe('240%')
  })
})
