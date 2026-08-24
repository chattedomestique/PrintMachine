import { useId, useState } from 'react'
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

/** Whitespace split — the same rule the engine groups words by, so an index
 *  here means the same word it means in the layout. */
function wordsOf(layer: TextLayer): string[] {
  const raw = layer.caps ? layer.text.toUpperCase() : layer.text
  return raw.split(/\s+/).filter((t) => t.length > 0)
}

export default function TypePanel() {
  const { settings, dispatch, selectedLayer } = useSettings()
  const textId = useId()
  const [selected, setSelected] = useState<number[]>([])
  const layer = selectedLayer ?? settings.layers[0]
  if (!layer) return null

  const patch = (p: Partial<TextLayer>, coalesce = false) =>
    dispatch({ type: 'patchLayer', id: layer.id, patch: p, coalesce })

  const words = wordsOf(layer)
  // Selecting nothing means "the words with an override already", so the
  // slider always has something meaningful to move.
  const targets = selected.length > 0 ? selected : words.map((_, i) => i).filter((i) => layer.wordTracking[String(i)])
  const shown = targets.length > 0 ? (layer.wordTracking[String(targets[0])] ?? 0) : 0

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
        label="Letter tracking"
        value={layer.tracking}
        min={-0.1}
        max={0.4}
        step={0.005}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(3)}em`}
        onChange={(tracking) => patch({ tracking }, true)}
      />

      <Field label={selected.length ? `Per-word tracking · ${selected.length} selected` : 'Per-word tracking'}>
        {words.length === 0 ? (
          <p className="plate-hint">This plate has no text yet.</p>
        ) : (
          <>
            <div className="word-chips" role="group" aria-label="Words to track">
              {words.map((word, i) => {
                const em = layer.wordTracking[String(i)]
                const isSelected = selected.includes(i)
                return (
                  <button
                    key={`${word}-${i}`}
                    type="button"
                    className="word-chip"
                    aria-pressed={isSelected}
                    data-tracked={em !== undefined || undefined}
                    onClick={() =>
                      setSelected((prev) =>
                        prev.includes(i) ? prev.filter((n) => n !== i) : [...prev, i],
                      )
                    }
                  >
                    {word}
                    {em !== undefined && (
                      <span className="word-chip-badge">{em > 0 ? '+' : ''}{em.toFixed(2)}</span>
                    )}
                  </button>
                )
              })}
            </div>
            <Slider
              label={targets.length ? 'Tracking for these words' : 'Tap words to track them'}
              value={shown}
              min={-0.1}
              max={0.6}
              step={0.005}
              format={(v) => (v === 0 ? 'normal' : `${v > 0 ? '+' : ''}${v.toFixed(3)}em`)}
              onChange={(em) => {
                if (targets.length === 0) return
                dispatch({ type: 'setWordTracking', layerId: layer.id, words: targets, em, coalesce: true })
              }}
            />
          </>
        )}
      </Field>

      <Slider
        label="Word spacing"
        value={layer.wordSpacing}
        min={-0.2}
        max={2}
        step={0.01}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}em`}
        onChange={(wordSpacing) => patch({ wordSpacing }, true)}
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
