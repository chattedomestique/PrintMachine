/**
 * The render pipeline.
 *
 * Pure in the sense that matters: it owns no state, creates no DOM, knows
 * nothing about React, and draws only into contexts handed to it. Both the
 * live preview and the export call this same function — the export just passes
 * `overlay = null`, which is what guarantees a saved file can never contain an
 * editing aid (playbook N8/§5.4).
 *
 * Pass order, and why it is this order:
 *
 *   type → tone      glyph alpha is the tone field
 *   edge             the burned stencil's ragged outline and ink spread —
 *                    on the tone, so the screen bites on the real edge
 *   density          ink can't reach full black; cap before screening so the
 *                    screen sees the tone that will actually be printed
 *   wear             mottle and speckle dropout, on the tone, so they change
 *                    how many dots print rather than how transparent the ink is
 *   plate shift      the artwork moves on the plate...
 *   screen/grain     ...and the lattice moves with it, so dots don't crawl
 *   composite        subtractive overprint onto textured paper
 *
 * Reordering this is not a refactor, it is a regression:
 *
 *  - The shift has to precede screening or the dots slide underneath the
 *    artwork instead of travelling with the plate.
 *  - The density cap has to precede screening or the highlights clip.
 *  - Every wear pass has to precede screening. Coverage is read by the
 *    compositor as ink transmittance, so scaling it after the screen thins the
 *    ink film and a faded region renders as grey — the "just turn the opacity
 *    down" look. Ink that fails to transfer does not go grey; there are fewer
 *    and smaller dots of full-strength pigment. Only a pre-screen fade can
 *    produce that.
 */

import { blurReach } from './blur.ts'
import { compositeLayers, type CompositeLayer, type PaperInput } from './composite.ts'
import { GrainStream, cellStarts, grainRows } from './dither.ts'
import { applyDensity, applyMottle, edgeToRough, registrationOffset, shiftRows, shiftSource, wearToMottle } from './ink.ts'
import { inkById, paperById } from './inks.ts'
import { roughenInPlace } from './rough.ts'
import { PaperSampler, paperField, type PaperField, type PaperOptions, type PaperSource } from './paper.ts'
import { FbmSampler, fbm2D, type CellNoise } from './rng.ts'
import { defaultAngle, screenField, type ScreenOptions } from './screen.ts'
import { cutKnockoutRows } from './knockout.ts'
import { LumaAccumulator, SWITCH_BAND, bandMask, coverRect, sampleLumaRows, snapRect, splitInks, type DrawRect, type InkSplit, type LumaGrid } from './media.ts'
import { drawBacking, drawGlyphs, planGlyphs, plateFontSize, rasterizeBacking, rasterizeText, type GlyphPlan, type SheetPart } from './text.ts'
import { readAlpha, readRgba } from './readback.ts'
import { TILE_BUDGET, TileRowCache, ringRows, rowsFromTiles, tileAt, tileGrid, type TileBudget, type TileGrid } from './tiles.ts'
import { REFERENCE_HEIGHT, bandHeight } from './limits.ts'
import { sheetAspect, type MediaLayer, type PressProfile, type PrintSettings, type TextLayer } from './types.ts'

/**
 * The preview renders smaller than the export so a slider drag stays smooth on
 * a phone. This is safe *because* every spatial quantity — screen pitch, dot
 * softness, registration offset — is scaled by `h / REFERENCE_HEIGHT` in
 * renderPlate, so the two resolutions produce the same look rather than the
 * same pixels. Changing one without the other is what makes a preview lie.
 *
 * The preview is sized by a PIXEL BUDGET, not a height (`previewSize`): its
 * cost goes with its pixels, and a fixed height made a landscape sheet cost
 * its width over its height more (a 3:1 Original sheet 3.75x a 4:5 one). The
 * budget is exactly the most expensive sheet before (1:1 at 1000 px), so no
 * portrait or square sheet changes and none costs more. The preview never
 * feeds the export, and it is not sharper than 1000 px tall.
 */
export const PREVIEW_HEIGHT = 1000
export const PREVIEW_PIXELS = 1_000_000

/**
 * Resolution used while a control is still moving.
 *
 * The press is a dozen full-image passes per plate, so its cost is quadratic in
 * the preview height. Measured on a 4x-throttled phone profile, a full-height
 * preview took over a second per change: dragging a slider froze the main
 * thread, which made *everything* — the drag, the scroll, the tap — feel
 * broken, not just the picture.
 *
 * Every spatial quantity is already scaled by h / REFERENCE_HEIGHT, so a
 * smaller render is the same print at lower fidelity rather than a different
 * one. Dropping to this while a value is in motion is roughly a seven-fold cut
 * in pixels; the full-height frame lands as soon as the control settles. A
 * pixel budget too (280 x 280), for the same reason as the preview's.
 */
export const DRAFT_HEIGHT = 280
export const DRAFT_PIXELS = 78_400

/**
 * The press's fixed constants, once settings and now decisions made here:
 *
 *  - Dot softness 0.7 px: the halftone dot's edge, at the reference height.
 *  - Tear scale 3 px: the feature size of the stencil's ragged edge.
 *  - Paper tooth 0.4 and cloud 0.5: fibre and cloudiness of the stock.
 *
 * Each belongs to the look but is not a choice anyone makes per print.
 */
const DOT_SOFTNESS = 0.7
const TEAR_SCALE = 3
const PAPER_TOOTH = 0.4
const PAPER_CLOUD = 0.5

/** The grain cell rides the screen size, a third of it, so the default 9 px
 *  screen gives the 3 px grain the press always shipped with. A division, not
 *  a multiplication by 1/3, so a converted dither's cell (stored as cell x 3)
 *  comes back exactly. Scaled with the render height and NOT rounded: the
 *  grain is the same size on the print at every height (dither.ts takes a
 *  fractional cell). Never finer than a pixel. */
const PITCH_PER_GRAIN = 3
export const grainCell = (screenPitch: number, scale: number): number =>
  Math.max(1, (screenPitch / PITCH_PER_GRAIN) * scale)

/** Output pixel dimensions for a sheet's width over its height (a number:
 *  `sheetAspect`) at a given render height. The one place the width is made. */
export function outputSize(aspect: number, height: number = REFERENCE_HEIGHT): { w: number; h: number } {
  return { w: Math.round(height * aspect), h: height }
}

/**
 * The tallest sheet of this aspect inside a pixel budget, at most `cap` tall:
 * `h = min(cap, floor(sqrt(budget / a)))`, `w = round(h x a)`. Floored, so the
 * width's rounding is the only overshoot (under half a row). Every sheet at
 * or narrower than square keeps the full `cap`.
 */
function budgetSize(aspect: number, budget: number, cap: number): { w: number; h: number } {
  const h = Math.max(1, Math.min(cap, Math.floor(Math.sqrt(budget / aspect))))
  return outputSize(aspect, h)
}

/** The settled preview's size: a million pixels, at most 1000 px tall. */
export const previewSize = (aspect: number) => budgetSize(aspect, PREVIEW_PIXELS, PREVIEW_HEIGHT)

/** The draft's size while a control moves: 78,400 pixels, at most 280 tall. */
export const draftSize = (aspect: number) => budgetSize(aspect, DRAFT_PIXELS, DRAFT_HEIGHT)

/** Editing aids. Never non-null on an export path. The one aid is the
 *  selected plate's crosshair: the on-sheet sign of which plate the gestures
 *  will move. */
export interface OverlaySpec {
  selectedLayerId: string | null
}

/**
 * The sheet's noise: the paper's shade, the ink film's mottle and the dropout
 * speckle. It depends only on the sheet's size, the seed and the stock.
 *
 * The preview's cache holds the paper and the mottle as arrays, built once and
 * reused every frame. An export reads both where they are needed and holds
 * neither (`sampledNoise`): 8 bytes a pixel it never allocates, on a phone
 * pressing 11 MP. The numbers are the same to the last bit either way.
 */
export interface SheetNoise {
  paper: PaperSource
  mottle: Float32Array | FbmSampler
  /** The dropout's white noise: one value per speck, a speck a pixel at the
   *  reference height. Read on demand, so it holds no memory. */
  speckle: CellNoise
}

/** What the sheet's noise is made from: one place, so the cached arrays and
 *  the samplers can never be built from different numbers. */
function noiseRecipe(s: PrintSettings, h: number) {
  const scale = h / REFERENCE_HEIGHT
  const paper: PaperOptions = {
    rgb: paperById(s.paperId).rgb,
    texture: PAPER_TOOTH,
    blotch: PAPER_CLOUD,
    seed: s.seed,
    scale,
  }
  return {
    paper,
    // Mottle cell is tied to the sheet, not to a pixel count, so the blotch
    // scale looks the same at preview and export resolution.
    mottle: { cell: Math.max(6, h / 90), octaves: 3, seed: s.seed ^ 0x9e3779b9 },
    // So is the speck: a pixel at the reference height, two at twice it.
    // (It was one value per PIXEL of a seeded stream, so a larger export
    // printed finer dust in a different pattern.)
    speckle: { cell: Math.max(1, scale), seed: s.seed ^ 0x85ebca6b },
  }
}

/** The sheet's noise for an export: read where it is printed, held nowhere. */
export function sampledNoise(s: PrintSettings, w: number, h: number): SheetNoise {
  const r = noiseRecipe(s, h)
  return {
    paper: new PaperSampler(w, h, r.paper),
    mottle: new FbmSampler(w, r.mottle.cell, r.mottle.octaves, r.mottle.seed),
    speckle: r.speckle,
  }
}

/**
 * Cache for the expensive derived fields (the preview's).
 *
 * Paper texture and the noise fields depend only on size and seed, so they must
 * not regenerate when an unrelated slider moves — that wastes work and, worse,
 * visibly re-randomises the grain, which reads as a bug (§5.7).
 */
