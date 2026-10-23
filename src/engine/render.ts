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

import { compositeLayers, type CompositeLayer, type PaperInput } from './composite.ts'
import { ditherField } from './dither.ts'
import { applyDensity, applyMottle, edgeToRough, registrationOffset, shiftField, wearToMottle } from './ink.ts'
import { inkById, paperById } from './inks.ts'
import { roughenEdges } from './rough.ts'
import { PaperSampler, paperField, type PaperField, type PaperOptions, type PaperSource } from './paper.ts'
import { FbmSampler, fbm2D, type CellNoise } from './rng.ts'
import { defaultAngle, screenField, type ScreenOptions } from './screen.ts'
import { knockoutMask } from './knockout.ts'
import { bandMask, coverRect, groundLuma, snapRect, splitInks, type DrawRect } from './media.ts'
import { rasterizeBacking, rasterizeText } from './text.ts'
import { REFERENCE_HEIGHT, passCount } from './limits.ts'
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

const toneOf = (r: { tone: ToneField; fontSize: number }) => ({ field: r.tone, fontSize: r.fontSize })

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
 *  field is converted (b / 255, as float32), a float field is used as is. */
export function toneAsFloat(tone: ToneField): Float32Array {
  if (tone instanceof Float32Array) return tone
  const out = new Float32Array(tone.length)
  for (let i = 0; i < tone.length; i++) out[i] = tone[i] / 255
  return out
}

/** A plate after the press, and what a knockout under it has to match. */
export interface PressedPlate {
  /** Screened coverage in bytes, 0..255: a quarter of a float field, held for
   *  every pass until the sheet is printed. */
  coverage: Uint8ClampedArray
  roughened: Float32Array
  dx: number
  dy: number
}

/**
 * Run the press over one tone field: everything from the stencil edge to the
 * screen. Shared by type and by backings — a backing that skipped this would be
 * the one clean, undistressed rectangle on an otherwise convincingly printed
 * sheet.
 *
 * Returns the screened coverage, and with it the two things a knockout under
 * this plate has to match exactly: the roughened tone (the plate's torn, bled
 * outline, before density and wear) and the offset the plate landed at. Handing
 * them on is what lets the knockout follow the plate without pressing it twice.
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
): PressedPlate {
  const tone = toneAsFloat(plate.field)
  const scale = h / REFERENCE_HEIGHT
  const detail = detailFactor(plate.fontSize, h)
  const edge = edgeToRough(s.edge)
  const wear = wearToMottle(s.wear)

  // Ragged stencil edge + ink spread, before anything downstream sees the
  // outline. Seeded per plate so two plates don't tear identically.
  const rough = roughenEdges(tone, w, h, {
    roughness: edge.roughness,
    // Unfloored: roughenEdges needs the size that was actually asked for,
    // not a whole number, or it cannot tell a fine tear from a clamped one.
    scale: TEAR_SCALE * scale * detail,
    // Bleed is a threshold offset, so at small sizes it eats the counters —
    // the holes in a, e, o fill and the word turns into a row of blobs.
    bleed: edge.bleed * detail,
    seed: seed ^ (index * 0x9e3779b9),
  })

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
  const worn = applyMottle(
    applyDensity(rough, s.density),
    noise.mottle,
    noise.speckle,
    wear.mottle * detail,
    wear.dropout * detail,
    w,
    h,
    detail,
  )

  // Misregistration is a paper-feed error, physically the same for the whole
  // sheet — but at 5px it obliterates 20px type while barely showing on a
  // poster. Scaled by sqrt so it stays visible on small type without eating it.
  const { dx, dy } = registrationOffset(seed, index, s.misregistration * scale * Math.sqrt(detail))
  const shifted = shiftField(worn, w, h, dx, dy)

  // Screened straight into bytes: the dot's soft edge is kept to half a
  // level, and every pass held until the print costs a quarter of a float.
  const coverage = new Uint8ClampedArray(w * h)
  if (s.method === 'grain') {
    // The grain cell rides the render scale like every other spatial
    // quantity, so the preview and the export show the same texture rather
    // than the same pixel count.
    ditherField(shifted, w, h, { scale: grainCell(s.screenPitch, scale) }, coverage)
  } else {
    screenField(
      shifted,
      w,
      h,
      {
        pitch: Math.max(1.2, s.screenPitch * scale * detail),
        // Each plate gets its own angle; the beat between them is the rosette.
        angle: defaultAngle(index),
        softness: DOT_SOFTNESS * scale * detail,
        originX: dx,
        originY: dy,
      },
      coverage,
    )
  }
  return { coverage, roughened: rough, dx, dy }
}

/**
 * Turn a soft 0..1 mask into a hard one through whichever press is running.
 *
 * A soft mask crossfades, and a crossfade between two inks is an opacity
 * blend — both print at partial strength and neither reads. Screening the mask
 * makes the changeover a *pattern*: full-strength ink either side, with the
 * boundary broken into the same dots or diffusion the rest of the sheet is
 * using. That is what a real two-colour transition looks like.
 */
