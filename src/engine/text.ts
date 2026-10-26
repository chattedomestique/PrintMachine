/**
 * Type → tone field.
 *
 * The only part of the engine that needs a real 2D context, because glyph
 * rasterisation is not something worth reimplementing. The context is handed
 * in rather than created here, so the engine still owns no DOM of its own and
 * the export path can pass an offscreen one.
 *
 * Layout is separated from drawing and produces *placed glyphs* — every
 * character's x offset within its line. Tracking, justification and the
 * backing all read those same numbers, which is the point: a block drawn from
 * one set of positions while the glyphs are drawn from another will drift
 * apart, and it will drift differently at every font size. One layout, one
 * source of truth.
 *
 * That also means glyphs are drawn one at a time rather than a line at a time,
 * which gives up native kerning. It is the right trade here — this is poster
 * type with tracking applied, where kerning barely registers.
 */

import { CANVAS_FONT_MAX, SIZE_MAX, SIZE_MIN } from './limits.ts'
import { readAlpha } from './readback.ts'
import { fontById, type TextAlign, type TextLayer } from './types.ts'

export interface PlacedGlyph {
  ch: string
  /** Offset from the line's left edge, in pixels. */
  x: number
  width: number
}

export interface LaidOutLine {
  text: string
  /** Width to the last glyph's ink, in pixels, tracking included. */
  width: number
  glyphs: PlacedGlyph[]
}

export interface TextLayout {
  lines: LaidOutLine[]
  /** Font size in pixels. */
  fontSize: number
  /** Letter spacing in pixels. */
  tracking: number
  lineHeight: number
  widest: number
  blockHeight: number
}

export type MeasureFn = (text: string, fontSize: number) => number

/** A face at a size: everything a 2D context needs to measure or draw it. */
export interface FontSpec {
  /** CSS font-family stack, from FONTS. */
  stack: string
  /** CSS font-weight. */
  weight: number
  /** Font size in pixels. */
  px: number
}

/** The natural advance width of `text` set in `font`, in pixels. Injected
 *  wherever text has to be measured outside a render, so the measuring code
 *  stays pure and runs in node tests with a stub. */
export type FontMeasure = (font: FontSpec, text: string) => number

/** The CSS font shorthand for a FontSpec. One spelling, shared by the renderer
 *  and anything that measures, so the two can never set different fonts. */
export const cssFont = (f: FontSpec): string => `${f.weight} ${f.px}px ${f.stack}`

