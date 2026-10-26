/**
 * The press, pinned. Eight synthetic documents through `printSheet` (every
 * stage that decides how a print looks: the tear, the density, the wear, the
 * shift, the screen or the grain, the second-ink split and its mask, the
 * knockouts and the composite), at two sheet sizes, against digests recorded
 * from the press as it was before the band engine (the commit that added this
 * file). Each coverage plane, the knockout and the printed RGBA have a digest.
 *
 * Every later change to the press must keep these: pressing a sheet in bands
 * is the same print, cut into pieces that do not show. A digest that moves is
 * a regression, never a re-baseline. To record them (once, on purpose):
 *
 *   UPDATE_GOLDEN=1 npx vitest run golden
 *
 * The documents are literals (never `defaultSettings()`, which changes on
 * purpose) and the tones and the photo are made by `__tests__/fields.ts`, so
 * nothing here depends on a canvas or on the fonts of the machine.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The knockout is the print's own business (it is cut into a running byte
// field and read as the sheet is composited), so it is read where it is
// handed to the compositor.
const seen = vi.hoisted(() => ({ knockout: undefined as Uint8ClampedArray | undefined }))
/** The knockout the last print handed the compositor (read after a print). */
const lastKnockout = (): Uint8ClampedArray | undefined => seen.knockout
vi.mock('./composite.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./composite.ts')>()
  return {
    ...real,
    compositeLayers: (...args: Parameters<typeof real.compositeLayers>) => {
      seen.knockout = args[3].knockout
      return real.compositeLayers(...args)
    },
  }
})

import { printSheet, sampledNoise } from './render.ts'
import type { PrintSettings } from './types.ts'
import { makeGround } from './__tests__/fields.ts'
import { DOCS, SIZES, syntheticTones } from './__tests__/documents.ts'

const FIXTURE = new URL('./__fixtures__/press-golden.json', import.meta.url)
const UPDATE = !!process.env.UPDATE_GOLDEN

const sha = (bytes: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
  createHash('sha256').update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest('hex')

interface PressDigest {
  planes: string[]
  knockout: string
  rgba: string
}

/** Press one document at w x h and digest what it printed. */
function pressDigest(name: string, w: number, h: number): PressDigest {
  const { settings, ground } = DOCS[name]
  const s: PrintSettings = JSON.parse(JSON.stringify(settings))
  const out = new Uint8ClampedArray(w * h * 4)
  seen.knockout = undefined
  const planes = printSheet(out, s, ground ? makeGround(w, h, 5) : undefined, syntheticTones(name, w, h), sampledNoise(s, w, h), w, h)
  const k = lastKnockout()
  return {
    planes: planes.map((p) => sha(p.coverage)),
    // No knockout and one cut nowhere print the same: both read "none".
    knockout: k && k.some((v) => v !== 0) ? sha(k) : 'none',
    rgba: sha(out),
  }
}

const recorded: Record<string, PressDigest> = UPDATE ? {} : JSON.parse(readFileSync(FIXTURE, 'utf8')).digests

describe('golden: the press prints the bytes it printed before the band engine', () => {
  for (const name of Object.keys(DOCS)) {
    for (const [w, h] of SIZES) {
      const key = `${name}@${w}x${h}`
      it(key, () => {
        const got = pressDigest(name, w, h)
        if (UPDATE) {
          recorded[key] = got
          return
        }
        expect(recorded[key], `no recorded digest for ${key}`).toBeDefined()
        expect(got).toEqual(recorded[key])
      })
    }
  }

  it('every document is in the record, and nothing else is', () => {
    if (UPDATE) return
    const want = Object.keys(DOCS).flatMap((n) => SIZES.map(([w, h]) => `${n}@${w}x${h}`))
    expect(Object.keys(recorded).sort()).toEqual(want.sort())
  })

  it('the documents exercise what they are named for', () => {
    // A guard on the fixtures themselves: a knockout where there is a ground
    // to cut, a split plate per second ink, and real ink on every plate.
    for (const name of Object.keys(DOCS)) {
      const { settings, ground } = DOCS[name]
      const w = 300
      const h = 400
      const s: PrintSettings = JSON.parse(JSON.stringify(settings))
      const out = new Uint8ClampedArray(w * h * 4)
      seen.knockout = undefined
      const planes = printSheet(out, s, ground ? makeGround(w, h, 5) : undefined, syntheticTones(name, w, h), sampledNoise(s, w, h), w, h)
      const split = ground ? s.layers.filter((l) => l.contrastInkId).length : 0
      const backings = s.layers.filter((l) => l.backing).length
      expect(planes.length, name).toBe(s.layers.length + backings + split)
      for (const p of planes.slice(0, 1)) expect(p.coverage.some((v) => v > 0), `${name}: the first plate prints`).toBe(true)
      const cuts = ground && (split > 0 || backings > 0)
      const k = lastKnockout()
      expect(!!k && k.some((v) => v > 0), `${name}: knockout`).toBe(!!cuts)
    }
  })
})

afterAll(() => {
  if (!UPDATE) return
  const sorted = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => a.localeCompare(b)))
  const file = {
    meta: {
      note:
        'Digests of the press (printSheet) over synthetic documents, recorded before the band engine. ' +
        'Re-record only on purpose (UPDATE_GOLDEN=1 npx vitest run golden) and say so in the commit: a change here is a change to every print.',
    },
    digests: sorted,
  }
  writeFileSync(FIXTURE, JSON.stringify(file, null, 2) + '\n')
})