export interface RenderCache extends SheetNoise {
  key: string
  w: number
  h: number
  paper: PaperField
  mottle: Float32Array
  /** Rasterised tone per plate, keyed on the properties that affect it.
   *  Dragging a press slider must not re-run getImageData for every plate.
   *  A backing is keyed separately from its glyphs under the same layer id. */
  tone: Map<string, { key: string; field: ToneField; fontSize: number }>
}

function cacheKey(s: PrintSettings, w: number, h: number): string {
  return [w, h, s.seed, s.paperId].join('|')
}

/** Everything about a layer that changes its rasterised glyphs (and so its
 *  backing, which is laid out from the same lines). Inks and screen settings
 *  are deliberately absent — they act downstream of the raster, so changing
 *  them should reuse it. */
function toneKey(l: TextLayer): string {
  return [
    l.text,
    l.fontId,
    l.bold,
    l.size,
    l.lineHeight,
    l.tracking,
    l.align,
    l.x,
    l.y,
    l.rotation,
  ].join('')
}

function buildCache(s: PrintSettings, w: number, h: number): RenderCache {
  const r = noiseRecipe(s, h)
  return {
    key: cacheKey(s, w, h),
    w,
    h,
    paper: paperField(w, h, r.paper),
    mottle: fbm2D(w, h, r.mottle.cell, r.mottle.octaves, r.mottle.seed),
    speckle: r.speckle,
    tone: new Map(),
  }
}

/** Rasterise a layer's glyphs, reusing the cached field when nothing that
 *  affects them has changed. */
function cachedTone(
  scratch: CanvasRenderingContext2D,
  layer: TextLayer,
  cache: RenderCache,
  w: number,
  h: number,
): { field: ToneField; fontSize: number } {
  const slot = layer.id
  const key = toneKey(layer) + '|' + slot
  const hit = cache.tone.get(slot)
  if (hit && hit.key === key) return hit
  const { tone, fontSize } = rasterizeText(scratch, layer, w, h)
  const entry = { key, field: tone, fontSize }
  cache.tone.set(slot, entry)
  return entry
}

/** Same, for a layer's backing: one block per line of its type. */
function cachedBackingTone(
  scratch: CanvasRenderingContext2D,
  layer: TextLayer,
  cache: RenderCache,
  w: number,
  h: number,
): { field: ToneField; fontSize: number } {
  const slot = `${layer.id}:backing`
  const key = toneKey(layer) + '|' + slot
  const hit = cache.tone.get(slot)
  if (hit && hit.key === key) return hit
  // A backing carries its type's rendered size, so it wears at the same scale
  // as the words it sits behind rather than as a poster-sized slab.
  const { tone, fontSize } = rasterizeBacking(scratch, layer, w, h)
  const entry = { key, field: tone, fontSize }
  cache.tone.set(slot, entry)
  return entry
}

/** Get a valid cache for these settings, rebuilding only when the inputs move. */
export function ensureCache(
  cache: RenderCache | null,
  s: PrintSettings,
  w: number,
  h: number,
): RenderCache {
  const key = cacheKey(s, w, h)
  if (cache && cache.key === key && cache.w === w && cache.h === h) return cache
  return buildCache(s, w, h)
}

/**
 * How finely to print, given how big the type actually came out.
 *
 * A real Riso screens the whole sheet at one ruling, so physically this should
 * be a constant — but a real Riso's master is ~600dpi, which at this reference
 * height is a screen finer than a pixel. The defaults here are deliberately
 * coarse so the halftone is *visible* at poster size, and that same coarseness
 * is wider than the strokes of small type: the dots stop describing the
 * letterform and start replacing it.
 *
 * So detail scales with the rendered type size, floored so small type still
 * reads as printed rather than as clean vector. Always on: it is a fix, not a
 * preference — off, the coarse screen and the wear eat small type.
 */
export function detailFactor(fontSize: number, canvasHeight: number): number {
  // 0.16 of the sheet height is the poster size the wear defaults were tuned
  // against; anything at or above it prints at full coarseness.
  const relative = fontSize / (canvasHeight * 0.16)
  if (relative >= 1) return 1
  // Square root rather than linear: halving the type should not halve the
  // texture, or small type loses its character entirely on the way to legible.
  return Math.max(0.22, Math.sqrt(relative))
}

/**
 * A plate's tone: how much ink the artwork asks for, per pixel. The glyph
 * raster's alpha bytes as they come off the canvas (0..255), or floats in
 * 0..1 (a test's hand-made field). The press reads both the same way.
 */
export type ToneField = Uint8Array | Float32Array

/** The tone as floats in 0..1, for the passes that need fractions: a byte
 *  field is converted (b / 255, as float32), a float field copied. Into
 *  `out` when given. */
export function toneAsFloat(tone: ToneField, out: Float32Array = new Float32Array(tone.length)): Float32Array {
  if (tone instanceof Float32Array) out.set(tone)
  else for (let i = 0; i < tone.length; i++) out[i] = tone[i] / 255
  return out
}

/**
 * The press's working buffers: three float windows of `rows` rows of the
 * sheet (all of it, for a press of the whole sheet), made once per render and
 * reused by every band and every plate, where each plate used to make a dozen
 * sheet-sized arrays of its own (tone, blur ping-pong, roughened, density,
 * mottle, shift, knockout...). Every pass works on views of these, sized
 * exactly to its window, to the same numbers.
 *
 *  - `rough`: the glyph window's tone, then the torn tone (handed back as
 *    `torn`, valid until the next plate is pressed);
 *  - `work`: the second blur's source, then the worn tone; between plates,
 *    the switch mask before it is screened;
 *  - `scratch`: the blur's other half, then the moved (shifted) tone the
 *    screen or the grain reads.
 *
 * `rows` is the largest window any band of any plate needs (`maxWindow`).
 */
export interface Workspace {
  rough: Float32Array
  work: Float32Array
  scratch: Float32Array
}

export function makeWorkspace(rows: number, w: number): Workspace {
  const n = rows * w
  return { rough: new Float32Array(n), work: new Float32Array(n), scratch: new Float32Array(n) }
}

/** No workspace: what a render holds once its plates are pressed. */
const RELEASED: Workspace = makeWorkspace(0, 0)

/** A plate after the press, and what a knockout under it has to match. */
export interface PressedPlate {
  /** Screened coverage in bytes, 0..255: a quarter of a float field, held for
   *  every pass until the sheet is printed. */
  coverage: Uint8ClampedArray
  /** The torn tone: the workspace's `rough`, so it is only good until the
   *  next plate is pressed with the same workspace. */
  roughened: Float32Array
  dx: number
  dy: number
}

/**
 * A plate's glyph tone, read a window of rows at a time: the whole field (a
 * test's, or the preview's cached raster) or, for an export, rows drawn as
 * they are needed.
 */
export interface ToneRows {
  /** Rows [a, b) of the tone: exactly (b - a) * w values, row a first. */
  rows(a: number, b: number): ToneField
}

/** The tone of a field held whole. */
export function wholeTone(field: ToneField, w: number): ToneRows {
  return { rows: (a, b) => field.subarray(a * w, b * w) }
}

/** One band of one plate, pressed. */
export interface PlateBand {
  /** Screened coverage of the band's rows [y0, y1), bytes: the `out` given. */
  coverage: Uint8ClampedArray
  /** The torn tone, the sheet's rows from `tornRow0` on: a view of the
   *  workspace's `rough`, good until the next plate is pressed. It covers
   *  every row the knockout under this band reads (`windowsFor`). */
  torn: Float32Array
  tornRow0: number
  dx: number
  dy: number
  detail: number
}

/**
 * Run the press over one plate: everything from the stencil edge to the
 * screen. Shared by type and by backings — a backing that skipped this would
 * be the one clean, undistressed rectangle on an otherwise convincingly
 * printed sheet.
 *
 * The whole sheet: `pressPlateBand` over the one band [0, h). Returns the
 * screened coverage, and with it the two things a knockout under this plate
 * has to match exactly: the roughened tone (the plate's torn, bled outline,
 * before density and wear) and the offset the plate landed at.
 *
 * Exported so tests can drive it without a canvas.
 */
export function pressPlate(
  plate: { field: ToneField; fontSize: number },
  index: number,
  s: PressProfile,
  seed: number,
  noise: SheetNoise,
  w: number,
  h: number,
  /** Reused buffers (a render passes one for all its plates); fresh ones by
   *  default. */
  ws: Workspace = makeWorkspace(h, w),
): PressedPlate {
  return drain(pressWholeSteps(plate, index, s, seed, noise, w, h, ws, { step: 'press', band: 0, bands: 1 }))
}

/** `pressPlate`, in stages (see `pressPlateBandSteps`). */
function* pressWholeSteps(
  plate: { field: ToneField; fontSize: number },
  index: number,
  s: PressProfile,
  seed: number,
  noise: SheetNoise,
  w: number,
  h: number,
  ws: Workspace,
  at: RenderProgress,
): Generator<RenderProgress, PressedPlate> {
  const coverage = new Uint8ClampedArray(w * h)
  const band = yield* pressPlateBandSteps(
    { rows: wholeTone(plate.field, w), fontSize: plate.fontSize },
    index,
    s,
    seed,
    noise,
    w,
    h,
    { y0: 0, y1: h },
    ws,
    coverage,
    // The torn tone of the whole sheet, every row: what a knockout cut from
    // it whole (cutKnockoutRows over the whole sheet) reads.
    { cuts: true, torn: { a: 0, b: h } },
    at,
  )
  return { coverage, roughened: band.torn, dx: band.dx, dy: band.dy }
}

