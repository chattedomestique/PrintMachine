/**
 * What the frame's fill is made from: the frame source (one fixed decode of
 * the photo), the palette's sample of it, and the inputs Save waits for.
 * The platform (the stored blob, the decode, the read-back) is handed in, so
 * the rules are tested in node.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MissingPhotoError } from '../../engine/export.ts'
import { framePalette } from '../../engine/palette.ts'
import { areaAverage, type RgbaImage } from '../../engine/resample.ts'
import type { FramePalette, PrintSettings } from '../../engine/types.ts'
import { defaultSettings, makeMedia } from '../../state/defaults.ts'
import { FrameSourceError, frameSourceSize, frameSources, paletteSample, type FrameSourceDeps } from './frameSource.ts'
import { ensureFrameInputs, fillShows, framePalettes, needsPalette, storedFrameInputs } from './frameInputs.ts'
// @ts-expect-error: a plain .mjs module, the generator the parity gate uses
import { PHOTOS, blockPhoto } from '../../../scripts/parity-borders/photos.mjs'

const refs = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../scripts/parity-borders/refs.json'), 'utf8')) as {
  photos: { id: string; hex: FramePalette }[]
}

/** A decode that is what the deps were asked for: `got` decides its size. */
function fakeDeps(got: (size?: { width: number; height: number }) => { width: number; height: number } | Error, blob: Blob | null = new Blob([new Uint8Array(4)])) {
  const log = { decodes: [] as string[], reads: [] as string[], closed: 0 }
  const deps: FrameSourceDeps = {
    getBlob: async () => blob,
    decode: async (_b, size) => {
      log.decodes.push(size ? `${size.width}x${size.height}` : 'whole')
      const r = got(size)
      if (r instanceof Error) throw r
      return { ...r, close: () => log.closed++ }
    },
    read: (bmp, w, h) => {
      log.reads.push(`${bmp.width}x${bmp.height} into ${w}x${h}`)
      return new Uint8ClampedArray(w * h * 4).fill(200)
    },
  }
  return { deps, log }
}

const photo = (width: number, height: number, id = 'p') => ({ id, width, height })

describe('the frame source: one decode, at a fixed size', () => {
  it('is the photo at 1024 on its long side, or as it is when smaller', () => {
    expect(frameSourceSize(7728, 5152)).toEqual({ width: 1024, height: 683 })
    expect(frameSourceSize(5152, 7728)).toEqual({ width: 683, height: 1024 })
    expect(frameSourceSize(12000, 2000)).toEqual({ width: 1024, height: 171 })
    expect(frameSourceSize(900, 600)).toEqual({ width: 900, height: 600 })
    expect(frameSourceSize(1024, 1024)).toEqual({ width: 1024, height: 1024 })
  })

  it('decodes the stored photo resized to that size, and reads back that size', async () => {
    const { deps, log } = fakeDeps((size) => size ?? { width: 7728, height: 5152 })
    const src = await frameSources(deps).load(photo(7728, 5152))
    expect([src.w, src.h, src.rgba.length]).toEqual([1024, 683, 1024 * 683 * 4])
    expect(log).toEqual({ decodes: ['1024x683'], reads: ['1024x683 into 1024x683'], closed: 1 })
  })

  it('an engine that ignores the resize hands back the photo whole: drawn into the source size, never read back whole', async () => {
    const { deps, log } = fakeDeps(() => ({ width: 7728, height: 5152 }))
    const src = await frameSources(deps).load(photo(7728, 5152))
    expect([src.w, src.h]).toEqual([1024, 683])
    expect(log.reads).toEqual(['7728x5152 into 1024x683'])
    expect(log.closed).toBe(1)
  })

  it('a decode squashed (resized before it was turned upright) is decoded again whole, the right way up', async () => {
    const { deps, log } = fakeDeps((size) => (size ? { width: 1024, height: 683 } : { width: 5152, height: 7728 }))
    const src = await frameSources(deps).load(photo(5152, 7728))
    expect([src.w, src.h]).toEqual([683, 1024])
    expect(log.decodes).toEqual(['683x1024', 'whole'])
    expect(log.reads).toEqual(['5152x7728 into 683x1024'])
    expect(log.closed).toBe(2)
  })

  it('a decode of the wrong shape twice, or one that throws, is a FrameSourceError; a missing photo is a MissingPhotoError', async () => {
    const wrong = fakeDeps(() => ({ width: 100, height: 100 }))
    await expect(frameSources(wrong.deps).load(photo(300, 200))).rejects.toBeInstanceOf(FrameSourceError)
    expect(wrong.log.closed).toBe(2)
    const throws = fakeDeps(() => new Error('Cannot create an image buffer'))
    await expect(frameSources(throws.deps).load(photo(300, 200))).rejects.toThrow(/Cannot create an image buffer/)
    const gone = fakeDeps((s) => s ?? { width: 300, height: 200 }, null)
    await expect(frameSources(gone.deps).load(photo(300, 200))).rejects.toBeInstanceOf(MissingPhotoError)
  })

  it('one photo at a time: asked again, the same source (and the same failure) without another decode', async () => {
    const { deps, log } = fakeDeps((size) => size ?? { width: 300, height: 200 })
    const sources = frameSources(deps)
    const a = await sources.load(photo(300, 200, 'a'))
    expect(await sources.load(photo(300, 200, 'a'))).toBe(a)
    expect(log.decodes.length).toBe(1)
    await sources.load(photo(300, 200, 'b'))
    expect(log.decodes.length).toBe(2)
    let n = 0
    const failing = frameSources(fakeDeps(() => (n++, new Error('no'))).deps)
    await expect(failing.load(photo(300, 200))).rejects.toThrow()
    await expect(failing.load(photo(300, 200))).rejects.toThrow()
    expect(n).toBe(1)
  })
})

