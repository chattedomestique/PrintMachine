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
  /** The photo's true pixel size, the right way up (EXIF orientation
   *  applied): the original's, since an import stores the original bytes.
   *  The cover fit, the pan and the export plan read this, never the size of
   *  whatever copy the preview decoded. */
  width: number
  height: number
  /** True for every photo imported since imports stopped resampling: the
   *  stored bytes are the original's. Absent on a document saved by an older
   *  build, whose stored copy was cut to a 2048 px long edge (media.ts
   *  `isReducedCopy`). */
  native?: boolean
  /** Zoom on the cover fit, at least 1: 1 exactly fills the visible
   *  rectangle (the sheet inside its frame; unframed, the sheet). */
  scale: number
  /** Centre of the photo in fractions of the visible rectangle, kept inside
   *  the range where the photo still covers it (media.ts `panBounds`). */
  x: number
  y: number
  /** The frame's four photo-keyed colours, computed once from this photo and
   *  stored with it, so the preview, the save and every reopen agree. Absent
   *  until computed; never set by hand (the reducer's `setPalette`). */
  palette?: FramePalette
}

/** The four colours a frame can take from its photo, as '#rrggbb'. */
export interface FramePalette {
  photo: string
  deep: string
  muted: string
  comp: string
}

/** What fills the frame: bare paper, one of the photo's four colours, or a
 *  blurred copy of the photo. The document stores the choice, never a
 *  colour, so a new photo re-keys the frame by itself. */
export type FillKey = 'paper' | keyof FramePalette | 'frosted'

/**
 * The frame round the photo.
 *
 * A document from before the frame opens with the template's width of 0:
 * unframed, exactly as it was saved.
 */
export interface FrameSettings {
  /** The border, as a fraction of the sheet's long side, 0..FRAME_WIDTH_MAX.
   *  0 is no frame. */
  width: number
  /** 0..1: the radius of the photo's corners, as a fraction of an eighth of
   *  the photo's shorter side. 0 is square. */
  corners: number
  fill: FillKey
  /** Frosted's blur, BLUR_MIN..BLUR_MAX; read only when the fill is Frosted. */
  blur: number
  /** Crop fills the inside of the frame with the photo, trimming what
   *  overhangs; Fit shows the whole photo inside it, matted by the fill. An
   *  Original sheet is always Crop. */
  mode: 'crop' | 'fit'
}

/** Screening method. A duplicator's RIP does one or the other, not both. */
export type ScreenMethod = 'halftone' | 'grain'

export interface FontChoice {
  readonly id: string
  readonly name: string
  /** A CSS font-family stack. Poster leads with the one bundled face,
   *  Tanklager Kompakt (src/styles/fonts.css, precached, so it is there
   *  offline); the others are system stacks. The rest of a stack is what a
   *  face that will not load falls back to. */
  readonly stack: string
  /** Whether the face has a bold. Tanklager is one weight: a Poster plate's
   *  Bold is kept in the document but sets nothing (`layerFont`), so no
   *  browser fakes one, and the press is the same on every engine. */
  readonly bold: boolean
}

export const FONTS: readonly FontChoice[] = [
  { id: 'grotesk', name: 'Grotesk', stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`, bold: true },
  { id: 'serif', name: 'Serif', stack: `ui-serif, 'New York', Georgia, 'Times New Roman', serif`, bold: true },
  { id: 'mono', name: 'Mono', stack: `ui-monospace, SFMono-Regular, Menlo, 'Courier New', monospace`, bold: true },
  { id: 'poster', name: 'Poster', stack: `Tanklager, Impact, Haettenschweiler, 'Arial Narrow Bold', 'Helvetica Neue', sans-serif`, bold: false },
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

  /** The sheet's shape: a fixed ratio, or 'original', the photo's own shape
   *  (frame.ts `sheetAspect`). The render resolution does not depend on the
   *  display size (playbook §5.2). */
  aspect: FixedAspect | 'original'

  /** The stock. Its tooth and cloudiness are fixed (render.ts). */
  paperId: string

  /** How the type is pulled. */
  press: PressProfile

  /** The frame round the photo (none at width 0). */
  frame: FrameSettings

  seed: number
  layers: TextLayer[]
}

/** A sheet shape with a fixed ratio: square, or a portrait ratio and its
 *  landscape twin (aspect.ts `flipOf`). */
export type FixedAspect = '1:1' | '4:5' | '5:4' | '3:4' | '4:3' | '2:3' | '3:2' | '9:16' | '16:9'

/** Width over height of each fixed sheet shape. */
export const ASPECTS: Record<FixedAspect, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '2:3': 2 / 3,
  '3:2': 3 / 2,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
}
