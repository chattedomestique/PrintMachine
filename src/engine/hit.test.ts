/**
 * hitLayer: which plate a tap on the sheet picks (Border Studio's
 * tap-to-select). Pure, over layouts made with a stub measure.
 */

import { describe, expect, it } from 'vitest'

import { makeLayer } from '../state/defaults.ts'
import { BACKING_PAD, hitLayer, layoutText, lineRects, type PlateLayout } from './text.ts'
import type { TextLayer } from './types.ts'

// A stand-in for the browser: every glyph is exactly half the font size wide.
const measure = (text: string, size: number) => text.length * size * 0.5

const SHEET = { w: 800, h: 1000 }

/** One plate, laid out on SHEET. Size 0.05 is a 50 px font there. */
const plate = (over: Partial<TextLayer> = {}): PlateLayout => {
  const layer = makeLayer({ text: 'ABCDEFGHIJ', size: 0.05, tracking: 0, lineHeight: 1, align: 'center', x: 0.5, y: 0.5, ...over })
  return { layer, layout: layoutText(layer, SHEET.h, measure) }
}

/** The layer's origin on SHEET, in pixels. */
const origin = (p: PlateLayout) => ({ x: p.layer.x * SHEET.w, y: p.layer.y * SHEET.h })

describe('hitLayer — which plate a tap picks', () => {
  // ABCDEFGHIJ at 50 px: a line 250 px wide; its box reaches 0.58 em + the
  // backing's pad above the baseline (35 px) and 0.32 em + pad below (22 px).
  const halfWidth = 125 + BACKING_PAD * 50
  const above = 0.58 * 50 + BACKING_PAD * 50

  it('hits a point on the line and misses one off it', () => {
    const p = plate()
    const o = origin(p)
    expect(hitLayer([p], o, SHEET)).toBe(p.layer.id)
    expect(hitLayer([p], { x: o.x + halfWidth - 1, y: o.y }, SHEET)).toBe(p.layer.id)
    expect(hitLayer([p], { x: o.x + halfWidth + 1, y: o.y }, SHEET)).toBeNull()
    expect(hitLayer([p], { x: o.x, y: o.y - above - 1 }, SHEET)).toBeNull()
  })

  it('a rotated line is hit along its slant and missed beside it', () => {
    const p = plate({ rotation: 30 })
    const o = origin(p)
    const t = (30 * Math.PI) / 180
    // 100 px out along the turned line: on it.
    const along = { x: o.x + 100 * Math.cos(t), y: o.y + 100 * Math.sin(t) }
    expect(hitLayer([p], along, SHEET)).toBe(p.layer.id)
    // 100 px out along the upright line: inside the upright box round the
    // block, but 50 px above the turned line, whose box reaches 35.
    const upright = { x: o.x + 100, y: o.y }
    expect(hitLayer([p], upright, SHEET)).toBeNull()
    expect(hitLayer([plate()], upright, SHEET)).not.toBeNull()
    // The turn is about the layer's origin: the far end of the line moved.
    const end = { x: o.x + 120 * Math.cos(t), y: o.y + 120 * Math.sin(t) }
    expect(hitLayer([p], end, SHEET)).toBe(p.layer.id)
    expect(hitLayer([p], { x: o.x + 120, y: o.y + 0 }, SHEET)).toBeNull()
  })

  it('hits each line where it is, not the block round them', () => {
    // Left-aligned: the short second line leaves the block's lower right empty.
    const p = plate({ text: 'ABCDEFGHIJ\nAB', align: 'left' })
    const o = origin(p)
    const rects = lineRects(p.layout, 'left', -p.layout.widest / 2, -p.layout.blockHeight / 2 + p.layout.lineHeight / 2)
    expect(rects).toHaveLength(2)
    const second = rects[1]
    const rowY = o.y + second.y + second.h / 2
    expect(hitLayer([p], { x: o.x + second.x + 5, y: rowY }, SHEET)).toBe(p.layer.id)
    expect(hitLayer([p], { x: o.x + 100, y: rowY }, SHEET)).toBeNull()
  })

  it('the topmost of two overlapping plates wins: the later one prints on top', () => {
    const below = plate()
    const above = plate()
    expect(hitLayer([below, above], origin(below), SHEET)).toBe(above.layer.id)
    expect(hitLayer([above, below], origin(below), SHEET)).toBe(below.layer.id)
  })

  it('a miss returns null, and so does a sheet with no plates', () => {
    const p = plate()
    expect(hitLayer([p], { x: 5, y: 5 }, SHEET)).toBeNull()
    expect(hitLayer([], { x: 400, y: 500 }, SHEET)).toBeNull()
  })

  it('a plate with no ink (empty, or only spaces) is never hit', () => {
    for (const text of ['', '   ', '\n\n']) {
      const p = plate({ text })
      expect(hitLayer([p], origin(p), SHEET, 50)).toBeNull()
    }
  })

  it('slop: a near miss counts, the nearest plate wins, and inside beats beside', () => {
    const p = plate()
    const o = origin(p)
    const beside = { x: o.x + halfWidth + 8, y: o.y }
    expect(hitLayer([p], beside, SHEET)).toBeNull()
    expect(hitLayer([p], beside, SHEET, 12)).toBe(p.layer.id)
    expect(hitLayer([p], { x: o.x + halfWidth + 13, y: o.y }, SHEET, 12)).toBeNull()

    // Two captions one above the other, their boxes 16 px apart: a point 4 px
    // under the upper one (12 px over the lower) picks the upper, though the
    // lower prints on top; 4 px over the lower picks the lower.
    const upperBottom = 450 + 0.32 * 50 + BACKING_PAD * 50
    const upper = plate({ y: 0.45 })
    const lower = plate({ y: (upperBottom + 16 + above) / 1000 })
    expect(hitLayer([upper, lower], { x: 400, y: upperBottom + 4 }, SHEET, 12)).toBe(upper.layer.id)
    expect(hitLayer([upper, lower], { x: 400, y: upperBottom + 12 }, SHEET, 12)).toBe(lower.layer.id)

    // Inside a lower plate, within slop of one on top: the one it is inside.
    const top = plate({ y: 0.5 + (above + 22 + 6) / 1000 })
    expect(hitLayer([p, top], { x: o.x, y: o.y + 20 }, SHEET, 12)).toBe(p.layer.id)
  })

  it('places the boxes on the sheet by the layer position, in the sheet the layouts were made for', () => {
    const p = plate({ x: 0.25, y: 0.8 })
    expect(hitLayer([p], { x: 200, y: 800 }, SHEET)).toBe(p.layer.id)
    expect(hitLayer([p], { x: 400, y: 500 }, SHEET)).toBeNull()
  })
})
