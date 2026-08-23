import { useId } from 'react'
import { Field, Segmented, Slider, Toggle } from '../../ui/controls.tsx'
import { FONTS, type TextAlign, type TextLayer } from '../../engine/types.ts'
import { MAX_SIZE, MIN_SIZE } from '../editor/useLayerGestures.ts'
import { useSettings } from '../../state/settingsStore.ts'

const ALIGNS: readonly { value: TextAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
  // Forced justification: every line, including the last, stretched to fill
  // the measure by spacing between characters. The solid rectangular block.
  { value: 'justify', label: 'Justify' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

export default function TypePanel() {
  const { settings, dispatch, selectedLayer } = useSettings()
  const textId = useId()
  const layer = selectedLayer ?? settings.layers[0]
  if (!layer) return null

  const patch = (p: Partial<TextLayer>, coalesce = false) =>
    dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce })

  return (
    <div className="control-stack">
      <p className="panel-note">
        On the sheet: drag to move, pinch to scale and rotate, double-tap to centre.
      </p>
      <Field label="Text" htmlFor={textId}>
        <textarea
          id={textId}
          className="text-input"
          rows={2}
          value={layer.text}
          spellCheck={false}
          autoCapitalize="characters"
          placeholder="Type something"
          onChange={(e) => patch({ text: e.target.value }, true)}
        />
      </Field>

      <Field label="Typeface">
        <Segmented
          label="Typeface"
          value={layer.fontId}
          options={FONTS.map((f) => ({ value: f.id, label: f.name }))}
          onChange={(fontId) => patch({ fontId })}
        />
      </Field>

      <Slider
        label="Weight"
        value={layer.weight}
        min={100}
        max={900}
        step={100}
        onChange={(weight) => patch({ weight }, true)}
      />

      <Toggle label="Fit to width" checked={layer.fitWidth} onChange={(fitWidth) => patch({ fitWidth })} />

      {/* Always available, never hidden behind fit-to-width — a control that
          disappears when a toggle flips is a control you cannot find again.
          Setting a size explicitly is a statement about size, so it releases
          fit-to-width rather than being silently overridden by it. */}
      <Slider
        label={layer.fitWidth ? 'Size · fit to width' : 'Size'}
        value={layer.size}
        min={MIN_SIZE}
        max={MAX_SIZE}
        step={0.005}
        format={pct}
        onChange={(size) => patch({ size, fitWidth: false }, true)}
      />

      <Slider
        label="Line height"
        value={layer.lineHeight}
        min={0.6}
        max={2}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(lineHeight) => patch({ lineHeight }, true)}
      />

      <Slider
        label="Tracking"
        value={layer.tracking}
        min={-0.1}
        max={0.4}
        step={0.005}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(3)}em`}
        onChange={(tracking) => patch({ tracking }, true)}
      />

      <Slider
        label="Rotation"
        value={layer.rotation}
        min={-180}
        max={180}
        step={0.5}
        format={(v) => `${v}°`}
        onChange={(rotation) => patch({ rotation }, true)}
      />

      <Field label="Alignment">
        <Segmented
          label="Alignment"
          value={layer.align}
          options={ALIGNS}
          onChange={(align) => patch({ align })}
        />
      </Field>

      <Toggle label="Uppercase" checked={layer.caps} onChange={(caps) => patch({ caps })} />
    </div>
  )
}
