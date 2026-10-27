import { useCallback, useEffect, useState } from 'react'
import { sheetAspect, type FrameInputs } from '../../engine/frame.ts'
import { FROST_DRAFT_LONG, FROST_FIELD_LONG } from '../../engine/limits.ts'
import type { RgbaImage } from '../../engine/resample.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { fillShows, needsFrost, needsPalette, pageFramePalettes, storedFrameInputs } from './frameInputs.ts'
import { pageFrameSources } from './frameSource.ts'
import { pageFrostFields } from './frostField.ts'
import type { MediaState } from './useMediaBitmap.ts'

/**
 * Where the frame's inputs are:
 *  - `none`       nothing to make (no photo, or nothing of the frame shows);
 *  - `preparing`  being made from the photo: the fill draws as Paper;
 *  - `ready`      the fill has what it needs;
 *  - `failed`     the photo could not be read for them.
 */
export type FrameInputState = 'none' | 'preparing' | 'ready' | 'failed'

/** The page's makers (a test hands in its own). */
const PAGE = { palettes: pageFramePalettes, sources: pageFrameSources, fields: pageFrostFields }

/**
 * The preview's frame inputs for the current document, and where they are.
 *
 * On the first need (a frame whose fill is a palette colour, on a photo
 * whose palette is not stored; or Frosted) the photo's frame source is
 * decoded once its preview copy has landed, so the two decodes never run
 * together. The palette made from it is stored with the photo
 * (`setPalette`, which is not an undo step). Frosted's field is made from it
 * when a frame is drawn (`inputsFor`): at the settled size (480) for a
 * settled frame, at the draft's (160) while a control moves, each kept
 * (frostField.ts), so a Blur drag stays fluid and the settled frame is the
 * one Save presses.
 */
export function useFrameInputs(
  settings: PrintSettings,
  media: MediaState,
  makers = PAGE,
): { inputsFor: (s: PrintSettings, draft: boolean) => FrameInputs; state: FrameInputState } {
  const { dispatch } = useSettings()
  const photo = settings.media
  const id = photo?.id ?? null
  const width = photo?.width ?? 0
  const height = photo?.height ?? 0
  const wantPalette = needsPalette(settings)
  const wantFrost = needsFrost(settings)
  // What the last attempt for a photo came to, when it stored nothing: the
  // photo has no colour (its fills are Paper), or it could not be read.
  const [settled, setSettled] = useState<{ id: string; outcome: 'colourless' | 'failed' } | null>(null)
  // The photo's frame source, for Frosted, once decoded.
  const [source, setSource] = useState<{ id: string; src: RgbaImage } | null>(null)

  useEffect(() => {
    if (!wantPalette || media !== 'ready' || !id) return
    void makers.palettes.palette({ id, width, height }).then(
      (palette) => {
        if (palette) dispatch({ type: 'setPalette', mediaId: id, palette })
        else setSettled({ id, outcome: 'colourless' })
      },
      () => setSettled({ id, outcome: 'failed' }),
    )
  }, [wantPalette, media, id, width, height, dispatch, makers])

  useEffect(() => {
    if (!wantFrost || media !== 'ready' || !id) return
    void makers.sources.load({ id, width, height }).then(
      (src) => setSource({ id, src }),
      () => setSettled({ id, outcome: 'failed' }),
    )
  }, [wantFrost, media, id, width, height, makers])

  // What a frame of `s` is drawn from: what the document holds, and
  // Frosted's field for its sheet and blur once the source is here.
  const inputsFor = useCallback(
    (s: PrintSettings, draft: boolean): FrameInputs => {
      const inputs = storedFrameInputs(s)
      if (!s.media || !needsFrost(s) || source?.id !== s.media.id) return inputs
      inputs.frost = makers.fields.field(s.media.id, source.src, sheetAspect(s), s.frame.blur, draft ? FROST_DRAFT_LONG : FROST_FIELD_LONG)
      return inputs
    },
    [source, makers],
  )

  const outcome = settled && settled.id === id ? settled.outcome : null
  const waiting = (wantPalette && outcome !== 'colourless') || (wantFrost && source?.id !== id)
  const state: FrameInputState = !fillShows(settings) ? 'none' : outcome === 'failed' ? 'failed' : waiting ? 'preparing' : 'ready'
  return { inputsFor, state }
}
