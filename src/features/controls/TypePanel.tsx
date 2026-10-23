import { useId } from 'react'
import { Field, Segmented, Slider, Toggle } from '../../ui/controls.tsx'
import { ASPECTS, FONTS, type TextAlign, type TextLayer } from '../../engine/types.ts'
import { fitSize } from '../../engine/text.ts'
import { SIZE_MIN, SIZE_SLIDER_MAX, SIZE_STEP } from '../../engine/limits.ts'
import { formatSize } from './sizeScale.ts'
import { canvasMeasure } from '../../state/persist.ts'
import { useSettings } from '../../state/settingsStore.ts'

const ALIGNS: readonly { value: TextAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
  // Forced justification: every line, including the last, stretched to the
  // widest — by its word gaps where it has any, by its letters where not.
  { value: 'justify', label: 'Justify' },
]

export default function TypePanel() {
  const { settings, dispatch, selectedLayer } = useSettings()
  const textId = useId()
  const layer = selectedLayer ?? settings.layers[0]
  if (!layer) return null

  const patch = (p: Partial<TextLayer>, coalesce = false) =>
    dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce })

  // One-shot: computes the size at which the widest line spans the sheet and
  // stores it, so there is only ever one size. Editing the text afterwards
  // does not re-fit; tapping Fit again does. Its own undo step.
  const fit = () => {
    const measure = canvasMeasure()
    if (measure) patch({ size: fitSize(layer, ASPECTS[settings.aspect], measure) })
  }

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

      <Toggle label="Bold" checked={layer.bold} onChange={(bold) => patch({ bold })} />

      {/* 10% to 100% across the whole travel, 1% a step: a tenth of the
          sheet reads 100%. Bigger type (a pinch, the keys, Fit on a short
          word) pins the thumb at the end and the readout shows the truth. */}
      <Slider
        label="Size"
        value={layer.size}
        min={SIZE_MIN}
        max={SIZE_SLIDER_MAX}
        step={SIZE_STEP}
        format={formatSize}
        onChange={(size) => patch({ size }, true)}
      />
      <button
        type="button"
        className="icon-button"
        aria-label="Fit: size the widest line to the sheet's width"
        onClick={fit}
      >
        Fit
      </button>

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
        label="Letter tracking"
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
    </div>
  )
}
