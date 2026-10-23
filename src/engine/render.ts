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

import { compositeLayers, type CompositeLayer } from './composite.ts'
import { ditherField } from './dither.ts'
import { applyDensity, applyMottle, edgeToRough, registrationOffset, shiftField, wearToMottle } from './ink.ts'
import { inkById, paperById } from './inks.ts'
import { roughenEdges } from './rough.ts'
import { paperField, type PaperField } from './paper.ts'
import { fbm2D, whiteNoise2D } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { knockoutMask } from './knockout.ts'
import { bandMask, coverRect, groundLuma, splitInks } from './media.ts'
import { rasterizeBacking, rasterizeText } from './text.ts'
import { ASPECTS, type PressProfile, type PrintSettings, type TextLayer } from './types.ts'

/**
 * Every pitch and offset in the settings is expressed against this height, so
 * the preview and the export produce the same *look* at different resolutions.
 * Named here as a deliberate ceiling rather than rediscovered later as a bug.
 */
export const REFERENCE_HEIGHT = 1800

/**
 * The preview renders smaller than the export so a slider drag stays smooth on
 * a phone. This is safe *because* every spatial quantity — screen pitch, dot
 * softness, registration offset — is scaled by `h / REFERENCE_HEIGHT` in
 * renderPlate, so the two resolutions produce the same look rather than the
 * same pixels. Changing one without the other is what makes a preview lie.
 */
export const PREVIEW_HEIGHT = 1000

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
 * in pixels; the full-height frame lands as soon as the control settles.
 */
export const DRAFT_HEIGHT = 280

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
 *  screen gives the 3 px grain the press always shipped with. */
const GRAIN_PER_PITCH = 1 / 3

/** Output pixel dimensions for an aspect at a given render height. */
export function outputSize(
  aspect: PrintSettings['aspect'],
  height: number = REFERENCE_HEIGHT,
): { w: number; h: number } {
  return { w: Math.round(height * ASPECTS[aspect]), h: height }
}

/** Editing aids. Never non-null on an export path. */
export interface OverlaySpec {
  selectedLayerId: string | null
  showGuides: boolean
}

/**
 * Cache for the expensive derived fields.
 *
 * Paper texture and the noise fields depend only on size and seed, so they must
 * not regenerate when an unrelated slider moves — that wastes work and, worse,
 * visibly re-randomises the grain, which reads as a bug (§5.7).
 */
export interface RenderCache {
  key: string
  w: number
  h: number
  paper: PaperField
  mottle: Float32Array
  speckle: Float32Array
  /** Rasterised tone per plate, keyed on the properties that affect it.
   *  Dragging a press slider must not re-run getImageData for every plate.
   *  A backing is keyed separately from its glyphs under the same layer id. */
  tone: Map<string, { key: string; field: Float32Array; fontSize: number }>
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
  return {
    key: cacheKey(s, w, h),
    w,
    h,
    paper: paperField(w, h, {
      rgb: paperById(s.paperId).rgb,
      texture: PAPER_TOOTH,
      blotch: PAPER_CLOUD,
      seed: s.seed,
    }),
    // Mottle cell is tied to the sheet, not to a pixel count, so the blotch
    // scale looks the same at preview and export resolution.
    mottle: fbm2D(w, h, Math.max(6, h / 90), 3, s.seed ^ 0x9e3779b9),
    speckle: whiteNoise2D(w, h, s.seed ^ 0x85ebca6b),
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
): { field: Float32Array; fontSize: number } {
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
): { field: Float32Array; fontSize: number } {
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

/** A plate after the press, and what a knockout under it has to match. */
export interface PressedPlate {
  coverage: Float32Array
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
  plate: { field: Float32Array; fontSize: number },
  index: number,
  s: PressProfile,
  seed: number,
  cache: RenderCache,
  w: number,
  h: number,
): PressedPlate {
  const tone = plate.field
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
    cache.mottle,
    cache.speckle,
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

  const coverage =
    s.method === 'grain'
      ? // The grain cell rides the render scale like every other spatial
        // quantity, so the preview and the export show the same texture rather
        // than the same pixel count.
        ditherField(shifted, w, h, { scale: Math.max(1, Math.round(s.screenPitch * GRAIN_PER_PITCH * scale)) })
      : screenField(shifted, w, h, {
          pitch: Math.max(1.2, s.screenPitch * scale * detail),
          // Each plate gets its own angle; the beat between them is the rosette.
          angle: defaultAngle(index),
          softness: DOT_SOFTNESS * scale * detail,
          originX: dx,
          originY: dy,
        })
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
): Float32Array {
  const scale = h / REFERENCE_HEIGHT
  if (press.method === 'grain') {
    return ditherField(mask, w, h, { scale: Math.max(1, Math.round(press.screenPitch * GRAIN_PER_PITCH * scale)) })
  }
  return screenField(mask, w, h, {
    pitch: Math.max(1.2, press.screenPitch * scale),
    angle: defaultAngle(index),
    softness: 0,
    originX: seed % 7,
    originY: seed % 5,
  })
}

/**
 * Render a full print.
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
   *  JS: four million bilinear samples per frame is not a phone budget. */
  media: CanvasImageSource | null = null,
): void {
  const { w, h } = outputSize(s.aspect, height)

  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w
    ctx.canvas.height = h
  }
  if (scratch.canvas.width !== w || scratch.canvas.height !== h) {
    scratch.canvas.width = w
    scratch.canvas.height = h
  }

