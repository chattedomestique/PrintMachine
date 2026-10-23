/**
 * Taking a photo in, holding it for the preview, and letting it go: the stored
 * bytes are the picked bytes at every size, the preview never shows the wrong
 * photo, and nothing deletes a photo an undo step can still bring back.
 */

import { describe, expect, it } from 'vitest'

import { historyReducer, initHistory } from '../../state/settingsReducer.ts'
import { defaultSettings, makeMedia } from '../../state/defaults.ts'
import { SWEEP_AFTER_MS, mediaCreatedAt, sweepMedia, type SweepStore } from '../../state/mediaStore.ts'
import { isReducedCopy } from '../../engine/media.ts'
import { importMedia, type ImportDeps } from './importMedia.ts'
import { PREVIEW_PHOTO_AREA, previewArea, workingSize } from './decode.ts'
import { MAX_AREA } from '../../engine/limits.ts'
import { coverRect } from '../../engine/media.ts'
import { previewSize } from '../../engine/render.ts'
import { mulberry32 } from '../../engine/rng.ts'
import { ASPECTS } from '../../engine/types.ts'
import { fromHeld, mediaState, type HeldMedia } from './useMediaBitmap.ts'

const NOW = Date.UTC(2026, 9, 23, 12)

/** A file of `n` recognisable bytes, standing in for a JPEG or PNG. */
const fileOf = (n: number, type: string) => {
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff
  return new Blob([bytes], { type })
}

/** A browser stand-in: decodes to the given (oriented) size, records what is
 *  stored and whether the decode was closed. */
function fakeDeps(width: number, height: number) {
  const stored = new Map<string, Blob>()
  const closed: boolean[] = []
  const deps: ImportDeps = {
    decode: async () => {
      const i = closed.push(false) - 1
      return { width, height, close: () => void (closed[i] = true) }
    },
    put: async (id, blob) => void stored.set(id, blob),
    now: () => NOW,
  }
  return { deps, stored, closed }
}

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

describe('import stores the original, byte for byte, at every size', () => {
  const rows: [string, number, number, string][] = [
    ['12 MP JPEG', 4032, 3024, 'image/jpeg'],
    ['the default iPhone capture, 24 MP', 5712, 4284, 'image/jpeg'],
    ['a synthetic 6000x4500 JPEG', 6000, 4500, 'image/jpeg'],
    ['48 MP', 8064, 6048, 'image/jpeg'],
    ['4096 square', 4096, 4096, 'image/jpeg'],
    ['one pixel past the old ceiling', 4097, 4096, 'image/jpeg'],
    ['a PNG (alpha and all)', 5000, 4000, 'image/png'],
  ]
  for (const [name, w, h, type] of rows) {
    it(`${name}, ${w}x${h}: stored as picked, at its own size, flagged native`, async () => {
      const file = fileOf(4099, type)
      const { deps, stored, closed } = fakeDeps(w, h)
      const { layer } = await importMedia(file, deps)
      expect(stored.size).toBe(1)
      const blob = stored.get(layer.id)!
      expect(blob.type).toBe(type)
      expect(blob.size).toBe(file.size)
      expect(await bytes(blob)).toEqual(await bytes(file))
      expect(layer).toEqual(makeMedia({ id: layer.id, width: w, height: h, native: true }))
      // The one decode is closed before anything is stored.
      expect(closed).toEqual([true])
    })
  }

  it('takes the size the right way up: an EXIF-rotated 24 MP portrait is 4284x5712', async () => {
    // The decode applies the orientation, so it reports the upright size.
    const { deps } = fakeDeps(4284, 5712)
    const { layer } = await importMedia(fileOf(100, 'image/jpeg'), deps)
    expect([layer.width, layer.height]).toEqual([4284, 5712])
  })

  it('refuses a file the browser cannot read, and stores nothing', async () => {
    const { deps, stored } = fakeDeps(1, 1)
    deps.decode = async () => {
      throw new DOMException('The source image could not be decoded.', 'InvalidStateError')
    }
    await expect(importMedia(fileOf(10, 'image/heic'), deps)).rejects.toThrow('That image could not be read.')
    expect(stored.size).toBe(0)
  })

  it('writes an id the launch sweep can date', async () => {
    const { deps } = fakeDeps(10, 10)
    const { layer } = await importMedia(fileOf(10, 'image/jpeg'), deps)
    expect(mediaCreatedAt(layer.id)).toBe(NOW)
  })
})

