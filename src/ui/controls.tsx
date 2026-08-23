import { useId, type ReactNode } from 'react'
import './ui.css'

/**
 * App-agnostic primitives. None of these know what a Riso is — they take
 * values and emit changes, consume tokens for every visual decision, and
 * carry the ARIA pattern their role demands (playbook §10.1).
 */

/* ── Field ────────────────────────────────────────────────────────────── */

export function Field({
  label,
  value,
  htmlFor,
  children,
}: {
  label: string
  value?: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <div className="field-head">
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {value !== undefined && <span className="field-value">{value}</span>}
      </div>
      {children}
    </div>
  )
}

/* ── Slider ───────────────────────────────────────────────────────────── */

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  const id = useId()
  return (
    <Field label={label} value={format ? format(value) : String(value)} htmlFor={id}>
      <input
        id={id}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  )
}

/* ── Segmented ────────────────────────────────────────────────────────── */

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/**
 * Radio group semantics, with a roving tab stop: the group takes one Tab, and
 * arrow keys move between options (§10.2).
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (v: T) => void
}) {
  const move = (delta: number) => {
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + delta + options.length) % options.length]
    if (next) onChange(next.value)
  }

  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((o) => {
        const checked = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="segmented-option"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── Toggle ───────────────────────────────────────────────────────────── */

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="toggle"
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
    </button>
  )
}

/* ── Swatches ─────────────────────────────────────────────────────────── */

export interface SwatchOption {
  id: string
  name: string
  rgb: readonly [number, number, number]
}

export function Swatches({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly SwatchOption[]
  onChange: (id: string) => void
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          aria-label={o.name}
          title={o.name}
          className="swatch"
          style={{ background: `rgb(${o.rgb[0]} ${o.rgb[1]} ${o.rgb[2]})` }}
          onClick={() => onChange(o.id)}
        />
      ))}
    </div>
  )
}

/* ── Icon button ──────────────────────────────────────────────────────── */

export function IconButton({
  label,
  onClick,
  disabled,
  variant,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'primary'
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="icon-button"
      data-variant={variant}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/* ── Panel ────────────────────────────────────────────────────────────── */

export function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="panel" data-open={open} aria-hidden={!open}>
      <div className="panel-inner" inert={!open ? true : undefined}>
        {children}
      </div>
    </div>
  )
}
