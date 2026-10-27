/**
 * The photo layer — the ground the ink prints on.
 *
 * A photo behind the type is not a sprite drawn on the canvas. It replaces the
 * *paper*: the base colour every transparent ink multiplies down from. That
 * falls out of the compositor already reading paper as `rgb × shade`, and it is
 * why type genuinely overprints a photo rather than sitting on it.
 *
 * Nothing here touches the DOM. The caller blits the pixels — `drawImage` is
 * far faster than sampling four million pixels in JS — but the *rectangle it
 * blits into* is computed here, because that is the part that has to be right
 * and the part worth testing.
 */

import { blurInPlace, needsSpare } from './blur.ts'

export interface MediaSize {
  width: number
  height: number
}

export interface MediaPlacement {
  /** Zoom on the cover fit, at least 1: 1 exactly fills the sheet. */
  scale: number
  /** Centre of the media, in sheet fractions. 0.5, 0.5 is the middle. */
  x: number
  y: number
}

export interface DrawRect {
  dx: number
  dy: number
  dw: number
  dh: number
}

/** A rectangle of the sheet, in sheet pixels, from (x0, y0), w x h: the part
 *  of the sheet the photo is placed on (frame.ts `layoutSheet`). */
export interface Area {
  x0: number
  y0: number
  w: number
  h: number
}

/** Where the photo's centre may sit, in sheet fractions, and still cover. */
export interface PanBounds {
  xLo: number
  xHi: number
  yLo: number
  yHi: number
}

/** The drawn size at a zoom: the cover fit, the same factor on both axes. */
function coverSize(media: MediaSize, sheetW: number, sheetH: number, scale: number) {
  const mw = Math.max(1, media.width)
  const mh = Math.max(1, media.height)
  // Never below the cover fit. Zooming out below it has no sane native export
  // size and leaves bare sheet, so the placement cannot ask for it.
  const s = Math.max(sheetW / mw, sheetH / mh) * Math.max(1, scale)
  return { dw: mw * s, dh: mh * s }
}

/**
 * How far the photo can travel and still cover the sheet.
 *
 * A covering photo is at least as large as the sheet on both axes, so its
 * centre may move until one of its edges reaches the trim: `[1 - d/2, d/2]`
 * per axis, with `d` the drawn size over the sheet's. On an axis where the
 * photo exactly fits, the range closes to the middle and there is no travel.
 */
export function panBounds(
  media: MediaSize & { scale: number },
  sheetW: number,
  sheetH: number,
): PanBounds {
  const { dw, dh } = coverSize(media, sheetW, sheetH, media.scale)
  // max() guards the float case where an exact fit computes a hair under half.
  const hx = Math.max(0.5, dw / (2 * sheetW))
  const hy = Math.max(0.5, dh / (2 * sheetH))
  return { xLo: 1 - hx, xHi: hx, yLo: 1 - hy, yHi: hy }
}

const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * The placement with its zoom at least 1 and its centre inside the pan
 * bounds, so the photo covers the sheet. Everything else is returned as given.
 */
export function clampPan<T extends MediaSize & MediaPlacement>(media: T, sheetW: number, sheetH: number): T {
  const scale = Math.max(1, media.scale)
  const b = panBounds({ ...media, scale }, sheetW, sheetH)
  return { ...media, scale, x: clampTo(media.x, b.xLo, b.xHi), y: clampTo(media.y, b.yLo, b.yHi) }
}

/**
 * The photo's position as a fraction of the travel it has: 0 shows its left
 * (or top) edge, 1 its right (or bottom) edge. 0.5 when it cannot travel.
 */
export function panFraction(
  media: MediaSize & MediaPlacement,
  sheetW: number,
  sheetH: number,
  axis: 'x' | 'y',
): number {
  const b = panBounds(media, sheetW, sheetH)
  const [lo, hi] = axis === 'x' ? [b.xLo, b.xHi] : [b.yLo, b.yHi]
  if (hi - lo <= 1e-9) return 0.5
  // The centre sits at `hi` when the photo's left edge is on the trim.
  return clampTo((hi - media[axis]) / (hi - lo), 0, 1)
}

