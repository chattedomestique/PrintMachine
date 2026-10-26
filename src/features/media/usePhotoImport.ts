import { useCallback, useState, type RefObject } from 'react'
import { useSettings } from '../../state/settingsStore.ts'
import { importMedia } from './importMedia.ts'

/** Choosing a photo: one file input for the whole app, opened from wherever
 *  a "Choose photo" is (the Photo tool's File tab, its empty Frame tab, the
 *  card that says a photo could not be loaded). */
export interface PhotoImport {
  /** Open the picker. */
  choose: () => void
  /** Store the picked file and put it under the print. */
  onPick: (file: File | undefined) => Promise<void>
  busy: boolean
  /** Why the last pick could not be used ("That image could not be read."). */
  error: string | null
}

/**
 * Neither Replace nor Remove deletes the old photo's bytes: Undo can bring
 * it back, and must find it. The launch sweep (mediaStore.ts) clears what
 * nothing references any more.
 *
 * @param announce says a failure in the status region too, so a pick made
 *   from outside the Photo tool is not refused in silence.
 */
export function usePhotoImport(
  /** The app's one file input. */
  inputRef: RefObject<HTMLInputElement | null>,
  announce: (message: string, kind: 'error') => void,
): PhotoImport {
  const { dispatch } = useSettings()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = useCallback(() => inputRef.current?.click(), [inputRef])

  const onPick = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      setBusy(true)
      setError(null)
      try {
        const { layer } = await importMedia(file)
        dispatch({ type: 'setMedia', media: layer })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'That image could not be read.'
        setError(message)
        announce(message, 'error')
      } finally {
        setBusy(false)
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [dispatch, announce, inputRef],
  )

  return { choose, onPick, busy, error }
}
