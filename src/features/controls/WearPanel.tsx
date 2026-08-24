import { Slider } from '../../ui/controls.tsx'
import type { PressProfile } from '../../engine/types.ts'
import type { PressTarget } from '../../state/settingsReducer.ts'
import { useSettings } from '../../state/settingsStore.ts'

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * How badly the machine is behaving.
 *
 * Separated from Press because these are failures rather than settings — the
 * press tab is what you'd dial in deliberately, this is what the drum does to
 * you. Every one of them is off at zero, so a clean pull is still reachable.
 */
export default function WearPanel({ target }: { target: PressTarget }) {
  const { settings, dispatch } = useSettings()
  const press = settings[target]
  const patch = (p: Partial<PressProfile>, coalesce = false) =>
    dispatch({ type: 'patchPress', target, patch: p, coalesce })

  return (
    <div className="control-stack">
      <p className="panel-note">
        A thermal stencil burned at low resolution, ink forced through it onto uncoated paper. None
        of that produces a clean edge.
      </p>

      <Slider
        label="Edge tear"
        value={press.roughness}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(roughness) => patch({ roughness }, true)}
      />

      <Slider
        label="Tear scale"
        value={press.roughScale}
        min={1}
        max={14}
        step={0.5}
        format={(v) => `${v}px`}
        onChange={(roughScale) => patch({ roughScale }, true)}
      />

      <Slider
        label="Ink bleed"
        value={press.bleed}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(bleed) => patch({ bleed }, true)}
      />

      <Slider
        label="Drum streaks"
        value={press.streaks}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(streaks) => patch({ streaks }, true)}
      />

      <Slider
        label="Smear"
        value={press.smear}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(smear) => patch({ smear }, true)}
      />

      <Slider
        label="Dropout patches"
        value={press.patches}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(patches) => patch({ patches }, true)}
      />
    </div>
  )
}
