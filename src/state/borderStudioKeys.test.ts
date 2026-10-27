/**
 * Border Studio's saves are not carried, and nothing here reads them.
 *
 * Its settings, its Looks and its three small preferences live under its own
 * storage keys. This app never reads, writes or deletes any of them: Border
 * Studio never stored a photo or a print; Looks are cut, so they have nowhere
 * to go; the frame's four basics are set once in a visit; and whether one
 * installed iOS app can read another's storage is untested. While /Borders/
 * is live its keys stay where they are.
 *
 * So no source under src/ or scripts/ names one, except the capture route
 * that froze Border Studio's frame (scripts/parity-borders/), which drives
 * Border Studio itself. The keys are assembled here from fragments, so this
 * file does not match its own search.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../..')

const KEYS = [
  [['border', 'studio'].join('-'), 'settings', 'v1'].join(':'),
  [['border', 'studio'].join('-'), 'presets', 'v1'].join(':'),
  ['bs', 'snap'].join('-'),
  ['bs', 'grid'].join('-'),
  ['bs', 'hint', 'seen'].join('-'),
]
/** Any key of theirs, or any other under their prefixes. */
const PATTERN = new RegExp([['border', 'studio'].join('-'), ['bs', 'snap'].join('-'), ['bs', 'grid'].join('-'), ['bs', 'hint'].join('-')].join('|'))

const SKIP = new Set(['node_modules', 'dist', 'dev-dist', 'parity-borders'])
const TEXT = /\.(?:ts|tsx|mjs|js|json|html|css)$/

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files(path, out)
    else if (TEXT.test(entry)) out.push(path)
  }
  return out
}

describe("Border Studio's storage keys", () => {
  const sources = [...files(join(repo, 'src')), ...files(join(repo, 'scripts'))]

  it('reads the sources (a search that finds nothing to search proves nothing)', () => {
    const names = sources.map((p) => relative(repo, p))
    expect(names).toEqual(expect.arrayContaining(['src/state/persist.ts', 'src/state/normalize.ts', 'scripts/check-save.mjs']))
  })

  it('are all five, and the search finds each of them', () => {
    expect(KEYS).toHaveLength(5)
    for (const key of KEYS) expect(PATTERN.test(`localStorage.getItem('${key}')`)).toBe(true)
  })

  it('appear in no source but the capture route', () => {
    const named = sources.filter((p) => PATTERN.test(readFileSync(p, 'utf8'))).map((p) => relative(repo, p))
    expect(named).toEqual([])
  })
})