  const cache = ensureCache(cacheRef.current, s, w, h)
  cacheRef.current = cache

  // Plate order is print order: a plate's backing goes down before its type,
  // so the type overprints the block into a third colour — what a real second
  // pass does.
  const plates: CompositeLayer[] = []
  let plateIndex = 0

  // The photo is laid down first — before any type is rasterised — because the
  // type needs to know what is underneath it before it can decide what colour
  // to be. `ground` is a copy, so `scratch` is free for glyph rasterisation
  // immediately after.
  let ground: Uint8ClampedArray | undefined
  let light: Float32Array | undefined
  let groundLum: Float32Array | undefined
  if (media && s.media) {
    const r = coverRect({ width: s.media.width, height: s.media.height }, w, h, s.media)
    scratch.clearRect(0, 0, w, h)
    scratch.imageSmoothingQuality = 'high'
    scratch.drawImage(media, r.dx, r.dy, r.dw, r.dh)
    ground = scratch.getImageData(0, 0, w, h).data
  }

  // Where the photo is cut back to paper, accumulated across plates: under
  // the second ink wherever that ink cannot print on what is there, and under
  // every backing. A transparent light ink over a solid dark area is still a
  // solid dark area, so without this neither buys anything.
  let knockout: Float32Array | undefined
  const cutOut = (k: Float32Array) => {
    if (!knockout) knockout = new Float32Array(w * h)
    for (let i = 0; i < k.length; i++) if (k[i] > knockout[i]) knockout[i] = k[i]
  }

  for (const layer of s.layers) {
    // A plate takes a backing OR a second ink, never both, and that is held
    // in the reducer and the normaliser rather than decided here. The reason:
    // the second ink picks each glyph's ink from the PHOTO's luminance, but
    // over a backing the real ground is the block's ink on paper, so a light
    // second ink chosen for a dark patch of photo would land on the block and
    // vanish.
    if (layer.backing) {
      const backing = pressPlate(
        cachedBackingTone(scratch, layer, cache, w, h),
        plateIndex,
        s.press,
        s.seed,
        cache,
        w,
        h,
      )
      plates.push({ coverage: backing.coverage, rgb: inkById(layer.backing).rgb })
      // The block prints on paper: the photo is cut back under its own torn,
      // misregistered outline, so a pale block over a dark photo still reads.
      if (ground) cutOut(knockoutMask(backing.roughened, null, { w, h, dx: backing.dx, dy: backing.dy }))
      plateIndex++
    }

    const tone = cachedTone(scratch, layer, cache, w, h)
    const pressed = pressPlate(tone, plateIndex, s.press, s.seed, cache, w, h)
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
      if (!light) {
        // Screened, not left soft. A soft mask makes *both* inks print at
        // partial coverage through the transition, which is an opacity
        // crossfade wearing a print's clothes — and it is why the switch point
        // read as a fade rather than as a switch. Running the mask through the
        // same screen or dither the press is already using makes the changeover
        // a real pattern: each ink lands at full strength, and the boundary
        // breaks up into dots the way a two-colour job actually does.
        light = binarise(
          bandMask(groundLum, layer.contrastThreshold),
          plateIndex,
          s.press,
          s.seed,
          w,
          h,
        )
      }
      const onLight = new Float32Array(w * h)
      const onDark = new Float32Array(w * h)
      for (let i = 0; i < coverage.length; i++) {
        onLight[i] = coverage[i] * light[i]
        onDark[i] = coverage[i] * (1 - light[i])
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
          split: { light, onLightLuma: split.onLightLuma, onDarkLuma: split.onDarkLuma },
        }),
      )
    } else {
      plates.push({ coverage, rgb: inkById(layer.inkId).rgb })
    }
  }

  if (ground && knockout) {
    // The photo is the ground, so knocking out means taking its alpha down and
    // letting the paper underneath come back through. That alpha path is also
    // what a transparent PNG's own transparency takes: both read as paper.
    ground = new Uint8ClampedArray(ground)
    for (let i = 0; i < knockout.length; i++) {
      ground[i * 4 + 3] = ground[i * 4 + 3] * (1 - knockout[i])
    }
  }

  const image = ctx.createImageData(w, h)
  compositeLayers(
    image.data,
    w,
    h,
    ground
      ? { ...cache.paper, base: ground, paperAmount: s.paperVeil ? 1 : 0 }
      : cache.paper,
    plates,
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

  if (overlay.showGuides) {
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'
    ctx.lineWidth = Math.max(1, unit)
    ctx.setLineDash([6 * unit, 6 * unit])
    for (let i = 1; i < 3; i++) {
      const x = (w * i) / 3
      const y = (h * i) / 3
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

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
