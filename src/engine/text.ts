/**
 * Type → tone field.
 *
 * The only part of the engine that needs a real 2D context, because glyph
 * rasterisation is not something worth reimplementing. The context is handed
 * in rather than created here, so the engine still owns no DOM of its own and
 * the export path can pass an offscreen one.
 *
 * Layout is separated from drawing: `layoutText` is pure given a measuring
 * function, which is what makes the tricky part (fit-to-width, alignment,
 * tracking) testable without a browser.
 */

import { fontById, type TextAlign, type TextLayer } from './types.ts'

export interface LaidOutLine {
  text: string
  /** Advance width in pixels at the layout's font size, tracking included. */
  width: number
}

export interface TextLayout {
  lines: LaidOutLine[]
  /** Font size in pixels, after any fit-to-width scaling. */
  fontSize: number
  /** Letter spacing in pixels, after scaling. */
  tracking: number
  lineHeight: number
  widest: number
  blockHeight: number
}

export type MeasureFn = (text: string, fontSize: number) => number

/**
 * Lay out a text block.
 *
 * @param measure  returns the natural advance width of `text` at `fontSize`,
 *                 excluding tracking. Injected so this stays pure.
 * @param maxWidth the width to fit into when `layer.fitWidth` is set.
 */
export function layoutText(
  layer: TextLayer,
  canvasHeight: number,
  maxWidth: number,
  measure: MeasureFn,
): TextLayout {
  const raw = layer.caps ? layer.text.toUpperCase() : layer.text
  const source = raw.split('\n')

  let fontSize = Math.max(1, layer.size * canvasHeight)
  let tracking = layer.tracking * fontSize

  const widthOf = (text: string, size: number, track: number): number => {
    if (text.length === 0) return 0
    // Tracking adds one gap after each character, including the last — which
    // is how CSS letter-spacing behaves, and matters for centring.
    return measure(text, size) + track * text.length
  }

  let widest = source.reduce((m, t) => Math.max(m, widthOf(t, fontSize, tracking)), 0)

  if (layer.fitWidth && widest > 0 && maxWidth > 0) {
    const scale = maxWidth / widest
    fontSize *= scale
    tracking *= scale
    widest = maxWidth
  }

  const lines = source.map((text) => ({ text, width: widthOf(text, fontSize, tracking) }))
  const lineHeight = fontSize * layer.lineHeight

  return {
    lines,
    fontSize,
    tracking,
    lineHeight,
    widest,
    blockHeight: lineHeight * Math.max(1, lines.length),
  }
}

/** Horizontal offset of a line within the block, for a given alignment. */
export function alignOffset(lineWidth: number, blockWidth: number, align: TextAlign): number {
  switch (align) {
    case 'left':
      return 0
    case 'right':
      return blockWidth - lineWidth
    case 'center':
      return (blockWidth - lineWidth) / 2
    case 'justify':
      // A justified line is stretched to the full measure by definition, so
      // there is no slack left to distribute.
      return 0
  }
}

/**
 * Forced justification: place every glyph by hand, splitting the line's
 * leftover space evenly across the gaps so it fills `targetWidth` exactly.
 *
 * "Forced" is the operative word — this justifies every line including the
 * last, and it stretches *between characters*, not just between words. That is
 * what produces the solid rectangular block of type the style depends on,
 * rather than the ragged final line a text engine would normally leave.
 *
 * `targetWidth` must be the width of the *widest line in the block*, never an
 * arbitrary measure. That is what keeps the extra gap non-negative: pass
 * something narrower than a line's natural width and the gap goes negative,
 * which pulls glyphs on top of each other and swallows the spaces between
 * words. Scale the type to the measure first (fit-to-width), then justify to
 * the widest line — in that order.
 *
 * A single-character line has no gaps to absorb the slack, so it is left where
 * it is instead of being scaled.
 *
 * @param widths per-character advance widths, in order.
 * @returns the x offset for each character, relative to the line start.
 */
