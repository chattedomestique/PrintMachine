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
 *   roughen/bleed    the burned stencil's ragged outline and ink spread —
 *                    on the tone, so the screen bites on the real edge
 *   density/gamma    ink can't reach full black; cap before screening so the
 *                    screen sees the tone that will actually be printed
 *   wear             mottle, dropout patches, drum streaks, smear, banding —
 *                    ALL on the tone, so they change how many dots print
 *                    rather than how transparent the ink is
 *   plate shift      the artwork moves on the plate...
 *   screen/dither    ...and the lattice moves with it, so dots don't crawl
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

import { blurField } from './blur.ts'
import { compositeLayers, type CompositeLayer } from './composite.ts'
import { ditherField } from './dither.ts'
import { applyDensity, applyMottle, registrationOffset, shiftField } from './ink.ts'
import { inkById, paperById } from './inks.ts'
import { applyDropoutPatches, applySmear, applyStreaks } from './misprint.ts'
import { roughenEdges } from './rough.ts'
import { applyRollerBanding, paperField, type PaperField } from './paper.ts'
import { fbm2D, whiteNoise2D } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { coverRect, lightMask, separateLuminance } from './media.ts'
import { rasterizeBoxes, rasterizeText } from './text.ts'
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
   *  Boxes are keyed separately from glyphs under the same layer id. */
  tone: Map<string, { key: string; field: Float32Array; fontSize: number }>
}

function cacheKey(s: PrintSettings, w: number, h: number): string {
  return [w, h, s.seed, s.paperId, s.paperTexture, s.paperBlotch].join('|')
}

/** Everything about a layer that changes its rasterised glyphs. Ink, opacity
 *  and screen settings are deliberately absent — they act downstream of the
 *  raster, so changing them should reuse it. */
function toneKey(l: TextLayer): string {
  return [
    l.text,
    l.fontId,
    l.weight,
    l.size,
    l.lineHeight,
    l.tracking,
    l.wordSpacing,
    l.align,
    l.justifyBy,
    l.soloAlign,
    l.x,
    l.y,
    l.rotation,
    l.caps,
    l.fitWidth,
  ].join('')
}