/**
 * Press one band of one plate: the rows [y0, y1) of its screened coverage,
 * with exactly the bytes pressing the whole sheet gives them.
 *
 * Each stage reads only the rows it needs (`windowsFor`, from the plate's own
 * geometry), and every value is keyed to the sheet's rows, never the band's:
 * the glyph rows the tear reaches; the tear on them (the wander at sheet
 * rows); density and wear on the rows the shift reads (mottle and speckle at
 * sheet rows, the stride wrapping at the sheet's height); the shift into the
 * rows the screen reads; the screen placed by sheet rows, or the grain stream
 * carrying its error from the band before. The torn tone is handed back over
 * the rows a knockout under the band reads, when the plate cuts one (`cuts`).
 *
 * It yields `at` after the tear and after the wear, so an export hands the
 * page a moment inside a pass as well as between them.
 *
 * @param out  the band's coverage, at least (y1 - y0) * w bytes; written in
 *             full for the band's rows.
 * @param opts.grain the plate's grain stream (one per plate, run band after
 *             band from the top); made here for a press of the whole sheet.
 * @param opts.torn rows the torn tone must cover besides the knockout's (a
 *             press of the whole sheet asks for every row).
 */
export function* pressPlateBandSteps(
  plate: { rows: ToneRows; fontSize: number },
  index: number,
  s: PressProfile,
  seed: number,
  noise: SheetNoise,
  w: number,
  h: number,
  band: { y0: number; y1: number },
  ws: Workspace,
  out: Uint8ClampedArray,
  opts: { cuts: boolean; grain?: GrainStream; torn?: RowWindow },
  at: RenderProgress,
): Generator<RenderProgress, PlateBand> {
  const { y0, y1 } = band
  const scale = h / REFERENCE_HEIGHT
  const g = plateGeometry(s, { fontSize: plate.fontSize, index }, seed, h)
  const { detail, dx, dy } = g
  const grain = g.grain ? (opts.grain ?? (y0 === 0 && y1 === h ? new GrainStream(w, h, g.cell) : null)) : null
  if (g.grain && !grain) throw new Error('pressPlateBand: a band of a grain plate needs the plate\'s stream')
  if (grain && grain.cell !== Math.max(1, g.cell)) throw new Error('pressPlateBand: the stream is for another cell')
  const win = windowsFor(band, g, h, opts.cuts, grain?.rows)
  const torn = opts.torn ? hullOf(win.torn, opts.torn) : win.torn
  const glyph = isEmpty(torn) ? torn : { a: Math.max(0, torn.a - 3 * g.rMax), b: Math.min(h, torn.b + 3 * g.rMax) }
  const edge = edgeToRough(s.edge)
  const wear = wearToMottle(s.wear)
  const rows = glyph.b - glyph.a
  const n = Math.max(0, rows) * w
  const rough = ws.rough.subarray(0, n)

  if (n > 0) {
    // The glyph rows the tear reaches, as floats, then torn in place.
    const tone = plate.rows.rows(glyph.a, glyph.b)
    if (tone.length !== n) throw new Error(`pressPlateBand: ${tone.length} tone values for rows [${glyph.a}, ${glyph.b})`)
    toneAsFloat(tone, rough)
    // Ragged stencil edge + ink spread, before anything downstream sees the
    // outline. Seeded per plate so two plates don't tear identically.
    roughenInPlace(
      rough,
      w,
      rows,
      {
        roughness: edge.roughness,
        // Unfloored: roughenInPlace needs the size that was actually asked for,
        // not a whole number, or it cannot tell a fine tear from a clamped one.
        scale: TEAR_SCALE * scale * detail,
        // Bleed is a threshold offset, so at small sizes it eats the counters —
        // the holes in a, e, o fill and the word turns into a row of blobs.
        bleed: edge.bleed * detail,
        seed: seed ^ (index * 0x9e3779b9),
      },
      ws.scratch.subarray(0, n),
      ws.work.subarray(0, n),
      glyph.a,
    )
  }

  // ── Wear, applied to TONE and therefore before the screen ───────────
  //
  // This ordering is the whole difference between a print that fades and a
  // print that goes grey. The compositor reads coverage as ink transmittance,
  // so scaling coverage *after* screening thins the ink film — a half-covered
  // pixel renders as half-strength ink, which is exactly "turn the opacity
  // down" and looks nothing like a real print.
  //
  // Ink that fails to transfer does not go grey. The dots that do print are
  // still full-strength pigment; there are simply fewer and smaller of them.
  // Modulating tone lets the screen convert a fade into *sparser dots*, so a
  // failing area visibly breaks up into halftone instead of dimming. Detail
  // scaling reaches the wear as well as the screen: on body copy a sheet-sized
  // blotch cell is about the height of a letter, so unscaled wear stops
  // texturing the ink and starts eating the letterform.
  yield at
  const { worn: wornRows, coverage: covRows } = win
  const worn = ws.work.subarray(0, Math.max(0, wornRows.b - wornRows.a) * w)
  if (worn.length > 0) {
    applyDensity(rough.subarray((wornRows.a - glyph.a) * w, (wornRows.b - glyph.a) * w), s.density, worn)
    applyMottle(worn, noise.mottle, noise.speckle, wear.mottle * detail, wear.dropout * detail, w, wornRows.b - wornRows.a, detail, worn, wornRows.a, h)
  }

  // Misregistration is a paper-feed error, physically the same for the whole
  // sheet — but at 5px it obliterates 20px type while barely showing on a
  // poster. Scaled by sqrt so it stays visible on small type without eating it
  // (plateGeometry). The rows the screen reads are moved into a window of
  // their own: a band reads its source a few rows away.
  const still = dx === 0 && dy === 0
  const moved = still ? worn : ws.scratch.subarray(0, Math.max(0, covRows.b - covRows.a) * w)
  if (!still && moved.length > 0) shiftRows(worn, w, wornRows.a, h, dx, dy, covRows.a, covRows.b, moved)
  yield at

  // Screened straight into bytes: the dot's soft edge is kept to half a
  // level, and every pass held until the print costs a quarter of a float.
  const coverage = out.subarray(0, (y1 - y0) * w)
  if (grain) {
    // The grain cell rides the render scale like every other spatial
    // quantity, so the preview and the export show the same texture rather
    // than the same pixel count.
    grain.run(moved, covRows.a, y0, y1, coverage)
  } else {
    coverage.fill(0)
    screenField(
      moved,
      w,
      y1 - y0,
      {
        pitch: Math.max(1.2, s.screenPitch * scale * detail),
        // Each plate gets its own angle; the beat between them is the rosette.
        angle: defaultAngle(index),
        softness: DOT_SOFTNESS * scale * detail,
        originX: dx,
        originY: dy,
        row0: y0,
      },
      coverage,
    )
  }
  return { coverage, torn: rough, tornRow0: glyph.a, dx, dy, detail }
}

/** `pressPlateBandSteps`, run to the end. */
export function pressPlateBand(
  plate: { rows: ToneRows; fontSize: number },
  index: number,
  s: PressProfile,
  seed: number,
  noise: SheetNoise,
  w: number,
  h: number,
  band: { y0: number; y1: number },
  ws: Workspace,
  out: Uint8ClampedArray,
  opts: { cuts: boolean; grain?: GrainStream; torn?: RowWindow },
): PlateBand {
  return drain(pressPlateBandSteps(plate, index, s, seed, noise, w, h, band, ws, out, opts, { step: 'press', band: 0, bands: 1 }))
}

/**
 * Where a plate lands and how far each of its stages reaches: what a press in
 * bands sizes its windows from. Computed exactly as `pressPlate` computes it
 * (the same detail factor, tear radius, offset and grain cell), so a window
 * can never be cut to a reach the press does not have.
 */
export interface PlateGeometry {
  /** detailFactor of the plate's type on this sheet. */
  detail: number
  /** The tear's blur radius (0 when the edge is off) and its per-pass reach
   *  in whole rows (blur.ts `blurReach`). */
  tearRadius: number
  rMax: number
  /** The plate's registration offset, in pixels. */
  dx: number
  dy: number
  /** Grain (error diffusion) or halftone, and the grain's cell in pixels. */
  grain: boolean
  cell: number
}

export function plateGeometry(
  press: PressProfile,
  plate: { fontSize: number; index: number },
  seed: number,
  h: number,
): PlateGeometry {
  const scale = h / REFERENCE_HEIGHT
  const detail = detailFactor(plate.fontSize, h)
  const edge = edgeToRough(press.edge)
  const tears = edge.roughness > 0 || edge.bleed > 0
  const tearRadius = tears ? Math.max(0, TEAR_SCALE * scale * detail) : 0
  const { dx, dy } = registrationOffset(seed, plate.index, press.misregistration * scale * Math.sqrt(detail))
  const grain = press.method === 'grain'
  return { detail, tearRadius, rMax: blurReach(tearRadius), dx, dy, grain, cell: grain ? grainCell(press.screenPitch, scale) : 0 }
}

/**
 * How many rows past a band, each side, one plate's press reads: the tear's
 * three blur passes, the shift (the offset and the bilinear's next row), and
 * under grain a cell row to reach the cell grid plus the two cell rows the
 * error diffuses into. A SIZING figure (memory estimates; what `windowsFor`'s
 * exact windows are checked against), never what a window is cut to.
 *
 *   halo = 3 rMax + (ceil |dy| + 2, when the plate moves) + (3 ceil(cell) + 1, under grain)
 */
export interface PlateHalo {
  blur: number
  shift: number
  grain: number
  total: number
  dx: number
  dy: number
  rMax: number
  cell: number
}

/** The halo of one plate, from its geometry (`plateGeometry`: its own
 *  offset; or any geometry a caller makes, e.g. the offset at its bound,
 *  |dy| = misregistration x scale x sqrt(detail)). */
export function plateHalo(g: PlateGeometry): PlateHalo {
  const blur = 3 * g.rMax
  const shift = g.dx !== 0 || g.dy !== 0 ? Math.ceil(Math.abs(g.dy)) + 2 : 0
  const grain = g.cell > 0 ? 3 * Math.ceil(g.cell) + 1 : 0
  return { blur, shift, grain, total: blur + shift + grain, dx: g.dx, dy: g.dy, rMax: g.rMax, cell: g.cell }
}

/** Rows [a, b) of the sheet; empty when a >= b. */
export interface RowWindow {
  a: number
  b: number
}

