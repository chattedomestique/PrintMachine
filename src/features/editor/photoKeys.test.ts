/**
 * The photo's keys (photoKeys.ts), with the Frame tool open on Crop or
 * Original: the arrows move the view as Border Studio's do (Right and Down
 * raise Position X and Y), by 0.06 of the photo's drawn size at 100%, the
 * zoom keys step by 1.15 within 100% to 400%, 0 resets, nothing uncovers the
 * visible rectangle, and a run of presses is one undo step.
 */

import { describe, expect, it } from 'vitest'
import { areaOf, clampPan, coverRect, panFraction } from '../../engine/media.ts'
import { defaultSettings, makeMedia } from '../../state/defaults.ts'
import { historyReducer, initHistory } from '../../state/settingsReducer.ts'
import { visibleAspect } from '../../engine/frame.ts'
import { PHOTO_KEY_STEP, PHOTO_KEY_ZOOM, photoKey } from './photoKeys.ts'

// A 4:3 photo on a 4:5 visible rectangle, zoomed to 200%: it travels both ways.
const ASPECT = 4 / 5
const AREA = areaOf(ASPECT, 1)
const photo = { ...makeMedia({ id: 'p', width: 4032, height: 3024 }), scale: 2, x: 0.5, y: 0.5 }

describe('the arrows move the view over the photo, as Border Studio\'s do', () => {
  it('Right and Down raise Position X and Y; Left and Up lower them', () => {
    const fx = (m: typeof photo) => panFraction(m, AREA, 'x')
    const fy = (m: typeof photo) => panFraction(m, AREA, 'y')
    const after = (key: string) => ({ ...photo, ...photoKey(key, photo, ASPECT)!.patch })
    expect(fx(after('ArrowRight'))).toBeGreaterThan(fx(photo))
    expect(fx(after('ArrowLeft'))).toBeLessThan(fx(photo))
    expect(fy(after('ArrowDown'))).toBeGreaterThan(fy(photo))
    expect(fy(after('ArrowUp'))).toBeLessThan(fy(photo))
    // The other axis stays where it was.
    expect(fy(after('ArrowRight'))).toBeCloseTo(fy(photo), 12)
    expect(fx(after('ArrowDown'))).toBeCloseTo(fx(photo), 12)
  })

  it('one press moves the drawn photo by 0.06 of its size at 100%, at any zoom', () => {
    const W = 800
    const H = 1000
    const at100 = coverRect(photo, areaOf(W, H), { scale: 1, x: 0.5, y: 0.5 })
    for (const scale of [1.5, 2, 3.7]) {
      const m = { ...photo, scale }
      const before = coverRect(m, areaOf(W, H), m)
      const moved = { ...m, ...photoKey('ArrowRight', m, ASPECT)!.patch }
      const after = coverRect(moved, areaOf(W, H), moved)
      // Right shows more of the right edge: the photo moves left.
      expect(before.dx - after.dx).toBeCloseTo(PHOTO_KEY_STEP * at100.dw, 9)
      const down = { ...m, ...photoKey('ArrowDown', m, ASPECT)!.patch }
      expect(before.dy - coverRect(down, areaOf(W, H), down).dy).toBeCloseTo(PHOTO_KEY_STEP * at100.dh, 9)
    }
  })

  it('stops at the edge: no press uncovers the visible rectangle', () => {
    let m = { ...photo }
    for (let i = 0; i < 100; i++) m = { ...m, ...photoKey('ArrowRight', m, ASPECT)!.patch }
    expect(panFraction(m, AREA, 'x')).toBe(1)
    expect(clampPan(m, AREA)).toEqual(m)
    // At 100% on its own shape it cannot move at all.
    const own = { ...photo, scale: 1 }
    expect(photoKey('ArrowLeft', own, 4032 / 3024)!.patch).toEqual({ scale: 1, x: 0.5, y: 0.5 })
  })
})

