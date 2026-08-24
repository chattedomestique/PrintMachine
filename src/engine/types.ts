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

/** Screening method. A duplicator's RIP does one or the other, not both. */
export type ScreenMethod = 'halftone' | 'dither'

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
  align: TextAlign
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

export interface PrintSettings {
  /** Output aspect. The render resolution is fixed in render.ts and does not
   *  depend on the display size (playbook §5.2). */
  aspect: '1:1' | '4:5' | '3:4' | '2:3'

  paperId: string
  paperTexture: number
  paperBlotch: number

  method: ScreenMethod
  screenShape: ScreenShape
  /** Lattice pitch in pixels at the reference render size. */
  screenPitch: number
  screenSoftness: number
  ditherType: DitherType
  ditherThreshold: number

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

  seed: number
  layers: TextLayer[]
}

export const ASPECTS: Record<PrintSettings['aspect'], number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
}