/** The centre, in sheet fractions, for a fraction of the travel. */
export function fromPanFraction(
  media: MediaSize & { scale: number },
  sheetW: number,
  sheetH: number,
  axis: 'x' | 'y',
  fraction: number,
): number {
  const b = panBounds(media, sheetW, sheetH)
  const [lo, hi] = axis === 'x' ? [b.xLo, b.xHi] : [b.yLo, b.yHi]
  return hi - clampTo(fraction, 0, 1) * (hi - lo)
}

/**
 * Where to draw the media so it covers the sheet without ever distorting.
 *
 * The scale factor is the *same on both axes* — that single fact is what keeps
 * a photo from being squashed, and it is asserted directly in the tests rather
 * than inferred from how the output looks. `max` of the two ratios gives cover
 * (fills the sheet, crops the overflow); `min` would give contain and leave
 * bars, which is not what a full-bleed print wants.
 *
 * Cover is enforced HERE, where the sheet is drawn, not only where the photo
 * is edited: the placement is clamped to `panBounds` (and the zoom to at least
 * 1) before the rectangle is computed. A pan that was legal on one sheet shape
 * can uncover another — pan a landscape photo to the side on a square sheet,
 * switch to 4:5, and without this a strip of bare sheet prints. No stored
 * placement can produce that, in the preview or in the export.
 */
export function coverRect(
  media: MediaSize,
  sheetW: number,
  sheetH: number,
  place: MediaPlacement,
): DrawRect {
  const p = clampPan({ ...media, ...place }, sheetW, sheetH)
  const { dw, dh } = coverSize(media, sheetW, sheetH, p.scale)
  return {
    dx: p.x * sheetW - dw / 2,
    dy: p.y * sheetH - dh / 2,
    dw,
    dh,
  }
}

/**
 * A photo a build before full-resolution imports saved: those cut every import
 * to a 2048 px long edge and re-encoded it, and that copy is all the store
 * has. It cannot be recovered, only chosen again. The exact legacy signature:
 * no `native` flag (every import since sets it) and a long edge of exactly
 * 2048.
 */
export function isReducedCopy(media: { width: number; height: number; native?: boolean }): boolean {
  return media.native !== true && Math.max(media.width, media.height) === 2048
}

/**
 * How near 1:1 a blit must be to be drawn at the photo's own pixels: within
 * this many pixels over the sheet's shorter side.
 *
 * It has to cover every height the export planner calls native
 * (exportPlan.ts): the smallest height at which the photo lands at least 1:1,
 * so over it by at most a row on the binding side, plus the width's rounding.
 * Over the sheet's short side (sheet a = w/h, height H) that is under:
 *  - 1.5 x (1 + 1/H) for every sheet the app makes: a fixed sheet (a <= 1),
 *    or an Original one, whose two sides bind together (1 + 0.5/a at or over
 *    1:1, a + 0.5 under it; the worst is an Original sheet of about 1:1);
 *  - (floor(a) + 1) / a x (1 + 2/H), just over 2 at most, for a sheet wider
 *    than 1:1 whose WIDTH binds — a photo narrower than a landscape sheet,
 *    which only a fixed landscape sheet could make (there is none).
 * A tolerance of 1.5 over the sheet's HEIGHT missed every tall sheet whose
 * width binds: a 2268x4032 photo on its own sheet at 113% was planned native
 * and resampled by 1.0005, losing a third of its finest detail. 2.5 holds
 * both bounds with room.
 *
 * The tolerance is not the whole story on a fixed landscape sheet. At exactly
 * 100% there, the native width can come out a pixel or two WIDER than the
 * photo (the width steps by up to ceil(a) px a row), so the photo at its own
 * size would not cover the sheet and the snap keeps the cover fit: a resample
 * under a `native` label. So the claim is for the sheets the app makes (the
 * fixed ones, none wider than 1:1, and Original, which binds on both sides),
 * at every zoom, and for any aspect only above 100%; a fixed landscape sheet
 * would need the planner to fit its width to the photo's. exportPlan.test.ts
 * checks each of those sweeps, and pins the landscape case.
 *
 * Snapping a little early costs nothing visible: a snap only ever draws the
 * photo at its own size, still covering the sheet, and the crop moves by
 * (scale - 1) x the photo's size — a few pixels at most.
 */
export const SNAP_PX = 2.5

