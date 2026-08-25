import { useId } from 'react'
import { Field, Segmented, Slider, Toggle } from '../../ui/controls.tsx'
import {
  FONTS,
  type JustifyBy,
  type SoloAlign,
  type TextAlign,
  type TextLayer,
} from '../../engine/types.ts'
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

const JUSTIFY_BY: readonly { value: JustifyBy; label: string }[] = [
  { value: 'words', label: 'Words' },
  { value: 'letters', label: 'Letters' },
]

const SOLO_ALIGN: readonly { value: SoloAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
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
        label="Letter tracking"
        value={layer.tracking}
        min={-0.1}
        max={0.4}
        step={0.005}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(3)}em`}
        onChange={(tracking) => patch({ tracking }, true)}
      />

      <Slider
        label="Word tracking"
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

      <Toggle
        label="Typewriter"
        checked={layer.typewriter !== null}
        onChange={(on) =>
          patch({
            typewriter: on ? { wear: 0.5, strike: 0.55, impression: 0.4, ribbon: 0.35 } : null,
          })
        }
      />
      <p className="panel-note">
        Fixed escapement, and every character struck by its own type slug — so the same
        letter leans the same way everywhere on the sheet while the force behind each
        keystroke varies. Randomising per keystroke instead is what makes most typewriter
        effects read as noise.
      </p>

      {layer.typewriter && (
        <>
          <Slider
            label="Type bar wear"
            value={layer.typewriter.wear}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(wear) => patch({ typewriter: { ...layer.typewriter!, wear } }, true)}
          />
          <Slider
            label="Uneven strike"
            value={layer.typewriter.strike}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(strike) => patch({ typewriter: { ...layer.typewriter!, strike } }, true)}
          />
          <Slider
            label="Slug impression"
            value={layer.typewriter.impression}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(impression) =>
              patch({ typewriter: { ...layer.typewriter!, impression } }, true)
            }
          />
          <Slider
            label="Ribbon weave"
            value={layer.typewriter.ribbon}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(ribbon) => patch({ typewriter: { ...layer.typewriter!, ribbon } }, true)}
          />
        </>
      )}

      <Field label="Alignment">
        <Segmented
          label="Alignment"
          value={layer.align}
          options={ALIGNS}
          onChange={(align) => patch({ align })}
        />
      </Field>

      {/* Only meaningful while justifying, and inert otherwise — so it appears
          directly under the control that switches it on rather than sitting
          dead in the panel the rest of the time. */}
      {layer.align === 'justify' && (
        <Field label="Justify by">
          <Segmented
            label="Justify by"
            value={layer.justifyBy}
            options={JUSTIFY_BY}
            onChange={(justifyBy) => patch({ justifyBy })}
          />
          <p className="panel-note">
            Filling the measure needs slack somewhere. Words keeps the words tight and opens
            the spaces; letters spreads every gap for the solid block.
          </p>
        </Field>
      )}

      {/* A line of one word has no space to open, so words mode leaves it at its
          natural width — this is which margin it sits against. */}
      {layer.align === 'justify' && layer.justifyBy === 'words' && (
        <Field label="Lines of one word">
          <Segmented
            label="Lines of one word"
            value={layer.soloAlign}
            options={SOLO_ALIGN}
            onChange={(soloAlign) => patch({ soloAlign })}
          />
        </Field>
      )}

      <Toggle label="Uppercase" checked={layer.caps} onChange={(caps) => patch({ caps })} />
    </div>
  )
}
