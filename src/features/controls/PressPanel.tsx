import { Field, Segmented, Slider, Toggle } from '../../ui/controls.tsx'
import { DITHER_TYPES } from '../../engine/dither.ts'
import type { ScreenShape } from '../../engine/screen.ts'
import type { PressProfile, ScreenMethod } from '../../engine/types.ts'
import type { PressTarget } from '../../state/settingsReducer.ts'
import { useSettings } from '../../state/settingsStore.ts'

const METHODS: readonly { value: ScreenMethod; label: string }[] = [
  { value: 'halftone', label: 'Halftone' },
  { value: 'dither', label: 'Dither' },
  { value: 'woodcut', label: 'Woodcut' },
  { value: 'scribble', label: 'Scribble' },
]

const SHAPES: readonly { value: ScreenShape; label: string }[] = [
  { value: 'circle', label: 'Dot' },
  { value: 'line', label: 'Line' },
  { value: 'square', label: 'Square' },
  { value: 'ellipse', label: 'Chain' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'cross', label: 'Cross' },
]



const pct = (v: number) => `${Math.round(v * 100)}%`
const px = (v: number) => `${v.toFixed(1)}px`

/** The machine, not the artwork. Everything here applies to every plate. */
export default function PressPanel({ target }: { target: PressTarget }) {
  const { settings, dispatch } = useSettings()
  const press = settings[target]
  const patch = (p: Partial<PressProfile>, coalesce = false) =>
    dispatch({ type: 'patchPress', target, patch: p, coalesce })

  return (
    <div className="control-stack">
      <Field label="Screening">
        <Segmented
          label="Screening method"
          value={press.method}
          options={METHODS}
          onChange={(method) => patch({ method })}
        />
      </Field>

      {press.method === 'halftone' && (
        <>
          <Field label="Dot shape">
            <Segmented
              label="Dot shape"
              value={press.screenShape}
              options={SHAPES}
              onChange={(screenShape) => patch({ screenShape })}
            />
          </Field>
          <Slider
            label="Screen pitch"
            value={press.screenPitch}
            min={2}
            max={24}
            step={0.5}
            format={px}
            onChange={(screenPitch) => patch({ screenPitch }, true)}
          />
          <Slider
            label="Dot softness"
            value={press.screenSoftness}
            min={0}
            max={3}
            step={0.05}
            format={px}
            onChange={(screenSoftness) => patch({ screenSoftness }, true)}
          />
        </>
      )}

      {press.method === 'dither' && (
        <>
          <Field label="Dither" value={DITHER_TYPES.find((d) => d.id === press.ditherType)?.name}>
            <Segmented
              label="Dither algorithm"
              value={press.ditherType === 'none' ? 'atkinson' : press.ditherType}
              options={DITHER_TYPES.map((d) => ({ value: d.id, label: d.name }))}
              onChange={(ditherType) => patch({ ditherType })}
            />
          </Field>
          <p className="panel-note">
            These are genuinely different textures, not one slider: Jarvis is smooth and slow,
            Burkes fast and contrasty, clustered the only one that still reads as a printing
            screen rather than a computer effect.
          </p>
          <Slider
            label="Dot size"
            value={press.ditherScale}
            min={1}
            max={12}
            step={1}
            format={(v) => `${v}px`}
            onChange={(ditherScale) => patch({ ditherScale }, true)}
          />
          <Slider
            label="Threshold"
            value={press.ditherThreshold}
            min={0.1}
            max={0.9}
            step={0.01}
            format={pct}
            onChange={(ditherThreshold) => patch({ ditherThreshold }, true)}
          />
        </>
      )}

      {(press.method === 'woodcut' || press.method === 'scribble') && (
        <>
          <p className="panel-note">
            {press.method === 'woodcut'
              ? 'Ink carried by whatever the blade left standing — grooves cut across the shape, and the block’s own grain showing through what remains.'
              : 'Hatched rather than flooded. Strokes bow instead of ruling straight, and a second pass crosses the first only where the shape wants to be darker.'}
          </p>
          <Slider
            label={press.method === 'woodcut' ? 'Groove spacing' : 'Stroke spacing'}
            value={press.carvePitch}
            min={3}
            max={40}
            step={1}
            format={(v) => `${v}px`}
            onChange={(carvePitch) => patch({ carvePitch }, true)}
          />
          <Slider
            label={press.method === 'woodcut' ? 'Cut direction' : 'Hatch direction'}
            value={press.carveAngle}
            min={0}
            max={180}
            step={1}
            format={(v) => `${v}°`}
            onChange={(carveAngle) => patch({ carveAngle }, true)}
          />
          <Slider
            label="Wander"
            value={press.carveRoughness}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onChange={(carveRoughness) => patch({ carveRoughness }, true)}
          />
        </>
      )}

      <Slider
        label="Ink density"
        value={press.density}
        min={0.3}
        max={1}
        step={0.01}
        format={pct}
        onChange={(density) => patch({ density }, true)}
      />

      <Slider
        label="Midtones"
        value={press.gamma}
        min={0.4}
        max={2.4}
        step={0.02}
        format={(v) => v.toFixed(2)}
        onChange={(gamma) => patch({ gamma }, true)}
      />

      <Toggle
        label="Scale detail to type size"
        checked={press.detailScaling}
        onChange={(detailScaling) => patch({ detailScaling })}
      />
      <p className="panel-note">
        A screen coarse enough to read on a poster is wider than the strokes of small type. With
        this on, small words get a proportionally finer screen, tear and bleed so they stay
        legible. Off is the literal behaviour — one ruling for the whole sheet.
      </p>

      <Slider
        label="Misregistration"
        value={press.misregistration}
        min={0}
        max={30}
        step={0.5}
        format={(v) => `${v}px`}
        onChange={(misregistration) => patch({ misregistration }, true)}
      />

      <Slider
        label="Ink mottle"
        value={press.mottle}
        min={0}
        max={0.8}
        step={0.01}
        format={pct}
        onChange={(mottle) => patch({ mottle }, true)}
      />

      <Slider
        label="Dropout"
        value={press.dropout}
        min={0}
        max={0.08}
        step={0.002}
        format={(v) => `${(v * 100).toFixed(1)}%`}
        onChange={(dropout) => patch({ dropout }, true)}
      />

      <Slider
        label="Roller banding"
        value={press.banding}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(banding) => patch({ banding }, true)}
      />
    </div>
  )
}
