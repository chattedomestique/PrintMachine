import { useEffect, useRef, useState } from 'react'
import type { MediaLayer } from '../../engine/types.ts'
import { decodePreview, previewArea, workingSize } from './decode.ts'

/** How long a zoom must rest before the photo is decoded again at a new tier:
 *  a pinch or a slider drag crosses tiers on its way. */
export const REDECODE_MS = 300

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

/** Which photo a decode is of, and which copy of it (`copyKey`). */
export interface DecodeJob {
  id: string | null
  copy: string
}

/** The copy a decode at `area` makes, as a key: its pixel size, which is the
 *  photo's own when the photo fits the tier. Two tiers that make the same
 *  copy (a photo smaller than both) are the same copy. */
export function copyKey(width: number, height: number, area: number): string {
  const size = workingSize(width, height, area)
  return size ? `${size.width}x${size.height}` : `${width}x${height}`
}

/**
 * What to do for photo `id` wanting copy `want`, given the decode `held` and
 * the one in flight:
 *  - `none`   nothing: the held copy is the one wanted, or a decode of it is
 *             on its way (a new photo's first decode is let land even at
 *             another copy; the right one follows it);
 *  - `drop`   the held copy is the one wanted again: the decode in flight, of
 *             another copy, is not needed;
 *  - `now`    decode at once: a new photo (or none held yet);
 *  - `later`  this photo is held at another copy: decode once the zoom and
 *             the sheet have rested REDECODE_MS, keeping the copy there is.
 */
export function decodeWhen(
  held: DecodeJob | null,
  inflight: DecodeJob | null,
  id: string | null,
  want: string,
): 'none' | 'drop' | 'now' | 'later' {
  if (inflight && inflight.id === id && inflight.copy === want) return 'none'
  if (held && held.id === id) {
    if (held.copy === want) return inflight ? 'drop' : 'none'
    return 'later'
  }
  if (inflight && inflight.id === id) return 'none'
  return 'now'
}

/**
 * The preview's decoded photo for the current document, and where it is.
 *
 * A WORKING copy, sized for what the preview shows at the photo's zoom on its
 * sheet (decode.ts `previewArea`), from the photo's true size in the
 * document. It is drawn scaled into the same rectangle the original would
 * fill, so geometry never depends on it; Save decodes the original itself.
 *
 * Decoding is not free and the bytes live in IndexedDB, so this holds one
 * bitmap. A new photo is decoded at once. The same photo is decoded again
 * only when the copy its zoom and sheet call for (a tier of `previewArea`) is
 * not the copy held, and only once the zoom and the sheet have rested for
 * REDECODE_MS: every change restarts the wait, so a pinch or a slider drag
 * that crosses tiers on its way decodes once, where it stops. Coming back to
 * the tier already held decodes nothing (and drops a decode of another tier
 * still in flight). Until a new copy lands the old one is drawn (the state
 * stays `ready`), and a decode at a new tier that fails keeps the old copy —
 * it is the same photo, not a missing one (`decodeWhen`).
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
 * nothing. The decode in flight is tracked in a ref too, not tied to the
 * effect's cleanup: the effect re-runs on every zoom step, and a first decode
 * cancelled by each would never land.
 */
export function useMediaBitmap(
  media: Pick<MediaLayer, 'id' | 'width' | 'height' | 'scale'> | null,
  /** The sheet's width over its height (`sheetAspect`). */
  aspect: number,
  /** The frame's width and how the photo is placed (`effectiveMode`): the
   *  photo is drawn inside the frame. */
  frame: { width: number; mode: 'crop' | 'fit' } = { width: 0, mode: 'crop' },
): {
  bitmap: ImageBitmap | null
  state: MediaState
} {
  const id = media?.id ?? null
  // A photo's size never changes under its id (an import mints a new id), so
  // these only ever change together with it.
  const width = media?.width ?? 0
  const height = media?.height ?? 0
  // Every change of these restarts the wait before a re-decode.
  const scale = media?.scale ?? 1
  const frameWidth = frame.width
  const fit = frame.mode === 'fit'
  // The copy's tier: changes with the zoom, the sheet and its frame, in
  // coarse steps.
  const area = media ? previewArea(media, aspect, { width: frameWidth, mode: fit ? 'fit' : 'crop' }) : 0
  const want = media ? copyKey(width, height, area) : ''
  const [held, setHeld] = useState<(HeldMedia & DecodeJob) | null>(null)
  const currentRef = useRef<ImageBitmap | null>(null)
  const inflightRef = useRef<(DecodeJob & { dropped: boolean }) | null>(null)
  const heldId = held?.id
  const heldCopy = held?.copy

  useEffect(() => {
    const heldJob = heldId === undefined ? null : { id: heldId, copy: heldCopy ?? '' }
    const action = decodeWhen(heldJob, inflightRef.current, id, want)
    if (action === 'none') return
    if (action === 'drop') {
      if (inflightRef.current) inflightRef.current.dropped = true
      inflightRef.current = null
      return
    }
    // The photo already held, wanted at another copy: keep drawing the copy
    // there is.
    const sameId = action === 'later'

    const timer = window.setTimeout(
      () => {
        if (inflightRef.current) inflightRef.current.dropped = true
        const job = { id, copy: want, dropped: false }
        inflightRef.current = job
        const load: Promise<(HeldMedia & DecodeJob) | null> = id
          ? decodePreview(id, width, height, area).then(
              (bitmap) => ({ id, copy: want, bitmap, failed: false }),
              // A new tier that cannot be decoded keeps the copy there is.
              () => (sameId ? null : { id, copy: want, bitmap: null, failed: true }),
            )
          : Promise.resolve({ id: null, copy: want, bitmap: null, failed: false })

        void load.then((next) => {
          if (inflightRef.current === job) inflightRef.current = null
          if (job.dropped) {
            next?.bitmap?.close()
            return
          }
          if (!next) return
          const prev = currentRef.current
          if (prev && prev !== next.bitmap) prev.close()
          currentRef.current = next.bitmap
          setHeld(next)
        })
      },
      sameId ? REDECODE_MS : 0,
    )

    return () => window.clearTimeout(timer)
    // `scale`, `aspect`, `frameWidth` and `fit` are not read here: they are
    // dependencies so that every change of the zoom, the sheet or its frame
    // restarts the wait.
  }, [id, width, height, area, want, scale, aspect, frameWidth, fit, heldId, heldCopy])

  // Unmount only — see above.
  useEffect(
    () => () => {
      if (inflightRef.current) inflightRef.current.dropped = true
      inflightRef.current = null
      currentRef.current?.close()
      currentRef.current = null
    },
    [],
  )

  return fromHeld(id, held)
}
