/**
 * README "Layout": `engine/` imports nothing from `state/`, `ui/` or
 * `features/`, and touches neither React nor the DOM beyond a canvas context
 * handed to it. The export's canvases come from the caller
 * (`SaveOptions.makeCanvas`) and the share sheet and the download are the
 * page's (features/shell/page.ts). Read from the sources themselves, tests
 * aside (they may build documents with `state/`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = import.meta.dirname

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

/** The code without its comments (block comments, and `//` comments that
 *  start a line or follow a space). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

describe('the engine stands alone', () => {
  const files = sources(root).map((path) => ({ path: relative(root, path), text: code(readFileSync(path, 'utf8')) }))

  it('reads its own sources (a test that finds nothing proves nothing)', () => {
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['export.ts', 'render.ts', 'tiles.ts', 'encode/jpeg.ts']))
  })

  it('imports nothing from state/, ui/, features/ or React', () => {
    const bad = files.filter((f) => /from\s+'(?:\.\.\/)+(?:state|ui|features)\/|from\s+'react/.test(f.text)).map((f) => f.path)
    expect(bad).toEqual([])
  })

  it('touches no DOM: no document, window or navigator', () => {
    const bad = files.filter((f) => /\b(?:document|window|navigator)\s*[.?[]/.test(f.text)).map((f) => f.path)
    expect(bad).toEqual([])
  })
})
