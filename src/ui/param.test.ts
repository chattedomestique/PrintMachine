/**
 * The rules every numeric setting follows (param.ts), one test per rule, and
 * the slider's markup rendered on the server so the wiring is checked too
 * (node has no DOM to tap, but the attributes a tap would meet are there).
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_MS,
  canNudge,
  committedValue,
  decimalsOf,
  dragChange,
  dragPicks,
  draftOf,
  isDoubleTap,
  nudge,
  nudgeChange,
  rangeText,
  resetChange,
  rowAt,
  snapTo,
  swipeOpens,
  thumbValue,
  trackPosition,
  typedChange,
  type Param,
} from './param.ts'
import { ParamStrip, Slider } from './Slider.tsx'

/** A Size-like setting: the slider 10%..100%, the setting 10%..1200%. */
function size(value: number, over: Partial<Param> = {}): Param {
  return {
    key: 'size',
    label: 'Size',
    trackMin: 0.01,
    trackMax: 0.1,
    min: 0.01,
    max: 1.2,
    step: 0.001,
    def: 0.04,
    toDisplay: (v) => Math.round(v * 1000),
    fromDisplay: (n) => n / 1000,
    format: (v) => `${Math.round(v * 1000)}%`,
    value,
    onChange: () => undefined,
    ...over,
  }
}

describe('snapTo puts a number on the grid and in the range', () => {
  it('rounds to the step from the minimum, with no float tail', () => {
    expect(snapTo(0.0412, 0.01, 1.2, 0.001)).toBe(0.041)
    expect(snapTo(0.041 + 1e-12, 0.01, 1.2, 0.001)).toBe(0.041)
    expect(snapTo(-4.3, -180, 180, 1)).toBe(-4)
    expect(snapTo(9.26, 2, 36, 0.5)).toBe(9.5)
    expect(snapTo(-0.0213, -0.1, 0.4, 0.005)).toBe(-0.02)
  })

  it('clamps to the range', () => {
    expect(snapTo(5, 0.01, 1.2, 0.001)).toBe(1.2)
    expect(snapTo(-1, 0.01, 1.2, 0.001)).toBe(0.01)
  })

  it('counts decimals of a step', () => {
    expect([decimalsOf(1), decimalsOf(0.5), decimalsOf(0.01), decimalsOf(0.005), decimalsOf(0.001)]).toEqual([0, 1, 2, 3, 3])
  })
})

describe('two ranges: the slider spans one, the setting holds the other', () => {
  it('the thumb is the value clamped into the travel; the readout is the TRUE value', () => {
    const p = size(0.24)
    expect(thumbValue(p)).toBe(0.1)
    expect(trackPosition(p)).toBe(1)
    expect(p.format(p.value)).toBe('240%')
    expect(trackPosition(size(0.01))).toBe(0)
    expect(trackPosition(size(0.055))).toBeCloseTo(0.5, 10)
  })

  it('a nudge steps the VALUE, clamped to the setting, not the slider: 240% then [−] is 239%, never 100%', () => {
    expect(nudge(size(0.24), -1)).toBe(0.239)
    expect(nudge(size(0.24), 1)).toBe(0.241)
    expect(nudge(size(0.1), 1)).toBe(0.101)
    expect(nudge(size(1.2), 1)).toBe(1.2)
    // A pinched value off the grid lands on it.
    expect(nudge(size(0.0412), 1)).toBe(0.042)
    expect(nudge(size(0.0412), -1)).toBe(0.04)
  })

  it('[+] is unavailable only at the setting\'s max, not at the end of the slider; [−] only at its min', () => {
    expect(canNudge(size(0.1), 1)).toBe(true)
    expect(canNudge(size(0.24), 1)).toBe(true)
    expect(canNudge(size(1.2), 1)).toBe(false)
    expect(canNudge(size(0.01), -1)).toBe(false)
    expect(canNudge(size(0.011), -1)).toBe(true)
  })

  it('a typed value is in display units, states the whole range, and commits into the FULL range: 240 is 240%', () => {
    expect(draftOf(size(0.05))).toBe('50')
    expect(draftOf(size(0.0412))).toBe('41')
    expect(rangeText(size(0.05))).toBe('10% to 1200%')
    expect(committedValue(size(0.05), '240')).toBe(0.24)
    expect(committedValue(size(0.05), ' 40 ')).toBe(0.04)
    expect(committedValue(size(0.05), '5000')).toBe(1.2)
    expect(committedValue(size(0.05), 'abc')).toBeNull()
    // A true minus sign counts as one.
    const rot = size(0, { min: -180, max: 180, step: 1, toDisplay: (v) => v, fromDisplay: (n) => n })
    expect(committedValue(rot, '−12')).toBe(-12)
  })

  it('a drag reports the thumb on the TRACK, so a pinned thumb jumps to the touch (stated, accepted); nothing else jumps', () => {
    expect(dragChange(size(0.24), 0.05)).toEqual({ value: 0.05, discrete: false })
    expect(nudgeChange(size(0.24), -1)?.value).toBe(0.239)
    expect(typedChange(size(0.24), '240')).toBeNull()
    expect(resetChange(size(0.24))?.value).toBe(0.04)
  })

  it('a drag is one coalesced undo step; a nudge, a typed value and a reset are each their own', () => {
    expect(dragChange(size(0.05), 0.06)?.discrete).toBe(false)
    expect(nudgeChange(size(0.05), 1)?.discrete).toBe(true)
    expect(typedChange(size(0.05), '60')?.discrete).toBe(true)
    expect(resetChange(size(0.05))?.discrete).toBe(true)
  })

  it('changes nothing when there is nothing to change, or the setting is unavailable', () => {
    expect(resetChange(size(0.04))).toBeNull()
    expect(nudgeChange(size(1.2), 1)).toBeNull()
    expect(dragChange(size(0.05), 0.05)).toBeNull()
    const off = size(0.05, { unavailable: 'Zoom in to move the photo' })
    expect([dragChange(off, 0.06), nudgeChange(off, 1), resetChange(off), typedChange(off, '60')]).toEqual([null, null, null, null])
  })
})

