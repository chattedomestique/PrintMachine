import { describe, expect, it } from 'vitest'
import { CHIP_RATIOS, flipOf, type AspectKey } from './aspect.ts'
import { ASPECTS, type FixedAspect } from './types.ts'
import { ASPECT_KEYS } from '../state/fields.ts'

const FIXED = Object.keys(ASPECTS) as FixedAspect[]

describe('the sheet shapes', () => {
  it('every fixed key is a positive ratio, width over height as its name says', () => {
    for (const key of FIXED) {
      const [w, h] = key.split(':').map(Number)
      expect(ASPECTS[key]).toBeGreaterThan(0)
      expect(ASPECTS[key]).toBe(w / h)
    }
  })

  it("the schema's keys are exactly the fixed keys plus Original", () => {
    expect(ASPECT_KEYS).toEqual([...FIXED, 'original'])
  })

  it('every portrait ratio has its landscape twin, and nothing else is added', () => {
    expect(FIXED.filter((k) => ASPECTS[k] < 1).sort()).toEqual(['2:3', '3:4', '4:5', '9:16'])
    expect(FIXED.filter((k) => ASPECTS[k] > 1).sort()).toEqual(['16:9', '3:2', '4:3', '5:4'])
  })
})

describe('flipOf', () => {
  it('turns a ratio the other way round, and back', () => {
    expect(flipOf('4:5')).toBe('5:4')
    expect(flipOf('5:4')).toBe('4:5')
    expect(flipOf('9:16')).toBe('16:9')
    expect(flipOf('2:3')).toBe('3:2')
    expect(flipOf('3:4')).toBe('4:3')
  })

  it('square and Original are themselves', () => {
    expect(flipOf('1:1')).toBe('1:1')
    expect(flipOf('original')).toBe('original')
  })

  it('is an involution, and every flip is the reciprocal ratio', () => {
    for (const key of [...FIXED, 'original'] as AspectKey[]) {
      const twin = flipOf(key)
      expect(flipOf(twin)).toBe(key)
      if (key !== 'original') expect(ASPECTS[twin as FixedAspect]).toBeCloseTo(1 / ASPECTS[key as FixedAspect], 12)
    }
  })
})

describe('the chips', () => {
  it("are Border Studio's list with Free as Original, each reaching its twin", () => {
    expect(CHIP_RATIOS).toEqual(['original', '1:1', '4:5', '3:4', '9:16', '2:3'])
    const reached = new Set(CHIP_RATIOS.flatMap((k) => [k, flipOf(k)]))
    expect([...reached].sort()).toEqual([...ASPECT_KEYS].sort())
  })
})
