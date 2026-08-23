import { Field, Segmented, Slider } from '../../ui/controls.tsx'
import type { DitherType } from '../../engine/dither.ts'
import type { ScreenShape } from '../../engine/screen.ts'
import type { PrintSettings, ScreenMethod } from '../../engine/types.ts'
import { useSettings } from '../../state/settingsStore.ts'

const METHODS: readonly { value: ScreenMethod; label: string }[] = [
  { value: 'halftone', label: 'Halftone' },
  { value: 'dither', label: 'Dither' },
]

const SHAPES: readonly { value: ScreenShape; label: string }[] = [
  { value: 'circle', label: 'Dot' },
  { value: 'line', label: 'Line' },
  { value: 'square', label: 'Square' },
  { value: 'ellipse', label: 'Chain' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'cross', label: 'Cross' },
]

const DITHERS: readonly { value: DitherType; label: string }[] = [
  { value: 'atkinson', label: 'Atkinson' },
  { value: 'floydsteinberg', label: 'Floyd' },
  { value: 'bayer', label: 'Bayer' },
  { value: 'threshold', label: 'Hard' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`
const px = (v: number) => `${v.toFixed(1)}px`

/** The machine, not the artwork. Everything here applies to every plate. */
export default function PressPanel() {
  const { settings, dispatch } = useSettings()
  const patch = (p: Partial<PrintSettings>, coalesce = false) => dispatch({ type: 'patch', patch: p, coalesce })

  return (
    <div className="control-group">
      <Field label="Screening">
        <Segmented
          label="Screening method"
          value={settings.method}
          options={METHODS}
          onChange={(method) => patch({ method })}
        />
      </Field>

      {settings.method === 'halftone' ? (
        <>
          <Field label="Dot shape">
            <Segmented
              label="Dot shape"
              value={settings.screenShape}
              options={SHAPES}
              onChange={(screenShape) => patch({ screenShape })}
            />
          </Field>
          <Slider
            label="Screen pitch"
            value={settings.screenPitch}
            min={2}
            max={24}
            step={0.5}
            format={px}
            onChange={(screenPitch) => patch({ screenPitch }, true)}
          />
          <Slider
            label="Dot softness"
            value={settings.screenSoftness}
            min={0}
            max={3}
            step={0.05}
            format={px}
            onChange={(screenSoftness) => patch({ screenSoftness }, true)}
          />
        </>
      ) : (
        <>
          <Field label="Dither">
            <Segmented
              label="Dither algorithm"
              value={settings.ditherType === 'none' ? 'atkinson' : settings.ditherType}
              options={DITHERS}
              onChange={(ditherType) => patch({ ditherType })}
            />
          </Field>
          <Slider
            label="Threshold"
            value={settings.ditherThreshold}
            min={0.1}
            max={0.9}
            step={0.01}
            format={pct}
            onChange={(ditherThreshold) => patch({ ditherThreshold }, true)}
          />
        </>
      )}

      <Slider
        label="Ink density"
        value={settings.density}
        min={0.3}
        max={1}
        step={0.01}
        format={pct}
        onChange={(density) => patch({ density }, true)}
      />

      <Slider
        label="Midtones"
        value={settings.gamma}
        min={0.4}
        max={2.4}
        step={0.02}
        format={(v) => v.toFixed(2)}
        onChange={(gamma) => patch({ gamma }, true)}
      />

      <Slider
        label="Misregistration"
        value={settings.misregistration}
        min={0}
        max={30}
        step={0.5}
        format={(v) => `${v}px`}
        onChange={(misregistration) => patch({ misregistration }, true)}
      />

      <Slider
        label="Ink mottle"
        value={settings.mottle}
        min={0}
        max={0.8}
        step={0.01}
        format={pct}
        onChange={(mottle) => patch({ mottle }, true)}
      />

      <Slider
        label="Dropout"
        value={settings.dropout}
        min={0}
        max={0.08}
        step={0.002}
        format={(v) => `${(v * 100).toFixed(1)}%`}
        onChange={(dropout) => patch({ dropout }, true)}
      />

      <Slider
        label="Roller banding"
        value={settings.banding}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(banding) => patch({ banding }, true)}
      />
    </div>
  )
}