describe('the zoom keys and 0', () => {
  it('plus and = zoom in by 1.15, minus and _ out, within 100% to 400%', () => {
    const at1 = { ...photo, scale: 1 }
    expect(photoKey('+', at1, ASPECT)!.patch.scale).toBeCloseTo(PHOTO_KEY_ZOOM, 12)
    expect(photoKey('=', at1, ASPECT)!.patch.scale).toBeCloseTo(PHOTO_KEY_ZOOM, 12)
    expect(photoKey('-', photo, ASPECT)!.patch.scale).toBeCloseTo(2 / PHOTO_KEY_ZOOM, 12)
    expect(photoKey('_', photo, ASPECT)!.patch.scale).toBeCloseTo(2 / PHOTO_KEY_ZOOM, 12)
    expect(photoKey('-', at1, ASPECT)!.patch.scale).toBe(1)
    expect(photoKey('+', { ...photo, scale: 3.9 }, ASPECT)!.patch.scale).toBe(4)
  })

  it('zooms about the middle of the frame: the point of the photo there stays there (Border Studio\'s keys)', () => {
    const area = areaOf(ASPECT, 1)
    // Panned to the left: the view's middle is left of the photo's centre.
    const panned = { ...photo, x: 0.8, y: 0.4 }
    const r0 = coverRect(panned, area, panned)
    const u = (0.5 * area.w - r0.dx) / r0.dw
    const v = (0.5 * area.h - r0.dy) / r0.dh
    let m = panned
    for (const key of ['+', '+', '-', '+']) {
      m = { ...m, ...photoKey(key, m, ASPECT)!.patch }
      const r = coverRect(m, area, m)
      expect(r.dx + u * r.dw).toBeCloseTo(0.5 * area.w, 9)
      expect(r.dy + v * r.dh).toBeCloseTo(0.5 * area.h, 9)
    }
  })

  it('zooming out pulls the pan back inside the travel the new zoom has', () => {
    const edge = { ...photo, x: clampPan({ ...photo, x: -9 }, AREA).x }
    const out = { ...edge, ...photoKey('-', edge, ASPECT)!.patch }
    expect(clampPan(out, AREA)).toEqual(out)
    expect(out.x).toBeGreaterThan(edge.x)
  })

  it('0 puts the photo back at 100% and centred', () => {
    expect(photoKey('0', photo, ASPECT)).toEqual({ patch: { scale: 1, x: 0.5, y: 0.5 }, coalesce: false })
  })

  it('every other key is not the photo\'s', () => {
    for (const key of ['[', ']', 'a', 'Enter', ' ', 'Tab', 'Escape']) expect(photoKey(key, photo, ASPECT), key).toBeNull()
  })
})

describe('in the history', () => {
  it('a run of arrows and zooms is one undo step, as a plate\'s keys are; 0 is a step of its own', () => {
    const doc = { ...defaultSettings(), aspect: '4:5' as const }
    let h = initHistory(historyReducer(initHistory(doc), { type: 'setMedia', media: makeMedia({ id: 'p', width: 4032, height: 3024 }) }).present)
    const press = (key: string) => {
      const m = h.present.media!
      const change = photoKey(key, m, visibleAspect(h.present))!
      h = historyReducer(h, { type: 'patchMedia', patch: change.patch, coalesce: change.coalesce })
    }
    for (const key of ['+', '+', 'ArrowRight', 'ArrowDown', '=']) press(key)
    expect(h.past).toHaveLength(1)
    expect(h.present.media!.scale).toBeCloseTo(PHOTO_KEY_ZOOM ** 3, 12)
    h = historyReducer(h, { type: 'endBurst' })
    press('0')
    expect(h.past).toHaveLength(2)
    expect(h.present.media).toMatchObject({ scale: 1, x: 0.5, y: 0.5 })
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.media!.scale).toBeCloseTo(PHOTO_KEY_ZOOM ** 3, 12)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.media).toMatchObject({ scale: 1, x: 0.5, y: 0.5 })
  })
})
