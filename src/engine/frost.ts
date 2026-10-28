/**
 * Frosted: a border made of the photo itself, blurred and graded (Border
 * Studio's `drawFrostedBg` at 597ce7a), with Blur its one setting.
 *
 * The photo is cover-filled into a small FIELD of the sheet's shape, blurred
 * by three box passes whose windows shrink at the edges (Border Studio's
 * `boxBlurPass`), then graded at Border Studio's shipped values (brightness
 * x 0.85, then saturation x 1.6 about Rec. 709 luma). The sheet's border is
 * sampled from the field, bilinearly, a pixel at a time, with Border Studio's
 * 2% overscan.
 *
 * Where it differs from Border Studio, it is so the preview and the save are
 * the same bytes:
 *  - the field's size comes from the sheet's numeric shape and a fixed long
 *    side (480 settled and saved, 160 while a control is dragged), never from
 *    a rendered size: a rendered size rounds differently at every size;
 *  - it is made by an area average in JavaScript, not a canvas's drawImage,
 *    and kept in float, with no rounding to bytes between the passes; the
 *    one rounding is at the sample, so a smooth sky has no stair that
 *    rounding the field first would leave (each field texel spans many sheet
 *    pixels);
 *  - the blur's radius scales with the field (Border Studio's own rule when
 *    it rendered larger): 2x at 480, 2/3 at the draft's 160.
 *
 * Pure: no DOM. The field is made once per photo, sheet shape and blur by
 * the page (features/media) and handed in (frame.ts `FrameInputs`).
 */

import { boxBlurPlane } from './blur.ts'
import type { RowSampler } from './frame.ts'
import { FROST_GRADE } from './limits.ts'
import { areaAverage, type RgbaImage } from './resample.ts'

/** The field: the photo blurred and graded, R, G and B planes of w x h
 *  floats (0..255), for one sheet shape and one blur. */
export interface FrostField {
  w: number
  h: number
  r: Float32Array
  g: Float32Array
  b: Float32Array
  /** The sheet's width over its height it was made for (frame.ts
   *  `sheetAspect`). */
  aspect: number
  /** The blur it was made at (10..240). */
  blur: number
  /** The photo has no opaque pixel: no colour to frost, so the border is
   *  Paper, as its colour fills are. */
  clear: boolean
}

/** The photo cover-filled into a field, before the blur: what a Blur change
 *  does not change, so it is kept and only the passes and the grade run
 *  again. R, G and B as floats 0..255; for a photo with transparent pixels
 *  multiplied by `a` (the alpha, 0..1), so a transparent pixel adds no
 *  colour to its neighbours as the passes spread it. */
export interface FrostCover {
  w: number
  h: number
  r: Float32Array
  g: Float32Array
  b: Float32Array
  /** The alpha plane, or null when every pixel of the photo is opaque. */
  a: Float32Array | null
  /** The photo's mean colour (alpha-weighted), what a transparent area no
   *  opaque pixel reaches takes. */
  mean: [number, number, number]
  /** Nothing under the field is opaque. */
  clear: boolean
  aspect: number
}

/** Border Studio's field: 240 px on its long side, at its preview scale. */
const BORDER_STUDIO_FIELD = 240

/** The field's size: `fieldLong` on the long side of the sheet's shape, the
 *  other side rounded (at least 4, as Border Studio's). */
export function frostFieldSize(aspect: number, fieldLong: number): { w: number; h: number } {
  return aspect >= 1
    ? { w: fieldLong, h: Math.max(4, Math.round(fieldLong / aspect)) }
    : { w: Math.max(4, Math.round(fieldLong * aspect)), h: fieldLong }
}

/** The box radius, in field pixels, of a blur (10..240) on a field of this
 *  long side: Border Studio's 3..21.8 on its 240 px field, scaled with the
 *  field, at least 2. */
export const frostRadius = (blur: number, fieldLong: number): number =>
  Math.max(2, Math.round((3 + ((blur - 10) * 9) / 110) * (fieldLong / BORDER_STUDIO_FIELD)))

/**
 * The photo `src` (the frame's source: the photo at its fixed decode)
 * cover-filled into the field of a sheet of `aspect`, `fieldLong` on its
 * long side: centred, area-averaged. A photo with transparent pixels is kept
 * multiplied by its alpha (see `FrostCover`).
 */