function binarise(
  mask: Float32Array,
  index: number,
  press: PressProfile,
  seed: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const scale = h / REFERENCE_HEIGHT
  // Hard either way (0 or 255): a dither is binary, and the switch screen has
  // no softness.
  const out = new Uint8ClampedArray(w * h)
  if (press.method === 'grain') return ditherField(mask, w, h, { scale: grainCell(press.screenPitch, scale) }, out)
  return screenField(mask, w, h, switchScreen(index, press, seed, scale), out)
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

/** Where each plate's tone comes from. The renderer rasterises glyphs into a
 *  canvas (and caches them); a test hands in fields it made itself. */
export interface ToneSource {
  type(layer: TextLayer): { field: ToneField; fontSize: number }
  backing(layer: TextLayer): { field: ToneField; fontSize: number }
}

/**
 * Where a render has got to. Reported between its stages, which is where an
 * export yields to the page (`renderPrintAsync`): before the photo is laid
 * down, before each pass on the press, and between bands of the final print.
 */
export interface RenderProgress {
  /** `photo`: laying the photo down; `press`: a pass on the press; `print`:
   *  printing the passes onto the sheet. */
  step: 'photo' | 'press' | 'print'
  /** The pass being pressed, from 1, and how many there are (a backing is a
   *  pass of its own). While printing, `pass` is `passes`. */
  pass: number
  passes: number
}

/** Rows of the sheet printed between two yields: about a million pixels, a
 *  fraction of a second of compositing on a phone. */
const PRINT_BAND_PIXELS = 1 << 20

/**
 * Press every plate and print the sheet: everything after the type is
 * rasterised and the photo is blitted, which is everything that decides how
 * the print looks. Pure — no canvas — so the order of passes, the knockouts
 * and the second-ink split are tested on the real code rather than on a copy
 * of it.
 *
 * @param out    RGBA bytes, w*h*4, written in full.
 * @param ground the photo at sheet size (RGBA), or undefined with no photo.
 * @returns every pass in print order, as composited.
 */
export function printSheet(
  out: Uint8ClampedArray,
  s: PrintSettings,
  ground: Uint8ClampedArray | undefined,
  tones: ToneSource,
  noise: SheetNoise,
  w: number,
  h: number,
): CompositeLayer[] {
  return drain(printSheetSteps(out, s, ground, tones, noise, w, h))
}

/** Run a staged render to the end, synchronously, and hand back its result. */
function drain<T>(steps: Generator<RenderProgress, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/**
 * `printSheet`, in stages: it yields where it has got to between them. The
 * one implementation both entry points run — the preview drains it at once,
 * an export yields to the page at every step — so the two cannot print
 * different pixels.
 */
export function* printSheetSteps(
  out: Uint8ClampedArray,
  s: PrintSettings,
  ground: Uint8ClampedArray | undefined,
  tones: ToneSource,
  noise: SheetNoise,
  w: number,
  h: number,
): Generator<RenderProgress, CompositeLayer[]> {
  // Plate order is print order: a plate's backing goes down before its type,
  // so the type overprints the block into a third colour — what a real second
  // pass does.
  const plates: CompositeLayer[] = []
  let plateIndex = 0
  const passes = passCount(s)

  let groundLum: Float32Array | undefined
  // The screened "ground is light" mask of the plate before, and the switch
  // point it was made for. Every plate switches at its own point; plates that
  // share one (the default: all at 50%) share the mask, so it is built once.
  let light: { threshold: number; mask: Uint8ClampedArray } | undefined
  // The screen index every switch mask is made at: the first one's. A mask
  // is then a function of its switch point alone, so moving one plate's point
  // can never turn another plate's dots — which it did while a rebuilt mask
  // took the rebuilding plate's angle, and a shared one the first plate's.
  let switchIndex: number | undefined

  // Where the photo is cut back to paper, accumulated across plates: under
  // the second ink wherever that ink cannot print on what is there, and under
  // every backing. A transparent light ink over a solid dark area is still a
  // solid dark area, so without this neither buys anything.
  // Held in bytes (0..255): only the anti-aliased skirt of a hole is between.
  let knockout: Uint8ClampedArray | undefined
  const cutOut = (k: Float32Array) => {
    if (!knockout) knockout = new Uint8ClampedArray(w * h)
    for (let i = 0; i < k.length; i++) {
      const v = k[i] * 255
      if (v > knockout[i]) knockout[i] = v
    }
  }

  for (const layer of s.layers) {
    // A plate takes a backing OR a second ink, never both, and that is held
    // in the reducer and the normaliser rather than decided here. The reason:
    // the second ink picks each glyph's ink from the PHOTO's luminance, but
    // over a backing the real ground is the block's ink on paper, so a light
    // second ink chosen for a dark patch of photo would land on the block and
    // vanish.
    if (layer.backing) {
      yield { step: 'press', pass: plateIndex + 1, passes }
      const backing = pressPlate(tones.backing(layer), plateIndex, s.press, s.seed, noise, w, h)
      plates.push({ coverage: backing.coverage, rgb: inkById(layer.backing).rgb })
      // The block prints on paper: the photo is cut back under its own torn,
      // misregistered outline, so a pale block over a dark photo still reads.
      if (ground) cutOut(knockoutMask(backing.roughened, null, { w, h, dx: backing.dx, dy: backing.dy }))
      plateIndex++
    }

    yield { step: 'press', pass: plateIndex + 1, passes }
    const tone = tones.type(layer)
    const pressed = pressPlate(tone, plateIndex, s.press, s.seed, noise, w, h)
    plateIndex++
    const coverage = pressed.coverage

    if (layer.contrastInkId && ground) {
      // One pass whose ink changes with what is under it — a split fountain
      // driven by the image rather than by position across the drum. Pressed
      // once and then split, so the letterforms stay coherent; pressing twice
      // would misregister the two halves against each other and tear every
      // glyph that happens to straddle the boundary.
      //
      // Which ink goes where is decided by what the inks *are*, not by which
      // field they were typed into. Keying it to the slot assumes the first
      // ink is the dark one, and the moment it isn't — white type over a
      // photograph, which is the ordinary case — the switch runs and puts
      // white on the sky and black on the water: both invisible, and worse
      // than not switching at all. The darker of the pair belongs on light
      // ground and the lighter on dark ground, whichever way round they were
      // chosen. The plate's own ink as its second ink is the one-colour case:
      // both halves print that ink, and the knockout keeps it readable.
      const split = splitInks(inkById(layer.inkId).rgb, inkById(layer.contrastInkId).rgb)

      if (!groundLum) {
        // Blurred across roughly a word. Anything finer and the mask reads the
        // photograph's own grain — the glitter on water is the same value as
        // white ink and about the size of a letter, so a tighter blur decides
        // light-or-dark differently inside a single word. A word is the unit
        // legibility is actually judged in, so it is the unit that commits.
        groundLum = groundLuma(ground, w, h, Math.max(2, tone.fontSize * 1.5))
      }
      if (!light || light.threshold !== layer.contrastThreshold) {
        // Screened, not left soft. A soft mask makes *both* inks print at
        // partial coverage through the transition, which is an opacity
        // crossfade wearing a print's clothes — and it is why the switch point
        // read as a fade rather than as a switch. Running the mask through the
        // same screen or dither the press is already using makes the changeover
        // a real pattern: each ink lands at full strength, and the boundary
        // breaks up into dots the way a two-colour job actually does.
        //
        // Made for THIS plate's switch point. (It used to be made once, from
        // the first split plate, so every later plate's Switch point did
        // nothing.) One mask is held at a time: a plate with its own point
        // costs a rebuild, and the old mask is let go before the new one is
        // made, so two masks are never held together.
        light = undefined
        switchIndex ??= plateIndex
        const threshold = layer.contrastThreshold
        light = { threshold, mask: binarise(bandMask(groundLum, threshold), switchIndex, s.press, s.seed, w, h) }
      }
      const mask = light.mask
      // The mask is hard (0 or 255), so each half is the coverage or nothing.
      const onLight = new Uint8ClampedArray(w * h)
      const onDark = new Uint8ClampedArray(w * h)
      for (let i = 0; i < coverage.length; i++) {
        onLight[i] = (coverage[i] * mask[i]) / 255
        onDark[i] = (coverage[i] * (255 - mask[i])) / 255
      }
      plates.push({ coverage: onLight, rgb: split.onLight })
      plates.push({ coverage: onDark, rgb: split.onDark })

      // Cut from the *same artwork the plate is*, torn by the same stencil and
      // moved by the same paper feed — the plate's own roughened tone and
      // offset, so the hole lands exactly where the ink does. Cutting it from
      // the raw tone instead leaves the hole a couple of pixels off, and the
      // only way to cover that gap is to spread the hole: on a poster a trap,
      // at text size a flood that swells every counter shut.
      cutOut(
        knockoutMask(pressed.roughened, groundLum, {
          w,
          h,
          dx: pressed.dx,
          dy: pressed.dy,
          split: { light: mask, onLightLuma: split.onLightLuma, onDarkLuma: split.onDarkLuma },
        }),
      )
    } else {
      plates.push({ coverage, rgb: inkById(layer.inkId).rgb })
    }
  }

  let base = ground
  if (base && knockout) {
    // The photo is the ground, so knocking out means taking its alpha down and
    // letting the paper underneath come back through. That alpha path is also
    // what a transparent PNG's own transparency takes: both read as paper.
    base = new Uint8ClampedArray(base)
    for (let i = 0; i < knockout.length; i++) {
      base[i * 4 + 3] = base[i * 4 + 3] * (1 - knockout[i] / 255)
    }
  }

  // Printed in bands, so an export can hand the page a moment between them —
  // and so a sampled paper is only ever a band of shade.
  const band = Math.max(1, Math.floor(PRINT_BAND_PIXELS / w))
  const sampled = noise.paper instanceof PaperSampler ? noise.paper : null
  const bandShade = sampled ? new Float32Array(Math.min(h, band) * w) : null
  const ground_ = base ? { base, paperAmount: s.paperVeil ? 1 : 0 } : {}
  for (let y = 0; y < h; y += band) {
    yield { step: 'print', pass: passes, passes }
    const y1 = Math.min(h, y + band)
    let paper: PaperInput
    if (sampled && bandShade) {
      sampled.rows(y, y1, bandShade)
      paper = { shade: bandShade, shadeRow0: y, rgb: sampled.rgb, ...ground_ }
    } else {
      paper = { ...(noise.paper as PaperField), ...ground_ }
    }
    compositeLayers(out, w, h, paper, plates, y, y1)
  }
  return plates
}

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
   *  further reads `media`: an export closes its full-size decode here rather
   *  than holding it through the whole press. */
  onGround?: () => void,
): void {
  drain(renderSteps(ctx, scratch, s, cacheRef, overlay, height, media, onGround))
}

export interface AsyncRenderOptions {
  /** Checked at every step; once aborted, the render stops there and rejects
   *  with an AbortError. */
  signal?: AbortSignal
  /** Where the render has got to, at every step. */
  onProgress?: (progress: RenderProgress) => void
  /** As renderPrint's `onGround`. */
  onGround?: () => void
}

/**
 * Render a full print for an export: the SAME stages as `renderPrint`, with a
 * yield to the event loop between them, so a render of many seconds leaves
 * the page able to paint its progress and take a Cancel. It adds nothing but
 * the yields, the abort checks and the progress reports, so at one height it
 * prints exactly the pixels the preview does (harness `--parity`). Never an
 * overlay, and a cache of its own: the export's noise fields are its size,
 * not the preview's.
 */
export async function renderPrintAsync(
  ctx: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  s: PrintSettings,
  height: number,
  media: CanvasImageSource | null,
  opts: AsyncRenderOptions = {},
): Promise<void> {
  const steps = renderSteps(ctx, scratch, s, null, null, height, media, opts.onGround)
  try {
    for (;;) {
      throwIfAborted(opts.signal)
      const next = steps.next()
      if (next.done) return
      opts.onProgress?.(next.value)
      await yieldToPage()
    }
  } finally {
    // An abandoned render runs its generator's cleanup too.
    steps.return(undefined)
  }
}

/** A macrotask: the page paints and takes input before the render goes on. */
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The save was cancelled.', 'AbortError')
}