function buildCache(s: PrintSettings, w: number, h: number): RenderCache {
  return {
    key: cacheKey(s, w, h),
    w,
    h,
    paper: paperField(w, h, {
      rgb: paperById(s.paperId).rgb,
      texture: s.paperTexture,
      blotch: s.paperBlotch,
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
  /** Word subset, for the plates a per-word override splits off. */
  words?: { only: ReadonlySet<number> } | { except: ReadonlySet<number> },
  slot = layer.id,
): { field: Float32Array; fontSize: number } {
  const key = toneKey(layer) + '|' + slot
  const hit = cache.tone.get(slot)
  if (hit && hit.key === key) return hit
  const { tone, fontSize } = rasterizeText(scratch, layer, w, h, words)
  const entry = { key, field: tone, fontSize }
  cache.tone.set(slot, entry)
  return entry
}

/**
 * Group the words that share the same per-word override.
 *
 * One plate per distinct setting rather than per word: three words all given
 * the same extra bleed went through the press together on a real job, so they
 * should tear and land together here too.
 */
function pressGroups(layer: TextLayer): Map<string, { words: Set<number>; bleed: number; offset: number }> {
  const groups = new Map<string, { words: Set<number>; bleed: number; offset: number }>()
  for (const [index, over] of Object.entries(layer.wordPress)) {
    const bleed = over.bleed ?? 0
    const offset = over.offset ?? 0
    if (bleed === 0 && offset === 0) continue
    const key = `${bleed}:${offset}`
    const g = groups.get(key) ?? { words: new Set<number>(), bleed, offset }
    g.words.add(Number(index))
    groups.set(key, g)
  }
  return groups
}

/** Same, for one box group. Keyed on the layout *and* the chosen words, so
 *  re-selecting words re-rasterises but moving a press slider does not. */
function cachedBoxTone(
  scratch: CanvasRenderingContext2D,
  layer: TextLayer,
  boxIndex: number,
  cache: RenderCache,
  w: number,
  h: number,
): { field: Float32Array; fontSize: number } {
  const box = layer.boxes[boxIndex]
  const id = `${layer.id}:box:${box.id}`
  const key = [toneKey(layer), layer.boxPadding, layer.boxRadius, box.words.join(',')].join('|')
  const hit = cache.tone.get(id)
  if (hit && hit.key === key) return hit
  const field = rasterizeBoxes(scratch, layer, w, h, new Set(box.words))
  // A box inherits its type's rendered size, so it wears at the same scale as
  // the words it sits behind rather than being treated as a poster-sized slab.
  const fontSize = cachedTone(scratch, layer, cache, w, h).fontSize
  cache.tone.set(id, { key, field, fontSize })
  return { field, fontSize }
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
 * reads as printed rather than as clean vector. Off by default it is not —
 * `detailScaling` exists because at some point somebody will want the honest
 * one-ruling-per-sheet behaviour.
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
 * Run the press over one tone field: everything from the stencil edge to the
 * screen. Shared by type and by background boxes — a box that skipped this
 * would be the one clean, undistressed rectangle on an otherwise convincingly
 * printed sheet.
 *
 * Exported so tests can drive it without a canvas.
 */
export function pressPlate(
  plate: { field: Float32Array; fontSize: number },
  index: number,
  /** Which press this pass goes through — the type's or the photo's. */
  s: PressProfile,
  seed: number,
  cache: RenderCache,
  w: number,
  h: number,
): Float32Array {
  const tone = plate.field
  const scale = h / REFERENCE_HEIGHT
  const detail = s.detailScaling ? detailFactor(plate.fontSize, h) : 1

  // Ragged stencil edge + ink spread, before anything downstream sees the
  // outline. Seeded per plate so two plates don't tear identically.
  const rough = roughenEdges(tone, w, h, {
    roughness: s.roughness,
    scale: Math.max(1, s.roughScale * scale * detail),
    // Bleed is a threshold offset, so at small sizes it eats the counters —
    // the holes in a, e, o fill and the word turns into a row of blobs.
    bleed: s.bleed * detail,
    seed: seed ^ (index * 0x9e3779b9),
  })

  let tone2 = applyDensity(rough, s.density, s.gamma)

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
  // failing area visibly breaks up into halftone instead of dimming.
  tone2 = applyMottle(tone2, cache.mottle, cache.speckle, s.mottle, s.dropout)
  tone2 = applyDropoutPatches(tone2, w, h, s.patches, seed ^ (index * 0x165667b1))
  tone2 = applyStreaks(tone2, w, h, s.streaks, seed ^ (index * 0x27d4eb2d))
  tone2 = applySmear(tone2, w, h, s.smear)
  tone2 = applyRollerBanding(tone2, w, h, s.banding, seed ^ (index * 0x27d4eb2d))

  // Misregistration is a paper-feed error, physically the same for the whole
  // sheet — but at 5px it obliterates 20px type while barely showing on a
  // poster. Scaled by sqrt so it stays visible on small type without eating it.
  const { dx, dy } = registrationOffset(seed, index, s.misregistration * scale * Math.sqrt(detail))
  const shifted = shiftField(tone2, w, h, dx, dy)

  if (s.method === 'dither') {
    return ditherField(shifted, w, h, s.ditherType, {
      threshold: s.ditherThreshold,
      // Cell size rides the render scale like every other spatial quantity, so
      // the preview and the export show the same texture rather than the same
      // pixel count.
      scale: Math.max(1, Math.round(s.ditherScale * scale)),
    })
  }
  return screenField(shifted, w, h, {
    shape: s.screenShape,
    pitch: Math.max(1.2, s.screenPitch * scale * detail),
    // Each plate gets its own angle; the beat between them is the rosette.
    angle: defaultAngle(index),
    softness: s.screenSoftness * scale * detail,
    originX: dx,
    originY: dy,
  })
}

/**
 * Render a full print.
 *
 * @param ctx     the target context. Its canvas is resized to the output size.
 * @param scratch a same-sized scratch context used for glyph rasterisation.
 * @param overlay editing aids, or null. Export paths pass null.
 */

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
  if (press.method === 'dither') {
    return ditherField(mask, w, h, press.ditherType, {
      threshold: press.ditherThreshold,
      scale: Math.max(1, Math.round(press.ditherScale * scale)),
    })
  }
  return screenField(mask, w, h, {
    shape: press.screenShape,
    pitch: Math.max(1.2, press.screenPitch * scale),
    angle: defaultAngle(index),
    softness: 0,
    originX: seed % 7,
    originY: seed % 5,
  })
}

/**
 * Grow a field outward by a few pixels.
 *
 * A knockout cut exactly to the glyph shows a dark fringe the moment anything
 * shifts, because nothing on a press lands twice in the same place. Printers
 * solve this by trapping — spreading the knockout slightly past the artwork so
 * a small misregistration still lands inside the hole. Same trick here.
 */
function spread(field: Float32Array, w: number, h: number, radius: number): Float32Array {
  const soft = blurField(field, w, h, radius)
  const out = new Float32Array(field.length)
  for (let i = 0; i < out.length; i++) {
    // Cut back to *hard* rather than keeping the blurred skirt. Leaving the
    // gradient in makes the hole fade out gradually, which prints as a halo of
    // bare paper round every reversed word — a glow, not a trap. A low cut on
    // the blur is a cheap dilation with a clean edge.
    out[i] = soft[i] > 0.14 ? 1 : field[i]
  }
  return out
}

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

  // Plate order is print order: boxes go down first so the type overprints
  // them, which is also what makes a box in a second ink read as a real
  // second pass rather than a shape pasted on top.
  const plates: CompositeLayer[] = []
  let plateIndex = 0

  // The photo is laid down first — before any type is rasterised — because the
  // type needs to know what is underneath it before it can decide what colour
  // to be. `ground` is a copy, so `scratch` is free for glyph rasterisation
  // immediately after.
  let ground: Uint8ClampedArray | undefined
  let light: Float32Array | undefined
  if (media && s.media) {
    const r = coverRect({ width: s.media.width, height: s.media.height }, w, h, s.media)
    scratch.clearRect(0, 0, w, h)
    scratch.imageSmoothingQuality = 'high'
    // Fading the photo is fading how much of it reaches the sheet, so it rides
    // on alpha and the compositor blends back toward paper. Printed mode keeps
    // full alpha — there the opacity belongs to the ink plate, not the source.
    scratch.globalAlpha = s.media.printed ? 1 : s.media.opacity
    scratch.drawImage(media, r.dx, r.dy, r.dw, r.dh)
    scratch.globalAlpha = 1
    ground = scratch.getImageData(0, 0, w, h).data
  }

  // Everywhere the type had to switch to its second ink, accumulated across
  // layers. The photo is knocked back to paper here: a transparent light ink
  // over a solid dark area is still a solid dark area, so without this the
  // second ink buys nothing.
  let knockout: Float32Array | undefined

  for (const layer of s.layers) {
    if (layer.opacity <= 0) continue

    for (let b = 0; b < layer.boxes.length; b++) {
      const box = layer.boxes[b]
      if (box.words.length === 0 || box.opacity <= 0) continue
      plates.push({
        coverage: pressPlate(
          cachedBoxTone(scratch, layer, b, cache, w, h),
          plateIndex,
          s.press,
          s.seed,
          cache,
          w,
          h,
        ),
        rgb: inkById(box.inkId).rgb,
        opacity: box.opacity * layer.opacity,
      })
      plateIndex++
    }

    // Words carrying their own bleed or offset come off the main plate and go
    // through the press separately, because both are things that happen to a
    // plate rather than to a pixel.
    const groups = pressGroups(layer)
    const special = new Set<number>()
    for (const g of groups.values()) for (const i of g.words) special.add(i)

    const tone =
      special.size > 0
        ? cachedTone(scratch, layer, cache, w, h, { except: special }, `${layer.id}:base`)
        : cachedTone(scratch, layer, cache, w, h)
    const coverage = pressPlate(tone, plateIndex, s.press, s.seed, cache, w, h)
    plateIndex++

    let gi = 0
    for (const [key, g] of groups) {
      const groupTone = cachedTone(
        scratch,
        layer,
        cache,
        w,
        h,
        { only: g.words },
        `${layer.id}:w${key}`,
      )
      plates.push({
        coverage: pressPlate(
          groupTone,
          // A distinct plate index gives a distinct registration seed, which is
          // the whole point of an offset override — the word has to land
          // somewhere the rest of the line did not.
          plateIndex,
          {
            ...s.press,
            bleed: Math.max(0, Math.min(1, s.press.bleed + g.bleed)),
            misregistration: s.press.misregistration + g.offset,
          },
          s.seed ^ (gi * 0x85ebca6b),
          cache,
          w,
          h,
        ),
        rgb: inkById(layer.inkId).rgb,
        opacity: layer.opacity,
      })
      plateIndex++
      gi++
    }

    if (layer.contrastInkId && ground) {
      // One pass whose ink changes with what is under it — a split fountain
      // driven by the image rather than by position across the drum. Pressed
      // once and then split, so the letterforms stay coherent; pressing twice
      // would misregister the two halves against each other and tear every
      // glyph that happens to straddle the boundary.
      if (!light) {
        const soft = lightMask(ground, w, h, layer.contrastThreshold, Math.max(2, h * 0.012))
        // Screened, not left soft. A soft mask makes *both* inks print at
        // partial coverage through the transition, which is an opacity
        // crossfade wearing a print's clothes — and it is why the switch point
        // read as a fade rather than as a switch. Running the mask through the
        // same screen or dither the press is already using makes the changeover
        // a real pattern: each ink lands at full strength, and the boundary
        // breaks up into dots the way a two-colour job actually does.
        light = binarise(soft, plateIndex, s.press, s.seed, w, h)
      }
      const onLight = new Float32Array(w * h)
      const onDark = new Float32Array(w * h)
      for (let i = 0; i < coverage.length; i++) {
        onLight[i] = coverage[i] * light[i]
        onDark[i] = coverage[i] * (1 - light[i])
      }
      plates.push({ coverage: onLight, rgb: inkById(layer.inkId).rgb, opacity: layer.opacity })
      plates.push({
        coverage: onDark,
        rgb: inkById(layer.contrastInkId).rgb,
        opacity: layer.opacity,
      })

      // The knockout is cut from the *unpressed* tone, not from the screened
      // coverage. Knocking out with the halftone leaves the photo standing in
      // every gap between the type's own dots, which is what turned the
      // reversed lines to mush — the light ink was printing onto a still-black
      // ground. A stencil has a solid hole in it.
      if (!knockout) knockout = new Float32Array(w * h)
      // Two pixels or so at export size: enough that a small misregistration
      // still lands inside the hole, not so much that it reads as a halo.
      const solid = spread(tone.field, w, h, Math.max(1, h * 0.0012))
      for (let i = 0; i < solid.length; i++) {
        const k = solid[i] * (1 - light[i])
        if (k > knockout[i]) knockout[i] = k
      }
    } else {
      plates.push({ coverage, rgb: inkById(layer.inkId).rgb, opacity: layer.opacity })
    }
  }

  if (ground && s.media) {
    if (s.media.printed) {
      // Through its own press — a photograph and a headline want genuinely
      // different rulings, and one profile for both ruins whichever it was not
      // tuned for.
      const photoTone = separateLuminance(ground, new Float32Array(w * h), {
        contrast: s.media.contrast,
        lift: s.media.lift,
      })
      const photoCoverage = pressPlate(
        { field: photoTone, fontSize: h * 0.16 },
        plateIndex,
        s.photoPress,
        s.seed,
        cache,
        w,
        h,
      )
      // Applied *after* the photo's press, so the hole lands where the type
      // actually is. Cutting it beforehand let the photo's own roughening,
      // screening and misregistration carry the hole away from the glyphs it
      // was meant to clear.
      if (knockout) for (let i = 0; i < photoCoverage.length; i++) photoCoverage[i] *= 1 - knockout[i]
      plates.unshift({
        // Its own plate index, not 0: sharing a seed with the first type plate
        // would misregister the two identically, which reads as the photo and
        // the type being in perfect register — the one thing a Riso never is.
        // A photo is poster-sized by definition, so it takes the full press.
        coverage: photoCoverage,
        rgb: inkById(s.media.inkId).rgb,
        opacity: s.media.opacity,
      })
      plateIndex++
      // Printed means separated *onto* paper, so the photo is no longer the
      // ground — its ink plate is the whole of its contribution.
      ground = undefined
    } else if (knockout) {
      // Not printed: the photo is the ground, so knocking out means taking its
      // alpha down and letting the paper underneath come back through.
      ground = new Uint8ClampedArray(ground)
      for (let i = 0; i < knockout.length; i++) {
        ground[i * 4 + 3] = ground[i * 4 + 3] * (1 - knockout[i])
      }
    }
  }

  const image = ctx.createImageData(w, h)
  compositeLayers(
    image.data,
    w,
    h,
    ground
      ? { ...cache.paper, base: ground, paperAmount: s.paperAmount }
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
