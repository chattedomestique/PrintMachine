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
 *   plate shift      the artwork moves on the plate...
 *   screen/dither    ...and the lattice moves with it, so dots don't crawl
 *   mottle/dropout   uneven ink film and drum dust, applied to real dots
 *   patches          regions where ink never transferred
 *   streaks          pale drum lines down the length of the sheet
 *   smear            ink dragged along the feed direction
 *   banding          feed-roller variation across the sheet
 *   composite        subtractive overprint onto textured paper
 *
 * Reordering this is not a refactor, it is a regression — the shift has to
 * happen before screening or the dots slide underneath the artwork, and the
 * density cap has to happen before screening or the highlights clip.
 */

import { compositeLayers, type CompositeLayer } from './composite.ts'
import { ditherField } from './dither.ts'
import { applyDensity, applyMottle, registrationOffset, shiftField } from './ink.ts'
import { inkById, paperById } from './inks.ts'
import { applyDropoutPatches, applySmear, applyStreaks } from './misprint.ts'
import { roughenEdges } from './rough.ts'
import { applyRollerBanding, paperField, type PaperField } from './paper.ts'
import { fbm2D, whiteNoise2D } from './rng.ts'
import { defaultAngle, screenField } from './screen.ts'
import { rasterizeText } from './text.ts'
import { ASPECTS, type PrintSettings, type TextLayer } from './types.ts'

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
  /** Rasterised glyph tone per layer, keyed on the properties that affect it.
   *  Dragging a press slider must not re-run getImageData for every plate. */
  tone: Map<string, { key: string; field: Float32Array }>
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
    l.align,
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
): Float32Array {
  const key = toneKey(layer)
  const hit = cache.tone.get(layer.id)
  if (hit && hit.key === key) return hit.field
  const field = rasterizeText(scratch, layer, w, h)
  cache.tone.set(layer.id, { key, field })
  return field
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

/** Build one plate's coverage field. Exported so tests can drive it directly. */
export function renderPlate(
  scratch: CanvasRenderingContext2D,
  layer: TextLayer,
  index: number,
  s: PrintSettings,
  cache: RenderCache,
  w: number,
  h: number,
): Float32Array {
  const scale = h / REFERENCE_HEIGHT

  const tone = cachedTone(scratch, layer, cache, w, h)

  // Ragged stencil edge + ink spread, before anything downstream sees the
  // outline. Seeded per plate so two plates don't tear identically.
  const rough = roughenEdges(tone, w, h, {
    roughness: s.roughness,
    scale: Math.max(1, s.roughScale * scale),
    bleed: s.bleed,
    seed: s.seed ^ (index * 0x9e3779b9),
  })

  const capped = applyDensity(rough, s.density, s.gamma)

  const { dx, dy } = registrationOffset(s.seed, index, s.misregistration * scale)
  const shifted = shiftField(capped, w, h, dx, dy)

  let coverage: Float32Array
  if (s.method === 'dither') {
    coverage = ditherField(shifted, w, h, s.ditherType, s.ditherThreshold)
  } else {
    coverage = screenField(shifted, w, h, {
      shape: s.screenShape,
      pitch: s.screenPitch * scale,
      // Each plate gets its own angle; the beat between them is the rosette.
      angle: defaultAngle(index),
      softness: s.screenSoftness * scale,
      originX: dx,
      originY: dy,
    })
  }

  coverage = applyMottle(coverage, cache.mottle, cache.speckle, s.mottle, s.dropout)
  coverage = applyDropoutPatches(coverage, w, h, s.patches, s.seed ^ (index * 0x165667b1))
  coverage = applyStreaks(coverage, w, h, s.streaks, s.seed ^ (index * 0x27d4eb2d))
  coverage = applySmear(coverage, w, h, s.smear)
  coverage = applyRollerBanding(coverage, w, h, s.banding, s.seed ^ (index * 0x27d4eb2d))
  return coverage
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

  const plates: CompositeLayer[] = []
  for (let i = 0; i < s.layers.length; i++) {
    const layer = s.layers[i]
    if (layer.opacity <= 0) continue
    plates.push({
      coverage: renderPlate(scratch, layer, i, s, cache, w, h),
      rgb: inkById(layer.inkId).rgb,
      opacity: layer.opacity,
    })
  }

  const image = ctx.createImageData(w, h)
  compositeLayers(image.data, w, h, cache.paper, plates)
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
