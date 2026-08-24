/**
 * Type → tone field.
 *
 * The only part of the engine that needs a real 2D context, because glyph
 * rasterisation is not something worth reimplementing. The context is handed
 * in rather than created here, so the engine still owns no DOM of its own and
 * the export path can pass an offscreen one.
 *
 * Layout is separated from drawing and produces *placed glyphs* — every
 * character's x offset within its line. Letter tracking, word tracking,
 * justification and the background boxes all read those same numbers, which is
 * the point: a box drawn from one set of positions while the glyphs are drawn
 * from another will drift apart, and it will drift differently at every font
 * size. One layout, one source of truth.
 *
 * That also means glyphs are drawn one at a time rather than a line at a time,
 * which gives up native kerning. It is the right trade here — this is poster
 * type with tracking applied, where kerning barely registers, and the
 * alternative is boxes that don't line up with the words they sit behind.
 */

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
  /** Advance width in pixels, tracking and word spacing included. */
  width: number
  glyphs: PlacedGlyph[]
  words: PlacedWord[]
}

export interface TextLayout {
  lines: LaidOutLine[]
  /** Font size in pixels, after any fit-to-width scaling. */
  fontSize: number
  /** Letter spacing in pixels, after scaling. */
  tracking: number
  /** Extra space at each word gap, in pixels, after scaling. */
  wordSpacing: number
  lineHeight: number
  widest: number
  blockHeight: number
}

export type MeasureFn = (text: string, fontSize: number) => number

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t'

/**
 * Place every glyph in a line, and group them into words as it goes.
 *
 * One pass rather than place-then-group, because per-word tracking makes the
 * two inseparable: the advance after a character depends on which word that
 * character belongs to. Grouping afterwards would mean deciding word
 * boundaries twice, and any disagreement between the two puts a word's box in
 * a different place from the word.
 *
 * Advances are the character's own width, plus `tracking` (global) plus that
 * word's own tracking delta, plus `wordSpacing` additionally after a space.
 * Tracking lands on spaces as well as letters, matching native letter-spacing,
 * so opening the type up widens the gaps between words along with it.
 */
function placeLine(
  text: string,
  line: number,
  startWordIndex: number,
  fontSize: number,
  tracking: number,
  wordSpacing: number,
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
      // opening the type up widens the word gaps with it. Word tracking is the
      // extra on top, for when the gaps should move independently.
      pen += width + tracking + wordSpacing
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
  let wordSpacing = layer.wordSpacing * fontSize

  const placeAll = () => {
    let next = 0
    return source.map((text, i) => {
      const out = placeLine(text, i, next, fontSize, tracking, wordSpacing, measure)
      next = out.nextWordIndex
      return out
    })
  }

  let placed = placeAll()
  let widest = placed.reduce((m, p) => Math.max(m, p.width), 0)

  if (layer.fitWidth && widest > 0 && maxWidth > 0) {
    const scale = maxWidth / widest
    fontSize *= scale
    tracking *= scale
    wordSpacing *= scale
    // Re-place rather than scaling the offsets: glyph advances are not exactly
    // linear in font size once hinting is involved, and a box positioned from
    // scaled offsets would sit slightly off the re-measured glyphs.
    placed = placeAll()
    widest = placed.reduce((m, p) => Math.max(m, p.width), 0)
  }

  // Justification stretches every line to the widest one, so that is the
  // block width for alignment purposes too.
  const target = widest

  const lines: LaidOutLine[] = placed.map((p, i) => {
    if (layer.align !== 'justify' || p.glyphs.length <= 1) {
      return { text: source[i], width: p.width, glyphs: p.glyphs, words: p.words }
    }

    // Justification moves glyphs, so the words have to be re-derived from the
    // moved glyphs rather than kept from the natural placement — otherwise a
    // box would sit where the word *would* have been.
    // Feed the natural gaps through so justification adds to them rather than
    // replacing them: a word gap stays wider than a letter gap by exactly the
    // word tracking, and only the leftover slack is shared out.
    const naturalGaps = p.glyphs
      .slice(0, -1)
      .map((g, k) => p.glyphs[k + 1].x - g.x - g.width)
    const xs = justifyOffsets(
      p.glyphs.map((g) => g.width),
      target,
      naturalGaps,
    )
    const glyphs = p.glyphs.map((g, k) => ({ ...g, x: xs[k] }))

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
    wordSpacing,
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
 * @param widths per-character glyph widths, in order.
 * @param targetWidth width every line is stretched to — the widest natural line.
 * @param gaps the gap already sitting before each following character (tracking,
 *   and word tracking at spaces). Omitted, every gap starts at zero.
 * @returns the x offset for each character, relative to the line start.
 */
export function justifyOffsets(
  widths: readonly number[],
  targetWidth: number,
  gaps: readonly number[] = [],
): number[] {
  const count = widths.length - 1
  // The slack is measured against the *placed* line, gaps included. Measuring
  // it against bare glyph widths instead throws the existing gaps away and
  // re-spreads them evenly, which silently converts word tracking into letter
  // tracking — the words end up no further apart than the letters.
  const natural =
    widths.reduce((a, b) => a + b, 0) + gaps.slice(0, count).reduce((a, b) => a + b, 0)
  const extra = count > 0 ? (targetWidth - natural) / count : 0

  const xs: number[] = []
  let pen = 0
  for (let i = 0; i < widths.length; i++) {
    xs.push(pen)
    pen += widths[i] + (gaps[i] ?? 0) + extra
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
function prepare(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  w: number,
  h: number,
): Prepared {
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
): { tone: Float32Array; fontSize: number } {
  ctx.clearRect(0, 0, w, h)
  const { layout, blockLeft, firstBaseline } = prepare(ctx, layer, w, h)

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

  layout.lines.forEach((line, i) => {
    const ox = blockLeft + alignOffset(line.width, layout.widest, layer.align)
    const oy = firstBaseline + i * layout.lineHeight
    for (const g of line.glyphs) {
      if (isSpace(g.ch)) continue
      ctx.fillText(g.ch, ox + g.x, oy)
    }
  })

  ctx.restore()
  // The rendered size is reported back because fit-to-width means the layer's
  // requested `size` is not what actually landed on the sheet, and the press
  // scales its detail to the real thing.
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

  const { layout, blockLeft, firstBaseline } = prepare(ctx, layer, w, h)
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

/** The layer's words, without needing a canvas — for the selection UI. */
export function layoutWords(
  layer: TextLayer,
  canvasHeight: number,
  maxWidth: number,
  measure: MeasureFn,
): PlacedWord[] {
  return wordsOf(layoutText(layer, canvasHeight, maxWidth, measure))
}