const isEmpty = (r: RowWindow) => r.b <= r.a

/** The smallest window holding both. */
function hullOf(p: RowWindow, q: RowWindow): RowWindow {
  if (isEmpty(p)) return q
  if (isEmpty(q)) return p
  return { a: Math.min(p.a, q.a), b: Math.max(p.b, q.b) }
}

/**
 * The exact rows one plate's press reads to print the band [y0, y1), stage
 * by stage, back from the output:
 *
 *  - `coverage`: the rows of the moved, worn tone the screen reads (the band)
 *    or the grain stream reads (`grainRows`: the cell rows not yet loaded, up
 *    to two past the band's; empty when an earlier band loaded them all);
 *  - `worn`: the rows of the worn tone the shift reads to make those
 *    (ink.ts `shiftSource`);
 *  - `knockout`: the rows of the torn tone the knockout under this band
 *    reads, when the plate cuts one (`cuts`);
 *  - `torn`: both (the worn tone is the torn tone, density and wear applied
 *    pixel by pixel);
 *  - `glyph`: the torn rows widened by the tear's reach, 3 rMax, each side:
 *    the glyph rows the tear reads.
 *
 * All clamped to the sheet. `rows` is the grain's cell rows (cellStarts of
 * the sheet's height at the plate's cell) under grain.
 */
export interface PlateWindows {
  coverage: RowWindow
  worn: RowWindow
  knockout: RowWindow
  torn: RowWindow
  glyph: RowWindow
}

export function windowsFor(
  band: { y0: number; y1: number },
  g: PlateGeometry,
  h: number,
  cuts: boolean,
  rows?: Int32Array,
): PlateWindows {
  if (g.grain && !rows) throw new Error('windowsFor: a grain plate needs its cell rows')
  const coverage = g.grain ? grainRows(rows!, band.y0, band.y1) : { a: band.y0, b: band.y1 }
  const worn = shiftSource(g.dx, g.dy, coverage.a, coverage.b, h)
  const knockout = cuts ? shiftSource(g.dx, g.dy, band.y0, band.y1, h) : { a: band.y0, b: band.y0 }
  const torn = hullOf(worn, knockout)
  const reach = 3 * g.rMax
  const glyph = isEmpty(torn) ? torn : { a: Math.max(0, torn.a - reach), b: Math.min(h, torn.b + reach) }
  return { coverage, worn, knockout, torn, glyph }
}

/**
 * The rows a press in bands of `bandRows` must hold for its largest window:
 * every band of the sheet walked once, for every plate, at set-up (a few
 * thousand integer steps). The workspace is this many rows of the sheet's
 * width, allocated once and reused by every band and every plate.
 */
export function maxWindow(
  plates: readonly { geometry: PlateGeometry; cuts: boolean }[],
  bandRows: number,
  h: number,
): number {
  const B = Math.max(1, Math.min(h, bandRows))
  let most = B
  for (const p of plates) {
    const rows = p.geometry.grain ? cellStarts(h, p.geometry.cell) : undefined
    for (let y0 = 0; y0 < h; y0 += B) {
      const win = windowsFor({ y0, y1: Math.min(h, y0 + B) }, p.geometry, h, p.cuts, rows)
      most = Math.max(most, win.glyph.b - win.glyph.a, win.coverage.b - win.coverage.a)
    }
  }
  return most
}

/**
 * The halftone a switch mask is screened with. Its origin is a seed-chosen
 * offset in REFERENCE pixels, scaled with the sheet like every other offset,
 * so the mask's dots sit at the same place against the plate's at every
 * render height (it was a fixed count of pixels, a smaller fraction of a cell
 * on every larger sheet). Exported for the scale tests.
 */
export function switchScreen(index: number, press: PressProfile, seed: number, scale: number): ScreenOptions {
  return {
    pitch: Math.max(1.2, press.screenPitch * scale),
    angle: defaultAngle(index),
    softness: 0,
    originX: (seed % 7) * scale,
    originY: (seed % 5) * scale,
  }
}

/** A plate's tone as a source hands it over: a field held whole, or rows
 *  read as they are needed. */
export type PlateTone = { field: ToneField; fontSize: number } | { rows: ToneRows; fontSize: number }

/** Where each plate's tone comes from. The renderer rasterises glyphs into a
 *  canvas (and caches them); a test hands in fields it made itself. */
export interface ToneSource {
  type(layer: TextLayer): PlateTone
  backing(layer: TextLayer): PlateTone
  /** The size the layer's type is set at, in pixels: what `type(layer)` and
   *  `backing(layer)` report as `fontSize`, without drawing anything. A
   *  source without it is asked for the tone itself. */
  size?(layer: TextLayer): number
  /** Told once, before the first band, every pass the print presses and the
   *  largest window of rows any of them reads (`maxWindow`): a source that
   *  draws its tones as the bands need them (an export's, on the tile grid)
   *  makes what it holds here, once. */
  reserve?(rows: number, passes: readonly TonePass[]): void
}

/** One pass a tone is asked for: a layer's type or its backing. */
export interface TonePass {
  layer: TextLayer
  kind: 'backing' | 'type'
}

const rowsOfTone = (t: PlateTone, w: number): ToneRows => ('rows' in t ? t.rows : wholeTone(t.field, w))

/**
 * Where a render has got to. Reported between its stages, which is where an
 * export yields to the page (`pressToSink`, `renderPrintAsync`): at every
 * band of the photo's luminance pass, before each pass on the press and
 * between its slow steps (after the tear, after the wear, after the switch's
 * luminance), and before each band's rows are printed.
 */
export interface RenderProgress {
  /**
   *  - `photo`: reading the photo, a band at a time, for the second ink's
   *    luminance (before the first band is pressed; only when a plate has a
   *    second ink over a photo);
   *  - `press`: pressing and printing band `band`;
   *  - `write`: every band done, the file being written (said by the save,
   *    not the engine).
   */
  step: 'photo' | 'press' | 'write'
  /** The band of rows, from 0, of `bands`: every band presses every pass and
   *  prints its rows. */
  band: number
  bands: number
}

/** Rows of the sheet printed between two yields: about a million pixels, a
 *  fraction of a second of compositing on a phone. */
const PRINT_BAND_PIXELS = 1 << 20

/** The photo's rows, a band at a time. */
export interface GroundRows {
  /** The ground's rows [y0, y1), RGBA, row y0 first: good until the next
   *  call. */
  rows(y0: number, y1: number): Uint8ClampedArray
}

/** The rows of a ground held whole: views of it, nothing copied. */
export function wholeGround(rgba: Uint8ClampedArray, w: number): GroundRows {
  return { rows: (a, b) => rgba.subarray(a * w * 4, b * w * 4) }
}

/**
 * Press every plate and print the sheet: everything after the type is
 * rasterised and the photo is blitted, which is everything that decides how
 * the print looks. Pure — no canvas — so the order of passes, the knockouts
 * and the second-ink split are tested on the real code rather than on a copy
 * of it.
 *
 * @param out    RGBA bytes, w*h*4, written in full.
 * @param ground the photo at sheet size (RGBA, or its rows a band at a time),
 *               or undefined with no photo; read, never written.
 * @returns every pass in print order, as composited (the last band's rows,
 *               when the sheet is pressed in more than one).
 */
export function printSheet(
  out: Uint8ClampedArray,
  s: PrintSettings,
  ground: GroundRows | Uint8ClampedArray | undefined,
  tones: ToneSource,
  noise: SheetNoise,
  w: number,
  h: number,
  opts: PrintOptions = {},
): CompositeLayer[] {
  return drain(printSheetSteps(out, s, ground, tones, noise, w, h, opts))
}

