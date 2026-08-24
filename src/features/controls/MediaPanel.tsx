import { useRef, useState } from 'react'
import { Field, Segmented, Slider, Toggle } from '../../ui/controls.tsx'
import { RISO_INKS } from '../../engine/inks.ts'
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
        genuinely overprints it. Drag and pinch on the sheet to place it.
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
          <Slider
            label="Size"
            value={media.scale}
            min={0.2}
            max={4}
            step={0.01}
            format={pct}
            onChange={(scale) => patch({ scale }, true)}
          />
          <Slider
            label="Opacity"
            value={media.opacity}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(opacity) => patch({ opacity }, true)}
          />

          {/* The control the whole feature hangs on: at 0 the stock stops
              tinting and texturing the photo, leaving type on the image. */}
          <Slider
            label="Paper over the photo"
            value={settings.paperAmount}
            min={0}
            max={1}
            step={0.01}
            format={(v) => (v === 0 ? 'off' : pct(v))}
            onChange={(paperAmount) => dispatch({ type: 'patch', patch: { paperAmount }, coalesce: true })}
          />

          <Toggle
            label="Print the photo"
            checked={media.printed}
            onChange={(printed) => patch({ printed })}
          />
          <p className="panel-note">
            Off, the photo shows as shot. On, it is separated into a single ink and run
            through the same press as the type — worn, screened and misregistered.
          </p>

          {media.printed && (
            <>
              <Field label="Photo ink">
                <Segmented
                  label="Photo ink"
                  value={media.inkId}
                  options={RISO_INKS.slice(0, 12).map((i) => ({ value: i.id, label: i.name }))}
                  onChange={(inkId) => patch({ inkId })}
                />
              </Field>
              <Slider
                label="Contrast"
                value={media.contrast}
                min={0.2}
                max={3}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(contrast) => patch({ contrast }, true)}
              />
              <Slider
                label="Highlight dropout"
                value={media.lift}
                min={0}
                max={0.6}
                step={0.01}
                format={pct}
                onChange={(lift) => patch({ lift }, true)}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