/**
 * The blit, made pixel-exact when the sheet holds the photo at its own pixels.
 *
 * At the native export height the cover fit lands within a hair of 1:1, but
 * the centred placement puts the photo half a pixel off the grid, and a
 * bilinear blit at a half-pixel offset blurs every pixel into its neighbour
 * (measured: Laplacian energy 0.753 of the original at native height; 1.000
 * snapped). So when the scale is within SNAP_PX of 1 over the sheet's SHORTER
 * side, draw the photo at exactly its own size, at a whole-pixel offset, kept
 * inside the travel that still covers the sheet — zoomed or not, since a
 * zoomed photo lands 1:1 at its own (smaller) native height. Anything that is
 * not 1:1 — the preview of a large photo, a zoom at another height — or a
 * photo smaller than the sheet is returned untouched.
 */
export function snapRect(r: DrawRect, mw: number, mh: number, sheetW: number, sheetH: number): DrawRect {
  if (Math.abs(r.dw / mw - 1) >= SNAP_PX / Math.min(sheetW, sheetH)) return r
  // Snapped to its own size the photo would not cover the sheet: leave it.
  if (mw < sheetW || mh < sheetH) return r
  return {
    dx: clampTo(Math.round(r.dx), sheetW - mw, 0),
    dy: clampTo(Math.round(r.dy), sheetH - mh, 0),
    dw: mw,
    dh: mh,
  }
}

/**
 * The rectangle a smaller copy is drawn at: the photo's rectangle on the
 * smaller sheet (`r`, from the cover fit: fractional), rounded UP to whole
 * pixels and placed at a whole-pixel offset, kept covering the sheet. The
 * copy's photo is decoded at exactly this size (decode.ts `decodeResized`)
 * and drawn 1:1, so a smaller copy is resampled once, by the decoder, and
 * never again by a fractional blit.
 */
export function snapCopyRect(r: DrawRect, sheetW: number, sheetH: number): DrawRect {
  const dw = Math.max(Math.ceil(r.dw - 1e-9), sheetW)
  const dh = Math.max(Math.ceil(r.dh - 1e-9), sheetH)
  return { dx: clampTo(Math.round(r.dx), sheetW - dw, 0), dy: clampTo(Math.round(r.dy), sheetH - dh, 0), dw, dh }
}

