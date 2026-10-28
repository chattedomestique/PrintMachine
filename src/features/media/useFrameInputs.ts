import { useCallback, useEffect, useState } from 'react'
import type { FrameInputs } from '../../engine/frame.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { attemptEnded, attemptsShown, frameFailed, needsFrost, noAttempts, pageFramePalettes, previewFrameInputs, wantsPalette } from './frameInputs.ts'
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
 * A source that would not decode is kept with its photo while it is shown,
 * and let go when another is (`attemptsShown`): a photo brought back by an
 * Undo reads as at first load until its new attempt ends. While the print
 * needs it, the frame is Paper and `failed` is true (Save refuses). An
 * attempt's result is applied only while its photo is the one shown
 * (`attemptEnded`), so a replaced photo's late decode never takes the place
 * of the shown photo's source or failure; the palette it makes is stored
 * with its own photo all the same (`setPalette` keys it).
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
  // The photo shown, whether its last attempt failed, and its frame source
  // for Frosted once decoded. Another photo shown lets a failure go (set
  // while rendering, as React adjusts state to a prop that changed).
  const [attempts, setAttempts] = useState(() => noAttempts(id))
  if (attempts.shown !== id) setAttempts(attemptsShown(attempts, id))

  useEffect(() => {
    if (!wantPalette || media !== 'ready' || !id) return
    void makers.palettes.palette({ id, width, height }).then(
      (palette) => {
        // Null: the photo has no colour; its colour fills are Paper.
        if (palette) dispatch({ type: 'setPalette', mediaId: id, palette })
        setAttempts((a) => attemptEnded(a, id, true))
      },
      () => setAttempts((a) => attemptEnded(a, id, false)),
    )
  }, [wantPalette, media, id, width, height, dispatch, makers])

  useEffect(() => {
    if (!wantFrost || media !== 'ready' || !id) return
    void makers.sources.load({ id, width, height }).then(
      (src) => setAttempts((a) => attemptEnded(a, id, true, src)),
      () => setAttempts((a) => attemptEnded(a, id, false)),
    )
  }, [wantFrost, media, id, width, height, makers])

  // What a frame of `s` is drawn from: what the document holds, and
  // Frosted's field for its sheet and blur once the source is here.
  const source = attempts.source
  const inputsFor = useCallback((s: PrintSettings, draft: boolean): FrameInputs => previewFrameInputs(s, source, draft, makers.fields), [source, makers])

  return { inputsFor, failed: frameFailed(settings, attempts.shown === id ? attempts.failedId : null) }
}
