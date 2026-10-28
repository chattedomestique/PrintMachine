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
import { frostFields, pageFrostFields } from './frostField.ts'
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

/** Whether the page should make the photo's palette: the frame shows, and
 *  the photo does not hold one yet, whatever the fill. The fill row shows
 *  all four colours before one is chosen (Border Studio keys its swatches
 *  on every photo), and under Frosted the source it is made from is decoded
 *  anyway. */
export const wantsPalette = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>): boolean => fillShows(s) && !s.media?.palette

/** Whether the print needs the palette made: the frame shows a palette
 *  colour its photo does not hold yet. */
export const needsPalette = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>): boolean =>
  wantsPalette(s) && PALETTE_FILLS.has(s.frame.fill)

/** Whether the frame shows Frosted, which is made from the photo's frame
 *  source every time the sheet's shape or the blur changes. */
export const needsFrost = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>): boolean => fillShows(s) && s.frame.fill === 'frosted'

/**
 * What the page keeps of its attempts to make the frame's inputs from the
 * photo shown (`shown`): whether its last attempt failed (`failedId`, its
 * id, or null), and Frosted's source, once decoded, with the photo it is
 * of.
 */
export interface FrameAttempts {
  shown: string | null
  failedId: string | null
  source: { id: string; src: RgbaImage } | null
}

export const noAttempts = (shown: string | null): FrameAttempts => ({ shown, failedId: null, source: null })

/**
 * Another photo shown (a Replace, an Undo, a Redo): a failure is let go, so
 * a photo brought back reads as it does at first load (Paper, Save offered
 * and waiting for its source) until its new attempt ends, and is refused
 * again only if that one fails. The source is kept: it is drawn only for
 * its own photo, and let go if that photo's new attempt fails.
 */
export const attemptsShown = (a: FrameAttempts, shown: string | null): FrameAttempts => (a.shown === shown ? a : { ...a, shown, failedId: null })

/**
 * An attempt for photo `id` ended: it worked (with Frosted's source, `src`,
 * when it was Frosted's) or failed. Applied only while `id` is the photo
 * shown: a decode that ends after its photo was replaced, or undone, changes
 * nothing of the photo shown now, neither its source nor its failure. A
 * failure also lets go a source kept for that photo from an earlier decode
 * (one made before it was replaced and brought back), so the frame is Paper
 * whenever the photo is said to be one that could not be loaded.
 */
export function attemptEnded(a: FrameAttempts, id: string, ok: boolean, src?: RgbaImage): FrameAttempts {
  if (a.shown !== id) return a
  if (!ok) return { ...a, failedId: id, source: a.source?.id === id ? null : a.source }
  return { ...a, failedId: null, source: src ? { id, src } : a.source }
}

/**
 * Whether a press of `s` cannot be made: its photo's frame source would not
 * decode (`failedId`), and the print needs something made from it (a
 * palette colour not stored, or Frosted). A fill that needs nothing made
 * (Paper, or a palette colour already stored) prints what the preview
 * shows.
 */
export const frameFailed = (s: Pick<PrintSettings, 'media' | 'frame' | 'aspect'>, failedId: string | null): boolean =>
  failedId !== null && s.media?.id === failedId && (needsPalette(s) || needsFrost(s))

/**
 * The photo's state as Save and the panels see it: a photo the frame's
 * inputs cannot be made from is `failed`, as one that cannot be decoded at
 * all is, and Save refuses it with the same words (export.ts PHOTO_MISSING)
 * rather than pressing a frame that is quietly Paper.
 */
export const frameState = (media: MediaState, failed: boolean): MediaState => (media === 'ready' && failed ? 'failed' : media)

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
  /** Resolves once no frame-source decode is running, whatever photo it was
   *  begun for (frameSource.ts `idle`); never rejects. */
  idle(): Promise<void>
}

/** The makers over one set of frame sources: one decode of each photo, its
 *  palette made once from it, its fields kept (frostField.ts). */
export function frameMakers(
  sources: ReturnType<typeof frameSources>,
  palettes: ReturnType<typeof framePalettes> = framePalettes(sources),
  fields: ReturnType<typeof frostFields> = frostFields(),
): FrameMakers {
  return {
    palette: (media) => palettes.palette(media),
    frost: async (media, aspect, blur, fieldLong) => fields.field(media.id, await sources.load(media), aspect, blur, fieldLong),
    idle: () => sources.idle(),
  }
}

/** The page's. */
export const PAGE_MAKERS: FrameMakers = frameMakers(pageFrameSources, pageFramePalettes, pageFrostFields)

/**
 * The inputs a press of this document needs, made now if they are not held:
 * Save awaits this before it presses, so a press never starts without them,
 * and before it decodes the original, so every frame-source decode is over
 * first and none runs beside the original's: the ones this print needs,
 * and any other still running (`makers.idle`), begun for a photo replaced
 * or undone, or for a frame that no longer shows. The palette is asked for
 * whenever the page is making it (`wantsPalette`, any framed fill: the same
 * held promise, from the same decode), and awaited under every fill; only
 * a print that shows a palette colour (`needsPalette`) takes it or fails
 * without it, so a source that cannot be read refuses no Paper save. It is
 * not stored here (the page's `useFrameInputs` stores it). Frosted's field
 * at the save's size (FROST_FIELD_LONG, the settled preview's too). Rejects
 * when the photo cannot be read for what the print needs.
 */
export async function ensureFrameInputs(s: PrintSettings, makers: FrameMakers = PAGE_MAKERS): Promise<FrameInputs> {
  const inputs = storedFrameInputs(s)
  if (!s.media) return inputs
  if (wantsPalette(s)) {
    const made = makers.palette(s.media)
    if (needsPalette(s)) {
      const palette = await made
      if (palette) inputs.palette = palette
    } else await made.catch(() => null)
  }
  if (needsFrost(s)) inputs.frost = await makers.frost(s.media, sheetAspect(s), s.frame.blur, FROST_FIELD_LONG)
  await makers.idle()
  return inputs
}
