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
 * background boxes all read those same numbers, which is
 * the point: a box drawn from one set of positions while the glyphs are drawn
 * from another will drift apart, and it will drift differently at every font
 * size. One layout, one source of truth.
 *
 * That also means glyphs are drawn one at a time rather than a line at a time,
 * which gives up native kerning. It is the right trade here — this is poster
 * type with tracking applied, where kerning barely registers, and the
 * alternative is boxes that don't line up with the words they sit behind.
 */

import { SIZE_MAX, SIZE_MIN } from './limits.ts'
import { fontById, type TextAlign, type TextLayer } from './types.ts'

export interface PlacedGlyph {
  ch: string
  /** Offset from the line's left edge, in pixels. */
  x: number
  width: number
}

export interface PlacedWord {
  text: string
  /** Index across the whole layer, whitespace-split — what a box refers to. */
  index: number
  /** Offset from the line's left edge, in pixels. */
  x: number
  width: number
  /** Which line this word sits on. */
  line: number
}

export interface LaidOutLine {
  text: string
  /** Advance width in pixels, tracking included. */
  width: number
  glyphs: PlacedGlyph[]
  words: PlacedWord[]
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

/**
 * Place every glyph in a line, and group them into words as it goes, so a
 * word's span is read off the same positions its glyphs are drawn at.
 *
 * Advances are the character's own width plus `tracking`. Tracking lands on
 * spaces as well as letters, matching native letter-spacing, so opening the
 * type up widens the gaps between words along with it.
 */
function placeLine(
  text: string,
  line: number,
  startWordIndex: number,
  fontSize: number,
  tracking: number,
  measure: MeasureFn,
): { glyphs: PlacedGlyph[]; words: PlacedWord[]; width: number; nextWordIndex: number } {
  const glyphs: PlacedGlyph[] = []
  const words: PlacedWord[] = []

  let pen = 0
  // Right edge of the last inked glyph. The line's width is this, not `pen`:
  // every glyph advances by its own trailing tracking, so `pen` ends one gap
  // past the ink. Counting that gap makes a centred line sit left of centre
  // and a right-aligned one stop short — invisible at normal tracking, plainly
  // wrong at +0.5em.
  let ink = 0
  let wordIndex = startWordIndex
  let run: PlacedGlyph[] = []

  const closeWord = () => {
    if (run.length === 0) return
    const first = run[0]
    const last = run[run.length - 1]
    words.push({
      text: run.map((g) => g.ch).join(''),
      index: wordIndex,
      x: first.x,
      // To the right edge of the last glyph, not to its advance origin.
      width: last.x + last.width - first.x,
      line,
    })
    run = []
    wordIndex += 1
  }

  for (const ch of text) {
    const width = measure(ch, fontSize)
    const glyph = { ch, x: pen, width }
    glyphs.push(glyph)

    if (isSpace(ch)) {
      closeWord()
      // Tracking lands on the space too, the way native letter-spacing does, so
      // opening the type up widens the word gaps with it.
      pen += width + tracking
    } else {
      run.push(glyph)
      ink = pen + width
      pen += width + tracking
    }
  }
  closeWord()

  return { glyphs, words, width: ink, nextWordIndex: wordIndex }
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

  const fontSize = Math.max(1, layer.size * canvasHeight)
  const tracking = layer.tracking * fontSize

  let next = 0
  const placed = source.map((text, i) => {
    const out = placeLine(text, i, next, fontSize, tracking, measure)
    next = out.nextWordIndex
    return out
  })
  const widest = placed.reduce((m, p) => Math.max(m, p.width), 0)

  // Justification stretches every line to the widest one, so that is the
  // block width for alignment purposes too.
  const target = widest

  const lines: LaidOutLine[] = placed.map((p, i) => {
    if (layer.align !== 'justify' || p.glyphs.length <= 1) {
      return { text: source[i], width: p.width, glyphs: p.glyphs, words: p.words }
    }

    // Feed the natural gaps through so justification adds to them rather than
    // replacing them: a word gap stays wider than a letter gap, and only the
    // leftover slack is shared out.
    const naturalGaps = p.glyphs
      .slice(0, -1)
      .map((g, k) => p.glyphs[k + 1].x - g.x - g.width)
    // One rule per line, no setting. A line with a space justifies by its word
    // gaps: the slack lands beside the spaces (a gap counts if either glyph
    // touching it is one), so the words stay exactly as set — never
    // `S L O W  D O W N`. A line with no space has no word gap to open, so it
    // spreads its letters — the solid poster stack. `absorb` empty means
    // every gap takes a share.
    const hasSpace = p.glyphs.some((g) => isSpace(g.ch))
    const absorb = hasSpace
      ? p.glyphs.slice(0, -1).map((g, k) => isSpace(g.ch) || isSpace(p.glyphs[k + 1].ch))
      : []

    const xs = justifyOffsets(
      p.glyphs.map((g) => g.width),
      target,
      naturalGaps,
      absorb,
    )
    const glyphs = p.glyphs.map((g, k) => ({ ...g, x: xs[k] }))

    // Justification moved the glyphs, so the words are re-derived from the
    // moved glyphs rather than kept from the natural placement — otherwise a
    // box would sit where the word *would* have been.
    const words: PlacedWord[] = []
    let run: PlacedGlyph[] = []
    let w = 0
    const close = () => {
      if (run.length === 0) return
      const first = run[0]
      const last = run[run.length - 1]
      words.push({
        text: run.map((g) => g.ch).join(''),
        index: p.words[w]?.index ?? w,
        x: first.x,
        width: last.x + last.width - first.x,
        line: i,
      })
      run = []
      w += 1
    }
    for (const g of glyphs) {
      if (isSpace(g.ch)) close()
      else run.push(g)
    }
    close()

    return { text: source[i], width: target, glyphs, words }
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
  const layout = layoutText({ ...layer, size: 1 }, REFERENCE, (text, px) =>
    measure(layerFont(layer, px), text),
  )
  const size = layout.widest > 0 ? (FIT_WIDTH * aspect * REFERENCE) / layout.widest : layer.size
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, size))
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

/** Every word in the layer, in reading order. Drives the selection UI. */
export function wordsOf(layout: TextLayout): PlacedWord[] {
  return layout.lines.flatMap((l) => l.words)
}

/* ── Rasterisation ────────────────────────────────────────────────────── */

interface Prepared {
  layout: TextLayout
  /** Left edge of the block, in canvas space, before per-line alignment. */
  blockLeft: number
  /** Baseline of the first line, in canvas space (textBaseline is 'middle'). */
  firstBaseline: number
}

/** Set the font, lay the block out, and place it. Shared by both rasterisers
 *  so glyphs and boxes are positioned by identical arithmetic. */
function prepare(ctx: CanvasRenderingContext2D, layer: TextLayer, h: number): Prepared {
  const setFont = (size: number) => {
    ctx.font = cssFont(layerFont(layer, size))
  }

  setFont(Math.max(1, layer.size * h))
  const measure: MeasureFn = (text, fontSize) => {
    setFont(fontSize)
    return ctx.measureText(text).width
  }

  const layout = layoutText(layer, h, measure)
  setFont(layout.fontSize)

  return {
    layout,
    blockLeft: -layout.widest / 2,
    firstBaseline: -layout.blockHeight / 2 + layout.lineHeight / 2,
  }
}

/** Apply the layer's placement transform to the context. */
function transform(ctx: CanvasRenderingContext2D, layer: TextLayer, w: number, h: number): void {
  ctx.translate(layer.x * w, layer.y * h)
  if (layer.rotation !== 0) ctx.rotate((layer.rotation * Math.PI) / 180)
}

/**
 * Draw one text layer's glyphs and return its tone field.
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
  /**
   * Restrict the raster to (or exclude) a set of word indices.
   *
   * A word given its own bleed or its own offset has to become its own plate,
   * because both of those happen *to a plate* — bleed is a threshold on the
   * stencil, offset is where the paper landed. Faking them inside one plate
   * would mean per-pixel parameters, which is not a thing a press has. So the
   * layer is rasterised twice: everything except the special words, and then
   * each group of special words on its own.
   */
  words?: { only: ReadonlySet<number> } | { except: ReadonlySet<number> },
): { tone: Float32Array; fontSize: number } {
  ctx.clearRect(0, 0, w, h)
  const { layout, blockLeft, firstBaseline } = prepare(ctx, layer, h)

  ctx.save()
  transform(ctx, layer, w, h)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  // Tracking is already baked into the glyph offsets; leaving the native
  // property set would apply it a second time.
  try {
    ctx.letterSpacing = '0px'
  } catch {
    // Older engines lack the property entirely, which is fine — nothing to undo.
  }

  // Which word each glyph belongs to, by the same grouping the layout used —
  // so an index here means the word the selection UI shows.
  const wanted = (index: number) => {
    if (!words) return true
    return 'only' in words ? words.only.has(index) : !words.except.has(index)
  }

  layout.lines.forEach((line, i) => {
    const ox = blockLeft + alignOffset(line.width, layout.widest, layer.align)
    const oy = firstBaseline + i * layout.lineHeight
    for (const g of line.glyphs) {
      if (isSpace(g.ch)) continue
      if (words) {
        const word = line.words.find((word) => g.x >= word.x && g.x < word.x + word.width)
        if (!wanted(word?.index ?? -1)) continue
      }
      ctx.fillText(g.ch, ox + g.x, oy)
    }
  })

  ctx.restore()
  // The rendered size is reported back so the press can scale its detail to
  // the type that actually landed on the sheet.
  return { tone: alphaToTone(ctx, w, h), fontSize: layout.fontSize }
}

/**
 * Draw solid boxes behind a chosen set of words and return their tone field.
 *
 * Emitted as its own plate so it carries its own ink and runs through the
 * identical roughen → wear → screen → misregister pipeline as the type. A box
 * that skipped that would be the one clean, undistressed rectangle on an
 * otherwise convincingly printed sheet.
 *
 * @param words global word indices to cover, as produced by the layout.
 */
export function rasterizeBoxes(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  w: number,
  h: number,
  words: ReadonlySet<number>,
): Float32Array {
  ctx.clearRect(0, 0, w, h)
  if (words.size === 0) return new Float32Array(w * h)

  const { layout, blockLeft, firstBaseline } = prepare(ctx, layer, h)
  const pad = layer.boxPadding * layout.fontSize
  const radius = Math.max(0, layer.boxRadius * layout.fontSize)

  // textBaseline is 'middle', so the em box straddles the baseline. These
  // fractions bracket cap height and descender for a typical face.
  const above = layout.fontSize * 0.58 + pad
  const below = layout.fontSize * 0.32 + pad

  ctx.save()
  transform(ctx, layer, w, h)
  ctx.fillStyle = '#fff'

  layout.lines.forEach((line, lineIndex) => {
    const ox = blockLeft + alignOffset(line.width, layout.widest, layer.align)
    const oy = firstBaseline + lineIndex * layout.lineHeight

    // Merge adjacent selected words into one box, so "very large" reads as a
    // single band rather than two abutting rectangles with a seam down them.
    let run: { x0: number; x1: number } | null = null
    const flush = () => {
      if (!run) return
      const x = ox + run.x0 - pad
      const y = oy - above
      const bw = run.x1 - run.x0 + pad * 2
      const bh = above + below
      ctx.beginPath()
      if (radius > 0 && typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, bw, bh, Math.min(radius, bh / 2, bw / 2))
      } else {
        ctx.rect(x, y, bw, bh)
      }
      ctx.fill()
      run = null
    }

    for (const word of line.words) {
      if (!words.has(word.index)) {
        flush()
        continue
      }
      if (run) run.x1 = word.x + word.width
      else run = { x0: word.x, x1: word.x + word.width }
    }
    flush()
  })

  ctx.restore()
  return alphaToTone(ctx, w, h)
}

/** Read the context's alpha channel as a tone field. */
function alphaToTone(ctx: CanvasRenderingContext2D, w: number, h: number): Float32Array {
  const { data } = ctx.getImageData(0, 0, w, h)
  const tone = new Float32Array(w * h)
  for (let i = 0, p = 3; i < tone.length; i++, p += 4) tone[i] = data[p] / 255
  return tone
}
