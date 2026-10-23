import { useEffect, useRef, useState } from 'react'
import type { MediaLayer } from '../../engine/types.ts'
import { decodePreview } from './decode.ts'

/**
 * Where the preview's photo is:
 *  - `none`     the document has no photo;
 *  - `loading`  the photo the document names is being decoded;
 *  - `ready`    the bitmap is that photo's;
 *  - `failed`   its stored image is missing or cannot be decoded — said out
 *               loud (the Photo panel's alert), never printed as bare paper.
 */
export type MediaState = 'none' | 'loading' | 'ready' | 'failed'

/** What the hook holds: the outcome of the last decode, and which photo it
 *  was for. */
export interface HeldMedia {
  id: string | null
  bitmap: ImageBitmap | null
  failed: boolean
}

/**
 * The state, DERIVED from the id the held decode was for. Never stored: the
 * previous photo's bitmap stays held until the next decode lands, so a state
 * flipped only when a promise resolves would report the OLD photo as `ready`
 * for the new id — and anything drawing then would draw the wrong photo.
 */
export function mediaState(id: string | null, held: HeldMedia | null): MediaState {
  if (id === null) return 'none'
  if (!held || held.id !== id) return 'loading'
  return held.failed ? 'failed' : 'ready'
}

/** What the hook hands out: a bitmap only when it is the named photo's. */
export function fromHeld(id: string | null, held: HeldMedia | null): { bitmap: ImageBitmap | null; state: MediaState } {
  const state = mediaState(id, held)
  return { bitmap: state === 'ready' ? (held?.bitmap ?? null) : null, state }
}

/**
 * The preview's decoded photo for the current document, and where it is.
 *
 * A WORKING copy, sized for the preview (decode.ts `PREVIEW_PHOTO_AREA`), from
 * the photo's true size in the document. It is drawn scaled into the same
 * rectangle the original would fill, so geometry never depends on it; Save
 * decodes the original itself.
 *
 * Decoding is not free and the bytes live in IndexedDB, so this holds one
 * bitmap and swaps it only when the photo changes — moving or zooming it
 * re-renders from the same decode.
 *
 * Everything lands through a promise, including the "no photo" case, so no
 * state is ever set synchronously inside the effect. That is not a lint
 * formality: a synchronous set here cascades a second render pass on every id
 * change, and the rule catching it is one the playbook records as having been
 * red and ignored in a shipped app.
 *
 * The live bitmap is tracked in a ref as well as state, because closing the
 * previous one has to happen exactly once — doing it from an effect keyed on
 * the bitmap closes it again on unmount, and a closed ImageBitmap draws
 * nothing.
 */
export function useMediaBitmap(media: Pick<MediaLayer, 'id' | 'width' | 'height'> | null): {
  bitmap: ImageBitmap | null
  state: MediaState
} {
  const id = media?.id ?? null
  // A photo's size never changes under its id (an import mints a new id), so
  // these only ever change together with it.
  const width = media?.width ?? 0
  const height = media?.height ?? 0
  const [held, setHeld] = useState<HeldMedia | null>(null)
  const currentRef = useRef<ImageBitmap | null>(null)

  useEffect(() => {
    let live = true

    const load: Promise<HeldMedia> = id
      ? decodePreview(id, width, height).then(
          (bitmap) => ({ id, bitmap, failed: false }),
          () => ({ id, bitmap: null, failed: true }),
        )
      : Promise.resolve({ id: null, bitmap: null, failed: false })

    void load.then((next) => {
      if (!live) {
        next.bitmap?.close()
        return
      }
      const prev = currentRef.current
      if (prev && prev !== next.bitmap) prev.close()
      currentRef.current = next.bitmap
      setHeld(next)
    })

    return () => {
      live = false
    }
  }, [id, width, height])

  // Unmount only — see above.
  useEffect(
    () => () => {
      currentRef.current?.close()
      currentRef.current = null
    },
    [],
  )

  return fromHeld(id, held)
}
