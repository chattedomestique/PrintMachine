/**
 * Saved prints must keep opening.
 *
 * The fixtures under `__fixtures__/` were written by the build before the
 * simplification (8d17b48), through its own `defaultSettings()` plus edits, so
 * they are documents real installs can be holding. They are frozen: a test
 * that read `defaultSettings()` instead would move with every deliberate
 * change and prove nothing about old saves.
 *
 * Plain node has no `localStorage`, and `loadSettings` swallows the resulting
 * ReferenceError and returns the defaults — so a test without the stub below
 * passes without reading anything at all. Every test here goes through it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import defaultDoc from './__fixtures__/legacy-default.json'
import garbage from './__fixtures__/legacy-garbage.json'
import maximal from './__fixtures__/legacy-maximal.json'
import photoSecondInk from './__fixtures__/legacy-photo-second-ink.json'
import preSplit from './__fixtures__/legacy-pre-split.json'
import unknownIds from './__fixtures__/legacy-unknown-ids.json'
import { loadSettings } from './persist.ts'

const KEY = 'printmachine:settings:v1'

/** A Map-backed Storage, so loadSettings reads what the test wrote. */
function stubStorage(): Map<string, string> {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  })
  return map
}

let store: Map<string, string>
beforeEach(() => {
  store = stubStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const load = (doc: unknown) => {
  store.set(KEY, JSON.stringify(doc))
  return loadSettings()
}

const FIXTURES: Record<string, unknown> = {
  'legacy-default': defaultDoc,
  'legacy-maximal': maximal,
  'legacy-pre-split': preSplit,
  'legacy-photo-second-ink': photoSecondInk,
  'legacy-unknown-ids': unknownIds,
}

describe('old saved prints', () => {
  it('reads through the stub, not past it', () => {
    // Guards the guard: a doc that differs from the defaults has to come back
    // different, or the stub is not wired and every other test is vacuous.
    const doc = { ...(defaultDoc as Record<string, unknown>), seed: 4242 }
    expect(load(doc).seed).toBe(4242)
  })

  for (const [name, doc] of Object.entries(FIXTURES)) {
    it(`opens ${name} with at least one layer`, () => {
      const s = load(doc)
      expect(Array.isArray(s.layers)).toBe(true)
      expect(s.layers.length).toBeGreaterThan(0)
    })
  }

  it('opens every garbage document with at least one layer', () => {
    for (const doc of garbage as unknown[]) {
      const s = load(doc)
      expect(s.layers.length).toBeGreaterThan(0)
    }
  })

  it('keeps the second ink a photo print was saved with', () => {
    const s = load(photoSecondInk)
    expect(s.layers.map((l) => l.contrastInkId)).toEqual(['yellow', 'midnight'])
  })
})
