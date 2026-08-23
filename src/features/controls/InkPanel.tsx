import { Field, IconButton, Slider, Swatches } from '../../ui/controls.tsx'
import { PlusIcon, TrashIcon } from '../../ui/icons.tsx'
import { cssRgb, inkById, overprint, RISO_INKS } from '../../engine/inks.ts'
import { useSettings } from '../../state/settingsStore.ts'

const pct = (v: number) => `${Math.round(v * 100)}%`

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
          <IconButton label="Add a plate" onClick={() => dispatch({ type: 'addLayer' })}>
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
            {settings.layers.length > 1
              ? 'Plates print in order — the last one lays on top.'
              : 'Add a second plate to get overprinting.'}
          </span>
        </div>
      </Field>

      {layer && (
        <>
          <Field label="Ink" value={inkById(layer.inkId).name}>
            <Swatches
              label="Ink"
              value={layer.inkId}
              options={RISO_INKS}
              onChange={(inkId) => dispatch({ type: 'patchLayer', id: layer.id, patch: { inkId } })}
            />
          </Field>

          <Slider
            label="Plate opacity"
            value={layer.opacity}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(opacity) =>
              dispatch({ type: 'patchLayer', id: layer.id, patch: { opacity }, coalesce: true })
            }
          />

          {settings.layers.length > 1 && <OverprintPreview />}
        </>
      )}
    </div>
  )
}

/** Shows what the inks actually make where they cross, computed with the same
 *  subtractive model as the compositor — so it can't drift from the render. */
function OverprintPreview() {
  const { settings } = useSettings()
  const inks = settings.layers.map((l) => inkById(l.inkId))
  const mixed = inks.slice(1).reduce<[number, number, number]>(
    (acc, ink) => overprint(acc, ink.rgb),
    [...inks[0].rgb] as [number, number, number],
  )

  return (
    <Field label="Where they overlap">
      <div className="overprint">
        {inks.map((ink, i) => (
          <span key={i} className="overprint-chip" style={{ background: cssRgb(ink.rgb) }} />
        ))}
        <span className="overprint-arrow" aria-hidden="true">
          →
        </span>
        <span className="overprint-chip is-result" style={{ background: cssRgb(mixed) }} />
      </div>
    </Field>
  )
}
