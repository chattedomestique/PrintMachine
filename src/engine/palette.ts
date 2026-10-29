/**
 * The frame's four photo-keyed colours: Border Studio's palette (its
 * `palette.js` at 597ce7a), trimmed to what the fill row shows.
 *
 * The photo's dominant colours by median cut, the most "photogenic" of them
 * as the hero, the population-weighted undertone for a grey hero's hue, and
 * four colours from the hero:
 *  - Photo: the hero itself, its lightness held to 22..78;
 *  - Deep: the hero's hue, half its saturation (14..32), lightness 12;
 *  - Muted: the hero's hue, 0.42 of its saturation (12..36), lightness 66;
 *  - Comp: the hero's hue turned 180 degrees in OKLCH, at a normalised
 *    lightness (0.64) and chroma, so it stands off the photo.
 *
 * Ported line for line where it sets a colour, so fed the same sample it
 * gives Border Studio's hex exactly (palette.test.ts feeds it Border Studio's
 * own recorded sample). What is not ported: Soft (it sits within a few dE of
 * a paper stock), Comp Lt, Comp Dk, Analogous, Split and Triadic (the same
 * idea at other angles), the colour-from-hex re-roll, and the de-duplication
 * of suggestions: the four are always returned, even when two share a hex,
 * because a stored fill choice must always have its colour.
 *
 * Pure: it takes the sample as RGBA bytes (features/media `paletteSample`
 * makes it from the photo) and no DOM.
 */

import type { FramePalette } from './types.ts'

/** A pixel this transparent is not part of the photo's colour: Border
 *  Studio's sampler skips it, so a transparent PNG does not key the frame
 *  from black. */
const OPAQUE_ENOUGH = 125

/** The median cut's depth: up to 2^5 = 32 clusters. Border Studio asks for
 *  `count = 6` and takes ceil(log2(6 x 3)) = 5; every colour then comes from
 *  the one hero, so the count was only ever this depth. */
const DEPTH = 5

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** RGB (0..255, fractional allowed) to HSL: hue in degrees, saturation and
 *  lightness in percent. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h: number
  let s: number
  const l = (max + min) / 2
  if (max === min) {
    h = s = 0
  } else {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      default:
        h = ((r - g) / d + 4) / 6
    }
  }
  return [h * 360, s * 100, l * 100]
}

/** HSL (hue in degrees, any turn; saturation and lightness in percent) to
 *  whole RGB bytes. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  h /= 360
  s /= 100
  l /= 100
  let r: number
  let g: number
  let b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const hue2rgb = (t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    r = hue2rgb(h + 1 / 3)
    g = hue2rgb(h)
    b = hue2rgb(h - 1 / 3)
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

/** RGB to '#rrggbb', each channel rounded and held to 0..255. */
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** HSL to '#rrggbb' (Border Studio's `hslCss`). */
export const hslHex = (h: number, s: number, l: number): string => rgbToHex(...hslToRgb(h, s, l))

/** '#rrggbb' to its three bytes. */
const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** '#rrggbb' to HSL. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex))
  return { h, s, l }
}

// OKLCH: a perceptual space, so a hue turned there keeps the lightness and
// chroma it reads as (an HSL turn does not).
function srgbToLinear(c: number): number {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return clamp(Math.round(v * 255), 0, 255)
}

function rgbToOklch(r: number, g: number, b: number): { L: number; C: number; H: number } {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(a, bb), H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 }
}

function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const bb = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return rgbToHex(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  )
}

type Px = [number, number, number]

/** Median cut to 2^depth boxes: each step splits the box with the largest
 *  single-channel spread (red, green and blue weighted 1, 1.2, 0.8, as luma
 *  separates them) at its median. The clusters' mean colours, most populous
 *  first. */