describe('double-tap, swipe and the picker\'s dead zone', () => {
  it('two taps within 320 ms are a double tap; a first tap never is', () => {
    expect(DOUBLE_TAP_MS).toBe(320)
    expect(isDoubleTap(1000, 1319)).toBe(true)
    expect(isDoubleTap(1000, 1320)).toBe(false)
    expect(isDoubleTap(0, 100)).toBe(false)
  })

  it('a row under the finger counts only after 6 px of movement, so the opening swipe cannot pick', () => {
    expect(dragPicks(500, 505)).toBe(false)
    expect(dragPicks(500, 494)).toBe(true)
    expect(dragPicks(500, 506)).toBe(true)
  })

  it('the sheet opens on a swipe UP of more than 8 px from the name', () => {
    expect(swipeOpens(500, 492)).toBe(false)
    expect(swipeOpens(500, 491)).toBe(true)
    expect(swipeOpens(500, 520)).toBe(false)
  })

  it('finds the row whose band holds the finger', () => {
    const rows = [
      { key: 'a', top: 100, bottom: 156 },
      { key: 'b', top: 156, bottom: 212 },
    ]
    expect(rowAt(rows, 120)).toBe('a')
    expect(rowAt(rows, 200)).toBe('b')
    expect(rowAt(rows, 300)).toBeNull()
  })
})

describe('the slider as rendered', () => {
  const html = (p: Param) => renderToStaticMarkup(createElement(Slider, { param: p }))
  const plus = (s: string) => /<button[^>]*aria-label="Increase Size"[^>]*>/.exec(s)?.[0] ?? ''
  const minus = (s: string) => /<button[^>]*aria-label="Decrease Size"[^>]*>/.exec(s)?.[0] ?? ''
  const range = (s: string) => /<input[^>]*type="range"[^>]*>/.exec(s)?.[0] ?? ''

  it('pinned past the end: the thumb at the end, the true value spoken, [+] still available', () => {
    const s = html(size(0.24))
    expect(range(s)).toContain('value="0.1"')
    expect(range(s)).toContain('aria-valuetext="240%"')
    expect(range(s)).toContain('max="0.1"')
    expect(plus(s)).not.toContain('aria-disabled')
    expect(s).toContain('--p:1')
  })

  it('[+] goes aria-disabled at the setting\'s max, [−] at its min; neither is removed', () => {
    expect(plus(html(size(1.2)))).toContain('aria-disabled="true"')
    expect(minus(html(size(0.01)))).toContain('aria-disabled="true"')
    expect(minus(html(size(0.05)))).not.toContain('aria-disabled')
  })

  it('an unavailable setting disables the track and the nudges, and says why in the strip', () => {
    const p = size(0.5, { unavailable: 'Zoom in to move the photo' })
    const s = html(p)
    expect(range(s)).toContain('disabled')
    expect(plus(s)).toContain('aria-disabled="true"')
    const strip = renderToStaticMarkup(createElement(ParamStrip, { params: [p] }))
    expect(strip).toContain('Zoom in to move the photo')
    expect(strip).not.toContain('tap to type')
  })

  it('one setting shows its name as plain text; several give the name the picker\'s chevrons', () => {
    const one = renderToStaticMarkup(createElement(ParamStrip, { params: [size(0.05)] }))
    expect(one).toContain('paramstrip__name')
    expect(one).not.toContain('chevrons-up-down')
    expect(one).toContain('aria-label="Size 50%, tap to type"')
    const two = renderToStaticMarkup(createElement(ParamStrip, { params: [size(0.05), { ...size(0.05), key: 'b', label: 'Other' }] }))
    expect(two).toContain('ic--chevrons-up-down')
    expect(two).toContain('aria-haspopup="dialog"')
  })
})
