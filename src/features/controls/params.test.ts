/**
 * The dock's parameter tables: every default a double-tap resets to is the
 * default document's own (the test that stops `def` drifting), every range is
 * the schema's, and every readout is formatted as the style guide asks (a true
 * minus sign, a fixed unit per setting).
 */

import { describe, expect, it } from 'vitest'
import { frameDefaults, makeLayer, makeMedia, pressProfile } from '../../state/defaults.ts'
import { FILLS, FRAME_FIELDS, LAYER_FIELDS, MEDIA_FIELDS, PRESS_FIELDS, type Row } from '../../state/fields.ts'
import { FRAME_WIDTH_FIRST, FRAME_WIDTH_MAX, SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX } from '../../engine/limits.ts'
import type { FrameSettings } from '../../engine/types.ts'
import { canNudge, committedValue, draftOf, nudge, rangeText, resetChange, thumbValue, type Param } from '../../ui/param.ts'
import {
  MINUS,
  NO_PHOTO,
  NO_TRAVEL,
  borderParams,
  cornersWords,
  degrees,
  ems,
  photoPlacementParams,
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
    const [zoom, x, y] = photoPlacementParams(media, 4 / 5, noop)
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
    const [zoom] = photoPlacementParams(makeMedia({ id: 'p', width: 4032, height: 3024 }), 4 / 5, noop)
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
    const [, x, y] = photoPlacementParams(media, 4 / 5, (patch) => changes.push(patch))
    expect(x.value).toBeCloseTo(0.5, 12)
    expect(x.unavailable).toBeUndefined()
    // A landscape photo on a 4:5 sheet fills its height: no travel up and down.
    expect(y.unavailable).toBe(NO_TRAVEL)
    x.onChange(0, { discrete: true })
    const left = (changes[0] as { x: number }).x
    expect(left).toBeGreaterThan(0.5)
    const [, x2] = photoPlacementParams({ ...media, x: left }, 4 / 5, noop)
    expect(x2.value).toBeCloseTo(0, 12)
  })

  it('on its own sheet at 100% the photo cannot move, and both positions say why', () => {
    const media = makeMedia({ id: 'p', width: 4032, height: 3024 })
    const [, x, y] = photoPlacementParams(media, 4032 / 3024, noop)
    expect([x.unavailable, y.unavailable]).toEqual([NO_TRAVEL, NO_TRAVEL])
    const [, xz, yz] = photoPlacementParams({ ...media, scale: 1.5 }, 4032 / 3024, noop)
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

describe('the frame\'s border: Width, Corners, and Blur under Frosted', () => {
  const frosted = (over: Partial<FrameSettings> = {}): FrameSettings => ({ ...frameDefaults(), fill: 'frosted', ...over })
  const byKey = (ps: Param[]) => Object.fromEntries(ps.map((p) => [p.key, p]))

  it('Blur is offered only while the fill is Frosted; Width and Corners always', () => {
    for (const fill of FILLS) {
      const keys = borderParams({ ...frameDefaults(), fill }, true, noop).map((p) => p.key)
      expect(keys, fill).toEqual(fill === 'frosted' ? ['width', 'corners', 'blur'] : ['width', 'corners'])
    }
  })

  it('every range is the schema\'s, and the slider spans all of it', () => {
    for (const p of borderParams(frosted(), true, noop)) {
      expect([p.min, p.max], p.key).toEqual(range(FRAME_FIELDS, p.key))
      expect([p.trackMin, p.trackMax], p.key).toEqual([p.min, p.max])
    }
    expect(byKey(borderParams(frosted(), true, noop)).width.max).toBe(FRAME_WIDTH_MAX)
  })

  it('Corners and Blur reset to the frame\'s template; Width to the border a first photo gets, never 0', () => {
    const fresh = frameDefaults() as unknown as Record<string, number>
    const p = byKey(borderParams(frosted({ width: 0.12, corners: 0.5, blur: 200 }), true, noop))
    expect(p.corners.def).toBe(fresh.corners)
    expect(p.blur.def).toBe(fresh.blur)
    expect(p.width.def).toBe(FRAME_WIDTH_FIRST)
    expect(p.width.def).not.toBe(fresh.width)
    expect(resetChange(p.width)).toEqual({ value: FRAME_WIDTH_FIRST, discrete: true })
    expect(p.width.format(p.width.def)).toBe('7.1%')
  })

  it('Width reads as a percent of the long side to a tenth, and is typed that way', () => {
    const p = byKey(borderParams(frosted({ width: FRAME_WIDTH_FIRST }), true, noop)).width
    expect(p.format(0)).toBe('0.0%')
    expect(p.format(0.16)).toBe('16.0%')
    expect(draftOf(p)).toBe('7.1')
    expect(committedValue(p, '7.1')).toBe(0.071)
    expect(committedValue(p, '12.5%')).toBe(0.125)
    expect(committedValue(p, '30')).toBe(FRAME_WIDTH_MAX)
    expect(rangeText(p)).toBe('0.0% to 16.0%')
  })

  it('Corners: Square at 0, Round at 100%, the percent between', () => {
    const p = byKey(borderParams(frameDefaults(), true, noop)).corners
    expect([p.format(0), p.format(0.4), p.format(1)]).toEqual(['Square', '40%', 'Round'])
    expect([cornersWords(0.004), cornersWords(0.996)]).toEqual(['Square', 'Round'])
    expect(rangeText(p)).toBe('Square to Round')
    expect(committedValue(p, '40')).toBe(0.4)
  })

  it('Blur shows its number, in Border Studio\'s steps of 2', () => {
    const p = byKey(borderParams(frosted(), true, noop)).blur
    expect([p.format(10), p.format(60), p.format(240)]).toEqual(['10', '60', '240'])
    expect(nudge(p, 1)).toBe(62)
  })

  it('a stored edge value is shown as it is, never clamped by the control', () => {
    const p = byKey(borderParams(frosted({ width: FRAME_WIDTH_MAX, corners: 1, blur: 240 }), true, noop))
    for (const key of ['width', 'corners', 'blur']) {
      expect(thumbValue(p[key]), key).toBe(p[key].value)
      expect(canNudge(p[key], 1), key).toBe(false)
      expect(canNudge(p[key], -1), key).toBe(true)
    }
    expect(p.width.format(p.width.value)).toBe('16.0%')
    // A width between the grid's steps (the seed is 1/14) reads as stored and
    // steps onto the grid.
    const seeded = byKey(borderParams(frosted({ width: FRAME_WIDTH_FIRST }), true, noop)).width
    expect(seeded.value).toBe(FRAME_WIDTH_FIRST)
    expect(nudge(seeded, 1)).toBe(0.072)
    expect(nudge(seeded, -1)).toBe(0.07)
  })

  it('each writes its own field, and nothing else', () => {
    const patches: unknown[] = []
    const p = byKey(borderParams(frosted(), true, (patch) => patches.push(patch)))
    p.width.onChange(0.05, { discrete: true })
    p.corners.onChange(0.25, { discrete: true })
    p.blur.onChange(120, { discrete: false })
    expect(patches).toEqual([{ width: 0.05 }, { corners: 0.25 }, { blur: 120 }])
  })

  it('without a photo there is nothing to frame, and each says so', () => {
    for (const p of borderParams(frosted(), false, noop)) expect(p.unavailable, p.key).toBe(NO_PHOTO)
    for (const p of borderParams(frosted(), true, noop)) expect(p.unavailable, p.key).toBeUndefined()
  })
})