/**
 * Both entry points' one implementation, in stages.
 *
 * @param cacheRef the preview's cache, or null for an export: a one-shot render
 *   keeps nothing for a next frame, so it samples the noise where it prints it
 *   and drops each plate's glyphs once the plate is pressed.
 */
function* renderSteps(
  ctx: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  s: PrintSettings,
  cacheRef: { current: RenderCache | null } | null,
  overlay: OverlaySpec | null,
  height: number,
  media: CanvasImageSource | null,
  onGround: (() => void) | undefined,
): Generator<RenderProgress, void> {
  const { w, h } = outputSize(sheetAspect(s), height)

  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w
    ctx.canvas.height = h
  }
  if (scratch.canvas.width !== w || scratch.canvas.height !== h) {
    scratch.canvas.width = w
    scratch.canvas.height = h
  }

  const cache = cacheRef ? ensureCache(cacheRef.current, s, w, h) : null
  if (cacheRef) cacheRef.current = cache
  const noise: SheetNoise = cache ?? sampledNoise(s, w, h)

  // The photo is laid down first — before any type is rasterised — because the
  // type needs to know what is underneath it before it can decide what colour
  // to be. `ground` is a copy, so `scratch` is free for glyph rasterisation
  // immediately after.
  let ground: Uint8ClampedArray | undefined
  if (media && s.media) {
    yield { step: 'photo', pass: 0, passes: passCount(s) }
    const r = groundRect(s.media, w, h)
    scratch.clearRect(0, 0, w, h)
    scratch.imageSmoothingQuality = 'high'
    scratch.drawImage(media, r.dx, r.dy, r.dw, r.dh)
    ground = scratch.getImageData(0, 0, w, h).data
  }
  onGround?.()

  const image = ctx.createImageData(w, h)
  yield* printSheetSteps(
    image.data,
    s,
    ground,
    cache
      ? {
          type: (layer) => cachedTone(scratch, layer, cache, w, h),
          backing: (layer) => cachedBackingTone(scratch, layer, cache, w, h),
        }
      : {
          type: (layer) => toneOf(rasterizeText(scratch, layer, w, h)),
          backing: (layer) => toneOf(rasterizeBacking(scratch, layer, w, h)),
        },
    noise,
    w,
    h,
  )
  ctx.putImageData(image, 0, 0)

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