describe('a photo saved by an older build', () => {
  it('is a reduced copy only with no native flag and a long edge of exactly 2048', () => {
    expect(isReducedCopy({ width: 2048, height: 1536 })).toBe(true)
    expect(isReducedCopy({ width: 1536, height: 2048 })).toBe(true)
    // Any import since stores the original and says so, even at 2048.
    expect(isReducedCopy({ width: 2048, height: 1536, native: true })).toBe(false)
    // A small photo an older build kept whole is the original too.
    expect(isReducedCopy({ width: 1600, height: 1200 })).toBe(false)
    expect(isReducedCopy({ width: 2047, height: 1536 })).toBe(false)
  })
})

describe("the preview's working copy", () => {
  it('is the photo itself up to 4 MP, and above it keeps the aspect and a long edge of at least 2048', () => {
    expect(workingSize(2048, 2048)).toBeNull()
    expect(workingSize(2365, 1773)).toBeNull()
    for (const [w, h] of [
      [5712, 4284],
      [4284, 5712],
      [8064, 6048],
      [6000, 1200],
      [4032, 3024],
    ]) {
      const s = workingSize(w, h)!
      expect(s.width * s.height).toBeLessThanOrEqual(PREVIEW_PHOTO_AREA)
      expect(Math.max(s.width, s.height)).toBeGreaterThanOrEqual(2048)
      // The aspect, to within the one pixel the floor can take.
      expect(Math.abs(s.width / s.height - w / h)).toBeLessThan((w / h) * (1 / Math.min(s.width, s.height)) + 1e-9)
    }
  })
})

describe("the preview's working copy follows the zoom", () => {
  const copyOf = (w: number, h: number, scale: number, aspect: number) => {
    const area = previewArea({ width: w, height: h, scale }, aspect)
    return { area, copy: workingSize(w, h, area) ?? { width: w, height: h } }
  }
  const sheets = [...Object.values(ASPECTS), 4 / 3, 3, 1 / 3]

  it('at 100% it is the 4 MP copy for a camera photo on any sheet it can have; a panorama on a narrow sheet gets what it is drawn at', () => {
    // The fixed sheets, and its own (Original).
    for (const [w, h] of [
      [4032, 3024], [3024, 4032], [5712, 4284], [8064, 6048], [6000, 4000], [5712, 3213], [3213, 5712], [1600, 1200],
    ]) {
      for (const a of [...Object.values(ASPECTS), w / h]) expect(copyOf(w, h, 1, a).area).toBe(PREVIEW_PHOTO_AREA)
    }
    // A 5:1 panorama on 4:5 is drawn 5000x1000 by the preview, more than 4 MP:
    // it is decoded whole (7.2 MP) rather than stretched.
    expect(copyOf(6000, 1200, 1, 4 / 5).copy).toEqual({ width: 6000, height: 1200 })
  })

  it('zoomed in, it grows in tiers so the preview stays one copy pixel or more to a preview pixel', () => {
    // A 12 MP 4:3 photo on 4:5 (an 800x1000 preview): the 4 MP copy is 1:1 at
    // 177%; past it the copy grows, and from 251% it is the whole photo.
    const row = (z: number) => copyOf(4032, 3024, z, 4 / 5).copy
    expect(row(1.77)).toEqual({ width: 2364, height: 1773 })
    expect(row(1.78)).toEqual({ width: 3344, height: 2508 })
    expect(row(2.51)).toEqual({ width: 4032, height: 3024 })
    expect(row(4)).toEqual({ width: 4032, height: 3024 })
    // A 24 MP one stops at the canvas ceiling, MAX_AREA.
    expect(copyOf(5712, 4284, 4, 4 / 5).copy).toEqual({ width: 4729, height: 3547 })
  })

  it('over 3000 random photos, sheets and zooms: 1:1 or better, never past MAX_AREA, never twice what is needed', () => {
    const rand = mulberry32(0xc8)
    for (let i = 0; i < 3000; i++) {
      const w = Math.round(400 + rand() * 11600)
      const h = Math.round(400 + rand() * 11600)
      const a = sheets[Math.floor(rand() * sheets.length)]
      const z = 1 + rand() * 3
      const { area, copy } = copyOf(w, h, z, a)
      const p = previewSize(a)
      const r = coverRect({ width: w, height: h }, p.w, p.h, { scale: z, x: 0.5, y: 0.5 })
      const needed = r.dw * r.dh
      expect(area).toBeLessThanOrEqual(MAX_AREA)
      expect(copy.width * copy.height).toBeLessThanOrEqual(Math.min(MAX_AREA, w * h))
      if (needed <= MAX_AREA) {
        // As many pixels as the preview draws the photo at (or all it has),
        // to the pixel the floor can take.
        expect(copy.width).toBeGreaterThanOrEqual(Math.min(w, r.dw) - 1)
        expect(copy.height).toBeGreaterThanOrEqual(Math.min(h, r.dh) - 1)
      }
      if (area > PREVIEW_PHOTO_AREA) expect(area).toBeLessThan(2 * needed)
    }
  })
})

