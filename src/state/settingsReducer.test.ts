/**
 * The rules the reducer holds for a plate: a backing or a second ink but never
 * both, "Keep this ink" following the ink, and the plate budget.
 */

import { describe, expect, it } from 'vitest'

import { MAX_PRESSED_PASSES, MAX_TEXT_PLATES, passCount } from '../engine/limits.ts'
import { contrastPartner } from '../engine/inks.ts'
import type { PrintSettings, TextLayer } from '../engine/types.ts'
import { defaultSettings, makeLayer, makeMedia } from './defaults.ts'
import { applySettings, hasSwitchPoint, overPhotoOf, overPhotoPatch } from './settingsReducer.ts'

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
