/**
 * The dock's tools: Frame, Type, Ink and Press, in that order; every tool's
 * glyph is one the app ships (a misspelt name draws nothing, and no test
 * would see it); and the Frame tool's sub-tabs are the four it is built with.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIRST_SUBS, SUBS, TOOLS } from './tools.ts'
import { FROSTED_ICON } from './frameChoices.ts'

const src = join(import.meta.dirname, '..', '..')
const glyphs = new Set(
  ['vendor/styleguide/icons.css', 'styles/index.css'].flatMap((f) =>
    [...readFileSync(join(src, f), 'utf8').matchAll(/\.ic--([a-z0-9-]+)\s*\{/g)].map((m) => m[1]),
  ),
)

describe('the tools', () => {
  it('reads the glyphs (a test that finds none proves nothing)', () => {
    expect(glyphs.size).toBeGreaterThan(100)
  })

  it('every tool draws a glyph the app ships', () => {
    for (const t of TOOLS) expect(glyphs.has(t.icon), t.icon).toBe(true)
  })

  it('so do the Frame tool\'s chips: Frosted\'s glyph, and the flip cue', () => {
    for (const name of [FROSTED_ICON, 'refresh-cw']) expect(glyphs.has(name), name).toBe(true)
  })

  it('Frame leads, then Type, Ink and Press: four tools, no fifth', () => {
    expect(TOOLS.map((t) => t.id)).toEqual(['frame', 'type', 'ink', 'press'])
  })

  it('every tool opens on a sub-tab it has', () => {
    for (const t of TOOLS) expect(SUBS[t.id].map((s) => s.id as string)).toContain(FIRST_SUBS[t.id])
  })

  it('Frame is Border Studio\'s crop glyph, its sub-tabs Border, Crop, Place and Photo', () => {
    expect(TOOLS[0]).toEqual({ id: 'frame', label: 'Frame', icon: 'crop' })
    expect(SUBS.frame.map((s) => [s.id, s.label])).toEqual([
      ['border', 'Border'],
      ['crop', 'Crop'],
      ['place', 'Place'],
      ['photo', 'Photo'],
    ])
  })
})
