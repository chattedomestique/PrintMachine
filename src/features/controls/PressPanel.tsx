import { Field, Segmented, Slider, Swatches } from '../../ui/controls.tsx'
import { PAPERS, paperById } from '../../engine/inks.ts'
import type { PressProfile, ScreenMethod } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'

const METHODS: readonly { value: ScreenMethod; label: string }[] = [
  { value: 'halftone', label: 'Halftone' },
  { value: 'grain', label: 'Grain' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

/** A seed other than the current one, so Re-roll always changes the sheet. */
function newSeed(current: number): number {
  for (;;) {
    const seed = Math.floor(Math.random() * 100000)
    if (seed !== current) return seed
  }
}

/** The machine, not the artwork. Everything here applies to every plate. */
export default function PressPanel() {
  const { settings, dispatch } = useSettings()
  const press = settings.press
  const patch = (p: Partial<PressProfile>, coalesce = false) =>
    dispatch({ type: 'patchPress', patch: p, coalesce })

  return (
    <div className="control-stack">
      <Field label="Screen">
        <Segmented
          label="Screen"
          value={press.method}
          options={METHODS}
          onChange={(method) => patch({ method })}
        />
      </Field>

      {/* One texture size for both screens: the halftone's dot pitch, and a
          grain cell a third of it. */}
      <Slider
        label="Screen size"
        value={press.screenPitch}
        min={2}
        max={24}
        step={0.5}
        format={(v) => `${v.toFixed(1)}px`}
        onChange={(screenPitch) => patch({ screenPitch }, true)}
      />

      <Slider
        label="Ink"
        value={press.density}
        min={0.3}
        max={1}
        step={0.01}
        format={pct}
        onChange={(density) => patch({ density }, true)}
      />

      <Slider
        label="Misregistration"
        value={press.misregistration}
        min={0}
        max={30}
        step={0.5}
        format={(v) => `${v}px`}
        onChange={(misregistration) => patch({ misregistration }, true)}
      />

      {/* The two things a person can name: the letters are ragged (Edge: the
          stencil's tear and the ink's bleed), the ink is blotchy (Wear: drum
          mottle and speckle dropout). */}
      <Slider
        label="Edge"
        value={press.edge}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(edge) => patch({ edge }, true)}
      />

      <Slider
        label="Wear"
        value={press.wear}
        min={0}
        max={0.8}
        step={0.01}
        format={pct}
        onChange={(wear) => patch({ wear }, true)}
      />

      {/* Pull another sheet: a different tear, mottle, registration and paper
          grain from the same settings. Its own undo step. */}
      <button
        type="button"
        className="icon-button"
        aria-label="Re-roll: pull another sheet"
        onClick={() => dispatch({ type: 'patch', patch: { seed: newSeed(settings.seed) } })}
      >
        Re-roll
      </button>

      <Field label="Stock" value={paperById(settings.paperId).name}>
        <Swatches
          label="Paper stock"
          value={settings.paperId}
          options={PAPERS}
          onChange={(paperId) => dispatch({ type: 'patch', patch: { paperId } })}
        />
      </Field>
    </div>
  )
}
