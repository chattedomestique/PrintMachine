/**
 * Palette samples that look like photographs, not flat blocks: what the
 * median cut, the hero's score and the undertone have to work on in a real
 * photo (a sky's gradient, noise, a few subjects, a grey scene with a cast,
 * a dark one), at the palette's sample size (84 x 56 and 56 x 84).
 *
 * `__fixtures__/palettes-597ce7a.json` holds Border Studio's own four
 * colours for each (its palette.js at 597ce7a, run on these very arrays), so
 * palette.test.ts holds the port to them. Same seed, same bytes, every run:
 * a seeded generator and plain arithmetic, so the fixture's generator and the
 * test's are this one file.
 */

import { mulberry32 } from '../rng.ts'

export interface PaletteSample {
  name: string
  /** RGBA bytes, a pixel every four. */
  rgba: Uint8ClampedArray
}

const KINDS = ['sky', 'subjects', 'noise', 'grey-cast', 'dark', 'pastel'] as const

/** `count` samples per kind, seeded by their index. */
export function paletteSamples(count = 6): PaletteSample[] {
  const out: PaletteSample[] = []
  for (const kind of KINDS) {
    for (let i = 0; i < count; i++) {
      const seed = 1000 * (KINDS.indexOf(kind) + 1) + i
      const portrait = i % 2 === 1
      out.push({ name: `${kind}-${i}`, rgba: sample(kind, seed, portrait ? 56 : 84, portrait ? 84 : 56) })
    }
  }
  return out
}

function sample(kind: (typeof KINDS)[number], seed: number, w: number, h: number): Uint8ClampedArray {
  const rng = mulberry32(seed)
  const colour = (lo = 0, hi = 256) => [0, 1, 2].map(() => lo + Math.floor(rng() * (hi - lo)))
  const top = colour()
  const bottom = colour()
  const cast = colour(-12, 13)
  const grain = 4 + rng() * 20
  // A few subjects: discs of their own colour.
  const discs = Array.from({ length: 2 + Math.floor(rng() * 4) }, () => ({ x: rng() * w, y: rng() * h, r: 4 + rng() * 18, c: colour() }))
  const alphaHole = kind === 'subjects' && seed % 3 === 0
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / (h - 1)
      let c: number[]
      switch (kind) {
        case 'sky':
          c = top.map((v, k) => v + (bottom[k] - v) * t)
          break
        case 'subjects': {
          c = top.map((v, k) => v + (bottom[k] - v) * (x / (w - 1)))
          for (const d of discs) if ((x - d.x) ** 2 + (y - d.y) ** 2 < d.r * d.r) c = d.c
          break
        }
        case 'noise':
          c = colour()
          break
        case 'grey-cast': {
          const g = 60 + 140 * t
          c = cast.map((v) => g + v)
          break
        }
        case 'dark':
          c = top.map((v, k) => (v + (bottom[k] - v) * t) * 0.18)
          break
        case 'pastel':
          c = top.map((v, k) => 170 + (v + (bottom[k] - v) * t) / 3)
          break
      }
      const o = (y * w + x) * 4
      for (let k = 0; k < 3; k++) px[o + k] = c[k] + (rng() - 0.5) * grain
      // A transparent corner on some: what a PNG's clear pixels read as.
      px[o + 3] = alphaHole && x < w / 4 && y < h / 4 ? Math.floor(rng() * 124) : 255
    }
  }
  return px
}
