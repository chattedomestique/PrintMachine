import { Slider } from '../../ui/controls.tsx'
import type { PrintSettings } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * How badly the machine is behaving.
 *
 * Separated from Press because these are failures rather than settings — the
 * press tab is what you'd dial in deliberately, this is what the drum does to
 * you. Every one of them is off at zero, so a clean pull is still reachable.
 */
export default function WearPanel() {
  const { settings, dispatch } = useSettings()
  const patch = (p: Partial<PrintSettings>, coalesce = false) =>
    dispatch({ type: 'patch', patch: p, coalesce })

  return (
    <div className="control-stack">
      <p className="panel-note">
        A thermal stencil burned at low resolution, ink forced through it onto uncoated paper. None
        of that produces a clean edge.
      </p>

      <Slider
        label="Edge tear"
        value={settings.roughness}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(roughness) => patch({ roughness }, true)}
      />

      <Slider
        label="Tear scale"
        value={settings.roughScale}
        min={1}
        max={14}
        step={0.5}
        format={(v) => `${v}px`}
        onChange={(roughScale) => patch({ roughScale }, true)}
      />

      <Slider
        label="Ink bleed"
        value={settings.bleed}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(bleed) => patch({ bleed }, true)}
      />

      <Slider
        label="Drum streaks"
        value={settings.streaks}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(streaks) => patch({ streaks }, true)}
      />

      <Slider
        label="Smear"
        value={settings.smear}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(smear) => patch({ smear }, true)}
      />

      <Slider
        label="Dropout patches"
        value={settings.patches}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(patches) => patch({ patches }, true)}
      />
    </div>
  )
}