export function frostCover(src: RgbaImage, aspect: number, fieldLong: number): FrostCover {
  const { w, h } = frostFieldSize(aspect, fieldLong)
  const cover = Math.max(w / src.w, h / src.h)
  const bw = w / cover
  const bh = h / cover
  const avg = areaAverage(src, { x: (src.w - bw) / 2, y: (src.h - bh) / 2, w: bw, h: bh }, w, h)
  const n = w * h
  const r = new Float32Array(n)
  const g = new Float32Array(n)
  const b = new Float32Array(n)
  let opaque = true
  for (let i = 3; i < src.rgba.length && opaque; i += 4) opaque = src.rgba[i] === 255
  if (opaque) {
    for (let i = 0; i < n; i++) {
      r[i] = avg[i * 4]
      g[i] = avg[i * 4 + 1]
      b[i] = avg[i * 4 + 2]
    }
    return { w, h, r, g, b, a: null, mean: [0, 0, 0], clear: false, aspect }
  }
  const a = new Float32Array(n)
  let sr = 0
  let sg = 0
  let sb = 0
  let sa = 0
  for (let i = 0; i < n; i++) {
    const al = avg[i * 4 + 3] / 255
    a[i] = al
    r[i] = avg[i * 4] * al
    g[i] = avg[i * 4 + 1] * al
    b[i] = avg[i * 4 + 2] * al
    sr += r[i]
    sg += g[i]
    sb += b[i]
    sa += al
  }
  return { w, h, r, g, b, a, mean: sa > 0 ? [sr / sa, sg / sa, sb / sa] : [0, 0, 0], clear: sa === 0, aspect }
}

/** How much of the photo's mean colour a blurred alpha is mixed with: where
 *  the photo reaches (alpha well above this) its own colour, untouched to
 *  within 0.03 of a level; where no opaque pixel reaches (alpha 0), the
 *  mean; smoothly between. */
const MEAN_WEIGHT = 1e-4

/**
 * The field of a kept cover at `blur`: blurred (three box passes, windows
 * shrunk at the edges), a transparent area taking the colour of the photo
 * round it (divided by the blurred alpha), then graded (brightness, then
 * saturation about luma), held to 0..255. Float throughout: nothing is
 * rounded here. The cover is not changed.
 */
export function frostBlur(cover: FrostCover, blur: number): FrostField {
  const { w, h, aspect } = cover
  const fieldLong = Math.max(w, h)
  const r = cover.r.slice()
  const g = cover.g.slice()
  const b = cover.b.slice()
  const n = w * h
  const radius = frostRadius(blur, fieldLong)
  const scratch = new Float32Array(n)
  for (const plane of [r, g, b]) boxBlurPlane(plane, scratch, w, h, radius, 'shrink')
  if (cover.a) {
    const a = cover.a.slice()
    boxBlurPlane(a, scratch, w, h, radius, 'shrink')
    const [mr, mg, mb] = cover.mean
    for (let i = 0; i < n; i++) {
      const al = Math.max(0, a[i]) + MEAN_WEIGHT
      r[i] = (r[i] + mr * MEAN_WEIGHT) / al
      g[i] = (g[i] + mg * MEAN_WEIGHT) / al
      b[i] = (b[i] + mb * MEAN_WEIGHT) / al
    }
  }
  const bright = 1 + FROST_GRADE.brightness / 100
  const sat = Math.max(0, 1 + FROST_GRADE.saturation / 100)
  for (let i = 0; i < n; i++) {
    const rv = r[i] * bright
    const gv = g[i] * bright
    const bv = b[i] * bright
    const luma = 0.2126 * rv + 0.7152 * gv + 0.0722 * bv
    r[i] = Math.min(255, Math.max(0, luma + (rv - luma) * sat))
    g[i] = Math.min(255, Math.max(0, luma + (gv - luma) * sat))
    b[i] = Math.min(255, Math.max(0, luma + (bv - luma) * sat))
  }
  return { w, h, r, g, b, aspect, blur, clear: cover.clear }
}

/**
 * The field of `src` for a sheet of `aspect`, `fieldLong` on its long side,
 * at `blur`: `frostBlur` of `frostCover`.
 */
