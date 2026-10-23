import { useRef, useState } from 'react'
import { Slider, Toggle } from '../../ui/controls.tsx'
import { useSettings } from '../../state/settingsStore.ts'
import { importMedia } from '../media/importMedia.ts'
import { deleteMedia } from '../../state/mediaStore.ts'
import type { MediaLayer } from '../../engine/types.ts'

const pct = (v: number) => `${Math.round(v * 100)}%`

export default function MediaPanel() {
  const { settings, dispatch } = useSettings()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const media = settings.media

  const patch = (p: Partial<MediaLayer>, coalesce = false) =>
    dispatch({ type: 'patchMedia', patch: p, coalesce })

  const onPick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const previous = media?.id
      const { layer } = await importMedia(file)
      dispatch({ type: 'setMedia', media: layer })
      // Only once the new photo is committed, so a failed import never leaves
      // the document pointing at bytes that are already gone.
      if (previous) void deleteMedia(previous)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That image could not be read.')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onClear = () => {
    const id = media?.id
    dispatch({ type: 'setMedia', media: null })
    if (id) void deleteMedia(id)
  }

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
