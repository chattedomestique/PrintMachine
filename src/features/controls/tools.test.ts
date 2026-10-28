/**
 * The dock's tools and the Frame tool that is to lead them: every tool's
 * glyph is one the app ships (a misspelt name draws nothing, and no test
 * would see it), and the Frame tool's sub-tabs are the four it is built with.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAME_SUBS, FRAME_TOOL, TOOLS } from './tools.ts'

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

  it('every tool, the Frame tool too, draws a glyph the app ships', () => {
    for (const t of [...TOOLS, FRAME_TOOL]) expect(glyphs.has(t.icon), t.icon).toBe(true)
  })

  it('Frame is Border Studio\'s crop glyph, its sub-tabs Border, Crop, Place and Photo', () => {
    expect(FRAME_TOOL).toEqual({ id: 'frame', label: 'Frame', icon: 'crop' })
    expect(FRAME_SUBS.map((s) => [s.id, s.label])).toEqual([
      ['border', 'Border'],
      ['crop', 'Crop'],
      ['place', 'Place'],
      ['photo', 'Photo'],
    ])
  })
})
