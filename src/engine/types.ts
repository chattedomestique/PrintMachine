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

import type { DitherType } from './dither.ts'
import type { ScreenShape } from './screen.ts'

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

/** Where forced justification puts the slack it needs to fill the measure.
 *  'words' keeps the words themselves tight and opens the spaces between them;
 *  'letters' spreads every gap equally for the solid rectangular block. A line
 *  with no spaces has nowhere to put word slack, so it falls back to letters. */
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
  /** Multiplier on the cover fit; 1 exactly fills the sheet. */
  scale: number
  x: number
  y: number
  opacity: number
  /** Run the photo through the press — separated, worn, screened, misregistered. */
  printed: boolean
  /** Ink for the separated plate. Only read when `printed`. */
  inkId: string
  contrast: number
  lift: number
}

export type JustifyBy = 'words' | 'letters'

/** Which edge a line with no spaces sits against inside a justified block.
 *  Such a line has no word gap to open, and pulling its letters apart to reach
 *  the measure tears the word in half — so it keeps its natural spacing and
 *  parks at one edge instead. */
export type SoloAlign = 'left' | 'right'

/** Screening method. A duplicator's RIP does one or the other, not both. */
export type ScreenMethod = 'halftone' | 'dither' | 'woodcut' | 'scribble'

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
  { id: 'rounded', name: 'Rounded', stack: `ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', system-ui, sans-serif` },
  { id: 'poster', name: 'Poster', stack: `Impact, Haettenschweiler, 'Arial Narrow Bold', 'Helvetica Neue', sans-serif` },
]

export function fontById(id: string): FontChoice {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]
}

/**
 * A solid box behind a chosen set of words.
 *
 * Its own ink and opacity, because the whole point is emphasis — a box in the
 * text's colour is just a heavier weight. Rendered as a separate plate under
 * the type, through the identical wear pipeline.
 */
export interface WordBox {
  id: string
  /** Global word indices, whitespace-split across the layer's whole text. */
  words: number[]
  inkId: string
  opacity: number
}

/** One plate: some type, in one ink. */
export interface TextLayer {
  id: string
  text: string
  /** Ink id from inks.ts. */
  inkId: string
  fontId: string
  /** CSS font-weight, 100–900. Ignored by fonts with a single weight. */
  weight: number
  /** Type size as a fraction of the canvas height. */
  size: number
  /** Multiple of the type size. */
  lineHeight: number
  /** Letter spacing in em — between every character. */
  tracking: number
  /** Word spacing in em — extra at each space, on top of tracking. */
  wordSpacing: number
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
   * null is off, and the type prints in one ink everywhere.
   */
  /**
   * Per-word press overrides, keyed by word index.
   *
   * Bleed and offset are properties *of a plate*, not of a pixel — bleed is
   * where the stencil's threshold sits, offset is where the paper landed. So a
   * word given either becomes its own plate and goes through the press
   * separately, which is also exactly how a real second hit would behave.
   * Deltas on the layer's press, so the global controls still move everything.
   */
  wordPress: Record<string, { bleed?: number; offset?: number }>

  /**
   * Print this layer's type and boxes *over* the photo instead of into it.
   *
   * Riso ink is transparent, so by default a plate multiplies down from
   * whatever it lands on — which is the whole reason type genuinely overprints
   * a photograph. Sometimes what you want is the opposite: the words sitting on
   * the image at full strength, unaffected by whatever is underneath.
   */
  opaque: boolean

  contrastInkId: string | null
  /** Luminance below which the photo counts as dark, 0..1. */
  contrastThreshold: number

  align: TextAlign
  justifyBy: JustifyBy
  soloAlign: SoloAlign
  /** Anchor position, 0..1 of canvas width/height. */
  x: number
  y: number
  /** Degrees, clockwise. */
  rotation: number
  caps: boolean
  opacity: number
  /** Scale the block uniformly so its widest line fills the canvas width. */
  fitWidth: boolean

  /** Background boxes, drawn under the type in plate order. */
  boxes: WordBox[]
  /** How far a box extends past its words, in em. */
  boxPadding: number
  /** Box corner radius in em. 0 is a hard rectangle. */
  boxRadius: number
}

/**
 * Everything about how one pass is pulled.
 *
 * Two of these exist per document — one for the type, one for the photo —
 * because a photo and a headline want genuinely different presses. A screen
 * coarse enough to read as print on a poster word turns a photograph into
 * mud, and wear tuned to tear a letterform pleasantly just reads as damage
 * across a face. Sharing one profile means every change to one ruins the
 * other, which is what the first cut of the photo layer did.
 *
 * The seed is deliberately *not* here: it is one sheet of paper going through
 * one machine, so both passes vary together.
 */
export interface PressProfile {
  method: ScreenMethod
  screenShape: ScreenShape
  /** Lattice pitch in pixels at the reference render size. */
  screenPitch: number
  screenSoftness: number
  ditherType: DitherType
  ditherThreshold: number
  /** Dither cell size in pixels at the reference render size. */
  ditherScale: number

  /** Spacing of woodcut grooves or scribble strokes, in px at reference size. */
  carvePitch: number
  /** Direction of the cut or the hatch, in degrees. */
  carveAngle: number
  /** 0..1. How far those marks wander from straight. */
  carveRoughness: number

  /** Ink density ceiling in [0,1]. */
  density: number
  /** Midtone shaping; <1 lays down more ink. */
  gamma: number
  mottle: number
  dropout: number
  banding: number

  /** Edge raggedness from the burned stencil, 0..1. */
  roughness: number
  /** Feature size of that raggedness, in px at the reference height. */
  roughScale: number
  /** Ink spread past the artwork edge, 0..1. */
  bleed: number
  /** Pale drum streaks running the length of the sheet, 0..1. */
  streaks: number
  /** Ink drag along the feed direction, 0..1. */
  smear: number
  /** Regions where ink did not transfer at all, 0..1. */
  patches: number
  /** Max plate offset in pixels at the reference render size. */
  misregistration: number

  /**
   * Scale the press's detail to the rendered type size.
   *
   * On: small type gets a proportionally finer screen, tear and bleed so it
   * stays legible. Off: one ruling for the whole sheet, which is physically
   * what a Riso does and what destroys small words.
   */
  detailScaling: boolean

}

export interface PrintSettings {
  /** The photo behind everything, or null for bare paper. */
  media: MediaLayer | null
  /**
   * How much of the paper's colour and tooth veils the photo. 0 prints
   * straight onto it; 1 is full stock character. No effect without a photo,
   * where the paper is the ground by definition.
   */
  paperAmount: number

  /** Output aspect. The render resolution is fixed in render.ts and does not
   *  depend on the display size (playbook §5.2). */
  aspect: '1:1' | '4:5' | '3:4' | '2:3'

  paperId: string
  paperTexture: number
  paperBlotch: number

  /** How the type is pulled. */
  press: PressProfile
  /** How the photo is pulled, when it is printed rather than shown as shot. */
  photoPress: PressProfile

  seed: number
  layers: TextLayer[]
}

export const ASPECTS: Record<PrintSettings['aspect'], number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
}
