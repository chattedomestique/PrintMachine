import { Field, IconButton, Segmented, Slider } from '../../ui/controls.tsx'
import { ShuffleIcon } from '../../ui/icons.tsx'
import { PAPERS, paperById } from '../../engine/inks.ts'
import { Swatches } from '../../ui/controls.tsx'
import type { PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'

const ASPECT_OPTIONS: readonly { value: PrintSettings['aspect']; label: string }[] = [
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '3:4', label: '3:4' },
  { value: '2:3', label: '2:3' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

export default function PaperPanel() {
  const { settings, dispatch } = useSettings()
  const patch = (p: Partial<PrintSettings>, coalesce = false) => dispatch({ type: 'patch', patch: p, coalesce })

  return (
    <div className="control-group">
      <Field label="Sheet">
        <Segmented
          label="Sheet proportions"
          value={settings.aspect}
          options={ASPECT_OPTIONS}
          onChange={(aspect) => patch({ aspect })}
        />
      </Field>

      <Field label="Stock" value={paperById(settings.paperId).name}>
        <Swatches
          label="Paper stock"
          value={settings.paperId}
          options={PAPERS}
          onChange={(paperId) => patch({ paperId })}
        />
      </Field>

      <Slider
        label="Tooth"
        value={settings.paperTexture}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(paperTexture) => patch({ paperTexture }, true)}
      />

      <Slider
        label="Cloudiness"
        value={settings.paperBlotch}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(paperBlotch) => patch({ paperBlotch }, true)}
      />

      <Field label="Grain seed" value={String(settings.seed)}>
        <div className="seed-row">
          <IconButton
            label="Reroll the grain"
            onClick={() => patch({ seed: Math.floor(Math.random() * 100000) })}
          >
            <ShuffleIcon />
          </IconButton>
          <span className="plate-hint">
            Every texture is derived from this number, so the same seed always prints the same sheet.
          </span>
        </div>
      </Field>
    </div>
  )
}
