import { useCallback, useEffect, useState } from 'react'
import type { FrameInputs } from '../../engine/frame.ts'
import type { RgbaImage } from '../../engine/resample.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { afterAttempt, frameFailed, needsFrost, pageFramePalettes, previewFrameInputs, wantsPalette } from './frameInputs.ts'
import { pageFrameSources } from './frameSource.ts'
import { pageFrostFields } from './frostField.ts'
import type { MediaState } from './useMediaBitmap.ts'

/** The page's makers (a test hands in its own). */
const PAGE = { palettes: pageFramePalettes, sources: pageFrameSources, fields: pageFrostFields }

/**
 * The preview's frame inputs for the current document, and whether a press
 * of it cannot be made.
 *
 * Once a frame shows on a photo whose palette is not stored (whatever the
 * fill), or Frosted shows, the photo's frame source is decoded once its
 * preview copy has landed, so the two decodes never run together. The
 * palette made from it is stored with the photo (`setPalette`, which is not
 * an undo step). Frosted's field is made from it when a frame is drawn
 * (`inputsFor`): at the settled size (480) for a settled frame, at the
 * draft's (160) while a control moves, each kept (frostField.ts); the
 * settled frame is the one Save presses.
 *
 * A source that would not decode is kept with its photo (`failedId`) until
 * an attempt for that photo works; while the print needs it, the frame is
 * Paper and `failed` is true (Save refuses).
 */
export function useFrameInputs(
  settings: PrintSettings,
  media: MediaState,
  makers = PAGE,
): { inputsFor: (s: PrintSettings, draft: boolean) => FrameInputs; failed: boolean } {
  const { dispatch } = useSettings()
  const photo = settings.media
  const id = photo?.id ?? null
  const width = photo?.width ?? 0
  const height = photo?.height ?? 0
  const wantPalette = wantsPalette(settings)
  const wantFrost = needsFrost(settings)
  // The photo whose frame source would not decode, on its last attempt.
  const [failedId, setFailedId] = useState<string | null>(null)
  // The photo's frame source, for Frosted, once decoded.
  const [source, setSource] = useState<{ id: string; src: RgbaImage } | null>(null)

  useEffect(() => {
    if (!wantPalette || media !== 'ready' || !id) return
    void makers.palettes.palette({ id, width, height }).then(
      (palette) => {
        // Null: the photo has no colour; its colour fills are Paper.
        if (palette) dispatch({ type: 'setPalette', mediaId: id, palette })
        setFailedId((f) => afterAttempt(f, id, true))
      },
      () => setFailedId((f) => afterAttempt(f, id, false)),
    )
  }, [wantPalette, media, id, width, height, dispatch, makers])

  useEffect(() => {
    if (!wantFrost || media !== 'ready' || !id) return
    void makers.sources.load({ id, width, height }).then(
      (src) => {
        setSource({ id, src })
        setFailedId((f) => afterAttempt(f, id, true))
      },
      () => setFailedId((f) => afterAttempt(f, id, false)),
    )
  }, [wantFrost, media, id, width, height, makers])

  // What a frame of `s` is drawn from: what the document holds, and
  // Frosted's field for its sheet and blur once the source is here.
  const inputsFor = useCallback((s: PrintSettings, draft: boolean): FrameInputs => previewFrameInputs(s, source, draft, makers.fields), [source, makers])

  return { inputsFor, failed: frameFailed(settings, failedId) }
}