/** Run a staged render to the end, synchronously, and hand back its result. */
function drain<T>(steps: Generator<RenderProgress, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

export interface PrintOptions {
  /** Rows pressed and printed at a time: `bandHeight(w, h)` by default
   *  (BAND_PIXELS over the width; a sheet of up to 2 MP, every preview, is
   *  one band). A speed and memory knob only: every band height prints the
   *  same bytes. */
  bandRows?: number
  /** Called once every plate is pressed for the last time and the last
   *  band's photo rows are read, before the last rows are printed: what
   *  pressed the plates (an export's tile canvas) may be let go. */
  onPressed?: () => void
  /** Called once the photo's last rows are read: nothing reads the photo
   *  after it, so an export may close its decode. */
  onGround?: () => void
  /** Every band's planes as they are composited, rows [y0, y1) of the sheet
   *  from row y0 on (the harness's seam report reads what was inked). */
  onBand?: (layers: readonly CompositeLayer[], y0: number, y1: number) => void
  /** Where the photo's luminance grid is kept between two presses of the
   *  same print (a save's retry at a smaller band): taken from here when it
   *  is there, left here when it is made. It does not depend on the band. */
  luma?: { grid?: LumaGrid }
}

/**
 * The ground's luminance grid (media.ts LumaGrid), gathered from every band
 * of the photo in turn, yielding at each. A full-size blur (cell 1) takes the
 * workspace when it is the sheet's size (one band), as it always has; a
 * smaller one leaves it its own.
 */
function* groundLuminance(ground: GroundRows, w: number, h: number, B: number, radius: number, ws: Workspace): Generator<RenderProgress, LumaGrid> {
  const acc = new LumaAccumulator(w, h, radius)
  const bands = Math.ceil(h / B)
  for (let y0 = 0; y0 < h; y0 += B) {
    yield { step: 'photo', band: y0 / B, bands }
    const y1 = Math.min(h, y0 + B)
    acc.addRows(ground.rows(y0, y1), y0, y1)
  }
  const whole = ws.scratch.length >= w * h
  return acc.finish(whole ? ws.scratch : undefined, whole ? ws.work : undefined)
}

/** A band's switch mask rows, per switch point (see printSheetSteps). */
type SwitchMasks = Map<number, { stream?: GrainStream; rows: Uint8ClampedArray; band: number }>

/** The grain cell a switch mask is dithered at. */
const switchCell = (press: PressProfile, h: number) => grainCell(press.screenPitch, h / REFERENCE_HEIGHT)

/**
 * The switch masks' buffers. One buffer for every point, the mask remade in
 * it when the point changes, wherever a remade mask is the same bits: under
 * halftone always (a pure function of the point and the sheet's rows), and
 * under grain when the sheet is pressed as one band (a fresh stream over the
 * whole sheet is the dither the point's own stream would have run), which
 * is what the parent held. Only grain in bands needs more: each point's
 * stream emits each band's rows once, and plates can alternate points within
 * a band (0.5, 0.4, 0.5), so each point has its stream and its own buffer
 * for the band's rows.
 */
function switchMasks(plates: readonly Plate[], press: PressProfile, w: number, h: number, B: number): SwitchMasks {
  const masks: SwitchMasks = new Map()
  const perPoint = press.method === 'grain' && B < h
  const shared = perPoint ? null : new Uint8ClampedArray(B * w)
  for (const p of plates) {
    if (!p.split || masks.has(p.layer.contrastThreshold)) continue
    masks.set(p.layer.contrastThreshold, {
      stream: perPoint ? new GrainStream(w, h, switchCell(press, h)) : undefined,
      rows: shared ?? new Uint8ClampedArray(B * w),
      band: -1,
    })
  }
  return masks
}

/** One pass on the press, as the print sets it up. */
interface Plate {
  layer: TextLayer
  /** A backing (the block behind the type's lines) or the type. */
  kind: 'backing' | 'type'
  /** The pass's index in print order: its screen angle and its offset. */
  index: number
  fontSize: number
  geometry: PlateGeometry
  /** It cuts the photo back to paper under itself (a backing, or a second
   *  ink, over a photo). */
  cuts: boolean
  /** A second ink over a photo: which ink goes where. */
  split?: InkSplit
  /** Its grain stream, under grain: carried from band to band. */
  grain?: GrainStream
  /** Its coverage for the band, and its dark half's when it splits. */
  coverage: Uint8ClampedArray
  onDark?: Uint8ClampedArray
  /** Its tone, from the first band it is pressed in to the last. */
  tone?: ToneRows
}

/**
 * `printSheet`, in stages: it yields where it has got to between them. The
 * one implementation both entry points run — the preview drains it at once,
 * an export yields to the page at every step — so the two cannot print
 * different pixels.
 *
 * Band by band, top to bottom: for each band every plate is pressed in print
 * order (pressPlateBand: only the rows that band reads), its knockout cut and
 * its second ink split for those rows, and the band is printed. Nothing that
 * depends on a band's place is computed from the band: every noise, screen
 * and mask is keyed to the sheet's rows, error diffusion carries its state
 * from band to band, and the photo's luminance is gathered from every band
 * before the first is pressed. So every band height prints the same bytes,
 * and one band is the sheet pressed whole (a sheet of up to 2 MP, every
 * preview, is one band by default: `bandHeight`).
 *
 * Everything a band needs is made once, before the first band, at the
 * largest size any band needs, and reused (`maxWindow`): no band allocates.
 */
export function* printSheetSteps(
  out: SheetOutput,
  s: PrintSettings,
  ground: GroundRows | Uint8ClampedArray | undefined,
  tones: ToneSource,
  noise: SheetNoise,
  w: number,
  h: number,
  opts: PrintOptions = {},
): Generator<RenderProgress, CompositeLayer[]> {
  const B = Math.max(1, Math.min(h, Math.floor(opts.bandRows ?? bandHeight(w, h))))
  const bands = Math.ceil(h / B)
  const scale = h / REFERENCE_HEIGHT
  const groundRows = ground instanceof Uint8ClampedArray ? wholeGround(ground, w) : ground

  // Plate order is print order: a plate's backing goes down before its type,
  // so the type overprints the block into a third colour — what a real second
  // pass does.
  //
  // A plate takes a backing OR a second ink, never both, and that is held in
  // the reducer and the normaliser rather than decided here. The reason: the
  // second ink picks each glyph's ink from the PHOTO's luminance, but over a
  // backing the real ground is the block's ink on paper, so a light second
  // ink chosen for a dark patch of photo would land on the block and vanish.
  const sizeOf = (layer: TextLayer, kind: Plate['kind']) =>
    tones.size?.(layer) ?? (kind === 'type' ? tones.type(layer) : tones.backing(layer)).fontSize
  const plates: Plate[] = []
  for (const layer of s.layers) {
    for (const kind of layer.backing ? (['backing', 'type'] as const) : (['type'] as const)) {
      const index = plates.length
      const fontSize = sizeOf(layer, kind)
      const geometry = plateGeometry(s.press, { fontSize, index }, s.seed, h)
      const splits = kind === 'type' && !!layer.contrastInkId && !!groundRows
      plates.push({
        layer,
        kind,
        index,
        fontSize,
        geometry,
        cuts: !!groundRows && (kind === 'backing' || splits),
        // Which ink goes where is decided by what the inks *are*, not by which
        // field they were typed into. Keying it to the slot assumes the first
        // ink is the dark one, and the moment it isn't — white type over a
        // photograph, which is the ordinary case — the switch runs and puts
        // white on the sky and black on the water: both invisible, and worse
        // than not switching at all. The darker of the pair belongs on light
        // ground and the lighter on dark ground, whichever way round they were
        // chosen. The plate's own ink as its second ink is the one-colour case:
        // both halves print that ink, and the knockout keeps it readable.
        split: splits ? splitInks(inkById(layer.inkId).rgb, inkById(layer.contrastInkId!).rgb) : undefined,
        grain: geometry.grain ? new GrainStream(w, h, geometry.cell) : undefined,
        coverage: new Uint8ClampedArray(B * w),
      })
    }
  }
  for (const p of plates) if (p.split) p.onDark = new Uint8ClampedArray(B * w)

  // One set of working buffers for every band and every plate (see
  // Workspace), at the largest window any of them needs.
  const windowRows = maxWindow(plates, B, h)
  let ws = makeWorkspace(windowRows, w)
  // A source that draws its tones as the bands read them makes what it
  // holds now, with everything else (an export's rings of glyph tiles).
  tones.reserve?.(windowRows, plates)

  // Where the photo is cut back to paper, accumulated across plates: under
  // the second ink wherever that ink cannot print on what is there, and under
  // every backing. A transparent light ink over a solid dark area is still a
  // solid dark area, so without this neither buys anything.
  // Held in bytes (0..255): only the anti-aliased skirt of a hole is between.
  const knock = plates.some((p) => p.cuts) ? new Uint8ClampedArray(B * w) : undefined

  // The ground's blurred luminance, held as a small grid (media.ts LumaGrid),
  // gathered from every band of the photo before the first is pressed, and
  // read back a band at a time into the workspace for each plate that
  // switches. Blurred across roughly a word of the FIRST plate that switches.
  // Anything finer and the mask reads the photograph's own grain — the
  // glitter on water is the same value as white ink and about the size of a
  // letter, so a tighter blur decides light-or-dark differently inside a
  // single word. A word is the unit legibility is actually judged in, so it
  // is the unit that commits.
  //
  // (Made in functions of their own, here and below: a generator's suspended
  // frame keeps every local it ever set, so a block-scoped accumulator or
  // buffer here would be held through every band and the print.)
  const firstSplit = plates.find((p) => p.split)
  let lumaGrid = firstSplit && groundRows ? (opts.luma?.grid ?? (yield* groundLuminance(groundRows, w, h, B, Math.max(2, firstSplit.fontSize * 1.5), ws))) : undefined
  // Kept for a press run again (a retry at another band height): the grid
  // does not depend on the band.
  if (opts.luma && lumaGrid) opts.luma.grid = lumaGrid

  // The screen index every switch mask is made at: the first one's (its
  // index + 1: the pass after it, as it always was). A mask is then a
  // function of its switch point alone, so moving one plate's point can never
  // turn another plate's dots — which it did while a rebuilt mask took the
  // rebuilding plate's angle, and a shared one the first plate's.
  const switchIndex = firstSplit ? firstSplit.index + 1 : 0
  // The screened "ground is light" mask for a band. Every plate switches at
  // its own point; plates that share one (the default: all at 50%) share the
  // mask. A halftone mask is a function of the point and the sheet's rows,
  // so one buffer is remade when the point changes, and so is a grain mask
  // on a sheet of one band; a grain mask in bands is error diffusion, a
  // stream run once per band, so each point has its own stream and its own
  // buffer for the band's rows (switchMasks).
  let masks = firstSplit ? switchMasks(plates, s.press, w, h, B) : undefined
  /** Which point the shared mask holds this band's rows for. */
  let screened: number | undefined

  // The printed rows: straight into `out`, or a band at a time into its
  // buffer and handed on (to the canvas), so the canvas, which already holds
  // the print, is not held a second time in a full-size array.
  const banded = out instanceof Uint8ClampedArray ? null : out
  const printRows = Math.min(h, banded ? banded.rows : Math.max(1, Math.floor(PRINT_BAND_PIXELS / w)))
  const sampled = noise.paper instanceof PaperSampler ? noise.paper : null
  // A sampled paper is a band of shade at a time (a band's rows, or the
  // output's if fewer). Made with everything else when there are bands to
  // share it; for one band, once the plates are pressed and their workspace
  // let go, as the print always made it.
  const shadeRows = Math.min(B, printRows)
  let shade = sampled && bands > 1 ? new Float32Array(shadeRows * w) : null

  // Each pass is pressed in a function of its own, so that what it holds — its
  // luminance rows, its mask's soft rows — is let go when it returns. This
  // generator's own locals would stay held, in its suspended frame, through
  // every later band and the print.
  function* pressBand(p: Plate, y0: number, y1: number, band: number): Generator<RenderProgress, void> {
    const at: RenderProgress = { step: 'press', band, bands }
    yield at
    p.tone ??= rowsOfTone(p.kind === 'type' ? tones.type(p.layer) : tones.backing(p.layer), w)
    const pressed = yield* pressPlateBandSteps(
      { rows: p.tone, fontSize: p.fontSize },
      p.index,
      s.press,
      s.seed,
      noise,
      w,
      h,
      { y0, y1 },
      ws,
      p.coverage,
      { cuts: p.cuts, grain: p.grain },
      at,
    )
    // Its last band: the tone is let go.
    if (y1 === h) p.tone = undefined
    const n = (y1 - y0) * w

    if (p.kind === 'backing') {
      // The block prints on paper: the photo is cut back under its own torn,
      // misregistered outline, so a pale block over a dark photo still reads.
      if (knock) cutKnockoutRows(knock, y0, pressed.torn, pressed.tornRow0, null, { w, h, dx: pressed.dx, dy: pressed.dy, y0, y1 })
      return
    }
    if (!p.split || !lumaGrid || !masks || !knock || !p.onDark) return

    // One pass whose ink changes with what is under it — a split fountain
    // driven by the image rather than by position across the drum. Pressed
    // once and then split, so the letterforms stay coherent; pressing twice
    // would misregister the two halves against each other and tear every
    // glyph that happens to straddle the boundary.
    //
    // The ground's luminance for the band, read back into the workspace's
    // scratch, free now that the plate is pressed; it stays there through
    // this plate's mask and knockout.
    const groundLum = sampleLumaRows(lumaGrid, y0, y1, ws.scratch.subarray(0, n))
    yield at
    // Screened, not left soft. A soft mask makes *both* inks print at
    // partial coverage through the transition, which is an opacity
    // crossfade wearing a print's clothes — and it is why the switch point
    // read as a fade rather than as a switch. Running the mask through the
    // same screen or dither the press is already using makes the changeover
    // a real pattern: each ink lands at full strength, and the boundary
    // breaks up into dots the way a two-colour job actually does.
    const threshold = p.layer.contrastThreshold
    const mask = masks.get(threshold)!
    const light = mask.rows.subarray(0, n)
    // Grain: a stream reads its own rows (two cell rows ahead of the band):
    // their luminance and their soft mask, in the workspace's other buffer.
    const dither = (stream: GrainStream) => {
      const need = stream.need(y0, y1)
      const soft = ws.work.subarray(0, (need.b - need.a) * w)
      bandMask(sampleLumaRows(lumaGrid!, need.a, need.b, soft), threshold, SWITCH_BAND, soft)
      stream.run(soft, need.a, y0, y1, light)
    }
    if (mask.stream) {
      if (mask.band !== band) {
        dither(mask.stream)
        mask.band = band
      }
    } else if (screened !== threshold) {
      if (s.press.method === 'grain') {
        // One band: the whole sheet, by a fresh stream.
        dither(new GrainStream(w, h, switchCell(s.press, h)))
      } else {
        const soft = bandMask(groundLum, threshold, SWITCH_BAND, ws.work.subarray(0, n))
        light.fill(0)
        screenField(soft, w, y1 - y0, { ...switchScreen(switchIndex, s.press, s.seed, scale), row0: y0 }, light)
      }
      screened = threshold
    }

    // The mask is hard (0 or 255), so each half is the coverage or nothing.
    // The light half takes the coverage's own buffer.
    const coverage = p.coverage
    const onDark = p.onDark
    for (let i = 0; i < n; i++) {
      onDark[i] = (coverage[i] * (255 - light[i])) / 255
      coverage[i] = (coverage[i] * light[i]) / 255
    }

    // Cut from the *same artwork the plate is*, torn by the same stencil and
    // moved by the same paper feed — the plate's own roughened tone and
    // offset, so the hole lands exactly where the ink does. Cutting it from
    // the raw tone instead leaves the hole a couple of pixels off, and the
    // only way to cover that gap is to spread the hole: on a poster a trap,
    // at text size a flood that swells every counter shut.
    cutKnockoutRows(knock, y0, pressed.torn, pressed.tornRow0, groundLum, {
      w,
      h,
      dx: pressed.dx,
      dy: pressed.dy,
      y0,
      y1,
      split: { light, onLightLuma: p.split.onLightLuma, onDarkLuma: p.split.onDarkLuma },
    })
  }

  // The plates as composited, in print order: a split plate is two.
  const layers: CompositeLayer[] = []
  for (const p of plates) {
    if (p.split && p.onDark) {
      layers.push({ coverage: p.coverage, rgb: p.split.onLight })
      layers.push({ coverage: p.onDark, rgb: p.split.onDark })
    } else {
      layers.push({ coverage: p.coverage, rgb: inkById(p.kind === 'backing' ? p.layer.backing! : p.layer.inkId).rgb })
    }
  }

  for (let band = 0; band < bands; band++) {
    const y0 = band * B
    const y1 = Math.min(h, y0 + B)
    if (knock) knock.fill(0, 0, (y1 - y0) * w)
    screened = undefined
    for (const p of plates) yield* pressBand(p, y0, y1, band)

    // The photo is the ground, so knocking out means taking its alpha down and
    // letting the paper underneath come back through. That alpha path is also
    // what a transparent PNG's own transparency takes: both read as paper. Done
    // as each pixel is printed (compositeLayers), not on a copy of the ground.
    // Read before the last band lets go of what it pressed with: a photo
    // drawn on the tile grid is drawn with the same canvas.
    const base = groundRows?.rows(y0, y1)

    if (y1 === h) {
      // Pressed for the last time and the photo read for the last time: the
      // working buffers, the ground's luminance, the masks and the streams
      // are let go (a suspended generator would otherwise hold them through
      // the print), and the caller may let go of the photo and of whatever it
      // pressed with.
      ws = RELEASED
      lumaGrid = undefined
      masks = undefined
      for (const p of plates) p.grain = undefined
      if (groundRows) opts.onGround?.()
      opts.onPressed?.()
    }
    opts.onBand?.(layers, y0, y1)
    const ground_ = base ? { base, knockout: knock, paperAmount: s.paperVeil ? 1 : 0 } : {}
    if (sampled) shade ??= new Float32Array(shadeRows * w)
    // Printed in rows of the output's band (or about a million pixels), so an
    // export hands the page a moment between them, a sampled paper is only
    // ever a band of shade, and the printed pixels only ever a band before
    // they are on the canvas.
    for (let p0 = y0; p0 < y1; p0 += shadeRows) {
      yield { step: 'press', band, bands }
      const p1 = Math.min(y1, p0 + shadeRows)
      let paper: PaperInput
      if (sampled && shade) {
        sampled.rows(p0, p1, shade)
        paper = { shade, shadeRow0: p0, rgb: sampled.rgb, ...ground_ }
      } else {
        paper = { ...(noise.paper as PaperField), ...ground_ }
      }
      if (banded) {
        compositeLayers(banded.band, w, h, paper, layers, p0, p1, p0, y0)
        banded.put(p0, p1)
      } else {
        compositeLayers(out as Uint8ClampedArray, w, h, paper, layers, p0, p1, 0, y0)
      }
    }
  }
  return layers
}

/**
 * Where the printed sheet goes: its whole RGBA (w*h*4), or a band of rows at a
 * time — `band` holds up to `rows` rows, and `put(y0, y1)` takes rows
 * [y0, y1) from it (to the canvas) before it is reused for the next band.
 */
export type SheetOutput = Uint8ClampedArray | { band: Uint8ClampedArray; rows: number; put(y0: number, y1: number): void }

/**
 * Where the photo is drawn on a w x h sheet: from the document's placement and
 * the photo's TRUE size, and nothing else. Whatever bitmap is drawn — the
 * preview's reduced working copy or the full original at Save — fills this
 * same rectangle, so the preview and the print place the photo identically.
 *
 * Snapped (`snapRect`) when the sheet holds the photo at its own pixels, so a
 * native export copies pixels instead of resampling them by a fraction.
 */
export function groundRect(media: MediaLayer, w: number, h: number): DrawRect {
  return snapRect(coverRect({ width: media.width, height: media.height }, w, h, media), media.width, media.height, w, h)
}

/**
 * Whether a photo lands on the sheet at its own pixels: drawn at exactly its
 * size (`r` is `mw` x `mh`) at a whole-pixel offset. Every native export is
 * (`snapRect`), and so is a smaller copy decoded to its rectangle. Such a
 * ground is a copy of the photo's pixels at any origin, so it is drawn a band
 * at a time; any other is resampled and drawn on the tile grid.
 */
export function isNativeRect(r: DrawRect, mw: number, mh: number): boolean {
  return r.dw === mw && r.dh === mh && Number.isInteger(r.dx) && Number.isInteger(r.dy)
}

/** The pixel size of something drawImage draws, when it says (an ImageBitmap,
 *  a canvas, an image); 0 when it does not. */
export function sourceSize(media: CanvasImageSource): { width: number; height: number } {
  const m = media as { width?: unknown; height?: unknown }
  return { width: typeof m.width === 'number' ? m.width : 0, height: typeof m.height === 'number' ? m.height : 0 }
}

/** Size a canvas, only if it is not that size already (sizing clears it and
 *  resets its state, and allocates its pixels again). */
function sizeCanvas(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (ctx.canvas.width !== w) ctx.canvas.width = w
  if (ctx.canvas.height !== h) ctx.canvas.height = h
}

/**
 * A photo at its own pixels, a band of rows at a time: each band blits its
 * own rows, in column pieces at most `edge` wide, into a piece canvas with
 * smoothing OFF (a nearest copy, so a 1:1 blit is the photo's pixels at any
 * origin, on every engine measured: Chromium, and an iPhone's WebKit in the
 * device spike), read back into the one band buffer made here. Nothing of
 * the sheet's size is held, and no tile ring: every band draws only its rows.
 */
class NativeGroundRows implements GroundRows {
  private readonly band: Uint8ClampedArray
  private readonly pieceW: number
  private readonly pieceH: number

  constructor(
    private readonly media: CanvasImageSource,
    private readonly r: DrawRect,
    private readonly w: number,
    private readonly piece: CanvasRenderingContext2D,
    rows: number,
    edge: number,
  ) {
    this.pieceW = Math.max(1, Math.min(w, Math.floor(edge)))
    this.pieceH = Math.max(1, rows)
    this.band = new Uint8ClampedArray(this.pieceH * w * 4)
    sizeCanvas(piece, this.pieceW, this.pieceH)
  }

  rows(y0: number, y1: number): Uint8ClampedArray {
    const { piece, media, r, w } = this
    if (y1 - y0 > this.pieceH) throw new RangeError(`NativeGroundRows: ${y1 - y0} rows asked of a band of ${this.pieceH}`)
    for (let x0 = 0; x0 < w; x0 += this.pieceW) {
      const pw = Math.min(this.pieceW, w - x0)
      piece.clearRect(0, 0, this.pieceW, this.pieceH)
      piece.imageSmoothingEnabled = false
      piece.drawImage(media, r.dx - x0, r.dy - y0, r.dw, r.dh)
      readRgba(piece, pw, y1 - y0, this.band, w, x0)
    }
    return this.band.subarray(0, (y1 - y0) * w * 4)
  }
}

/** Draw a photo, resampled into `part` of a w x h sheet at the rectangle
 *  `r`, on a cleared canvas exactly the part's size: the call the whole
 *  sheet's ground was always drawn with, moved to the part's origin. */
function drawGroundPart(ctx: CanvasRenderingContext2D, media: CanvasImageSource, r: DrawRect, part: SheetPart): void {
  ctx.clearRect(0, 0, part.w, part.h)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(media, r.dx - part.x0, r.dy - part.y0, r.dw, r.dh)
}

/** Fills `slot` with tile row `ty` of the sheet: every tile of the row,
 *  drawn and read back into its columns (the sheet's width a row, from the
 *  tile row's first row). */
export type TileRowLoader<T> = (ty: number, slot: T) => void

/**
 * A photo that is NOT at its own pixels (a small photo enlarged to the
 * reference height, or any height the harness asks for): resampled, which is
 * not the same bytes under translation, so it is drawn on the tile grid
 * (absolute tiles, each drawn with smoothing 'high' as the whole sheet was:
 * `groundTiles`) into one ring shared by the luminance pass and the press. A
 * sheet of one tile is drawn as it always was.
 */
export class TiledGroundRows implements GroundRows {
  private readonly cache: TileRowCache<Uint8ClampedArray<ArrayBuffer>>
  private readonly span: Uint8ClampedArray<ArrayBuffer>

  /** @param rows the most rows a band asks for at once. */
  constructor(
    private readonly grid: TileGrid,
    rows: number,
    load: TileRowLoader<Uint8ClampedArray<ArrayBuffer>>,
  ) {
    const { w, h, tileH } = grid
    this.cache = new TileRowCache(ringRows(grid, rows), () => new Uint8ClampedArray(w * Math.min(tileH, h) * 4), load)
    this.span = new Uint8ClampedArray(grid.rows > 1 ? Math.min(rows, h) * w * 4 : 0)
  }

  rows(y0: number, y1: number): Uint8ClampedArray {
    return rowsFromTiles(this.grid, this.cache, 4, this.span, y0, y1)
  }
}

/** The photo's tiles, resampled at `r`, drawn into the tile canvas one at a
 *  time and read back into a tile row of RGBA. */
function groundTiles(ctx: CanvasRenderingContext2D, media: CanvasImageSource, r: DrawRect, grid: TileGrid): TileRowLoader<Uint8ClampedArray> {
  return (ty, slot) => {
    for (let cx = 0; cx < grid.cols; cx++) {
      const t = tileAt(grid, cx, ty)
      sizeCanvas(ctx, t.w, t.h)
      drawGroundPart(ctx, media, r, t)
      readRgba(ctx, t.w, t.h, slot, grid.w, t.x0)
    }
  }
}

/**
 * An export's glyph tones, on the tile grid: each pass's tone read from a
 * ring of its tile rows, filled by `load` as the bands reach them
 * (`glyphTiles`: every tile of the row drawn into the one tile canvas and its
 * alpha read back). `reserve` makes the rings, once, before the first band.
 */
export class TiledTones implements ToneSource {
  private rings = new Map<string, TileRowCache<Uint8Array<ArrayBuffer>>>()
  private span: Uint8Array<ArrayBuffer> = new Uint8Array(0)

  constructor(
    private readonly grid: TileGrid,
    private readonly load: (pass: TonePass, ty: number, slot: Uint8Array) => void,
  ) {}

  size(layer: TextLayer): number {
    return plateFontSize(layer, this.grid.h)
  }

  reserve(rows: number, passes: readonly TonePass[]): void {
    const { w, h, tileH } = this.grid
    // What an earlier press made goes before anything new is made.
    this.release()
    this.span = new Uint8Array(this.grid.rows > 1 ? Math.min(rows, h) * w : 0)
    for (const pass of passes) {
      const { layer, kind } = pass
      this.rings.set(
        `${kind}:${layer.id}`,
        new TileRowCache(ringRows(this.grid, rows), () => new Uint8Array(w * Math.min(tileH, h)), (ty, slot) => this.load({ layer, kind }, ty, slot)),
      )
    }
  }

  private tone(layer: TextLayer, kind: TonePass['kind']): PlateTone {
    const ring = this.rings.get(`${kind}:${layer.id}`)
    if (!ring) throw new Error(`TiledTones: no ring for the ${kind} of "${layer.id}" (reserve first)`)
    return { rows: { rows: (a, b) => rowsFromTiles(this.grid, ring, 1, this.span, a, b) }, fontSize: this.size(layer) }
  }

  type(layer: TextLayer): PlateTone {
    return this.tone(layer, 'type')
  }

  backing(layer: TextLayer): PlateTone {
    return this.tone(layer, 'backing')
  }

  /** Let the rings go (the press is done with them). */
  release(): void {
    this.rings = new Map()
    this.span = new Uint8Array(0)
  }
}

/** Every pass's glyph tiles (or backing tiles), drawn into the tile canvas
 *  one at a time and read back into a tile row of alpha. One layout per
 *  layer (`planGlyphs`), made once and kept in `plans`: every tile draws the
 *  same calls, only the tile's origin differs. */
function glyphTiles(ctx: CanvasRenderingContext2D, grid: TileGrid, plans: Map<string, GlyphPlan>): (pass: TonePass, ty: number, slot: Uint8Array) => void {
  return ({ layer, kind }, ty, slot) => {
    let plan = plans.get(layer.id)
    if (!plan) {
      plan = planGlyphs(ctx, layer, grid.h)
      plans.set(layer.id, plan)
    }
    for (let cx = 0; cx < grid.cols; cx++) {
      const t = tileAt(grid, cx, ty)
      sizeCanvas(ctx, t.w, t.h)
      if (kind === 'type') drawGlyphs(ctx, plan, layer, grid.w, grid.h, t)
      else drawBacking(ctx, plan, layer, grid.w, grid.h, t)
      readAlpha(ctx, t.w, t.h, slot, grid.w, t.x0)
    }
  }
}

/** What an export draws on. */
export interface ExportCanvases {
  /** The tile canvas: every glyph tile, and a resampled photo's tiles, are
   *  drawn into it in turn, sized to each tile (clipped to the sheet: a
   *  sheet of one tile is drawn on a canvas of its own size). */
  tile: CanvasRenderingContext2D
  /** A canvas for a photo at its own pixels, blitted a band at a time: made
   *  when such a photo is pressed. */
  piece?: () => CanvasRenderingContext2D
}

export interface ExportPressOptions {
  /** Rows pressed at a time; `bandHeight(w, h)` by default. */
  bandRows?: number
  /** The tile grid's budget; TILE_BUDGET by default (a test forces small
   *  tiles with it). */
  tileBudget?: TileBudget
  /** As renderPrint's `onGround`: fired once the photo's last rows are read. */
  onGround?: () => void
  /** See PrintOptions.onBand. */
  onBand?: PrintOptions['onBand']
  /** The plates' layouts, by layer id: made on first use and kept here, so
   *  a press run again (a retry) does not lay the type out again. */
  plans?: Map<string, GlyphPlan>
  /** See PrintOptions.luma. */
  luma?: PrintOptions['luma']
  /** Where the photo lands, when not where the document puts it: a smaller
   *  copy, decoded to the integer rectangle it fills (media.ts
   *  `snapCopyRect`), so it is drawn at its own pixels. */
  rect?: DrawRect
}

/**
 * An export's press, in stages: the band engine fed from the tile grid. No
 * canvas, array or tone of the sheet's size is made here: the glyphs come off
 * the tile grid a tile row at a time, the photo a band at a time (at its own
 * pixels) or off the tile grid (resampled), the noise is sampled where it is
 * printed, and the printed rows go to `out` a band at a time.
 */
function* exportSteps(
  out: SheetOutput,
  s: PrintSettings,
  height: number,
  media: CanvasImageSource | null,
  canvases: ExportCanvases,
  opts: ExportPressOptions,
): Generator<RenderProgress, void> {
  const { w, h } = outputSize(sheetAspect(s), height)
  const grid = tileGrid(w, h, opts.tileBudget)
  const B = Math.max(1, Math.min(h, Math.floor(opts.bandRows ?? bandHeight(w, h))))
  const noise = sampledNoise(s, w, h)
  const tones = new TiledTones(grid, glyphTiles(canvases.tile, grid, opts.plans ?? new Map()))

  let ground: GroundRows | undefined
  let piece: CanvasRenderingContext2D | null = null
  if (media && s.media) {
    const r = opts.rect ?? groundRect(s.media, w, h)
    const size = sourceSize(media)
    if (isNativeRect(r, size.width, size.height)) {
      if (!canvases.piece) throw new Error('A photo at its own pixels is pressed a band at a time, on a canvas the export hands over.')
      piece = canvases.piece()
      ground = new NativeGroundRows(media, r, w, piece, B, (opts.tileBudget ?? TILE_BUDGET).edge)
    } else {
      ground = new TiledGroundRows(grid, B, groundTiles(canvases.tile, media, r, grid))
    }
  } else {
    opts.onGround?.()
  }

  yield* printSheetSteps(out, s, ground, tones, noise, w, h, {
    bandRows: B,
    onGround: opts.onGround,
    onBand: opts.onBand,
    luma: opts.luma,
    // The tiles are done once the plates are and the photo is read: the
    // rings and the tile canvas go before the last rows are printed.
    onPressed: () => {
      tones.release()
      canvases.tile.canvas.width = 0
      if (piece) piece.canvas.width = 0
    },
  })
}

/**
 * Render a full print.
 *
 * Synchronous: this is the preview's entry point, run inside one animation
 * frame. An export runs the same stages through `renderPrintAsync`.
 *
 * @param ctx     the target context. Its canvas is resized to the output size.
 * @param scratch a same-sized scratch context used for glyph rasterisation.
 * @param overlay editing aids, or null. Export paths pass null.
 */
export function renderPrint(
  ctx: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  s: PrintSettings,
  cacheRef: { current: RenderCache | null },
  overlay: OverlaySpec | null,
  height: number = REFERENCE_HEIGHT,
  /** The decoded photo, or null. Drawn with drawImage rather than sampled in
   *  JS: four million bilinear samples per frame is not a phone budget. Any
   *  decode of it will do — the preview's working copy or the original — as it
   *  is drawn scaled into the rectangle the photo's TRUE size (`s.media`)
   *  gives, never one its own size gives. */
  media: CanvasImageSource | null = null,
  /** Called once the photo has been copied into the ground, when nothing
   *  further reads `media`. */
  onGround?: () => void,
): void {
  drain(previewSteps(ctx, scratch, s, cacheRef, overlay, height, media, onGround))
}

export interface AsyncRenderOptions extends ExportPressOptions {
  /** Checked at every step; once aborted, the render stops there and rejects
   *  with an AbortError. */
  signal?: AbortSignal
  /** Where the render has got to, at every step. */
  onProgress?: (progress: RenderProgress) => void
  /** Makes the canvas a photo at its own pixels is blitted into, a band at
   *  a time (`ExportCanvases.piece`). */
  makeCanvas?: () => CanvasRenderingContext2D
}

/**
 * Render a full print for the parity gate and the harness: the export's
 * press (`exportSteps`: the band engine on the tile grid, what Save runs
 * through `pressToSink`), painted into `ctx` a band at a time instead of
 * encoded, with a yield to the event loop between its steps. Never an
 * overlay, and no cache: a one-shot render reads its noise where it prints it
 * (bit for bit the preview's arrays) and keeps nothing for a next frame.
 *
 * On a sheet of one tile (up to 4.19 MP, at most 4096 wide: every height the
 * preview and the harness record) it prints exactly the pixels the preview
 * does (harness `--parity`). Above that the export rasterises type on the
 * tile grid, which the preview never does (README "The glyphs and a resampled
 * photo on a tile grid").
 *
 * @param scratch the tile canvas (`ExportCanvases.tile`).
 */
export async function renderPrintAsync(
  ctx: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  s: PrintSettings,
  height: number,
  media: CanvasImageSource | null,
  opts: AsyncRenderOptions = {},
): Promise<void> {
  const { w, h } = outputSize(sheetAspect(s), height)
  sizeCanvas(ctx, w, h)
  // The sheet is printed a band of rows at a time into one band-sized buffer,
  // and each band put on the canvas: the canvas already holds the print, so
  // it is not held a second time in a full-size array.
  const rows = Math.max(1, Math.min(h, Math.floor(PRINT_BAND_PIXELS / w)))
  const image = ctx.createImageData(w, rows)
  const out: SheetOutput = { band: image.data, rows, put: (y0, y1) => ctx.putImageData(image, 0, y0, 0, 0, w, y1 - y0) }
  await drive(exportSteps(out, s, height, media, { tile: scratch, piece: opts.makeCanvas }, opts), opts)
}

/**
 * Where an export's printed rows go, a band at a time: the save's encoder.
 *
 *  - `put(rgba, rows)` takes `rows` rows of RGBA from `rgba[0]` BEFORE it
 *    returns: the band buffer is reused at once;
 *  - `settled()` resolves once what was put has been taken (a compressor's
 *    backpressure: the press waits on it after every step, so at most a band
 *    is ever queued);
 *  - `finish()` ends the file; `abort()` drops it and leaves nothing pending.
 */
export interface RowSink {
  put(rgba: Uint8ClampedArray, rows: number): void
  settled(): Promise<void>
  finish(): Promise<void>
  abort(): void
}

export interface PressOptions extends ExportPressOptions {
  /** Checked at every step; once aborted, the press stops there and rejects
   *  with an AbortError. */
  signal?: AbortSignal
  /** Where the press has got to, at every step. */
  onProgress?: (progress: RenderProgress) => void
  /** What the press draws on. */
  canvases: ExportCanvases
}

/**
 * Press a print for Save: the export's press (`exportSteps`), its printed
 * rows handed to `sink` a band at a time, with a yield to the page and the
 * sink's backpressure awaited between its steps, so a press of minutes leaves
 * the page painting its progress and taking a Cancel. No canvas, array or
 * file buffer of the sheet's size: the band buffer here (`bandRows` rows) is
 * the only output the press holds. `sink.finish()` is the caller's.
 */
export async function pressToSink(
  s: PrintSettings,
  height: number,
  media: CanvasImageSource | null,
  sink: RowSink,
  opts: PressOptions,
): Promise<void> {
  const { w, h } = outputSize(sheetAspect(s), height)
  const B = Math.max(1, Math.min(h, Math.floor(opts.bandRows ?? bandHeight(w, h))))
  const band = new Uint8ClampedArray(B * w * 4)
  const out: SheetOutput = { band, rows: B, put: (y0, y1) => sink.put(band.subarray(0, (y1 - y0) * w * 4), y1 - y0) }
  await drive(exportSteps(out, s, height, media, opts.canvases, { ...opts, bandRows: B }), opts, () => sink.settled())
}

/** Run a press's steps, yielding to the page (and awaiting `settled`, when
 *  given) after every one; stopped by the signal. */
async function drive(
  steps: Generator<RenderProgress, void>,
  opts: { signal?: AbortSignal; onProgress?: (progress: RenderProgress) => void },
  settled?: () => Promise<void>,
): Promise<void> {
  try {
    for (;;) {
      throwIfAborted(opts.signal)
      const next = steps.next()
      if (next.done) return
      opts.onProgress?.(next.value)
      await yieldToPage()
      if (settled) await settled()
    }
  } finally {
    // An abandoned press runs its generator's cleanup too.
    steps.return(undefined)
  }
}

/** A macrotask: the page paints and takes input before the render goes on. */
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Stop, with an AbortError, once the save is cancelled (export.ts checks it
 *  after encoding too). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The save was cancelled.', 'AbortError')
}

