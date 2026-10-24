/**
 * The Size control's numbers: "10% should be our new 100%", a slider whose
 * travel is where people actually set type, and a step that is not touchy.
 */

import { describe, expect, it } from 'vitest'

import { SIZE_MAX, SIZE_MIN, SIZE_SLIDER_MAX, SIZE_STEP } from '../../engine/limits.ts'
import { defaultSettings, makeLayer } from '../../state/defaults.ts'
import { applySettings } from '../../state/settingsReducer.ts'
import { committedValue, rangeText } from '../../ui/param.ts'
import { sizeParam } from './params.ts'
import { formatSize, fromDisplay, stepSize, toDisplay } from './sizeScale.ts'

describe('the size display: a tenth of the sheet reads 100%', () => {
  it('maps the stored size to the shown percent', () => {
    expect([0.1, 0.04, 0.01, 0.001, SIZE_MAX].map(toDisplay)).toEqual([100, 40, 10, 1, 1200])
    expect(formatSize(0.1)).toBe('100%')
    // Past the slider's end the readout shows the true value.
    expect(formatSize(0.24)).toBe('240%')
    expect(fromDisplay(100)).toBe(0.1)
  })

  // What a person types into the Size strip's value (ui/param.ts, with the
  // Size parameter of params.ts).
  const typed = (text: string) => committedValue(sizeParam(makeLayer(), () => undefined), text)

  it('round-trips every whole percent from 10 to 1200 through what a person types', () => {
    for (let pct = 10; pct <= 1200; pct++) {
      const size = typed(String(pct))
      expect(size).toBe(fromDisplay(pct))
      expect(toDisplay(size!)).toBe(pct)
      expect(typed(`${pct}%`)).toBe(size)
      expect(typed(` ${pct} % `)).toBe(size)
    }
  })

  it('snaps a typed value to the step, clamps it to the range, and refuses what is not a size', () => {
    expect(typed('40.4')).toBe(0.04)
    expect(typed('5')).toBe(SIZE_MIN)
    expect(typed('5000')).toBe(SIZE_MAX)
    for (const bad of ['-5', '\u22125', 'x', '', '%', '4 0', '1e3', '0x10', 'Infinity', '--1', '40%%']) expect(typed(bad)).toBeNull()
  })

  it('states the range a typed value may take', () => {
    expect(rangeText(sizeParam(makeLayer(), () => undefined))).toBe('10% to 1200%')
  })
})

describe('the slider: where people set type, at a step that is not touchy', () => {
  it('gives the old usable band a third of the travel, in 90 positions', () => {
    // The user's usable range was 1-4% of the old readout (0.01-0.04 of the
    // sheet). Before: (0.04 - 0.015) / (1.2 - 0.015) = 0.021 of the travel.
    expect((0.04 - SIZE_MIN) / (SIZE_SLIDER_MAX - SIZE_MIN)).toBeGreaterThanOrEqual(0.3)
    expect((SIZE_SLIDER_MAX - SIZE_MIN) / SIZE_STEP).toBeCloseTo(90, 9)
  })

  it('changes the size by at most 10% per step at its small end, 2.5% at 40%', () => {
    // The pixels per step are measured on the real track (WP3's geometry
    // gate); these are the constants that measurement rests on.
    expect(SIZE_STEP / SIZE_MIN).toBeCloseTo(0.1, 12)
    expect(SIZE_STEP / 0.04).toBeCloseTo(0.025, 12)
  })

  it('opens every plate inside the slider: the defaults, a new plate and both demo plates', () => {
    const inside = (size: number) => {
      expect(size).toBeGreaterThan(SIZE_MIN)
      expect(size).toBeLessThan(SIZE_SLIDER_MAX)
    }
    inside(makeLayer().size)
    const doc = defaultSettings()
    doc.layers.forEach((l) => inside(l.size))
    const added = applySettings(doc, { type: 'addLayer' })
    expect(added.layers).toHaveLength(doc.layers.length + 1)
    inside(added.layers[added.layers.length - 1].size)
  })
})

describe('the + and - keys', () => {
  it('step by exactly one step at the floor, and never past either end', () => {
    expect(stepSize(SIZE_MIN, 1)).toBeCloseTo(SIZE_MIN + SIZE_STEP, 12)
    expect(stepSize(SIZE_MIN, -1)).toBe(SIZE_MIN)
    expect(stepSize(SIZE_MAX, 1)).toBe(SIZE_MAX)
    expect(stepSize(SIZE_MAX, -1)).toBeLessThan(SIZE_MAX)
    expect(stepSize(SIZE_MAX, 1, true)).toBe(SIZE_MAX)
  })

  it('move by 5% (20% with Shift) above the floor, on the step grid', () => {
    expect(stepSize(0.4, 1)).toBe(0.42)
    expect(stepSize(0.4, -1)).toBe(0.38)
    expect(stepSize(0.4, 1, true)).toBe(0.48)
    // Every press moves, from anywhere a pinch can leave the size.
    for (let size = SIZE_MIN; size <= SIZE_MAX; size += 0.00037) {
      const up = stepSize(size, 1)
      const down = stepSize(size, -1)
      if (size < SIZE_MAX - SIZE_STEP) expect(up).toBeGreaterThan(size)
      if (size > SIZE_MIN + SIZE_STEP) expect(down).toBeLessThan(size)
      // On the grid, with no float tail.
      expect(up).toBe(fromDisplay(toDisplay(up)))
    }
  })
})
