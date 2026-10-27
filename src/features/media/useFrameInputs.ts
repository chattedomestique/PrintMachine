import { useEffect, useMemo, useState } from 'react'
import type { FrameInputs } from '../../engine/frame.ts'
import type { PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import { fillShows, needsPalette, pageFramePalettes } from './frameInputs.ts'
import type { MediaState } from './useMediaBitmap.ts'

/**
 * Where the frame's inputs are:
 *  - `none`       nothing to make (no photo, or nothing of the frame shows);
 *  - `preparing`  being made from the photo: the fill draws as Paper;
 *  - `ready`      the fill has what it needs;
 *  - `failed`     the photo could not be read for them.
 */
export type FrameInputState = 'none' | 'preparing' | 'ready' | 'failed'

/**
 * The preview's frame inputs for the current document, and where they are.
 * On the first need (a frame whose fill is a palette colour, on a photo
 * whose palette is not stored) the palette is made once the preview's own
 * copy of the photo has landed, so the two decodes never run together, and
 * stored with the photo (`setPalette`, which is not an undo step).
 */
export function useFrameInputs(settings: PrintSettings, media: MediaState, palettes = pageFramePalettes): { inputs: FrameInputs; state: FrameInputState } {
  const { dispatch } = useSettings()
  const photo = settings.media
  const id = photo?.id ?? null
  const width = photo?.width ?? 0
  const height = photo?.height ?? 0
  const want = needsPalette(settings)
  // What the last attempt for a photo came to, when it stored nothing: the
  // photo has no colour (its fills are Paper), or it could not be read.
  const [settled, setSettled] = useState<{ id: string; outcome: 'colourless' | 'failed' } | null>(null)

  useEffect(() => {
    if (!want || media !== 'ready' || !id) return
    void palettes.palette({ id, width, height }).then(
      (palette) => {
        if (palette) dispatch({ type: 'setPalette', mediaId: id, palette })
        else setSettled({ id, outcome: 'colourless' })
      },
      () => setSettled({ id, outcome: 'failed' }),
    )
  }, [want, media, id, width, height, dispatch, palettes])

  const palette = photo?.palette
  const inputs = useMemo<FrameInputs>(() => (palette ? { palette } : {}), [palette])
  const outcome = settled && settled.id === id ? settled.outcome : null
  const state: FrameInputState = !fillShows(settings) ? 'none' : outcome === 'failed' ? 'failed' : want && outcome !== 'colourless' ? 'preparing' : 'ready'
  return { inputs, state }
}
