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
import { CUT_SHRINK, REVEAL_PAD_PX, chipCut, chipFace, chipKeyTarget, chipName, chipTabStop, chipTap, revealDelta, type ChipItem } from './chips.ts'
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

  it('a chip whose choice is still being made says so, chosen or not, before what a tap does', () => {
    expect(chipName({ ...sq, busy: true }, 'sq')).toBe('1:1, preparing')
    expect(chipName({ ...sq, busy: true }, 'own')).toBe('1:1, preparing')
    expect(chipName({ ...nineSixteen, busy: true }, '16:9')).toBe('16:9, preparing, tap to flip')
    // Busy is said, not a reason to refuse a tap.
    expect(chipTap({ ...sq, busy: true }, 'own')).toBe('sq')
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

describe("the chip cut at a scrolling row's end (the style guide's 42-chip cut)", () => {
  // A row as the dock lays one out: chips of the given widths, `gap` apart,
  // from the content's start; the row clips `pad` past its inner width.
  const row = (widths: number[], gap = 4) => {
    let s = 0
    return widths.map((w) => {
      const it = { s, w }
      s += w + gap
      return it
    })
  }
  // What shows of the first chip not whole when every chip is `grow` wider.
  const shown = (items: { s: number; w: number }[], room: number, edge: number, grow: number) => {
    for (let i = 0; i < items.length; i++) {
      const s = items[i].s + i * grow
      const w = items[i].w + grow
      if (s + w > room + 0.5) return { v: edge - s, w }
    }
    return null
  }

  it('leaves a row that fits alone, and tightens one that misses by a few pixels until it fits', () => {
    expect(chipCut(row([48, 48, 48, 48, 48, 48]), 400, 408)).toBeNull()
    // 6 x 48 + 5 x 4 = 308 in 306: tightened, every chip 0.5 px at a time.
    const g = chipCut(row([48, 48, 48, 48, 48, 48]), 306, 314)!
    expect(g).toBeLessThan(0)
    expect(g).toBeGreaterThanOrEqual(CUT_SHRINK)
    expect(shown(row([48, 48, 48, 48, 48, 48]), 306, 314, g)).toBeNull()
  })

  it('cuts the edge chip between 30% and 60% of itself and at least 24 px: never a sliver, never only its round end', () => {
    // A fill row whose fifth chip (88 px) peeks in by 4 px at rest.
    const fill = row([76, 76, 72, 80, 88, 96])
    const before = shown(fill, 316, 324, 0)!
    expect(before.v).toBeLessThan(24)
    const g = chipCut(fill, 316, 324)!
    const after = shown(fill, 316, 324, g)!
    expect(after.v).toBeGreaterThanOrEqual(Math.max(24, 0.3 * after.w))
    expect(after.v).toBeLessThanOrEqual(0.6 * after.w)
  })

  it('every cut it gives is fair, and it gives none only when no amount in its range would be', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31)
    let scrolls = 0
    let fair = 0
    for (let k = 0; k < 2000; k++) {
      const items = row(Array.from({ length: 6 }, () => 40 + Math.round(rnd() * 60)))
      const room = 220 + Math.round(rnd() * 200)
      const edge = room + 8
      const g = chipCut(items, room, edge)
      const last = items[items.length - 1]
      if (last.s + last.w <= room + 0.5) {
        expect(g).toBeNull()
        continue
      }
      const c = shown(items, room, edge, g ?? 0)
      if (c === null) continue // tightened to fit
      const isFair = (x: { v: number; w: number } | null) => !!x && x.v >= Math.max(24, 0.3 * x.w) && x.v <= 0.6 * x.w
      scrolls++
      if (g === null) {
        // None in range: the row keeps the cut it has, as the script leaves it.
        for (let grow = CUT_SHRINK; grow <= 48; grow += 0.5) expect(isFair(shown(items, room, edge, grow)) && !isFair(c)).toBe(false)
        continue
      }
      expect(isFair(c)).toBe(true)
      fair++
    }
    expect(scrolls).toBeGreaterThan(500)
    expect(fair).toBeGreaterThan(scrolls / 2)
  })
})