/**
 * The preview's render, in stages: the whole sheet in one canvas, its glyph
 * rasters and noise cached across frames (`RenderCache`). A preview is under
 * 2 MP, so it is one band and one tile: the band engine presses it whole.
 */
function* previewSteps(
  ctx: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  s: PrintSettings,
  cacheRef: { current: RenderCache | null },
  overlay: OverlaySpec | null,
  height: number,
  media: CanvasImageSource | null,
  onGround: (() => void) | undefined,
): Generator<RenderProgress, void> {
  const { w, h } = outputSize(sheetAspect(s), height)
  sizeCanvas(ctx, w, h)
  sizeCanvas(scratch, w, h)

  const cache = ensureCache(cacheRef.current, s, w, h)
  cacheRef.current = cache

  // The photo is laid down first — before any type is rasterised — because the
  // type needs to know what is underneath it before it can decide what colour
  // to be. `ground` is a copy, so `scratch` is free for glyph rasterisation
  // immediately after.
  let ground: Uint8ClampedArray | undefined
  if (media && s.media) {
    yield { step: 'photo', band: 0, bands: 1 }
    drawGroundPart(scratch, media, groundRect(s.media, w, h), { x0: 0, y0: 0, w, h })
    ground = new Uint8ClampedArray(w * h * 4)
    readRgba(scratch, w, h, ground, w)
  }
  onGround?.()

  const rows = Math.max(1, Math.min(h, Math.floor(PRINT_BAND_PIXELS / w)))
  const image = ctx.createImageData(w, rows)
  yield* printSheetSteps(
    { band: image.data, rows, put: (y0, y1) => ctx.putImageData(image, 0, y0, 0, 0, w, y1 - y0) },
    s,
    ground,
    {
      type: (layer) => cachedTone(scratch, layer, cache, w, h),
      backing: (layer) => cachedBackingTone(scratch, layer, cache, w, h),
      size: (layer) => plateFontSize(layer, h),
    },
    cache,
    w,
    h,
  )

  if (overlay) drawOverlay(ctx, s, overlay, w, h)
}

/**
 * Editing aids, drawn last and only when an overlay spec is present.
 *
 * Kept in this file so it is obvious at the call site that the export path
 * skips it, rather than hidden behind a flag somewhere downstream.
 */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  s: PrintSettings,
  overlay: OverlaySpec,
  w: number,
  h: number,
): void {
  ctx.save()
  const unit = h / REFERENCE_HEIGHT

  const selected = s.layers.find((l) => l.id === overlay.selectedLayerId)
  if (selected) {
    const cx = selected.x * w
    const cy = selected.y * h
    const r = 14 * unit
    ctx.lineWidth = Math.max(1.5, 2 * unit)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.moveTo(cx - r * 1.6, cy)
    ctx.lineTo(cx + r * 1.6, cy)
    ctx.moveTo(cx, cy - r * 1.6)
    ctx.lineTo(cx, cy + r * 1.6)
    ctx.stroke()
  }

  ctx.restore()
}