export function justifyOffsets(widths: readonly number[], targetWidth: number): number[] {
  const gaps = widths.length - 1
  const natural = widths.reduce((a, b) => a + b, 0)
  const extra = gaps > 0 ? (targetWidth - natural) / gaps : 0

  const xs: number[] = []
  let pen = 0
  for (let i = 0; i < widths.length; i++) {
    xs.push(pen)
    pen += widths[i] + extra
  }
  return xs
}

/** Does this context support the `letterSpacing` property? Safari picked it up
 *  in 17.4; older engines silently ignore it, so we fall back to drawing glyph
 *  by glyph rather than quietly dropping the user's tracking. */
function supportsLetterSpacing(ctx: CanvasRenderingContext2D): boolean {
  try {
    ctx.letterSpacing = '2px'
    const ok = ctx.letterSpacing === '2px'
    ctx.letterSpacing = '0px'
    return ok
  } catch {
    return false
  }
}

/**
 * Draw one text layer and return its tone field.
 *
 * Glyphs are drawn opaque white onto a cleared context, and the alpha channel
 * *is* the tone — antialiasing included, which is what gives the screen
 * something to bite on at glyph edges instead of a hard stair-step.
 *
 * @param ctx a 2D context whose canvas is exactly w x h. Cleared on entry.
 */
export function rasterizeText(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  w: number,
  h: number,
): Float32Array {
  ctx.clearRect(0, 0, w, h)

  const font = fontById(layer.fontId)
  const setFont = (size: number) => {
    ctx.font = `${layer.weight} ${size}px ${font.stack}`
  }

  setFont(Math.max(1, layer.size * h))
  const measure: MeasureFn = (text, fontSize) => {
    setFont(fontSize)
    return ctx.measureText(text).width
  }

  // Leave a small margin so fit-to-width type doesn't bleed off the sheet.
  const layout = layoutText(layer, h, w * 0.92, measure)
  setFont(layout.fontSize)

  const canTrack = layout.tracking !== 0 && supportsLetterSpacing(ctx)
  if (canTrack) {
    ctx.letterSpacing = `${layout.tracking}px`
    // Re-set the font: some engines reset letterSpacing when `font` is assigned.
    setFont(layout.fontSize)
    ctx.letterSpacing = `${layout.tracking}px`
  }

  ctx.save()
  ctx.translate(layer.x * w, layer.y * h)
  if (layer.rotation !== 0) ctx.rotate((layer.rotation * Math.PI) / 180)

  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  const blockWidth = layout.widest
  // Centre the block on the anchor vertically.
  const firstBaseline = -layout.blockHeight / 2 + layout.lineHeight / 2

  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i]
    if (line.text.length === 0) continue
    const ox = alignOffset(line.width, blockWidth, layer.align) - blockWidth / 2
    const oy = firstBaseline + i * layout.lineHeight

    if (layer.align === 'justify') {
      // letterSpacing would fight the computed gaps, so measure and place
      // without it, then re-apply it after the block.
      if (canTrack) ctx.letterSpacing = '0px'
      const chars = Array.from(line.text)
      const widths = chars.map((c) => ctx.measureText(c).width)
      const xs = justifyOffsets(widths, blockWidth)
      for (let k = 0; k < chars.length; k++) ctx.fillText(chars[k], ox + xs[k], oy)
      if (canTrack) ctx.letterSpacing = `${layout.tracking}px`
    } else if (canTrack) {
      ctx.fillText(line.text, ox, oy)
    } else if (layout.tracking !== 0) {
      // Manual advance so tracking still works on engines without the property.
      let pen = ox
      for (const ch of line.text) {
        ctx.fillText(ch, pen, oy)
        pen += ctx.measureText(ch).width + layout.tracking
      }
    } else {
      ctx.fillText(line.text, ox, oy)
    }
  }

  ctx.restore()
  if (canTrack) ctx.letterSpacing = '0px'

  // Alpha channel → tone.
  const { data } = ctx.getImageData(0, 0, w, h)
  const tone = new Float32Array(w * h)
  for (let i = 0, p = 3; i < tone.length; i++, p += 4) tone[i] = data[p] / 255
  return tone
}
