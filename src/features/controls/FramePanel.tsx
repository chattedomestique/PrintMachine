import { useId } from 'react'
import { Icon, Segmented, type SegmentedOption } from '../../ui/ui.tsx'
import { ChipRow } from '../../ui/ChipRow.tsx'
import { ParamStrip } from '../../ui/Slider.tsx'
import type { ChangeHow } from '../../ui/param.ts'
import { PHOTO_MISSING } from '../../engine/export.ts'
import { isReducedCopy } from '../../engine/media.ts'
import type { FrameSettings, MediaLayer } from '../../engine/types.ts'
import { effectiveMode, visibleAspect } from '../../engine/frame.ts'
import { FRAME_MODES } from '../../state/fields.ts'
import { useSettings } from '../../state/settingsStore.ts'
import type { PhotoState } from '../media/frameInputs.ts'
import type { PhotoImport } from '../media/usePhotoImport.ts'
import { DockEmpty, DockPanel, Rule } from './Dock.tsx'
import { ORIGINAL_WHOLE, fillChips, ratioChips } from './frameChoices.ts'
import { NO_PHOTO, borderParams, photoPlacementParams } from './params.ts'
import { SUBS, type SubId } from './tools.ts'

/** Crop and Fit by name, in the schema's order (state/fields.ts
 *  `FRAME_MODES`), read rather than typed again. */
const MODE_LABELS: Record<FrameSettings['mode'], string> = { crop: 'Crop', fit: 'Fit' }
const MODES: readonly SegmentedOption<FrameSettings['mode']>[] = FRAME_MODES.map((id) => ({ id, label: MODE_LABELS[id] }))

/** What Crop and Fit do to the photo, for a screen reader (on screen the
 *  sheet shows it, as in Border Studio). */
const MODE_SAID: Record<FrameSettings['mode'], string> = {
  crop: 'The photo fills the inside of the frame, trimmed to the ratio.',
  fit: 'The whole photo sits inside the frame, matted, nothing trimmed.',
}

/**
 * Frame: the photo, and the frame round it (Border Studio's Frame and Fill
 * tools, and this app's Photo tool, as one). Border (the fill row, then
 * Width, Corners and, under Frosted, Blur), Crop (the sheet's ratio, a second
 * tap flipping it, then Crop or Fit), Place (Zoom and Position: the tap
 * equivalents of pinching and dragging the photo, which the sheet's gestures
 * do while this tool is open), Photo (choose, replace or remove it, and
 * anything there is to say about it). Without a photo the tool opens on
 * Photo; Border shows Width and Corners unavailable, saying why, under the
 * action that changes that (the fill row waits for a photo: its colours are
 * the photo's), and Place says there is none; the ratio is the sheet's, so
 * Crop works on bare paper too. While the chosen fill is being made from the
 * photo its chip says so, quietly, and the border is Paper (`fillPreparing`).
 * A fill that cannot be made is said by the status card, Save's refusal.
 */
export default function FramePanel({
  sub,
  onSub,
  mediaState,
  fillPreparing,
  photo,
}: {
  sub: SubId<'frame'>
  onSub: (sub: SubId<'frame'>) => void
  mediaState: PhotoState
  fillPreparing: boolean
  photo: PhotoImport
}) {
  const { settings, dispatch } = useSettings()
  const modeSaid = useId()
  const modeWhyId = useId()
  const media = settings.media
  const frame = settings.frame
  const mode = effectiveMode(settings)

  const setFrame = (p: Partial<FrameSettings>, how: ChangeHow) => dispatch({ type: 'patchFrame', patch: p, coalesce: !how.discrete, join: how.joins })
  const setPlace = (p: Partial<MediaLayer>, how: ChangeHow) => dispatch({ type: 'patchMedia', patch: p, coalesce: !how.discrete, join: how.joins })

  // Crop or Fit means something only for a photo on a ratio of its own.
  const modeWhy = !media ? NO_PHOTO : settings.aspect === 'original' ? ORIGINAL_WHOLE : null

  const chooseButton = (
    <button type="button" className="btn" data-size="sm" disabled={photo.busy} onClick={photo.choose}>
      <span className="btn__label">
        <Icon name="upload" />
        {photo.busy ? 'Reading…' : media ? 'Replace' : 'Choose photo'}
      </span>
    </button>
  )

  return (
    <DockPanel tool="frame" label="Frame" tabs={SUBS.frame} sub={sub} onSub={onSub}>
      {sub === 'border' &&
        (media ? (
          <>
            {/* The fill leads: it is what the frame is. Each chip shows the
                colour the frame is drawn in, from the photo's palette. */}
            <ChipRow
              label="Fill"
              items={fillChips(media.palette, settings.paperId, frame.fill, fillPreparing)}
              value={frame.fill}
              onChange={(fill) => dispatch({ type: 'patchFrame', patch: { fill } })}
            />
            <Rule />
            <ParamStrip key="border" params={borderParams(frame, true, setFrame)} />
          </>
        ) : (
          <>
            {/* Width and Corners mean what they will with a photo, so they
                are there to find, unavailable and saying why; the fill row's
                colours are the photo's, so the action that brings one takes
                its place. */}
            <div className="controls__row">
              <span className="controls__hint">{NO_PHOTO}</span>
              {chooseButton}
            </div>
            <Rule />
            <ParamStrip key="border-bare" params={borderParams(frame, false, setFrame)} />
          </>
        ))}

      {sub === 'crop' && (
        <>
          {/* The ratio is what you came for, so it leads (Border Studio's
              Crop tab). It is the sheet's, in Crop and in Fit. */}
          <ChipRow
            label="Sheet ratio"
            items={ratioChips(media !== null)}
            value={settings.aspect}
            onChange={(aspect) => dispatch({ type: 'patch', patch: { aspect } })}
            // Original, the photo's own shape, waits for a photo: the line
            // under Crop | Fit says so.
            whyId={media ? undefined : modeWhyId}
          />
          <Rule />
          {/* What the ratio does to the photo: trim it, or mat it whole
              inside the frame. Its name, then the choice, as any setting. */}
          <div className="controls__row">
            <span className="controls__label" aria-hidden="true">
              Photo
            </span>
            <Segmented
              label="Photo"
              value={mode}
              block={false}
              options={MODES.map((o) => ({ ...o, disabled: modeWhy !== null }))}
              onChange={(m) => dispatch({ type: 'patchFrame', patch: { mode: m } })}
              describedBy={modeWhy ? modeWhyId : modeSaid}
            />
          </div>
          {modeWhy ? (
            <p className="controls__hint" id={modeWhyId}>
              {modeWhy}
            </p>
          ) : (
            <p className="sr-only" id={modeSaid}>
              {MODE_SAID[mode]}
            </p>
          )}
        </>
      )}

      {sub === 'place' &&
        (media ? (
          <ParamStrip key="place" params={photoPlacementParams(media, visibleAspect(settings), setPlace, mode === 'fit')} />
        ) : (
          <DockEmpty action={chooseButton}>{NO_PHOTO}: the print is on bare paper.</DockEmpty>
        ))}

      {sub === 'photo' && (
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
          {!media && !photo.error && <p className="controls__hint">{NO_PHOTO}: the print is on bare paper.</p>}
        </>
      )}
    </DockPanel>
  )
}