/** The face a layer is set in, at a pixel size: Bold is weight 700, else 400. */
export function layerFont(layer: TextLayer, px: number): FontSpec {
  return { stack: fontById(layer.fontId).stack, weight: layer.bold ? 700 : 400, px }
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t'

/** First and last glyph that prints in a line, or null for a line of nothing
 *  but spaces. */
function inkSpan(glyphs: readonly PlacedGlyph[]): { first: number; last: number } | null {
  let first = -1
  let last = -1
  glyphs.forEach((g, k) => {
    if (isSpace(g.ch)) return
    if (first < 0) first = k
    last = k
  })
  return first < 0 ? null : { first, last }
}

/**
 * Place every glyph in a line.
 *
 * Advances are the character's own width plus `tracking`. Tracking lands on
 * spaces as well as letters, matching native letter-spacing, so opening the
 * type up widens the gaps between words along with it.
 */
function placeLine(
  text: string,
  fontSize: number,
  tracking: number,
  measure: MeasureFn,
): { glyphs: PlacedGlyph[]; width: number } {
  const glyphs: PlacedGlyph[] = []

  let pen = 0
  // Right edge of the last inked glyph. The line's width is this, not `pen`:
  // every glyph advances by its own trailing tracking, so `pen` ends one gap
  // past the ink. Counting that gap makes a centred line sit left of centre
  // and a right-aligned one stop short — invisible at normal tracking, plainly
  // wrong at +0.5em.
  let ink = 0

  for (const ch of text) {
    const width = measure(ch, fontSize)
    glyphs.push({ ch, x: pen, width })
    // Tracking lands on the space too, the way native letter-spacing does, so
    // opening the type up widens the word gaps with it.
    if (!isSpace(ch)) ink = pen + width
    pen += width + tracking
  }

  return { glyphs, width: ink }
}

/**
 * The size a plate's type is set at on a sheet `h` px tall: the em, in
 * pixels, never under one. The one spelling of it: the layout sets the type
 * at this size, and the press reads it before any glyph is drawn (its detail
 * factor, and the second ink's blur across a word).
 */
export function plateFontSize(layer: Pick<TextLayer, 'size'>, h: number): number {
  return Math.max(1, layer.size * h)
}

/**
 * Lay out a text block. Lines break only where the text breaks them, and the
 * text is set exactly as typed — no case transform, no fitting: the stored size
 * is the size that prints (the Fit action writes one, see `fitSize`).
 *
 * @param measure returns the natural advance width of `text` at `fontSize`,
 *                excluding tracking. Injected so this stays pure.
 */
export function layoutText(layer: TextLayer, canvasHeight: number, measure: MeasureFn): TextLayout {
  const source = layer.text.split('\n')

  const fontSize = plateFontSize(layer, canvasHeight)
  const tracking = layer.tracking * fontSize

  const placed = source.map((text) => placeLine(text, fontSize, tracking, measure))
  const justify = layer.align === 'justify'

  // Justify works on a line's INK: first letter to last. A space before the
  // first letter or after the last is not a word gap — there is no word on its
  // far side — so it neither takes slack nor counts toward the measure. Left
  // in, one stray space (easy to leave on a phone keyboard) made `PRINT `
  // justify by that space alone, which pushed nothing and printed it ragged.
  // Under the other alignments a leading space is an indent, set as typed.
  const spans = placed.map((p) => (justify ? inkSpan(p.glyphs) : null))
  const widthOf = (p: (typeof placed)[number], i: number): number => {
    const span = spans[i]
    return span ? p.width - p.glyphs[span.first].x : p.width
  }
  const widest = placed.reduce((m, p, i) => Math.max(m, widthOf(p, i)), 0)

  // Justification stretches every line to the widest one, so that is the
  // block width for alignment purposes too.
  const target = widest

  const lines: LaidOutLine[] = placed.map((p, i) => {
    const span = spans[i]
    if (!span) return { text: source[i], width: p.width, glyphs: p.glyphs }

    // The ink starts the line. Spaces outside it keep their own advances
    // either side and are never drawn.
    const origin = p.glyphs[span.first].x
    const run = p.glyphs.slice(span.first, span.last + 1)
    if (run.length <= 1) {
      return { text: source[i], width: widthOf(p, i), glyphs: p.glyphs.map((g) => ({ ...g, x: g.x - origin })) }
    }

    // Feed the natural gaps through so justification adds to them rather than
    // replacing them: a word gap stays wider than a letter gap, and only the
    // leftover slack is shared out.
    const naturalGaps = run.slice(0, -1).map((g, k) => run[k + 1].x - g.x - g.width)
    // One rule per line, no setting. A line with a word gap justifies by its
    // word gaps: the slack lands beside the spaces between words (a gap counts
    // if either glyph touching it is one), so the words stay exactly as set —
    // never `S L O W  D O W N`. A line with no word gap spreads its letters —
    // the solid poster stack. `absorb` empty means every gap takes a share.
    const hasSpace = run.some((g) => isSpace(g.ch))
    const absorb = hasSpace ? run.slice(0, -1).map((g, k) => isSpace(g.ch) || isSpace(run[k + 1].ch)) : []

    const xs = justifyOffsets(
      run.map((g) => g.width),
      target,
      naturalGaps,
      absorb,
    )
    const last = p.glyphs[span.last]
    const glyphs = p.glyphs.map((g, k) => ({
      ...g,
      x:
        k < span.first
          ? g.x - origin
          : k <= span.last
            ? xs[k - span.first]
            : xs[run.length - 1] + (g.x - last.x),
    }))

    return { text: source[i], width: target, glyphs }
  })

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

/** How much of the sheet's width the Fit action fills: a small margin either
 *  side, so fitted type does not run into the trim. */
export const FIT_WIDTH = 0.92

/**
 * The size at which the layer's widest line spans `FIT_WIDTH` of the sheet's
 * width — what the Fit action stores. One-shot: it computes a size and the
 * layer keeps it, so there is one size and one source of truth, and the first
 * touch of the slider, a pinch or a key starts from what is on the sheet.
 *
 * Measured once, at a large reference size, and scaled: width is linear in
 * size (tracking is in em, so it scales too), and measuring big keeps hinting
 * error out of the ratio. Clamped to the size range.
 *
 * @param aspect the sheet's width over its height, as a NUMBER — never an
 *               aspect key, so a sheet shape the table does not list cannot
 *               reach it.
 * @param measure measures text set in a face, as the renderer will draw it.
 */
export function fitSize(layer: TextLayer, aspect: number, measure: FontMeasure): number {
  const REFERENCE = 1000
  const layout = layoutIn({ ...layer, size: 1 }, REFERENCE, measure)
  const size = layout.widest > 0 ? (FIT_WIDTH * aspect * REFERENCE) / layout.widest : layer.size
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, size))
}

