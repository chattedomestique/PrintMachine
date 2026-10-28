/**
 * README "Architecture": `ui/` is the style guide's elements as React
 * components, app-agnostic: it imports nothing from `engine/`, `state/` or
 * `features/`, so nothing in it knows what a print is (the caller hands in
 * the values and the words). Read from the sources themselves, tests aside.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = import.meta.dirname
const files = readdirSync(root)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(root, f), 'utf8') }))

describe('ui/ stands apart from the app', () => {
  it('reads its own sources (a test that finds nothing proves nothing)', () => {
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(['ui.tsx', 'Slider.tsx', 'param.ts', 'ChipRow.tsx', 'chips.ts']))
  })

  it('imports only React and its own modules', () => {
    const bad = files.flatMap((f) =>
      [...f.text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)]
        .map((m) => m[1])
        .filter((from) => !/^(?:react|react-dom|react-dom\/client)$/.test(from) && !/^\.\/[^/]+$/.test(from))
        .map((from) => `${f.name}: ${from}`),
    )
    expect(bad).toEqual([])
  })
})