describe("the palette's sample", () => {
  const block = (id: string) => {
    const gen = PHOTOS.find((p: { id: string }) => p.id === id)
    const { px } = blockPhoto(gen.width, gen.height, gen.blocks)
    return { w: gen.width, h: gen.height, rgba: px } as RgbaImage
  }
  /** The source as the decoder would make it, an area average standing in
   *  for the decoder's own resize. */
  const sourceOf = (img: RgbaImage): RgbaImage => {
    const { width, height } = frameSourceSize(img.w, img.h)
    return { w: width, h: height, rgba: Uint8ClampedArray.from(areaAverage(img, { x: 0, y: 0, w: img.w, h: img.h }, width, height)) }
  }

  it('is 84 px on its long side, the photo whole, the same bytes every time', () => {
    const src = sourceOf(block('block-land'))
    const a = paletteSample(src)
    expect(a.length).toBe(84 * 56 * 4)
    expect(paletteSample(src)).toEqual(a)
    const port = paletteSample(sourceOf(block('block-port')))
    expect(port.length).toBe(56 * 84 * 4)
  })

  it("on Border Studio's block photos keys Border Studio's four colours (pinned: the samplers differ, flat blocks hardly show it)", () => {
    // Border Studio sampled its canvas's own downscale; this one is an area
    // average of the 1024 px source. Measured: the same hex on both photos,
    // every channel (largest difference 0).
    for (const p of refs.photos) {
      const ours = framePalette(paletteSample(sourceOf(block(p.id))))!
      let worst = 0
      for (const k of ['photo', 'deep', 'muted', 'comp'] as const) {
        for (const i of [1, 3, 5]) worst = Math.max(worst, Math.abs(parseInt(ours[k].slice(i, i + 2), 16) - parseInt(p.hex[k].slice(i, i + 2), 16)))
      }
      expect(worst, p.id).toBeLessThanOrEqual(0)
    }
  })

  it('a transparent part of the photo does not key the frame', () => {
    // Left half clear (black at alpha 0, as a PNG reads back), right half red.
    const img = { w: 200, h: 100, rgba: new Uint8ClampedArray(200 * 100 * 4) }
    for (let y = 0; y < 100; y++) for (let x = 100; x < 200; x++) img.rgba.set([210, 70, 60, 255], (y * 200 + x) * 4)
    const red = { w: 100, h: 100, rgba: new Uint8ClampedArray(100 * 100 * 4) }
    for (let i = 0; i < 100 * 100; i++) red.rgba.set([210, 70, 60, 255], i * 4)
    expect(framePalette(paletteSample(img))).toEqual(framePalette(paletteSample(red)))
  })
})

