import { describe, expect, it } from 'vitest'
import { RING_ROOM, intoView, lineEnd } from './dockLine.ts'

// The Crop tab at 320x640 and 200% text, as the browser lays it out: the
// open panel 218..538 (its bound), the tool's tabs 230..294, a ratio chip
// 338..410 at the panel's start, and the line two lines tall (90 px).
const PANEL = { top: 218, bottom: 538, scrolls: true }
const LINE = 90

describe('lineEnd: which end of the open panel the very-large line takes', () => {
  it('the top, the dock\'s first line, when that covers nothing in use', () => {
    expect(lineEnd(PANEL, LINE, { top: 338, bottom: 410 })).toBe('top')
    expect(lineEnd(PANEL, LINE, null)).toBe('top')
  })

  it('the foot when the control in use is where the top would cover it (a chip with the panel scrolled to its end, a focused tab)', () => {
    expect(lineEnd(PANEL, LINE, { top: 251, bottom: 323 })).toBe('foot')
    expect(lineEnd(PANEL, LINE, { top: 230, bottom: 294 })).toBe('foot')
  })

  it('the top when the panel is under its bound: the dock grows above it and covers nothing', () => {
    expect(lineEnd({ ...PANEL, scrolls: false }, LINE, { top: 230, bottom: 294 })).toBe('top')
  })

  it('the top when neither end leaves the control whole (the fallback scrolls it in)', () => {
    expect(lineEnd(PANEL, 200, { top: 338, bottom: 410 })).toBe('top')
  })

  it('keeps the ring\'s room round the control: a control one pixel inside the edge is covered', () => {
    const edge = PANEL.top + LINE + RING_ROOM
    expect(lineEnd(PANEL, LINE, { top: edge, bottom: edge + 72 })).toBe('top')
    expect(lineEnd(PANEL, LINE, { top: edge - 1, bottom: edge + 71 })).toBe('foot')
  })
})

describe('intoView: the fallback scroll that keeps the control in use whole', () => {
  const box = { top: 308, bottom: 538 }
  it('nothing when it is whole, even at the panel\'s edge where the person left it', () => {
    expect(intoView(box, { top: 320, bottom: 400 })).toBe(0)
    expect(intoView(box, { top: 482, bottom: 538 })).toBe(0)
  })
  it('up to show its top, down to show its foot, never pushing its top out', () => {
    expect(intoView(box, { top: 251, bottom: 323 })).toBe(251 - RING_ROOM - 308)
    expect(intoView(box, { top: 500, bottom: 560 })).toBe(560 + RING_ROOM - 538)
    expect(intoView(box, { top: 320, bottom: 900 })).toBe(320 - RING_ROOM - 308)
  })
})