/** Rec. 709 luma, 0..1. The channel weights a print separation actually uses. */
export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * The photo's luminance as the eye judges legibility against it — blurred.
 *
 * A photograph is full of local contrast: a bright speck inside a shadow, a
 * dark seam across a highlight, the glitter on water. Read raw, that decides
 * "light or dark" differently for every letter, and the type flickers between
 * two inks mid-word — far harder to read than either ink alone. Blurring first
 * lets the answer follow the picture's large shapes, which is what the eye is
 * actually weighing a word against.
 *
 * Kept as the number itself rather than thresholded on the spot because the
 * press needs it, not just which side of a line it fell: whether an ink can
 * darken what it lands on is a comparison against this, and a mask has already
 * thrown that away.
 *
 * Held small: the luminance is averaged on a grid of `cell`-pixel squares
 * (each the mean of its pixels' luminance), blurred there by radius / cell,
 * and read back at full resolution by bilinear sampling (`sampleLumaRows`).
 *
 * The blur runs across roughly a word (radius 1.5 em: about 500 px on a 12 MP
 * export), so the field has nothing finer than a few hundred pixels in it, and
 * blurring it at full resolution — the press's single slowest pass, and a
 * sheet-sized float held through every plate — paid for detail the blur then
 * throws away. The grid is LUMA_GRID_SPAN cells of blur radius across, so it
 * keeps the field's shape: the switch and the knockout move on under 1% of the
 * pixels (diet.test.ts), and only there.
 *
 * Where the radius is small (small type at preview size), the cell is one
 * pixel: the grid is the luminance at every pixel, blurred at full
 * resolution, as the press held it before the grid.
 */
export interface LumaGrid {
  /** Blurred luminance per cell, gw * gh. */
  grid: Float32Array
  gw: number
  gh: number
  cell: number
  w: number
  h: number
}

/** The blur radius, in cells, the grid is made fine enough to hold. */
export const LUMA_GRID_SPAN = 16

/** The grid's cell, in pixels, for a blur of this radius. */
export const lumaCell = (blurRadius: number): number => Math.max(1, Math.floor(blurRadius / LUMA_GRID_SPAN))

export function groundLumaGrid(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  blurRadius: number,
  /** Buffers for a full-resolution blur (cell 1), if the caller has them. */
  scratch?: Float32Array,
  spare?: Float32Array,
): LumaGrid {
  const acc = new LumaAccumulator(w, h, blurRadius)
  acc.addRows(rgba, 0, h)
  return acc.finish(scratch, spare)
}

/** One pixel of the ground as its luminance: transparent ground is bare
 *  paper, the lightest thing there is. */
const groundLumaAt = (rgba: Uint8ClampedArray, o: number): number => {
  const a = rgba[o + 3] / 255
  return luma(rgba[o], rgba[o + 1], rgba[o + 2]) * a + (1 - a)
}

/**
 * `groundLumaGrid`, fed a band of the ground's rows at a time, top to bottom:
 * what a press that never holds the whole ground builds the grid with. The
 * grid comes out the same to the bit as from the whole ground at once,
 * because each cell is summed in the same order (its rows in turn, each row's
 * pixels in turn, in float64) and blurred whole once every row is in.
 *
 * At cell 1 (a blur under LUMA_GRID_SPAN pixels: small type on a small sheet)
 * the grid IS the luminance at every pixel, a sheet-sized float field, as
 * the press has always held it.
 */
export class LumaAccumulator {
  readonly cell: number
  readonly gw: number
  readonly gh: number
  /** Cell 1: the luminance itself. Otherwise: the cells' sums. */
  private readonly field: Float32Array | null
  private readonly sum: Float64Array | null
  private nextRow = 0

  constructor(
    readonly w: number,
    readonly h: number,
    readonly blurRadius: number,
  ) {
    this.cell = lumaCell(blurRadius)
    this.gw = this.cell === 1 ? w : Math.ceil(w / this.cell)
    this.gh = this.cell === 1 ? h : Math.ceil(h / this.cell)
    this.field = this.cell === 1 ? new Float32Array(w * h) : null
    this.sum = this.cell === 1 ? null : new Float64Array(this.gw * this.gh)
  }

  /** The ground's rows [y0, y1), RGBA, row y at rgba[(y - y0) * w * 4]. Rows
   *  come in order, each band starting where the last ended. */
  addRows(rgba: Uint8ClampedArray, y0: number, y1: number): void {
    if (y0 !== this.nextRow || y1 < y0 || y1 > this.h) throw new Error(`LumaAccumulator: rows [${y0}, ${y1}) after row ${this.nextRow}`)
    this.nextRow = y1
    const { w, cell, gw, field, sum } = this
    for (let y = y0; y < y1; y++) {
      const src = (y - y0) * w * 4
      if (field) {
        const row = y * w
        for (let x = 0; x < w; x++) field[row + x] = groundLumaAt(rgba, src + x * 4)
      } else {
        const row = Math.floor(y / cell) * gw
        for (let x = 0; x < w; x++) sum![row + Math.floor(x / cell)] += groundLumaAt(rgba, src + x * 4)
      }
    }
  }

  /** The finished grid, once every row is in: averaged and blurred. Cell 1
   *  blurs the field where it lies, with the caller's buffers if given. */
  finish(scratch?: Float32Array, spare?: Float32Array): LumaGrid {
    if (this.nextRow !== this.h) throw new Error(`LumaAccumulator: finished at row ${this.nextRow} of ${this.h}`)
    const { w, h, cell, gw, gh, blurRadius } = this
    if (this.field) {
      const lum = this.field
      if (blurRadius > 0) {
        const n = w * h
        blurInPlace(lum, w, h, blurRadius, scratch ?? new Float32Array(n), needsSpare(blurRadius) ? (spare ?? new Float32Array(n)) : undefined)
      }
      return { grid: lum, gw: w, gh: h, cell, w, h }
    }
    const sum = this.sum!
    const grid = new Float32Array(gw * gh)
    for (let j = 0; j < gh; j++) {
      const rows = Math.min(h, (j + 1) * cell) - j * cell
      for (let i = 0; i < gw; i++) {
        const cols = Math.min(w, (i + 1) * cell) - i * cell
        grid[j * gw + i] = sum[j * gw + i] / (rows * cols)
      }
    }
    const r = blurRadius / cell
    blurInPlace(grid, gw, gh, r, new Float32Array(gw * gh), needsSpare(r) ? new Float32Array(gw * gh) : undefined)
    return { grid, gw, gh, cell, w, h }
  }
}

/** The grid read back at the sheet's rows [y0, y1), into `out` (row y at
 *  out[(y - y0) * w]): bilinear between cell centres, held at the edge cells
 *  beyond them. Each pixel is read from the grid at its own sheet position,
 *  so a band is the same numbers as those rows of the whole sheet. */
export function sampleLumaRows(g: LumaGrid, y0: number, y1: number, out: Float32Array): Float32Array {
  const { grid, gw, gh, cell, w } = g
  if (cell === 1) {
    out.set(grid.subarray(y0 * w, y1 * w))
    return out
  }
  const xs0 = new Int32Array(w)
  const xs1 = new Int32Array(w)
  const fxs = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    const u = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5))
    xs0[x] = Math.floor(u)
    xs1[x] = Math.min(gw - 1, xs0[x] + 1)
    fxs[x] = u - xs0[x]
  }
  for (let y = y0; y < y1; y++) {
    const v = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5))
    const ya = Math.floor(v)
    const yb = Math.min(gh - 1, ya + 1)
    const fy = v - ya
    const r0 = ya * gw
    const r1 = yb * gw
    const o = (y - y0) * w
    for (let x = 0; x < w; x++) {
      const fx = fxs[x]
      const top = grid[r0 + xs0[x]] + (grid[r0 + xs1[x]] - grid[r0 + xs0[x]]) * fx
      const bot = grid[r1 + xs0[x]] + (grid[r1 + xs1[x]] - grid[r1 + xs0[x]]) * fx
      out[o + x] = top + (bot - top) * fy
    }
  }
  return out
}

