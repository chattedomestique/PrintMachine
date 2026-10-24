import { useId } from 'react'
import { Icon, Switch } from '../../ui/ui.tsx'
import { ParamStrip } from '../../ui/Slider.tsx'
import type { ChangeHow } from '../../ui/param.ts'
import { PHOTO_MISSING } from '../../engine/export.ts'
import { isReducedCopy } from '../../engine/media.ts'
import { sheetAspect, type MediaLayer, type PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'
import type { MediaState } from '../media/useMediaBitmap.ts'
import type { PhotoImport } from '../media/usePhotoImport.ts'
import { DockEmpty, DockPanel, Rule } from './Dock.tsx'
import { frameParams } from './params.ts'
import { SUBS, type SubId } from './tools.ts'

const SHEETS: readonly { value: PrintSettings['aspect']; label: string }[] = [
  // The photo's own shape: the default once there is a photo, and the one
  // sheet that neither crops nor resamples it.
  { value: 'original', label: 'Original' },
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '3:4', label: '3:4' },
  { value: '2:3', label: '2:3' },
]

/**
 * Photo: the ground the ink prints on. Sheet (its shape, five choices, so the
 * native select; and whether the paper lies over the photo), Frame (zoom and
 * where it sits: the tap equivalents of pinching and dragging it, which the
 * sheet's gestures do while this tool is open), File (choose, replace or
 * remove it, and anything there is to say about it).
 */
export default function PhotoPanel({
  sub,
  onSub,
  mediaState,
  photo,
}: {
  sub: SubId<'photo'>
  onSub: (sub: SubId<'photo'>) => void
  mediaState: MediaState
  photo: PhotoImport
}) {
  const { settings, dispatch } = useSettings()
  const sheetId = useId()
  const veilHint = useId()
  const media = settings.media

  const set = (p: Partial<MediaLayer>, how: ChangeHow) => dispatch({ type: 'patchMedia', patch: p, coalesce: !how.discrete })

  const chooseButton = (
    <button type="button" className="btn" data-size="sm" disabled={photo.busy} onClick={photo.choose}>
      <span className="btn__label">
        <Icon name="upload" />
        {photo.busy ? 'Reading…' : media ? 'Replace' : 'Choose photo'}
      </span>
    </button>
  )

  return (
    <DockPanel tool="photo" label="Photo" tabs={SUBS.photo} sub={sub} onSub={onSub}>
      {sub === 'sheet' && (
        <>
          {/* The sheet's shape is a deliverable (a 4:5 feed, a square, a
              print), and it decides which part of the photo survives the
              crop. Original is the photo's own shape, so it needs a photo. */}
          <div className="controls__row">
            <label className="controls__label" htmlFor={sheetId}>
              Sheet
            </label>
            <div className="select controls__select">
              <select
                className="controls__select-field"
                id={sheetId}
                value={settings.aspect}
                onChange={(e) => dispatch({ type: 'patch', patch: { aspect: e.target.value as PrintSettings['aspect'] } })}
              >
                {SHEETS.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.value === 'original' && !media}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" />
            </div>
          </div>
          <Rule />
          {/* On, the photo takes the stock's tint and tooth, so it and the type
              read as one printed sheet. Off, the ink lands straight on the
              photograph's own colour. */}
          <Switch
            label="Paper over the photo"
            checked={settings.paperVeil}
            describedBy={veilHint}
            onChange={(paperVeil) => dispatch({ type: 'patch', patch: { paperVeil } })}
          />
          <p className="sr-only" id={veilHint}>
            On, the photo takes the paper's tint and grain, so the photo and the type read as one printed sheet. Off,
            the ink lands on the photograph's own colour.
          </p>
        </>
      )}

      {sub === 'frame' &&
        (media ? (
          <ParamStrip key="frame" params={frameParams(media, sheetAspect(settings), set)} />
        ) : (
          <DockEmpty action={chooseButton}>No photo yet: the print is on bare paper.</DockEmpty>
        ))}

      {sub === 'file' && (
        <>
          <div className="controls__row controls__row--start">
            {chooseButton}
            {media && (
              // Not a delete: Undo brings the photo back.
              <button type="button" className="btn" data-size="sm" onClick={() => dispatch({ type: 'setMedia', media: null })}>
                <span className="btn__label">
                  <Icon name="trash-2" />
                  Remove
                </span>
              </button>
            )}
          </div>
          {(photo.error || mediaState === 'failed' || (media && isReducedCopy(media)) || !media) && <Rule />}
          {photo.error && (
            <p className="controls__note" role="alert">
              <Icon name="circle-alert" />
              {photo.error}
            </p>
          )}
          {/* Persistent while it is true: a missing photo is never printed as
              bare paper, and Save refuses too, saying the same. */}
          {mediaState === 'failed' && (
            <p className="controls__note" role="alert">
              <Icon name="circle-alert" />
              {PHOTO_MISSING}
            </p>
          )}
          {media && isReducedCopy(media) && (
            <p className="controls__note">
              This photo was saved at reduced size by an older version. Choose it again for full resolution.
            </p>
          )}
          {!media && !photo.error && <p className="controls__hint">No photo yet: the print is on bare paper.</p>}
        </>
      )}
    </DockPanel>
  )
}
