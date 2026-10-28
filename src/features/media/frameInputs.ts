/**
 * What the frame's fill is made from, beyond the document (engine/frame.ts
 * `FrameInputs`): derived from the photo here, in the page, and handed to
 * the engine beside the photo. The engine never decodes and never caches
 * them.
 *
 *  - The palette (the four colours Photo, Deep, Muted and Comp are) is
 *    computed once per photo from its frame source (frameSource.ts) and
 *    stored with it (`media.palette`, through the reducer's `setPalette`,
 *    the one thing that writes it), so the preview, the save and every
 *    reopen agree.
 *  - Frosted's field (engine/frost.ts) is made from the same source for the
 *    sheet's shape and the blur, and kept (frostField.ts), not stored: it is
 *    tens of milliseconds to make again.
 *
 * Until an input is there the fill draws as Paper (the bare stock), never a
 * wrong colour; the page draws again once it arrives. Save waits for it
 * (`ensureFrameInputs`), so a press never starts without its inputs.
 */

import { effectiveMode, sheetAspect, type FrameInputs } from '../../engine/frame.ts'
import type { FrostField } from '../../engine/frost.ts'
import { FROST_DRAFT_LONG, FROST_FIELD_LONG } from '../../engine/limits.ts'
import { framePalette } from '../../engine/palette.ts'
import type { RgbaImage } from '../../engine/resample.ts'
import type { FillKey, FramePalette, PrintSettings } from '../../engine/types.ts'
import { pageFrameSources, paletteSample, type frameSources } from './frameSource.ts'
import { pageFrostFields, type frostFields } from './frostField.ts'
import type { MediaState } from './useMediaBitmap.ts'

/** The inputs a document already holds: the palette stored with its photo
 *  (`media.palette`), when it has been computed. A fill whose input is not
 *  here draws as Paper until it is. */
export const storedFrameInputs = (s: Pick<PrintSettings, 'media'>): FrameInputs => (s.media?.palette ? { palette: s.media.palette } : {})

/** The fills whose colour is one of the palette's. */
const PALETTE_FILLS: ReadonlySet<FillKey> = new Set<FillKey>(['photo', 'deep', 'muted', 'comp'])

/**
 * Whether the frame's fill can show: there is a photo, and a border, round
 * corners or Fit's matte round it. Otherwise the print composes no frame
 * (frame.ts `isUnframed`) and needs nothing made for one.
 */
export const fillShows = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>): boolean =>
  s.media !== null && (s.frame.width > 0 || s.frame.corners > 0 || effectiveMode(s) === 'fit')

/** Whether the frame shows a palette colour its photo does not hold yet. */
export const needsPalette = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>): boolean =>
  fillShows(s) && PALETTE_FILLS.has(s.frame.fill) && !s.media?.palette

/** Whether the frame shows Frosted, which is made from the photo's frame
 *  source every time the sheet's shape or the blur changes. */
export const needsFrost = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>): boolean => fillShows(s) && s.frame.fill === 'frosted'

/**
 * Where the frame's inputs are:
 *  - `none`       nothing to make (no photo, or nothing of the frame shows);
 *  - `preparing`  being made from the photo: the fill draws as Paper;
 *  - `ready`      the fill has what it needs (or needs nothing made: Paper,
 *                 or a palette colour whose palette is stored);
 *  - `failed`     the fill needs the photo's frame source, and it would not
 *                 decode.
 */
export type FrameInputState = 'none' | 'preparing' | 'ready' | 'failed'

/**
 * Where a document's frame inputs are, from what the page has of them: the
 * last attempt's outcome for its photo (`colourless`: made, and the photo
 * has no colour, so its colour fills are Paper; `failed`: its frame source
 * would not decode), and which photo's frame source is held. A failure is
 * kept with its photo until another is chosen, and counts while the fill
 * needs something made from it: a fill that needs nothing (Paper, or a
 * palette colour already stored) prints what the preview shows.
 */