/**
 * How far past the switch point the blend runs, in luminance.
 *
 * Deliberately narrow. The band is there so a stroke crossing the boundary
 * cross-fades instead of snapping, and with a blur measured in whole words the
 * boundary is already gradual *in space* — widening it in *value* only buys a
 * large region where both inks print at partial strength, which is neither
 * colour and reads as mud. Over water, whose blurred luminance sits close to
 * mid grey across the whole frame, a wide band puts every line in that region
 * at once.
 */
export const SWITCH_BAND = 0.07

/** Turn ground luminance into "light enough for the darker ink", 0..1. */
export function bandMask(
  lum: Float32Array,
  threshold: number,
  band = SWITCH_BAND,
  out: Float32Array = new Float32Array(lum.length),
): Float32Array {
  const lo = threshold - band
  const span = Math.max(1e-6, band * 2)
  for (let i = 0; i < lum.length; i++) {
    const t = (lum[i] - lo) / span
    const c = t <= 0 ? 0 : t >= 1 ? 1 : t
    // Smoothstep: eases in and out of the switch instead of ramping linearly
    // into it, so neither end of the blend shows a visible seam.
    out[i] = c * c * (3 - 2 * c)
  }
  return out
}

export type InkRgb = readonly [number, number, number]

export interface InkSplit {
  /** The ink to lay where the photo is light. */
  onLight: InkRgb
  /** The ink to lay where the photo is dark. */
  onDark: InkRgb
  onLightLuma: number
  onDarkLuma: number
}

/**
 * Which of two inks belongs on light ground, and which on dark.
 *
 * Decided by what the inks *are*, never by which field they were typed into.
 * Keying it to the slot assumes the first ink is the dark one, and the moment
 * it isn't — white type over a photograph, the ordinary case — the switch runs
 * and puts white on the sky and black on the water: both invisible, and worse
 * than not switching at all. Ties keep the given order, because with two inks
 * of the same weight there is nothing to choose between them.
 */
export function splitInks(a: InkRgb, b: InkRgb): InkSplit {
  const la = luma(a[0], a[1], a[2])
  const lb = luma(b[0], b[1], b[2])
  const aFirst = la <= lb
  return {
    onLight: aFirst ? a : b,
    onDark: aFirst ? b : a,
    onLightLuma: Math.min(la, lb),
    onDarkLuma: Math.max(la, lb),
  }
}
