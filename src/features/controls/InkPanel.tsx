import { Field, IconButton, Segmented, Slider, Swatches, Toggle } from '../../ui/controls.tsx'
import { PlusIcon, TrashIcon } from '../../ui/icons.tsx'
import { contrastPartner, cssRgb, inkById, RISO_INKS } from '../../engine/inks.ts'
import { MAX_PRESSED_PASSES, MAX_TEXT_PLATES } from '../../engine/limits.ts'
import type { TextLayer } from '../../engine/types.ts'
import {
  atPassLimit,
  atPlateLimit,
  hasSwitchPoint,
  overPhotoOf,
  overPhotoPatch,
  type OverPhoto,
} from '../../state/settingsReducer.ts'
import { useSettings } from '../../state/settingsStore.ts'

const pct = (v: number) => `${Math.round(v * 100)}%`

const BUDGET = `Up to ${MAX_TEXT_PLATES} plates and ${MAX_PRESSED_PASSES} passes (a backing is a pass of its own).`

/**
 * Plates, and what colour each one is.
 *
 * The strip doubles as the layer selector — a real press has one plate per
 * colour, so "which layer am I editing" and "which ink is this" are the same
 * question, and there is no reason to answer it in two places.
 */
export default function InkPanel() {
  const { settings, dispatch, selectedLayerId, selectLayer, selectedLayer } = useSettings()
  const layer = selectedLayer ?? settings.layers[0]
  const plateLimit = atPlateLimit(settings)
  const passLimit = atPassLimit(settings)

  const patch = (p: Partial<TextLayer>, coalesce = false) =>
    layer && dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce })

  const setOver = (over: OverPhoto) => layer && patch(overPhotoPatch(layer, over))

  return (
    <div className="control-stack">
      <Field label={`Plates · ${settings.layers.length}`}>
        <div className="plate-strip">
          {settings.layers.map((l, i) => {
            const ink = inkById(l.inkId)
            const active = l.id === (selectedLayerId ?? settings.layers[0]?.id)
            return (
              <button
                key={l.id}
                type="button"
                className="plate"
                aria-pressed={active}
                onClick={() => selectLayer(l.id)}
              >
                <span className="plate-dot" style={{ background: cssRgb(ink.rgb) }} aria-hidden="true" />
                <span className="plate-text">{l.text.split('\n')[0] || `Plate ${i + 1}`}</span>
                <span className="plate-ink">{ink.name}</span>
              </button>
            )
          })}
        </div>
        <div className="plate-actions">
          <IconButton label="Add a plate" disabled={plateLimit} onClick={() => dispatch({ type: 'addLayer' })}>
            <PlusIcon />
          </IconButton>
          <IconButton
            label="Delete this plate"
            disabled={settings.layers.length <= 1 || !layer}
            onClick={() => layer && dispatch({ type: 'removeLayer', id: layer.id })}
          >
            <TrashIcon />
          </IconButton>
          <span className="plate-hint">
            {plateLimit
              ? BUDGET
              : settings.layers.length > 1
                ? 'Plates print in order — the last one lays on top.'
                : 'Add a second plate to get overprinting.'}
          </span>
        </div>
      </Field>

      {layer && (
        <>
          <Field label="Ink" value={inkById(layer.inkId).name}>
            <Swatches label="Ink" value={layer.inkId} options={RISO_INKS} onChange={(inkId) => patch({ inkId })} />
          </Field>

          {/* One choice per plate, because the two cannot be combined: the
              second ink reads the photo, but over a backing the ground is the
              block. */}
          <Field label="Over the photo">
            <Segmented
              label="Over the photo"
              value={overPhotoOf(layer)}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'second', label: 'Second ink' },
                { value: 'backing', label: 'Backing', disabled: passLimit && !layer.backing },
              ]}
              onChange={setOver}
            />
            {passLimit && !layer.backing && <p className="plate-hint">{BUDGET}</p>}
          </Field>

          {overPhotoOf(layer) === 'second' && layer.contrastInkId && (
            <>
              <p className="panel-note">
                {hasSwitchPoint(layer)
                  ? 'Type in one ink cannot read across a whole photograph. The pass is pressed once ' +
                    'and split between two inks by what is behind it, and the photo is knocked back ' +
                    'to paper wherever the ink is lighter than what it lands on — a transparent light ' +
                    'ink over solid black is still solid black. Keep this ink to stay in one colour.'
                  : 'One colour across the whole photograph: the photo is cut back to paper wherever ' +
                    'it is darker than the ink, so the ink prints on paper there and reads everywhere.'}
                {settings.media ? '' : ' It shows once there is a photo behind the type.'}
              </p>
              <Toggle
                label="Keep this ink"
                checked={layer.contrastInkId === layer.inkId}
                onChange={(keep) =>
                  patch({ contrastInkId: keep ? layer.inkId : contrastPartner(layer.inkId) })
                }
              />
              <Field label="Second ink" value={inkById(layer.contrastInkId).name}>
                <Swatches
                  label="Second ink"
                  value={layer.contrastInkId}
                  options={RISO_INKS.filter((i) => i.id !== layer.inkId)}
                  onChange={(contrastInkId) => patch({ contrastInkId })}
                />
              </Field>
              {/* Only between two different inks: with the plate's own ink
                  both halves print the same colour, so it would move nothing. */}
              {hasSwitchPoint(layer) && (
                <Slider
                  label="Switch point"
                  value={layer.contrastThreshold}
                  min={0.1}
                  max={0.9}
                  step={0.01}
                  format={pct}
                  onChange={(contrastThreshold) => patch({ contrastThreshold }, true)}
                />
              )}
            </>
          )}

          {overPhotoOf(layer) === 'backing' && layer.backing && (
            <>
              <p className="panel-note">
                A solid block of ink behind each line, pressed as its own plate before the type, so
                the type overprints it into a third colour. The photo is cut back to paper under the
                block, so it reads the same over any part of the picture.
              </p>
              <Field label="Backing ink" value={inkById(layer.backing).name}>
                <Swatches
                  label="Backing ink"
                  value={layer.backing}
                  options={RISO_INKS}
                  onChange={(backing) => patch({ backing })}
                />
              </Field>
            </>
          )}
        </>
      )}
    </div>
  )
}