/** Lay a layer out in its own face (Bold included), as the renderer will set
 *  it, on a sheet `h` pixels tall. Fit and the hit-test both measure so. */
export function layoutIn(layer: TextLayer, h: number, measure: FontMeasure): TextLayout {
  return layoutText(layer, h, (text, px) => measure(layerFont(layer, px), text))
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
 * words.
 *
 * A single-character line has no gaps to absorb the slack, so it is left where
 * it is instead of being scaled.
 *
 * @param widths per-character glyph widths, in order.
 * @param targetWidth width every line is stretched to — the widest natural line.
 * @param gaps the gap already sitting before each following character
 *   (tracking). Omitted, every gap starts at zero.
 * @returns the x offset for each character, relative to the line start.
 */
export function justifyOffsets(
  widths: readonly number[],
  targetWidth: number,
  gaps: readonly number[] = [],
  absorb: readonly boolean[] = [],
): number[] {
  const count = widths.length - 1
  // The slack is measured against the *placed* line, gaps included. Measuring
  // it against bare glyph widths instead throws the existing gaps away and
  // re-spreads them evenly, which silently changes the letterfit the tracking
  // set.
  const natural =
    widths.reduce((a, b) => a + b, 0) + gaps.slice(0, count).reduce((a, b) => a + b, 0)
  // Only some gaps may be allowed to grow — the ones beside a space, on a line
  // that has one. With none marked, the slack spreads across every gap.
  const eligible: number[] = []
  for (let i = 0; i < count; i++) if (absorb.length === 0 || absorb[i]) eligible.push(i)
  const takers = eligible.length > 0 ? eligible : Array.from({ length: count }, (_, i) => i)
  const share = new Set(takers)
  const extra = takers.length > 0 ? (targetWidth - natural) / takers.length : 0

  const xs: number[] = []
  let pen = 0
  for (let i = 0; i < widths.length; i++) {
    xs.push(pen)
    pen += widths[i] + (gaps[i] ?? 0) + (share.has(i) ? extra : 0)
  }
  return xs
}

/* ── Rasterisation ────────────────────────────────────────────────────── */

/**
 * A plate laid out and placed, ready to be drawn into any tile of its sheet:
 * one layout per plate, so every tile draws the same glyphs at the same
 * places.
 */
export interface GlyphPlan {
  layout: TextLayout
  /** Left edge of the block, in canvas space, before per-line alignment. */
  blockLeft: number
  /** Baseline of the first line, in canvas space (textBaseline is 'middle'). */
  firstBaseline: number
  /** The type's size, in pixels (the layout's). */
  fontSize: number
  /** The font cap's factor: the canvas is set at fontSize / k and drawn under
   *  `scale(k, k)`. 1 at or under CANVAS_FONT_MAX, where nothing changes. */
  k: number
}

/** How far a type size is over the canvas's font cap: 1 at or under it. */
export const fontCapFactor = (fontSize: number): number => Math.max(1, fontSize / CANVAS_FONT_MAX)

/**
 * Set the font, lay the block out, and place it. Shared by both rasterisers
 * so the glyphs and the backing are positioned by identical arithmetic.
 *
 * Type over CANVAS_FONT_MAX is measured at fontSize / k and its advances
 * scaled back by k, so the layout is the full size's while the canvas never
 * sees a font over the cap (Chromium clamps at 10,000 px and would measure
 * and draw the clamped size). At k = 1 every call is the plain one: `/ 1`
 * and `* 1` are exact.
 */
export function planGlyphs(ctx: CanvasRenderingContext2D, layer: TextLayer, h: number): GlyphPlan {
  const k = fontCapFactor(plateFontSize(layer, h))
  const setFont = (size: number) => {
    ctx.font = cssFont(layerFont(layer, size / k))
  }

  setFont(plateFontSize(layer, h))
  const measure: MeasureFn = (text, fontSize) => {
    setFont(fontSize)
    return ctx.measureText(text).width * k
  }

  const layout = layoutText(layer, h, measure)
  setFont(layout.fontSize)

  return { layout, ...blockOrigin(layout), fontSize: layout.fontSize, k }
}

/** The part of the sheet a canvas holds: the whole sheet, or one tile of it
 *  (the canvas is exactly the tile's size). */
export interface SheetPart {
  x0: number
  y0: number
  w: number
  h: number
}

/** Clear the canvas and set it up to draw a plate into `part` of a w x h
 *  sheet: the part's origin first, then the layer's placement, then the font
 *  cap's scale. Run `draw` inside, then restore. */
function inPart(
  ctx: CanvasRenderingContext2D,
  plan: GlyphPlan,
  layer: TextLayer,
  w: number,
  h: number,
  part: SheetPart,
  draw: () => void,
): void {
  ctx.clearRect(0, 0, part.w, part.h)
  ctx.save()
  // Every tile draws the same calls; only where the sheet sits differs.
  ctx.translate(-part.x0, -part.y0)
  transform(ctx, layer, w, h)
  if (plan.k !== 1) ctx.scale(plan.k, plan.k)
  // Set here as well as when planned: a canvas resized since (a tile of
  // another size) has lost its font.
  ctx.font = cssFont(layerFont(layer, plan.fontSize / plan.k))
  ctx.fillStyle = '#fff'
  draw()
  ctx.restore()
}

/**
 * Draw a plate's glyphs into `part` of its sheet: opaque white on a cleared
 * canvas, so the alpha channel is the tone. The canvas is exactly the part's
 * size.
 */
export function drawGlyphs(ctx: CanvasRenderingContext2D, plan: GlyphPlan, layer: TextLayer, w: number, h: number, part: SheetPart): void {
  const { layout, blockLeft, firstBaseline, k } = plan
  inPart(ctx, plan, layer, w, h, part, () => {
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    // Tracking is already baked into the glyph offsets; leaving the native
    // property set would apply it a second time.
    try {
      ctx.letterSpacing = '0px'
    } catch {
      // Older engines lack the property entirely, which is fine — nothing to undo.
    }
    layout.lines.forEach((line, i) => {
      const ox = blockLeft + alignOffset(line.width, layout.widest, layer.align)
      const oy = firstBaseline + i * layout.lineHeight
      for (const g of line.glyphs) {
        if (isSpace(g.ch)) continue
        ctx.fillText(g.ch, (ox + g.x) / k, oy / k)
      }
    })
  })
}

/** Draw a plate's backing (a block behind each line) into `part` of its
 *  sheet, as `drawGlyphs` draws its glyphs. */
export function drawBacking(ctx: CanvasRenderingContext2D, plan: GlyphPlan, layer: TextLayer, w: number, h: number, part: SheetPart): void {
  const { layout, blockLeft, firstBaseline, k } = plan
  inPart(ctx, plan, layer, w, h, part, () => {
    for (const r of lineRects(layout, layer.align, blockLeft, firstBaseline)) ctx.fillRect(r.x / k, r.y / k, r.w / k, r.h / k)
  })
}

/** Where a laid-out block sits about the layer's origin: centred on it, its
 *  left edge before per-line alignment and its first baseline. One spelling,
 *  shared by both rasterisers and the hit-test, so what a tap finds is where
 *  the glyphs and the backing are drawn. */
function blockOrigin(layout: TextLayout): { blockLeft: number; firstBaseline: number } {
  return { blockLeft: -layout.widest / 2, firstBaseline: -layout.blockHeight / 2 + layout.lineHeight / 2 }
}

/** Apply the layer's placement transform to the context. */
function transform(ctx: CanvasRenderingContext2D, layer: TextLayer, w: number, h: number): void {
  ctx.translate(layer.x * w, layer.y * h)
  if (layer.rotation !== 0) ctx.rotate((layer.rotation * Math.PI) / 180)
}

/**
 * Draw one text layer's glyphs over the whole sheet and return its tone
 * field: the sheet as one part (`drawGlyphs`), read back.
 *
 * Glyphs are drawn opaque white onto a cleared context, and the alpha channel
 * *is* the tone — antialiasing included, which gives the screen something to
 * bite on at glyph edges instead of a hard stair-step.
 *
 * @param ctx a 2D context whose canvas is exactly w x h. Cleared on entry.
 */
export function rasterizeText(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  w: number,
  h: number,
): { tone: Uint8Array; fontSize: number } {
  const plan = planGlyphs(ctx, layer, h)
  drawGlyphs(ctx, plan, layer, w, h, { x0: 0, y0: 0, w, h })
  // The rendered size is reported back so the press can scale its detail to
  // the type that actually landed on the sheet.
  return { tone: alphaToTone(ctx, w, h), fontSize: plan.fontSize }
}

/** The backing's padding round each line, in em, and its corners: square. */
export const BACKING_PAD = 0.12

/** A block behind one line, in the block's own coordinates (before the
 *  layer's position and rotation). */
export interface LineRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One rectangle per line that holds ink: the line's ink, first letter to last,
 * plus `BACKING_PAD` em all round, read off the same layout that places the
 * glyphs, so the block sits exactly behind its line at every size. A space
 * outside the ink (an indent, a stray trailing space) is not covered, and a
 * line with no ink (blank, or only spaces) gets no block.
 *
 * Pure: the layout and the block's origin are all it needs.
 */
export function lineRects(layout: TextLayout, align: TextAlign, blockLeft: number, firstBaseline: number): LineRect[] {
  const pad = BACKING_PAD * layout.fontSize
  // textBaseline is 'middle', so the em box straddles the baseline. These
  // fractions bracket cap height and descender for a typical face.
  const above = layout.fontSize * 0.58 + pad
  const below = layout.fontSize * 0.32 + pad
  const rects: LineRect[] = []
  layout.lines.forEach((line, i) => {
    const span = inkSpan(line.glyphs)
    if (!span || !(line.width > 0)) return
    const lead = line.glyphs[span.first].x
    const ox = blockLeft + alignOffset(line.width, layout.widest, align)
    const oy = firstBaseline + i * layout.lineHeight
    rects.push({ x: ox + lead - pad, y: oy - above, w: line.width - lead + pad * 2, h: above + below })
  })
  return rects
}

/* ── Which plate is under a point ─────────────────────────────────────── */

/** A plate and its layout on the sheet being hit-tested (`layoutIn`, at that
 *  sheet's height). */
export interface PlateLayout {
  layer: TextLayer
  layout: TextLayout
}

/**
 * The plate under a point on the sheet, or null: what a tap on the sheet
 * picks. Pure — the layouts come in, so no context is needed here.
 *
 * Each plate is tested against its line boxes: the rectangles its backing
 * fills (`lineRects`), one per line of ink, read off the same layout and the
 * same origin the glyphs are drawn from. The point is taken into the block's
 * own coordinates — moved to the layer's origin and turned back by its
 * rotation, which the drawing turns about that origin (`transform`) — so a
 * tilted line is hit along its slant, not by an upright box round it.
 *
 * Plates print in order, the last on top, so the topmost plate under the point
 * wins. `slop` lets a near miss count, for a fingertip on a caption only a few
 * pixels tall: of the plates within `slop` of the point, the nearest wins, so
 * a point inside a box always beats one beside a box; a tie goes to the
 * topmost.
 *
 * @param point in sheet pixels, from the sheet's top-left corner.
 * @param sheet the sheet's size, in the pixels the layouts were made at.
 * @param slop how far outside a box still counts, in the same pixels.
 */
export function hitLayer(
  plates: readonly PlateLayout[],
  point: { x: number; y: number },
  sheet: { w: number; h: number },
  slop = 0,
): string | null {
  let hit: string | null = null
  let nearest = Infinity
  for (const { layer, layout } of plates) {
    const { blockLeft, firstBaseline } = blockOrigin(layout)
    const turn = (layer.rotation * Math.PI) / 180
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    const dx = point.x - layer.x * sheet.w
    const dy = point.y - layer.y * sheet.h
    // The inverse of translate-then-rotate: into the block's frame.
    const bx = dx * cos + dy * sin
    const by = dy * cos - dx * sin
    for (const r of lineRects(layout, layer.align, blockLeft, firstBaseline)) {
      const out = Math.hypot(Math.max(r.x - bx, 0, bx - r.x - r.w), Math.max(r.y - by, 0, by - r.y - r.h))
      // `<=`: a later plate takes a tie, as it prints on top.
      if (out <= slop && out <= nearest) {
        nearest = out
        hit = layer.id
      }
    }
  }
  return hit
}

/**
 * Draw the layer's backing — a solid block behind each line — and return its
 * tone field.
 *
 * Emitted as its own plate so it carries its own ink and runs through the
 * identical roughen → wear → screen → misregister pipeline as the type. A
 * block that skipped that would be the one clean, undistressed rectangle on an
 * otherwise convincingly printed sheet.
 */
export function rasterizeBacking(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  w: number,
  h: number,
): { tone: Uint8Array; fontSize: number } {
  const plan = planGlyphs(ctx, layer, h)
  drawBacking(ctx, plan, layer, w, h, { x0: 0, y0: 0, w, h })
  return { tone: alphaToTone(ctx, w, h), fontSize: plan.fontSize }
}

/**
 * Read the context's alpha channel as a tone field: the alpha bytes
 * themselves, 0..255 — exactly what was drawn, in a quarter of the memory a
 * float field takes. Read in pieces (readback.ts), so the canvas's RGBA is
 * never copied out whole (4 bytes a pixel, for one byte of it).
 */
function alphaToTone(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const tone = new Uint8Array(w * h)
  readAlpha(ctx, w, h, tone, w)
  return tone
}
