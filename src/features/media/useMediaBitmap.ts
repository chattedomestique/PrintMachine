import { useEffect, useRef, useState } from 'react'
import { getMedia } from '../../state/mediaStore.ts'

/**
 * The decoded photo for the current document, or null.
 *
 * Decoding is not free and the bytes live in IndexedDB, so this holds one
 * bitmap and swaps it only when the id changes — moving or scaling the photo
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
export function useMediaBitmap(id: string | null): ImageBitmap | null {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const currentRef = useRef<ImageBitmap | null>(null)

  useEffect(() => {
    let live = true

    const load = id
      ? getMedia(id).then((blob) => (blob ? createImageBitmap(blob) : null))
      : Promise.resolve<ImageBitmap | null>(null)

    void load
      // A missing or unreadable photo means printing on bare paper, which is a
      // worse print but a working app.
      .catch(() => null)
      .then((next) => {
        if (!live) {
          next?.close()
          return
        }
        const prev = currentRef.current
        if (prev && prev !== next) prev.close()
        currentRef.current = next
        setBitmap(next)
      })

    return () => {
      live = false
    }
  }, [id])

  // Unmount only — see above.
  useEffect(
    () => () => {
      currentRef.current?.close()
      currentRef.current = null
    },
    [],
  )

  return bitmap
}
