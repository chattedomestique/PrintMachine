/**
 * A row of chips with one pressed (chips.ts, ChipRow.tsx): what each chip
 * shows and says, what a tap chooses (the flip on the chosen chip), where the
 * keys move focus, and how far a chip that takes focus scrolls the row. The
 * row is rendered on the server too (node has no DOM to tap), so the
 * attributes a tap or a screen reader would meet are checked.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { REVEAL_PAD_PX, chipFace, chipKeyTarget, chipName, chipTabStop, chipTap, revealDelta, type ChipItem } from './chips.ts'
import { ChipRow } from './ChipRow.tsx'

type R = 'own' | 'sq' | '4:5' | '5:4' | '9:16' | '16:9'
const ITEMS: readonly ChipItem<R>[] = [
  { id: 'own', label: 'Original' },
  { id: 'sq', label: '1:1' },
  { id: '4:5', label: '4:5', alt: { id: '5:4', label: '5:4' } },
  { id: '9:16', label: '9:16', alt: { id: '16:9', label: '16:9' } },
]
const [own, sq, fourFive, nineSixteen] = ITEMS

describe('what a chip shows', () => {
  it('the chosen way round, pressed; the first way when neither is chosen', () => {
    expect(chipFace(nineSixteen, '9:16')).toEqual({ id: '9:16', label: '9:16', pressed: true, flips: true })
    expect(chipFace(nineSixteen, '16:9')).toEqual({ id: '16:9', label: '16:9', pressed: true, flips: true })
    expect(chipFace(nineSixteen, '4:5')).toEqual({ id: '9:16', label: '9:16', pressed: false, flips: false })
    expect(chipFace(sq, 'sq')).toEqual({ id: 'sq', label: '1:1', pressed: true, flips: false })
  })

  it('the chosen chip that flips says so to a screen reader; no other does', () => {
    expect(chipName(nineSixteen, '9:16')).toBe('9:16, tap to flip')
    expect(chipName(nineSixteen, '16:9')).toBe('16:9, tap to flip')
    expect(chipName(nineSixteen, 'own')).toBe('9:16')
    expect(chipName(own, 'own')).toBe('Original')
    expect(chipName(sq, 'sq')).toBe('1:1')
  })
})

describe('what a tap chooses', () => {
  it('a chip not chosen: its first way round, whichever way the last choice was', () => {
    expect(chipTap(fourFive, '16:9')).toBe('4:5')
    expect(chipTap(own, '4:5')).toBe('own')
  })

  it('the chosen chip: its other way round, and back', () => {
    expect(chipTap(nineSixteen, '9:16')).toBe('16:9')
    expect(chipTap(nineSixteen, '16:9')).toBe('9:16')
  })

  it('the chosen chip with no other way round: nothing', () => {
    expect(chipTap(own, 'own')).toBeNull()
    expect(chipTap(sq, 'sq')).toBeNull()
  })

  it('a chip that cannot be chosen: nothing, from any value', () => {
    const off: ChipItem<R> = { ...fourFive, disabled: true }
    expect(chipTap(off, 'own')).toBeNull()
    expect(chipTap(off, '4:5')).toBeNull()
  })
})

describe('the keys move focus along the row', () => {
  it('arrows step and stop at the ends; Home and End go to them', () => {
    expect(chipKeyTarget('ArrowRight', 1, 4)).toBe(2)
    expect(chipKeyTarget('ArrowLeft', 1, 4)).toBe(0)
    expect(chipKeyTarget('ArrowRight', 3, 4)).toBeNull()
    expect(chipKeyTarget('ArrowLeft', 0, 4)).toBeNull()
    expect(chipKeyTarget('Home', 3, 4)).toBe(0)
    expect(chipKeyTarget('End', 0, 4)).toBe(3)
    expect(chipKeyTarget('End', 3, 4)).toBeNull()
  })

  it('Enter, Space and every other key are the button\'s own', () => {
    for (const key of ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'Tab', 'a']) expect(chipKeyTarget(key, 1, 4), key).toBeNull()
  })

  it('one tab stop: the focused chip while focus is in the row, else the chosen one, else the first', () => {
    expect(chipTabStop(2, 0)).toBe(2)
    expect(chipTabStop(-1, 3)).toBe(3)
    expect(chipTabStop(-1, -1)).toBe(0)
  })
})

describe('a chip that takes focus shows whole, with some of its neighbour', () => {
  const row = { left: 0, right: 300 }
  it('cut at the end: scrolls on until the pad shows past it', () => {
    expect(revealDelta({ left: 260, right: 320 }, row)).toBe(320 - 300 + REVEAL_PAD_PX)
  })
  it('cut at the start: scrolls back', () => {
    expect(revealDelta({ left: -30, right: 30 }, row)).toBe(-30 - REVEAL_PAD_PX)
  })
  it('whole, with the pad: stays', () => {
    expect(revealDelta({ left: 100, right: 160 }, row)).toBe(0)
    expect(revealDelta({ left: REVEAL_PAD_PX, right: 300 - REVEAL_PAD_PX }, row)).toBe(0)
  })
})

describe('the row as rendered', () => {
  const html = (value: R) =>
    renderToStaticMarkup(createElement(ChipRow<R>, { label: 'Sheet ratio', items: ITEMS, value, onChange: () => undefined }))
  const chip = (s: string, id: string) => new RegExp(`<button[^>]*data-chip="${id}"[^>]*>.*?</button>`).exec(s)?.[0] ?? ''

  it('a labelled group of the style guide\'s chips on one scrolling line', () => {
    const s = html('4:5')
    expect(s).toMatch(/^<div class="chips scroller chiprow" role="group" aria-label="Sheet ratio">/)
    expect(s.match(/<button type="button" class="chip num"/g)).toHaveLength(ITEMS.length)
  })

  it('the chosen chip is pressed, the one tab stop, and carries the flip cue; the others are none of these', () => {
    const s = html('5:4')
    const on = chip(s, '5:4')
    expect(on).toContain('aria-pressed="true"')
    expect(on).toContain('tabindex="0"')
    expect(on).toContain('aria-label="5:4, tap to flip"')
    expect(on).toContain('ic--refresh-cw')
    for (const id of ['own', 'sq', '9:16']) {
      const off = chip(s, id)
      expect(off, id).toContain('aria-pressed="false"')
      expect(off, id).toContain('tabindex="-1"')
      expect(off, id).not.toContain('ic--refresh-cw')
    }
    expect(s.match(/tabindex="0"/g)).toHaveLength(1)
  })

  it('a chosen chip with no other way round has no flip cue', () => {
    const on = chip(html('own'), 'own')
    expect(on).toContain('aria-pressed="true"')
    expect(on).toContain('aria-label="Original"')
    expect(on).not.toContain('ic--refresh-cw')
  })

  it('a colour as data (--swatch) and a glyph before the name; a chip that cannot be chosen is aria-disabled, still in the row', () => {
    type F = 'paper' | 'frost' | 'gone'
    const items: readonly ChipItem<F>[] = [
      { id: 'paper', label: 'Paper', swatch: 'rgb(240, 236, 226)' },
      { id: 'frost', label: 'Frosted', icon: 'blend' },
      { id: 'gone', label: 'Gone', disabled: true },
    ]
    const s = renderToStaticMarkup(createElement(ChipRow<F>, { label: 'Fill', items, value: 'paper', onChange: () => undefined }))
    expect(chip(s, 'paper')).toMatch(/<span class="chiprow__swatch" style="--swatch:rgb\(240, 236, 226\)" aria-hidden="true"><\/span>Paper/)
    expect(chip(s, 'frost')).toMatch(/<span class="ic ic--blend" aria-hidden="true"><\/span>Frosted/)
    expect(chip(s, 'gone')).toContain('aria-disabled="true"')
    for (const id of ['paper', 'frost']) expect(chip(s, id)).not.toContain('aria-disabled')
  })
})
