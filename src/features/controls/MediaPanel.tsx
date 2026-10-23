import { useRef, useState } from 'react'
import { Field, Segmented, Slider, Toggle } from '../../ui/controls.tsx'
import { useSettings } from '../../state/settingsStore.ts'
import { importMedia } from '../media/importMedia.ts'
import type { MediaState } from '../media/useMediaBitmap.ts'
import { isReducedCopy } from '../../engine/media.ts'
import type { MediaLayer, PrintSettings } from '../../engine/types.ts'

const SHEETS: readonly { value: PrintSettings['aspect']; label: string }[] = [
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '3:4', label: '3:4' },
  { value: '2:3', label: '2:3' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

export default function MediaPanel({ mediaState }: { mediaState: MediaState }) {
  const { settings, dispatch } = useSettings()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const media = settings.media

  const patch = (p: Partial<MediaLayer>, coalesce = false) =>
    dispatch({ type: 'patchMedia', patch: p, coalesce })

  // Neither Replace nor Remove deletes the old photo's bytes: Undo can bring
  // it back, and must find it. The launch sweep (mediaStore.ts) clears what
  // nothing references any more.
  const onPick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const { layer } = await importMedia(file)
      dispatch({ type: 'setMedia', media: layer })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That image could not be read.')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onClear = () => dispatch({ type: 'setMedia', media: null })

  return (
    <div className="control-stack">
      <p className="panel-note">
        A photo sits under every plate as the ground the ink prints on, so the type
        genuinely overprints it. With this tab open, drag and pinch on the sheet to
        choose which part of it fills the sheet; double-tap to fit it again.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="visually-hidden"
        onChange={(e) => void onPick(e.target.files?.[0])}
      />

      <div className="media-actions">
        <button
          type="button"
          className="icon-button"
          data-variant="primary"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? 'Reading…' : media ? 'Replace photo' : 'Choose photo'}
        </button>
        {media && (
          <button type="button" className="icon-button" onClick={onClear}>
            Remove
          </button>
        )}
      </div>

      {error && <p className="panel-note" role="alert">{error}</p>}

      {/* Persistent while it is true: a missing photo is never printed as
          bare paper, and Save refuses too, with its reason. */}
      {mediaState === 'failed' && (
        <p className="panel-note" role="alert">
          This photo could not be loaded. Choose it again.
        </p>
      )}
      {media && isReducedCopy(media) && (
        <p className="panel-note">
          This photo was saved at reduced size by an older version. Choose it again for full resolution.
        </p>
      )}

      {/* The sheet's shape is a deliverable (a 4:5 feed, a square, a print),
          and it decides which part of the photo survives the crop. */}
      <Field label="Sheet">
        <Segmented
          label="Sheet proportions"
          value={settings.aspect}
          options={SHEETS}
          onChange={(aspect) => dispatch({ type: 'patch', patch: { aspect } })}
        />
      </Field>

      {!media ? (
        <p className="plate-hint">No photo yet — the print is on bare paper.</p>
      ) : (
        <>
          {/* Zoom in only: at 100% the photo exactly covers the sheet, and
              below that it would leave bare paper round it. */}
          <Slider
            label="Zoom"
            value={media.scale}
            min={1}
            max={4}
            step={0.01}
            format={pct}
            onChange={(scale) => patch({ scale }, true)}
          />

          {/* On, the photo takes the stock's tint and tooth, so it and the
              type read as one printed sheet. Off, the ink lands straight on
              the photograph's own colour. */}
          <Toggle
            label="Paper over the photo"
            checked={settings.paperVeil}
            onChange={(paperVeil) => dispatch({ type: 'patch', patch: { paperVeil } })}
          />
        </>
      )}
    </div>
  )
}
