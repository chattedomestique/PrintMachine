/**
 * The document model.
 *
 * Split the way a real press is: the *print settings* describe the machine —
 * paper, screen, ink density, how badly it registers — and are global, while
 * each *layer* is one plate's artwork and its ink. That split is why adding a
 * second or third colour doesn't multiply the number of controls.
 *
 * Lives in engine/ because engine/ is what consumes it; state/ imports from
 * here, never the other way round.
 */

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

/**
 * An imported photo, sitting under every plate as the ground the ink prints on.
 *
 * The bytes are not here — they live in IndexedDB, keyed by `id`, because a
 * photo cannot go in localStorage and a document that carried one would blow
 * the quota on the first save. This is only the placement.
 */
export interface MediaLayer {
  id: string
  /** Intrinsic pixel size of the decoded image, for the cover fit. */
  width: number
  height: number
  /** Zoom on the cover fit, at least 1: 1 exactly fills the sheet. */
  scale: number
  /** Centre of the photo in sheet fractions, kept inside the range where the
   *  photo still covers the sheet (media.ts `panBounds`). */
  x: number
  y: number
}

/** Screening method. A duplicator's RIP does one or the other, not both. */
export type ScreenMethod = 'halftone' | 'grain'

export interface FontChoice {
  readonly id: string
  readonly name: string
  /** A CSS font-family stack. System fonts only — an external font in an
   *  offline-first app is a contradiction (playbook §3.6). */
  readonly stack: string
}

export const FONTS: readonly FontChoice[] = [
  { id: 'grotesk', name: 'Grotesk', stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` },
  { id: 'serif', name: 'Serif', stack: `ui-serif, 'New York', Georgia, 'Times New Roman', serif` },
  { id: 'mono', name: 'Mono', stack: `ui-monospace, SFMono-Regular, Menlo, 'Courier New', monospace` },
  { id: 'poster', name: 'Poster', stack: `Impact, Haettenschweiler, 'Arial Narrow Bold', 'Helvetica Neue', sans-serif` },
]

export function fontById(id: string): FontChoice {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]
}

/** One plate: some type, in one ink. */
export interface TextLayer {
  id: string
  text: string
  /** Ink id from inks.ts. */
  inkId: string
  fontId: string
  /** Bold (weight 700) or regular (400). The weight decision that matters on a
   *  photo: heavier strokes survive the screen, the tear and the bleed. */
  bold: boolean
  /** Type size as a fraction of the canvas height. The size that prints: the
   *  Fit action writes one, nothing scales it afterwards. */
  size: number
  /** Multiple of the type size. */
  lineHeight: number
  /** Letter spacing in em — between every character. */
  tracking: number
  /**
   * A second ink for wherever the photo behind the type is dark.
   *
   * Type in one ink over a photograph is unreadable by definition: the photo
   * runs from paper-white to solid, and no single transparent ink reads
   * against both ends. So the pass switches ink by what is underneath — a
   * split fountain driven by the image rather than by position on the sheet —
   * and knocks the photo back to paper under the second ink, because a
   * transparent light ink over solid black is still solid black.
   *
   * The plate's own ink is a valid second ink ("Keep this ink"): both halves
   * print that ink, and the photo is knocked back to paper wherever it is
   * darker than the ink, so one colour stays readable across the whole photo
   * — the riso way, with the ink still transparent.
   *
   * null is off, and the type prints in one ink everywhere. Never set
   * together with `backing`.
   */
  contrastInkId: string | null
  /** Luminance below which the photo counts as dark, 0..1. */
  contrastThreshold: number

  /** Justify stretches every line to the widest: a line with a space by its
   *  word gaps, a line without one by its letters. */
  align: TextAlign
  /** Anchor position, 0..1 of canvas width/height. */
  x: number
  y: number
  /** Degrees, clockwise. */
  rotation: number

  /**
   * A solid block of ink behind each line of the type, or null for none: the
   * ink id it is printed in. Pressed as its own plate before the type, so it
   * tears, bleeds and misregisters like everything else, and the type
   * overprints it into a third colour. The photo is cut back to paper under
   * it, so the block reads the same over any part of the picture. Padding
   * 0.12 em, square corners. Never set together with `contrastInkId`.
   */
  backing: string | null
}

/**
 * Everything about how one pass is pulled. One per document: the photo is the
 * ground the type prints on, not a pass of its own, so the press is the
 * type's.
 *
 * The seed is deliberately *not* here: it is one sheet of paper going through
 * one machine, so every pass on it varies together.
 */
export interface PressProfile {
  /** Halftone dots, or Atkinson grain. */
  method: ScreenMethod
  /** Halftone lattice pitch in pixels at the reference render size; the grain
   *  cell is a third of it. */
  screenPitch: number
  /** Ink density ceiling in [0,1] — the "Ink" control. */
  density: number
  /** Max plate offset in pixels at the reference render size. */
  misregistration: number
  /** 0..1. The burned stencil's edge: tear and bleed together (ink.ts
   *  `edgeToRough`). */
  edge: number
  /** 0..0.8. The drum's uneven ink film: mottle and speckle dropout together
   *  (ink.ts `wearToMottle`). */
  wear: number
}

export interface PrintSettings {
  /** The photo behind everything, or null for bare paper. */
  media: MediaLayer | null
  /**
   * Whether the paper's colour and tooth veil the photo. On, the photo looks
   * printed on the same stock as the type; off, the ink lands straight on the
   * photograph's own colour. No effect without a photo, where the paper is the
   * ground by definition.
   */
  paperVeil: boolean

  /** Output aspect. The render resolution is fixed in render.ts and does not
   *  depend on the display size (playbook §5.2). */
  aspect: '1:1' | '4:5' | '3:4' | '2:3'

  /** The stock. Its tooth and cloudiness are fixed (render.ts). */
  paperId: string

  /** How the type is pulled. */
  press: PressProfile

  seed: number
  layers: TextLayer[]
}

export const ASPECTS: Record<PrintSettings['aspect'], number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
}
