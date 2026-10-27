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
 *
 * Until an input is there the fill draws as Paper (the bare stock), never a
 * wrong colour; the page draws again once it arrives. Save waits for it
 * (`ensureFrameInputs`), so a press never starts without its inputs.
 */

import { effectiveMode, type FrameInputs } from '../../engine/frame.ts'
import { framePalette } from '../../engine/palette.ts'
import type { FillKey, FramePalette, PrintSettings } from '../../engine/types.ts'
import { pageFrameSources, paletteSample, type frameSources } from './frameSource.ts'

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

/**
 * The palettes, one photo's at a time, from its frame source: asked again
 * for the same photo, the same answer without a second computation (a photo
 * whose palette an undo took away gets it back at once). Null for a photo
 * with no pixel opaque enough to have a colour: its colour fills are Paper.
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

/**
 * The inputs a press of this document needs, made now if they are not held:
 * Save awaits this before it presses, so a press never starts without them.
 * A palette made here is not stored (the page's `useFrameInputs` stores it);
 * it is the same palette, from the same decode. Rejects when the photo
 * cannot be read for them.
 */
export async function ensureFrameInputs(s: PrintSettings, palettes = pageFramePalettes): Promise<FrameInputs> {
  const held = storedFrameInputs(s)
  if (!s.media || !needsPalette(s)) return held
  const palette = await palettes.palette(s.media)
  return palette ? { ...held, palette } : held
}