describe('the inputs a press needs', () => {
  const PALETTE: FramePalette = { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' }
  const doc = (frame: Partial<PrintSettings['frame']>, palette?: FramePalette): PrintSettings => {
    const s = defaultSettings()
    return { ...s, aspect: '4:5', media: makeMedia({ id: 'p', width: 3000, height: 2000, ...(palette ? { palette } : {}) }), frame: { ...s.frame, ...frame } }
  }
  /** Palettes that count what they were asked for. */
  const counting = (palette: FramePalette | null | Error) => {
    const asked: string[] = []
    return {
      asked,
      palettes: {
        palette: async (m: { id: string }) => {
          asked.push(m.id)
          if (palette instanceof Error) throw palette
          return palette
        },
      },
    }
  }

  it('the fill shows with a photo and a border, round corners or Fit; not unframed, not without a photo', () => {
    expect(fillShows(doc({ width: 0, corners: 0, mode: 'crop' }))).toBe(false)
    expect(fillShows(doc({ width: 0.05 }))).toBe(true)
    expect(fillShows(doc({ width: 0, corners: 0.5 }))).toBe(true)
    expect(fillShows(doc({ width: 0, mode: 'fit' }))).toBe(true)
    // Fit is ignored on Original (it is always Crop there).
    expect(fillShows({ ...doc({ width: 0, mode: 'fit' }), aspect: 'original' })).toBe(false)
    expect(fillShows({ ...doc({ width: 0.05 }), media: null })).toBe(false)
  })

  it('a palette is needed for Photo, Deep, Muted and Comp where the fill shows and none is stored; never for Paper', () => {
    for (const fill of ['photo', 'deep', 'muted', 'comp'] as const) {
      expect(needsPalette(doc({ width: 0.05, fill }))).toBe(true)
      expect(needsPalette(doc({ width: 0.05, fill }, PALETTE))).toBe(false)
      expect(needsPalette(doc({ width: 0, fill }))).toBe(false)
    }
    expect(needsPalette(doc({ width: 0.05, fill: 'paper' }))).toBe(false)
  })

  it('Save takes the stored palette as it is, and makes one only when it is missing', async () => {
    const c = counting(PALETTE)
    expect(await ensureFrameInputs(doc({ width: 0.05 }, PALETTE), c.palettes)).toEqual({ palette: PALETTE })
    expect(await ensureFrameInputs(doc({ width: 0.05, fill: 'paper' }), c.palettes)).toEqual({})
    expect(await ensureFrameInputs(doc({ width: 0 }), c.palettes)).toEqual({})
    expect(c.asked).toEqual([])
    expect(await ensureFrameInputs(doc({ width: 0.05, fill: 'muted' }), c.palettes)).toEqual({ palette: PALETTE })
    expect(c.asked).toEqual(['p'])
  })

  it('a photo with no colour (nothing opaque) presses its colour fills as Paper; one that cannot be read rejects', async () => {
    expect(await ensureFrameInputs(doc({ width: 0.05 }), counting(null).palettes)).toEqual({})
    await expect(ensureFrameInputs(doc({ width: 0.05 }), counting(new FrameSourceError('no')).palettes)).rejects.toBeInstanceOf(FrameSourceError)
  })

  it('the palettes are made once a photo, from its source', async () => {
    const { deps, log } = fakeDeps((size) => size ?? { width: 300, height: 200 })
    const palettes = framePalettes(frameSources(deps))
    const a = await palettes.palette(photo(300, 200, 'a'))
    expect(a).toEqual(framePalette(new Uint8ClampedArray(84 * 56 * 4).fill(200)))
    expect(await palettes.palette(photo(300, 200, 'a'))).toBe(a)
    expect(log.decodes.length).toBe(1)
  })

  it('what a document holds: its stored palette, or nothing', () => {
    expect(storedFrameInputs(doc({}, PALETTE))).toEqual({ palette: PALETTE })
    expect(storedFrameInputs(doc({}))).toEqual({})
    expect(storedFrameInputs({ media: null })).toEqual({})
  })
})
