/**
 * The rules the reducer holds for a plate: a backing or a second ink but never
 * both, "Keep this ink" following the ink, and the plate budget.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FRAME_WIDTH_FIRST, MAX_PRESSED_PASSES, MAX_TEXT_PLATES, passCount } from '../engine/limits.ts'
import { contrastPartner } from '../engine/inks.ts'
import { type PrintSettings, type TextLayer } from '../engine/types.ts'
import { originalBorder, sheetAspect, visibleAspect } from '../engine/frame.ts'
import { areaOf, clampPan } from '../engine/media.ts'
import { defaultSettings, frameDefaults, makeLayer, makeMedia } from './defaults.ts'
import {
  applySettings,
  hasSwitchPoint,
  historyReducer,
  initHistory,
  overPhotoOf,
  overPhotoPatch,
  type HistoryState,
  type SettingsAction,
} from './settingsReducer.ts'

const doc = (layers: TextLayer[]): PrintSettings => ({ ...defaultSettings(), layers })
const patch = (s: PrintSettings, id: string, p: Partial<TextLayer>) =>
  applySettings(s, { type: 'patchLayer', id, patch: p })

describe('a backing or a second ink, never both', () => {
  it('setting a backing clears the second ink', () => {
    const l = makeLayer({ contrastInkId: 'white' })
    const s = patch(doc([l]), l.id, { backing: 'yellow' })
    expect(s.layers[0].backing).toBe('yellow')
    expect(s.layers[0].contrastInkId).toBeNull()
  })

  it('setting a second ink clears the backing', () => {
    const l = makeLayer({ backing: 'yellow' })
    const s = patch(doc([l]), l.id, { contrastInkId: 'black' })
    expect(s.layers[0].contrastInkId).toBe('black')
    expect(s.layers[0].backing).toBeNull()
  })

  it('the first photo does not seed a second ink on a plate that has a backing', () => {
    const backed = makeLayer({ backing: 'yellow' })
    const plain = makeLayer()
    const s = applySettings(doc([backed, plain]), {
      type: 'setMedia',
      media: makeMedia({ id: 'p', width: 100, height: 100 }),
    })
    expect(s.layers[0].contrastInkId).toBeNull()
    expect(s.layers[0].backing).toBe('yellow')
    expect(s.layers[1].contrastInkId).toBe(contrastPartner(plain.inkId))
  })
})

describe('"Keep this ink"', () => {
  it('follows the ink when the plate keeps its own ink', () => {
    const l = makeLayer({ inkId: 'fluorescentpink', contrastInkId: 'fluorescentpink' })
    const s = patch(doc([l]), l.id, { inkId: 'blue' })
    expect(s.layers[0].contrastInkId).toBe('blue')
  })

  it('leaves a different second ink alone when the ink changes', () => {
    const l = makeLayer({ inkId: 'fluorescentpink', contrastInkId: 'white' })
    const s = patch(doc([l]), l.id, { inkId: 'blue' })
    expect(s.layers[0].contrastInkId).toBe('white')
  })

  it('reads as Second ink in the over-the-photo choice', () => {
    expect(overPhotoOf(makeLayer({ contrastInkId: 'fluorescentpink' }))).toBe('second')
  })

  it('has no Switch point: both halves print the same ink, so it would change nothing', () => {
    expect(hasSwitchPoint(makeLayer({ inkId: 'fluorescentpink', contrastInkId: 'fluorescentpink' }))).toBe(false)
    // Two different inks: the switch point is where one hands over to the other.
    expect(hasSwitchPoint(makeLayer({ inkId: 'fluorescentpink', contrastInkId: 'white' }))).toBe(true)
    // No second ink, or a backing: nothing to switch.
    expect(hasSwitchPoint(makeLayer({ contrastInkId: null }))).toBe(false)
    expect(hasSwitchPoint(makeLayer({ backing: 'yellow', contrastInkId: null }))).toBe(false)
  })
})

describe('the over-the-photo choice', () => {
  it('Off to Second ink starts at the automatic partner', () => {
    const l = makeLayer({ inkId: 'yellow' })
    expect(overPhotoPatch(l, 'second')).toEqual({ contrastInkId: contrastPartner('yellow'), backing: null })
  })

  it('Backing starts in an ink that is not the plate\'s own', () => {
    for (const inkId of ['yellow', 'fluorescentpink', 'blue', 'black']) {
      const p = overPhotoPatch(makeLayer({ inkId }), 'backing')
      expect(p.backing).not.toBe(inkId)
      expect(p.contrastInkId).toBeNull()
    }
  })

  it('Off clears both', () => {
    expect(overPhotoPatch(makeLayer({ backing: 'yellow' }), 'off')).toEqual({ contrastInkId: null, backing: null })
  })

  it('reads back what the plate does', () => {
    expect(overPhotoOf(makeLayer())).toBe('off')
    expect(overPhotoOf(makeLayer({ backing: 'blue' }))).toBe('backing')
    expect(overPhotoOf(makeLayer({ contrastInkId: 'black' }))).toBe('second')
  })
})

describe('the plate budget', () => {
  it('counts a pass per plate and one more per backing; a second ink counts once', () => {
    const table: [Partial<TextLayer>[], number][] = [
      [[{}], 1],
      [[{}, {}], 2],
      [[{ backing: 'yellow' }], 2],
      [[{ contrastInkId: 'white' }, {}], 2],
      [[{ backing: 'yellow' }, { backing: 'blue' }], 4],
      [[{}, {}, { backing: 'blue' }], 4],
      [[{}, {}, {}, {}], 4],
    ]
    for (const [layers, n] of table) expect(passCount(doc(layers.map((o) => makeLayer(o))))).toBe(n)
  })

  it(`adds no ${MAX_TEXT_PLATES + 1}th plate`, () => {
    const s = doc([makeLayer(), makeLayer(), makeLayer()])
    expect(applySettings(s, { type: 'addLayer' })).toBe(s)
    expect(applySettings(doc([makeLayer(), makeLayer()]), { type: 'addLayer' }).layers).toHaveLength(3)
    // The plate button names the new plate's id, so it can select it.
    expect(applySettings(doc([makeLayer()]), { type: 'addLayer', id: 'plate-new' }).layers[1].id).toBe('plate-new')
  })

  it(`adds no plate when ${MAX_PRESSED_PASSES} passes are already spent`, () => {
    const s = doc([makeLayer({ backing: 'yellow' }), makeLayer({ backing: 'blue' })])
    expect(passCount(s)).toBe(MAX_PRESSED_PASSES)
    expect(applySettings(s, { type: 'addLayer' })).toBe(s)
  })

  it('refuses a new backing at the pass limit, but lets an existing one change ink', () => {
    const a = makeLayer({ backing: 'yellow' })
    const b = makeLayer()
    const c = makeLayer()
    const s = doc([a, b, c])
    expect(passCount(s)).toBe(4)
    expect(patch(s, b.id, { backing: 'blue' })).toBe(s)
    expect(patch(s, a.id, { backing: 'blue' }).layers[0].backing).toBe('blue')
    // Freeing a pass frees the choice.
    const freed = patch(s, a.id, { backing: null })
    expect(patch(freed, b.id, { backing: 'blue' }).layers[1].backing).toBe('blue')
  })

  it('keeps every plate of a document saved over the budget, and blocks adding', () => {
    const over = doc([makeLayer(), makeLayer(), makeLayer(), makeLayer()])
    expect(applySettings(over, { type: 'addLayer' })).toBe(over)
    // Removing still works, and brings it back inside.
    const fewer = applySettings(over, { type: 'removeLayer', id: over.layers[0].id })
    expect(fewer.layers).toHaveLength(3)
  })
})

describe('the Original sheet: the photo\'s own shape', () => {
  const landscape = makeMedia({ id: 'a', width: 4032, height: 3024 })
  const portrait = makeMedia({ id: 'b', width: 3024, height: 4032 })

  it('is the sheet the first photo opens on, and Undo brings the old sheet back', () => {
    const before = { ...defaultSettings(), aspect: '1:1' as const }
    let h = initHistory(before)
    h = historyReducer(h, { type: 'setMedia', media: landscape })
    expect(h.present.aspect).toBe('original')
    // The photo's own shape inside the frame; the sheet is that and the
    // border round it.
    expect(visibleAspect(h.present)).toBeCloseTo(4 / 3, 12)
    const b = originalBorder(4032, 3024, h.present.frame.width)
    expect(sheetAspect(h.present)).toBeCloseTo((4032 + 2 * b) / (3024 + 2 * b), 12)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.aspect).toBe('1:1')
  })

  it('a replaced photo keeps the sheet the person chose; an Original sheet takes the new shape', () => {
    const square = applySettings(applySettings(defaultSettings(), { type: 'setMedia', media: landscape }), {
      type: 'patch',
      patch: { aspect: '1:1' },
    })
    expect(applySettings(square, { type: 'setMedia', media: portrait }).aspect).toBe('1:1')
    const original = applySettings(defaultSettings(), { type: 'setMedia', media: landscape })
    const swapped = applySettings(original, { type: 'setMedia', media: portrait })
    expect(swapped.aspect).toBe('original')
    expect(visibleAspect(swapped)).toBeCloseTo(3 / 4, 12)
  })

  it('removing the photo from an Original sheet leaves 4:5; from a chosen sheet, that sheet', () => {
    const original = applySettings(defaultSettings(), { type: 'setMedia', media: landscape })
    expect(applySettings(original, { type: 'setMedia', media: null }).aspect).toBe('4:5')
    const square = applySettings(original, { type: 'patch', patch: { aspect: '1:1' } })
    expect(applySettings(square, { type: 'setMedia', media: null }).aspect).toBe('1:1')
    // And with no photo there is no Original to choose.
    expect(applySettings(defaultSettings(), { type: 'patch', patch: { aspect: 'original' } }).aspect).toBe('4:5')
  })

  it('re-clamps the pan against the new shape on every change', () => {
    // Zoomed and pushed to the right edge of a square sheet...
    let s = applySettings(defaultSettings(), { type: 'setMedia', media: landscape })
    s = applySettings(s, { type: 'patch', patch: { aspect: '1:1' } })
    s = applySettings(s, { type: 'patchMedia', patch: { scale: 1.2, x: -5, y: 0.5 } })
    const onSquare = s.media!.x
    // ...then the photo's own shape: less travel across, so it is pulled in.
    s = applySettings(s, { type: 'patch', patch: { aspect: 'original' } })
    expect(s.media!.x).toBeGreaterThan(onSquare)
    expect(clampPan(s.media!, areaOf(visibleAspect(s), 1))).toEqual(s.media)
    // Replaced by a portrait photo on the same Original sheet: clamped again.
    s = applySettings(s, { type: 'setMedia', media: { ...portrait, scale: 1.2, x: -5, y: 9 } })
    expect(clampPan(s.media!, areaOf(visibleAspect(s), 1))).toEqual(s.media)
  })
})

describe('the undo history', () => {
  const landscape = makeMedia({ id: 'm', width: 4000, height: 3000 })

  it('a change that changes nothing is not an undo step', () => {
    const l = makeLayer({ x: 0.5 })
    let h = initHistory(doc([l]))
    // The same value again (a second reset; a patch that writes what is
    // there). A run that goes away and comes back, within one burst, is the
    // test after next.
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.5 } })
    expect(h.past).toHaveLength(0)
    // A photo at 100% on its own sheet cannot move: every drag clamps back.
    h = historyReducer(h, { type: 'setMedia', media: landscape })
    expect(h.past).toHaveLength(1)
    const before = h.present
    h = historyReducer(h, { type: 'patchMedia', patch: { x: 0.9, y: 0.1 }, coalesce: true })
    expect(h.present).toBe(before)
    expect(h.past).toHaveLength(1)
    expect(h.bursting).toBe(false)
    // So Undo takes back the photo, the last thing that changed.
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.media).toBeNull()
  })

  it('a real change still is one, and a drag still coalesces into one', () => {
    const l = makeLayer({ x: 0.5 })
    let h = initHistory(doc([l]))
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.6 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.6 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.7 }, coalesce: true })
    expect(h.past).toHaveLength(1)
    expect(h.present.layers[0].x).toBe(0.7)
  })

  it('a run that ends where it began leaves no undo step: a drag back to its start', () => {
    const l = makeLayer({ x: 0.5 })
    let h = initHistory(doc([l]))
    const start = h.present
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.6 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.7 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.5 }, coalesce: true })
    expect(h.past).toHaveLength(0)
    expect(h.present).toBe(start)
    expect(h.bursting).toBe(false)
    // The finger carries on: that is a step of its own, back to 0.5.
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.55 }, coalesce: true })
    expect(h.past).toEqual([start])
    // A step before the run is kept: the run drops only the step it opened.
    h = historyReducer(h, { type: 'endBurst' })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.6 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { x: 0.55 }, coalesce: true })
    expect(h.past).toHaveLength(1)
    expect(h.present.layers[0].x).toBe(0.55)
  })

  it('a run that ends where it began leaves no undo step: a double tap on a setting at its default', () => {
    // Press › Screen size at its default, double-tapped at 80% of the track:
    // the first tap moves the thumb (a coalesced step), the reset joins it
    // and lands back on the default.
    let h = initHistory(defaultSettings())
    const def = h.present.press.screenPitch
    h = historyReducer(h, { type: 'patchPress', patch: { screenPitch: 19.5 }, coalesce: true })
    expect(h.past).toHaveLength(1)
    h = historyReducer(h, { type: 'patchPress', patch: { screenPitch: def }, join: true })
    expect(h.past).toHaveLength(0)
    expect(h.present.press.screenPitch).toBe(def)
    expect(h.bursting).toBe(false)
    // The same when the second tap is handled after the burst is over.
    h = historyReducer(h, { type: 'patchPress', patch: { screenPitch: 19.5 }, coalesce: true })
    h = historyReducer(h, { type: 'endBurst' })
    h = historyReducer(h, { type: 'patchPress', patch: { screenPitch: def }, join: true })
    expect(h.past).toHaveLength(0)
  })

  it('a double tap\'s reset joins its first tap\'s step even after the burst is over', () => {
    // The second tap is handled late (behind a render), after the burst's
    // idle timer has ended the first tap's burst; it still touched within the
    // double-tap window, so the reset is part of that step.
    const l = makeLayer({ size: 0.09 })
    let h = initHistory(doc([l]))
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.082 }, coalesce: true })
    h = historyReducer(h, { type: 'endBurst' })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.04 }, join: true })
    expect(h.past).toHaveLength(1)
    expect(h.present.layers[0].size).toBe(0.04)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.layers[0].size).toBe(0.09)
    expect(h.past).toHaveLength(0)
  })

  it('a join is a step of its own when there is no step to join, or one was undone since', () => {
    const l = makeLayer({ size: 0.09 })
    let h = initHistory(doc([l]))
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.04 }, join: true })
    expect(h.past).toHaveLength(1)
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.05 } })
    h = historyReducer(h, { type: 'undo' })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.06 }, join: true })
    expect(h.past).toHaveLength(2)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.layers[0].size).toBe(0.04)
  })

  it('an earlier step survives a double tap whose first tap\'s run was dropped', () => {
    // The typeface, then Size: the first tap lands on the thumb and the finger
    // wobbles a step and back (a run that ends where it began: dropped), and
    // the second tap resets. The reset has no step of its run to join, so it
    // is one of its own: one Undo takes back the reset and keeps the typeface.
    const l = makeLayer({ size: 0.09, fontId: 'poster' })
    let h = initHistory(doc([l]))
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { fontId: 'serif' } })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.091 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.09 }, coalesce: true })
    expect(h.past).toHaveLength(1)
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.04 }, join: true })
    expect(h.past).toHaveLength(2)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.layers[0].size).toBe(0.09)
    expect(h.present.layers[0].fontId).toBe('serif')
    // The same when the reset is handled after the burst is over.
    h = initHistory(doc([l]))
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { fontId: 'serif' } })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.091 }, coalesce: true })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.09 }, coalesce: true })
    h = historyReducer(h, { type: 'endBurst' })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.04 }, join: true })
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.layers[0].fontId).toBe('serif')
  })

  it('a join merges only into the step a coalescing run opened, with nothing else since', () => {
    const l = makeLayer({ size: 0.09, fontId: 'poster' })
    const run = (h: HistoryState) => historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.082 }, coalesce: true })
    const reset = (h: HistoryState) => historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.04 }, join: true })
    // A plain step after the run: the reset no longer joins the run.
    let h = run(initHistory(doc([l])))
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { fontId: 'serif' } })
    h = reset(h)
    expect(h.past).toHaveLength(3)
    // Undo then Redo of the run: the run's step is back, but it is no longer
    // the change a reset arriving now belongs to.
    h = run(initHistory(doc([l])))
    h = historyReducer(historyReducer(h, { type: 'undo' }), { type: 'redo' })
    h = reset(h)
    expect(h.past).toHaveLength(2)
    // A step that is not a run's (the typeface) is never joined.
    h = historyReducer(initHistory(doc([l])), { type: 'patchLayer', id: l.id, patch: { fontId: 'serif' } })
    h = reset(h)
    expect(h.past).toHaveLength(2)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.layers[0].fontId).toBe('serif')
  })

  it('a run that opened no step leaves nothing to join', () => {
    // A Size drag, its burst over; then a drag on a photo that cannot move (a
    // run whose every change clamps back: no step); then a reset that says it
    // joins. The Size drag is not its step.
    const l = makeLayer({ size: 0.09 })
    let h = initHistory(doc([l]))
    h = historyReducer(h, { type: 'setMedia', media: landscape })
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.082 }, coalesce: true })
    h = historyReducer(h, { type: 'endBurst' })
    const before = h.present
    h = historyReducer(h, { type: 'patchMedia', patch: { x: 0.9 }, coalesce: true })
    expect(h.present).toBe(before)
    h = historyReducer(h, { type: 'patchPress', patch: { screenPitch: 19.5 }, join: true })
    expect(h.past).toHaveLength(3)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.layers[0].size).toBe(0.082)
  })

  it('a join opens no burst: a drag after a reset that found nothing to join is a step of its own', () => {
    const l = makeLayer({ size: 0.09 })
    let h = initHistory(doc([l]))
    // Even if a caller marks it coalescing.
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.04 }, coalesce: true, join: true })
    expect(h.past).toHaveLength(1)
    expect(h.bursting).toBe(false)
    h = historyReducer(h, { type: 'patchLayer', id: l.id, patch: { size: 0.05 }, coalesce: true })
    expect(h.past).toHaveLength(2)
  })
})

describe('the frame', () => {
  const photo = makeMedia({ id: 'm', width: 4000, height: 3000 })

  it('a frame edit changes the frame and nothing else: no plate is rewritten', () => {
    const s = applySettings(defaultSettings(), { type: 'setMedia', media: photo })
    const next = applySettings(s, { type: 'patchFrame', patch: { width: 0.1, corners: 0.5, fill: 'deep', blur: 120, mode: 'fit' } })
    expect(next.frame).toEqual({ width: 0.1, corners: 0.5, fill: 'deep', blur: 120, mode: 'fit' })
    expect(next.layers).toEqual(s.layers)
    expect({ ...next, frame: s.frame }).toEqual(s)
  })

  it('a drag on a frame setting coalesces into one undo step, and a double tap joins it, as the press does', () => {
    let h = initHistory(applySettings(defaultSettings(), { type: 'setMedia', media: photo }))
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.03 } })
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.05 }, coalesce: true })
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.08 }, coalesce: true })
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.12 }, coalesce: true })
    expect(h.past).toHaveLength(2)
    expect(h.present.frame.width).toBe(0.12)
    h = historyReducer(h, { type: 'endBurst' })
    h = historyReducer(h, { type: 'patchFrame', patch: { width: FRAME_WIDTH_FIRST }, join: true })
    expect(h.past).toHaveLength(2)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.frame.width).toBe(0.03)
  })

  it('the first photo is framed: the border a first photo gets, the rest of the frame at the template', () => {
    const s = applySettings(defaultSettings(), { type: 'setMedia', media: photo })
    expect(defaultSettings().frame.width).toBe(0)
    expect(s.frame).toEqual({ ...frameDefaults(), width: FRAME_WIDTH_FIRST })
    expect(s.frame).toEqual({ width: 1 / 14, corners: 0, fill: 'photo', blur: 60, mode: 'crop' })
    // Beside the Original sheet and the second ink, in the one step Undo
    // takes back.
    const start = defaultSettings()
    let h = initHistory(start)
    h = historyReducer(h, { type: 'setMedia', media: photo })
    expect([h.present.aspect, h.present.frame.width, h.past.length]).toEqual(['original', FRAME_WIDTH_FIRST, 1])
    h = historyReducer(h, { type: 'undo' })
    expect(h.present).toBe(start)
    expect(h.present.frame.width).toBe(0)
  })

  it('a frame the document has is kept: a Replace keeps the whole print, and a first photo keeps a border already set', () => {
    const framed = applySettings(applySettings(defaultSettings(), { type: 'setMedia', media: photo }), {
      type: 'patchFrame',
      patch: { width: 0.12, fill: 'deep', corners: 0.4 },
    })
    const replaced = applySettings(framed, { type: 'setMedia', media: makeMedia({ id: 'n', width: 3000, height: 4000 }) })
    expect(replaced.frame).toEqual(framed.frame)
    // Removed, then another photo chosen: the border it had is kept.
    const bare = applySettings(framed, { type: 'setMedia', media: null })
    expect(bare.frame).toEqual(framed.frame)
    expect(applySettings(bare, { type: 'setMedia', media: photo }).frame).toEqual(framed.frame)
    // A border taken away (0) before the photo comes back is seeded again.
    const unframed = applySettings(bare, { type: 'patchFrame', patch: { width: 0 } })
    expect(applySettings(unframed, { type: 'setMedia', media: photo }).frame).toEqual({ ...framed.frame, width: FRAME_WIDTH_FIRST })
  })

  it('the seed rewrites no plate beyond the second ink a first photo always gave (D-13: type belongs to the sheet)', () => {
    const l = makeLayer({ x: 0.3, y: 0.7, size: 0.12, rotation: 5 })
    const s = applySettings(doc([l]), { type: 'setMedia', media: photo })
    expect(s.layers).toEqual([{ ...l, contrastInkId: contrastPartner(l.inkId) }])
  })
})

describe("the photo's palette", () => {
  const photo = makeMedia({ id: 'm', width: 4000, height: 3000 })
  const palette = { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' }

  it('is stored with the photo it was computed from, and is never an undo step', () => {
    let h = initHistory(defaultSettings())
    h = historyReducer(h, { type: 'setMedia', media: photo })
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.07 }, coalesce: true })
    const { past, future, bursting, joinable } = h
    h = historyReducer(h, { type: 'setPalette', mediaId: 'm', palette })
    expect(h.present.media!.palette).toEqual(palette)
    // The steps, the burst and what may be joined are as they were: the
    // entries that hold the photo take its palette, and nothing else moves.
    const unkeyed = (e: PrintSettings) => (e.media ? { ...e, media: { ...e.media, palette: undefined } } : e)
    expect(h.past.map(unkeyed)).toEqual(past.map(unkeyed))
    expect(h.past[0]).toBe(past[0])
    expect(h.past[1].media!.palette).toEqual(palette)
    expect(h.future).toEqual(future)
    expect([h.bursting, h.joinable]).toEqual([bursting, joinable])
    // The drag goes on into the same step, and keeps the palette.
    const keyedPast = h.past
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.09 }, coalesce: true })
    expect(h.past).toBe(keyedPast)
    expect(h.present.media!.palette).toEqual(palette)
  })

  it('arriving after its photo was replaced or removed, it keys the entries that hold that photo, and no other', () => {
    let h = initHistory(applySettings(defaultSettings(), { type: 'setMedia', media: photo }))
    h = historyReducer(h, { type: 'setMedia', media: makeMedia({ id: 'n', width: 3000, height: 4000 }) })
    h = historyReducer(h, { type: 'setMedia', media: null })
    const before = h
    h = historyReducer(h, { type: 'setPalette', mediaId: 'm', palette })
    // The present (no photo) and the entry of photo n are as they were.
    expect(h.present).toBe(before.present)
    expect(h.past[1]).toBe(before.past[1])
    expect(h.past[1].media!.palette).toBeUndefined()
    // Two Undos bring photo m back with its palette.
    h = historyReducer(historyReducer(h, { type: 'undo' }), { type: 'undo' })
    expect(h.present.media!.id).toBe('m')
    expect(h.present.media!.palette).toEqual(palette)
    // A palette for a photo no entry holds changes nothing.
    expect(historyReducer(before, { type: 'setPalette', mediaId: 'x', palette })).toBe(before)
  })

  it('no Undo or Redo takes it away: entries made before it landed, and redo entries, hold it too', () => {
    let h = initHistory(defaultSettings())
    h = historyReducer(h, { type: 'setMedia', media: photo })
    // Edits made while the palette is being made.
    h = historyReducer(h, { type: 'patchFrame', patch: { width: 0.07 } })
    h = historyReducer(h, { type: 'patch', patch: { aspect: '1:1' } })
    // An Undo before it lands leaves a redo entry.
    h = historyReducer(h, { type: 'undo' })
    h = historyReducer(h, { type: 'setPalette', mediaId: 'm', palette })
    for (const s of [...h.past, h.present, ...h.future]) {
      if (s.media?.id === 'm') expect(s.media.palette).toEqual(palette)
    }
    // Back to the photo's arrival, and forward past the redo entry: kept at every step.
    const seen: unknown[] = []
    h = historyReducer(h, { type: 'undo' })
    seen.push(h.present.media!.palette)
    h = historyReducer(h, { type: 'redo' })
    seen.push(h.present.media!.palette)
    h = historyReducer(h, { type: 'redo' })
    seen.push(h.present.media!.palette)
    expect(h.present.aspect).toBe('1:1')
    expect(seen).toEqual([palette, palette, palette])
  })
})

describe('only setPalette writes the palette', () => {
  const palette = { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' }
  const other = { photo: '#d2463c', deep: '#281615', muted: '#bf9592', comp: '#00a4be' }
  const photo = makeMedia({ id: 'm', width: 4000, height: 3000 })
  const base = (): PrintSettings => ({ ...defaultSettings(), media: { ...photo, palette } })
  // Loosely typed, as a careless caller might send it: each action that can
  // carry a photo tries to carry another palette in with it.
  const loose = (a: unknown) => a as SettingsAction

  /** Every action the reducer knows (the Record makes a new one fail to
   *  compile until it is listed here). */
  const ACTIONS: Record<SettingsAction['type'], SettingsAction[]> = {
    patch: [loose({ type: 'patch', patch: { media: { ...photo, palette: other } } }), { type: 'patch', patch: { aspect: '1:1' } }],
    patchLayer: [{ type: 'patchLayer', id: defaultSettings().layers[0].id, patch: { size: 0.05 } }],
    addLayer: [{ type: 'addLayer' }],
    removeLayer: [{ type: 'removeLayer', id: defaultSettings().layers[0].id }],
    patchPress: [{ type: 'patchPress', patch: { wear: 0.2 } }],
    patchFrame: [{ type: 'patchFrame', patch: { width: 0.1, fill: 'muted' } }],
    setMedia: [loose({ type: 'setMedia', media: { ...photo, palette: other } }), loose({ type: 'setMedia', media: { ...photo, id: 'n', palette: other } })],
    patchMedia: [loose({ type: 'patchMedia', patch: { palette: other, x: 0.4 } })],
    setPalette: [{ type: 'setPalette', mediaId: 'm', palette: other }],
  }

  it('no other action writes one: a palette carried in is dropped, the stored one is kept for its photo', () => {
    for (const [type, actions] of Object.entries(ACTIONS)) {
      for (const action of actions) {
        const next = applySettings(base(), action)
        const kept = next.media?.palette
        if (type === 'setPalette') expect(kept).toEqual(other)
        else if (type === 'setMedia') expect(kept, JSON.stringify(action)).toBeUndefined()
        else expect(kept, JSON.stringify(action)).toEqual(palette)
      }
    }
  })

  it('in the app, only the frame inputs dispatch it', () => {
    const src = resolve(import.meta.dirname, '..')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /type: 'setPalette'/.test(readFileSync(p, 'utf8'))) hits.push(relative(src, p))
      }
    }
    walk(src)
    // The reducer names it in its action type; the page's hook is the one
    // place that sends it.
    expect(hits.sort()).toEqual(['features/media/useFrameInputs.ts', 'state/settingsReducer.ts'])
  })
})