export function frameInputState(
  s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>,
  outcome: 'colourless' | 'failed' | null,
  sourceId: string | null,
): FrameInputState {
  if (!fillShows(s)) return 'none'
  const palette = needsPalette(s)
  const frost = needsFrost(s)
  if (!palette && !frost) return 'ready'
  if (outcome === 'failed') return 'failed'
  const waiting = (palette && outcome !== 'colourless') || (frost && sourceId !== s.media?.id)
  return waiting ? 'preparing' : 'ready'
}

/**
 * The photo's state as Save and the panels see it: a photo the frame's
 * inputs cannot be made from is `failed`, as one that cannot be decoded at
 * all is, and Save refuses it with the same words (export.ts PHOTO_MISSING)
 * rather than pressing a frame that is quietly Paper.
 */
export const frameState = (media: MediaState, inputs: FrameInputState): MediaState => (media === 'ready' && inputs === 'failed' ? 'failed' : media)

/**
 * What the preview draws a frame of `s` from: what the document holds, and,
 * once its photo's frame source is here, Frosted's field for its sheet and
 * blur, at the draft's size (FROST_DRAFT_LONG) while a control moves and at
 * the settled one (FROST_FIELD_LONG, the size Save presses) otherwise, each
 * kept. Without the source, Frosted is Paper until it lands.
 */
export function previewFrameInputs(
  s: PrintSettings,
  source: { id: string; src: RgbaImage } | null,
  draft: boolean,
  fields: ReturnType<typeof frostFields> = pageFrostFields,
): FrameInputs {
  const inputs = storedFrameInputs(s)
  if (!s.media || !needsFrost(s) || source?.id !== s.media.id) return inputs
  inputs.frost = fields.field(s.media.id, source.src, sheetAspect(s), s.frame.blur, draft ? FROST_DRAFT_LONG : FROST_FIELD_LONG)
  return inputs
}

/**
 * The palettes, one photo's at a time, from its frame source: asked again
 * for the same photo, the same answer without a second computation (Save
 * asks for the one the page is making). Null for a photo with no pixel
 * opaque enough to have a colour: its colour fills are Paper.
 */
export function framePalettes(sources: ReturnType<typeof frameSources> = pageFrameSources) {
  let held: { id: string; palette: Promise<FramePalette | null> } | null = null
  return {
    palette(media: { id: string; width: number; height: number }): Promise<FramePalette | null> {
      if (held?.id !== media.id) held = { id: media.id, palette: sources.load(media).then((src) => framePalette(paletteSample(src))) }
      return held.palette
    },
  }
}

/** The page's. */
export const pageFramePalettes = framePalettes()

/** What `ensureFrameInputs` makes the inputs with (a test hands in its
 *  own). */
export interface FrameMakers {
  palette(media: { id: string; width: number; height: number }): Promise<FramePalette | null>
  /** Frosted's field of the photo, for a sheet of `aspect`, at `blur`,
   *  `fieldLong` on its long side. */
  frost(media: { id: string; width: number; height: number }, aspect: number, blur: number, fieldLong: number): Promise<FrostField>
}

/** The page's: one decode of each photo (frameSource.ts), its palette made
 *  once, its fields kept (frostField.ts). */
export const PAGE_MAKERS: FrameMakers = {
  palette: (media) => pageFramePalettes.palette(media),
  frost: async (media, aspect, blur, fieldLong) => pageFrostFields.field(media.id, await pageFrameSources.load(media), aspect, blur, fieldLong),
}

/**
 * The inputs a press of this document needs, made now if they are not held:
 * Save awaits this before it presses, so a press never starts without them.
 * The palette is made only when the document does not hold it, and not
 * stored here (the page's `useFrameInputs` stores it; it is the same
 * palette, from the same decode); Frosted's field at the save's size
 * (FROST_FIELD_LONG, the settled preview's too). Rejects when the photo
 * cannot be read for them.
 */
export async function ensureFrameInputs(s: PrintSettings, makers: FrameMakers = PAGE_MAKERS): Promise<FrameInputs> {
  const inputs = storedFrameInputs(s)
  if (!s.media) return inputs
  if (needsPalette(s)) {
    const palette = await makers.palette(s.media)
    if (palette) inputs.palette = palette
  }
  if (needsFrost(s)) inputs.frost = await makers.frost(s.media, sheetAspect(s), s.frame.blur, FROST_FIELD_LONG)
  return inputs
}