describe('the preview holds only the photo the document names', () => {
  const bmp = (name: string) => ({ name, close() {} }) as unknown as ImageBitmap
  const held = (id: string | null, failed = false): HeldMedia => ({ id, bitmap: failed || !id ? null : bmp(id), failed })

  it('no photo is none', () => {
    expect(fromHeld(null, null)).toEqual({ bitmap: null, state: 'none' })
    expect(fromHeld(null, held('a'))).toEqual({ bitmap: null, state: 'none' })
  })

  it("after Replace, before the new decode lands, it is loading — never the old photo as ready", () => {
    expect(fromHeld('b', held('a'))).toEqual({ bitmap: null, state: 'loading' })
    expect(mediaState('b', null)).toBe('loading')
  })

  it('a missing or undecodable stored image is failed, with no bitmap', () => {
    expect(fromHeld('a', held('a', true))).toEqual({ bitmap: null, state: 'failed' })
  })

  it('the named photo, decoded, is ready', () => {
    const h = held('a')
    expect(fromHeld('a', h)).toEqual({ bitmap: h.bitmap, state: 'ready' })
  })
})

describe('stored photos outlive Remove and Replace until nothing can reach them', () => {
  const HOUR = 60 * 60 * 1000
  const idAt = (t: number, n = 0) => `media-${t.toString(36)}-${n}`
  const fakeStore = (ids: string[]) => {
    const held = new Set(ids)
    const store: SweepStore = {
      list: async () => [...held],
      remove: async (id) => void held.delete(id),
    }
    return { held, store }
  }

  it('sweeps only what is unreferenced AND older than a day', async () => {
    const old = idAt(NOW - 2 * 24 * HOUR)
    const oldKept = idAt(NOW - 3 * 24 * HOUR, 1)
    const fresh = idAt(NOW - 5 * 60 * 1000, 2)
    const edge = idAt(NOW - SWEEP_AFTER_MS, 3)
    const odd = 'not-an-import-id'
    const { held, store } = fakeStore([old, oldKept, fresh, edge, odd])
    const gone = await sweepMedia(new Set([oldKept]), store, NOW)
    expect(gone.sort()).toEqual([old, odd].sort())
    // Referenced, minutes old (another tab's, or one landing mid-sweep), or
    // exactly a day old: all kept.
    expect([...held].sort()).toEqual([oldKept, fresh, edge].sort())
  })

  it('Remove, then Undo: the photo comes back and its bytes are still there', async () => {
    const photo = makeMedia({ id: idAt(NOW - 3 * 24 * HOUR), width: 4032, height: 3024, native: true })
    const { held, store } = fakeStore([photo.id])
    let h = initHistory({ ...defaultSettings(), media: photo })
    h = historyReducer(h, { type: 'setMedia', media: null })
    expect(h.present.media).toBeNull()
    // Removing is a document edit only: nothing in it deletes stored bytes.
    expect(held.has(photo.id)).toBe(true)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.media?.id).toBe(photo.id)
    // At the next launch the saved document references it: it stays.
    await sweepMedia(new Set([h.present.media!.id]), store, NOW)
    expect(held.has(photo.id)).toBe(true)
  })

  it('a photo removed and not brought back goes at the first launch a day after it was imported', async () => {
    const photo = idAt(NOW - 2 * 24 * HOUR)
    const { held, store } = fakeStore([photo])
    await sweepMedia(new Set(), store, NOW)
    expect(held.has(photo)).toBe(false)
  })
})