function medianCut(pixels: Px[], depth: number): { rgb: Px; pop: number }[] {
  const boxes = [pixels]
  const weight = [1.0, 1.2, 0.8]
  while (boxes.length < 1 << depth) {
    let bi = -1
    let bestRange = -1
    let bestCh = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.length < 2) continue
      const mn = [255, 255, 255]
      const mx = [0, 0, 0]
      for (const p of box) {
        for (let c = 0; c < 3; c++) {
          if (p[c] < mn[c]) mn[c] = p[c]
          if (p[c] > mx[c]) mx[c] = p[c]
        }
      }
      for (let c = 0; c < 3; c++) {
        const range = (mx[c] - mn[c]) * weight[c]
        if (range > bestRange) {
          bestRange = range
          bi = i
          bestCh = c
        }
      }
    }
    if (bi === -1) break
    const box = boxes[bi]
    box.sort((a, b) => a[bestCh] - b[bestCh])
    const mid = box.length >> 1
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid))
  }
  return boxes
    .filter((b) => b.length)
    .map((box) => {
      let r = 0
      let g = 0
      let b = 0
      for (const p of box) {
        r += p[0]
        g += p[1]
        b += p[2]
      }
      const n = box.length
      return { rgb: [r / n, g / n, b / n] as Px, pop: n }
    })
    .sort((a, b) => b.pop - a.pop)
}

interface Cluster {
  r: number
  g: number
  b: number
  s: number
  l: number
  pop: number
  frac: number
  hex: string
}

/** How frame-worthy a cluster is: its area (square-rooted, so a large sky
 *  does not always win), its chroma, and how far it is from black or
 *  white. */
function photogenic(c: Cluster): number {
  const area = Math.sqrt(c.frac)
  const chroma = 0.3 + 0.7 * (c.s / 100)
  const midness = 1 - clamp(Math.abs(c.l - 55) / 70, 0, 0.85)
  return area * chroma * midness
}

/**
 * The photo's four frame colours, from its sample: RGBA bytes, a pixel every
 * four (`paletteSample`, about 84 px on the long side), pixels with alpha
 * under 125 skipped. Null when no pixel is opaque enough to say anything.
 */
export function framePalette(rgba: ArrayLike<number>): FramePalette | null {
  const px: Px[] = []
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < OPAQUE_ENOUGH) continue
    px.push([rgba[i], rgba[i + 1], rgba[i + 2]])
  }
  if (!px.length) return null

  const clusters = medianCut(px, DEPTH)
  const total = clusters.reduce((s, c) => s + c.pop, 0) || 1
  const pal: Cluster[] = clusters.map((c) => {
    const [r, g, b] = c.rgb
    const [, s, l] = rgbToHsl(r, g, b)
    return { r, g, b, s, l, pop: c.pop, frac: c.pop / total, hex: rgbToHex(r, g, b) }
  })

  // The undertone: the population-weighted mean colour's hue, which a grey
  // hero takes as its own.
  let ar = 0
  let ag = 0
  let ab = 0
  let w = 0
  for (const c of pal) {
    ar += c.r * c.pop
    ag += c.g * c.pop
    ab += c.b * c.pop
    w += c.pop
  }
  const [undertone] = rgbToHsl(ar / w, ag / w, ab / w)
  const hero = pal.slice().sort((a, b) => photogenic(b) - photogenic(a))[0]

  const { h: heroH0, s: heroS, l: heroL0 } = hexToHsl(hero.hex)
  const heroH = heroS < 6 ? undertone : heroH0
  const heroL = clamp(heroL0, 22, 78)

  // Comp: the hero's OKLCH hue turned half a circle, at lightness 0.64 and a
  // chroma normalised to 0.10..0.16, so a dark or washed-out hero still
  // gives a clean colour.
  const { C, H } = rgbToOklch(...hexToRgb(hero.hex))
  const chroma = clamp(C * 0.9 + 0.03, 0.1, 0.16)

  return {
    photo: hslHex(heroH, heroS, heroL),
    deep: hslHex(heroH, clamp(heroS * 0.5, 14, 32), 12),
    muted: hslHex(heroH, clamp(heroS * 0.42, 12, 36), 66),
    comp: oklchToHex(0.64, chroma, H + 180),
  }
}