export const frostField = (src: RgbaImage, aspect: number, fieldLong: number, blur: number): FrostField => frostBlur(frostCover(src, aspect, fieldLong), blur)

/** Where a sheet pixel's centre falls on the field along one axis: the
 *  field stretched over the sheet and 2% of its long side past each edge
 *  (Border Studio's overscan), a texel's centre at i + 0.5, held inside. */
function axis(sheet: number, pad: number, field: number): { i0: Int32Array; i1: Int32Array; t: Float64Array } {
  const i0 = new Int32Array(sheet)
  const i1 = new Int32Array(sheet)
  const t = new Float64Array(sheet)
  for (let x = 0; x < sheet; x++) {
    const f = Math.min(field - 1, Math.max(0, ((x + 0.5 + pad) / (sheet + 2 * pad)) * field - 0.5))
    i0[x] = Math.floor(f)
    i1[x] = Math.min(field - 1, i0[x] + 1)
    t[x] = f - i0[x]
  }
  return { i0, i1, t }
}

/**
 * The field as a w x h sheet's fill: each pixel the field sampled
 * bilinearly at its centre, in float, rounded to a byte once (as the byte
 * store rounds), opaque. A pure function of the pixel's position, so a sheet
 * sampled in bands of any height is the same bytes as sampled whole.
 *
 * A row is sampled down the field first (its two field rows mixed, for the
 * field columns the row reaches, once a row however many runs of it are
 * asked for), then across: the border's runs of a row and its corners'
 * single pixels share that work.
 */
export function frostSampler(field: FrostField, w: number, h: number): RowSampler {
  const rows = new FrostRows(field, w, h)
  return (y, x0, x1, out, o) => rows.sample(y, x0, x1, out, o)
}

/** The sampler's state: where each sheet column and row falls on the field,
 *  and the field row mixed down for the row in hand. One class, so every
 *  sheet's sampler runs the same compiled code. */
class FrostRows {
  private readonly c0: Int32Array
  private readonly c1: Int32Array
  private readonly ct: Float64Array
  private readonly r0: Int32Array
  private readonly r1: Int32Array
  private readonly rt: Float64Array
  private readonly mr: Float64Array
  private readonly mg: Float64Array
  private readonly mb: Float64Array
  // The field columns mixed down for row (mark - 1).
  private readonly mixed: Int32Array

  constructor(
    private readonly field: FrostField,
    w: number,
    h: number,
  ) {
    const pad = Math.round(0.02 * Math.max(w, h))
    const cols = axis(w, pad, field.w)
    const rows = axis(h, pad, field.h)
    this.c0 = cols.i0
    this.c1 = cols.i1
    this.ct = cols.t
    this.r0 = rows.i0
    this.r1 = rows.i1
    this.rt = rows.t
    this.mr = new Float64Array(field.w)
    this.mg = new Float64Array(field.w)
    this.mb = new Float64Array(field.w)
    this.mixed = new Int32Array(field.w)
  }

  sample(y: number, x0: number, x1: number, out: Uint8ClampedArray, o: number): void {
    if (x1 <= x0) return
    const { c0, c1, ct, mr, mg, mb, mixed } = this
    const { r, g, b, w: fw } = this.field
    const top = this.r0[y] * fw
    const bottom = this.r1[y] * fw
    const s = this.rt[y]
    const mark = y + 1
    for (let i = c0[x0], end = c1[x1 - 1]; i <= end; i++) {
      if (mixed[i] === mark) continue
      mixed[i] = mark
      mr[i] = r[top + i] + (r[bottom + i] - r[top + i]) * s
      mg[i] = g[top + i] + (g[bottom + i] - g[top + i]) * s
      mb[i] = b[top + i] + (b[bottom + i] - b[top + i]) * s
    }
    for (let x = x0, p = o; x < x1; x++, p += 4) {
      const a = c0[x]
      const c = c1[x]
      const t = ct[x]
      out[p] = mr[a] + (mr[c] - mr[a]) * t
      out[p + 1] = mg[a] + (mg[c] - mg[a]) * t
      out[p + 2] = mb[a] + (mb[c] - mb[a]) * t
      out[p + 3] = 255
    }
  }
}
