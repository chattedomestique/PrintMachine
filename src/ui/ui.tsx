/**
 * The style guide's elements, as React components (Border Studio's ui.jsx,
 * typed).
 *
 * Each one renders the style guide's own markup (see the element's header in
 * src/vendor/styleguide/elements, or its docs page) and lets React own the
 * state. The style guide's state-owning scripts (tabs, slider, dialog, menu)
 * are deliberately not loaded — two owners of aria-selected fight — so the
 * keyboard patterns they would add are implemented here instead.
 *
 * App-agnostic: nothing here knows what a print is.
 */

import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useModalDialog } from './useModalDialog.ts'

/** A masked symbol (the style guide's `.ic`). Decorative: the control that
 *  holds it carries the name. */
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`ic ic--${name}${className ? ` ${className}` : ''}`} aria-hidden="true" />
}

export interface SegmentedOption<T extends string> {
  id: T
  label: ReactNode
  /** The name a screen reader hears, when the visible label is short. */
  aria?: string
  /** Shown but not choosable; the caller says why in visible text nearby. */
  disabled?: boolean
}

/**
 * Pick one of two to four values. Native radios inside, so arrow keys, roving
 * focus and the screen-reader semantics come from the browser (and arrows
 * skip a disabled option on their own).
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'sm',
  block = true,
  name,
  describedBy,
}: {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  block?: boolean
  name?: string
  describedBy?: string
}) {
  const auto = useId()
  const group = name ?? `seg${auto}`
  return (
    <fieldset className="segmented" data-size={size} data-block={block ? '' : undefined} aria-describedby={describedBy}>
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={o.id} className="segmented__opt">
          <input
            type="radio"
            name={group}
            value={o.id}
            checked={value === o.id}
            disabled={o.disabled}
            onChange={() => onChange(o.id)}
            aria-label={o.aria}
          />
          <span className="segmented__label">{o.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

export interface TabItem<T extends string> {
  id: T
  label: string
  /** A setting on this tab is in effect: a dot after its name. */
  on?: boolean
}

/**
 * Tabs that swap the panel beneath them (the dock's sub-views). ARIA tabs with
 * automatic activation: one tab stop, arrows / Home / End move and choose.
 * The panel is the caller's: give it role="tabpanel", id `${idBase}-panel`
 * and aria-labelledby `${idBase}-tab-${value}`, so the pairing is announced.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idBase,
}: {
  label: string
  tabs: readonly TabItem<T>[]
  value: T
  onChange: (v: T) => void
  idBase: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // A bar wider than the dock scrolls; keep the chosen tab in view (the style
  // guide's tabs script would, and it is not loaded). The row is scrolled to
  // the first tab START from which the chosen tab is whole, so the row always
  // begins with a whole word, never a sliver of another.
  useEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !el || list.scrollWidth <= list.clientWidth) return
    const box = list.getBoundingClientRect()
    const pad = parseFloat(getComputedStyle(list).paddingInlineStart) || 0
    const at = (t: Element) => t.getBoundingClientRect().left - box.left + list.scrollLeft - pad
    const start = at(el)
    const end = start + el.getBoundingClientRect().width + 2 * pad
    const starts = [...list.querySelectorAll('[role="tab"]')].map(at)
    const whole = (x: number) => x <= start && end - x <= list.clientWidth
    if (whole(list.scrollLeft) && starts.some((x) => Math.abs(x - list.scrollLeft) < 1)) return
    list.scrollTo({ left: starts.find(whole) ?? start })
  }, [value])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value)
    const last = tabs.length - 1
    const next =
      e.key === 'ArrowRight' ? Math.min(last, i + 1)
      : e.key === 'ArrowLeft' ? Math.max(0, i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null || next === i) return
    e.preventDefault()
    onChange(tabs[next].id)
    // Focus follows the choice once React has re-rendered the roving tabindex.
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next].id}"]`)?.focus())
  }

  return (
    // The underline variant: flat words with a bar under the chosen one.
    <div className="tabs" data-variant="underline" data-size="sm">
      <div className="tabs__bar">
        <div className="tabs__list" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
          {tabs.map((t) => {
            const on = t.id === value
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="tabs__tab"
                id={`${idBase}-tab-${t.id}`}
                data-tab={t.id}
                aria-selected={on}
                aria-controls={`${idBase}-panel`}
                tabIndex={on ? 0 : -1}
                onClick={() => onChange(t.id)}
              >
                {t.label}
                {t.on && (
                  <>
                    <span className="tabs__on" aria-hidden="true" />
                    <span className="sr-only">, on</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** An on/off setting that applies at once: a native checkbox with role=switch. */
export function Switch({
  label,
  checked,
  onChange,
  hideLabel = false,
  describedBy,
  layout,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hideLabel?: boolean
  describedBy?: string
  /** 'start': [switch][label], shrinking to fit, for a switch that shares a
   *  row; the default row spans the width. */
  layout?: 'start'
  disabled?: boolean
}) {
  return (
    <label className="switch" data-state="hidden" data-layout={layout}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={describedBy}
      />
      <span className={`switch__label${hideLabel ? ' sr-only' : ''}`}>{label}</span>
      <span className="switch__state" aria-hidden="true">
        <span data-on="">On</span>
        <span data-off="">Off</span>
      </span>
    </label>
  )
}

export interface SwatchItem {
  id: string
  label: string
  /** The colour itself: data, so it comes in as --swatch (the one place a
   *  component takes a colour from data). */
  color: string
}

/**
 * Pick one colour from a set: native radios, each a round chip with its NAME
 * under it, so nobody has to tell two colours apart by eye. The frame, the
 * check and the name are roles; only the chip's fill is the data.
 */
export function SwatchSet({
  legend,
  items,
  value,
  onPick,
  hideLegend = true,
  name,
}: {
  legend: string
  items: readonly SwatchItem[]
  value: string | null
  onPick: (item: SwatchItem) => void
  hideLegend?: boolean
  name?: string
}) {
  const auto = useId()
  const group = name ?? `sw${auto}`
  return (
    <fieldset className="swatch-set">
      <legend className={hideLegend ? 'sr-only' : undefined}>{legend}</legend>
      <div className="swatch-set__list">
        {items.map((it) => (
          <label key={it.id} className="swatch-set__opt" style={{ '--swatch': it.color } as CSSProperties}>
            <input type="radio" name={group} value={it.id} checked={value === it.id} onChange={() => onPick(it)} />
            <span className="swatch-set__chip">
              <Icon name="check" />
            </span>
            <span className="swatch-set__name">{it.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * The style guide's action sheet (its menu presented as a sheet): big rows
 * docked to the bottom of the screen, over a scrim that dims the photo and the
 * dock alike, and a Cancel row last. On a modal <dialog>, so the page behind is
 * inert, Esc and a tap on the scrim cancel, and focus goes back to whatever
 * opened it. The caller passes the rows (.menu__item buttons); arrow keys, Home
 * and End move between them, and the checked one (or the first) has focus
 * when it opens.
 */
export function ActionSheet({
  open,
  onClose,
  title,
  label,
  children,
  listRef,
}: {
  open: boolean
  onClose: () => void
  title?: string
  label?: string
  children: ReactNode
  listRef?: RefObject<HTMLDivElement | null>
}) {
  const ref = useModalDialog(open, onClose)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const list = ref.current?.querySelector('.actsheet__list')
    ;(list?.querySelector<HTMLElement>('[aria-checked="true"]') ?? list?.querySelector<HTMLElement>('.menu__item'))?.focus()
  }, [open, ref])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.menu__item:not([aria-disabled="true"])')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const last = items.length - 1
    const next =
      e.key === 'ArrowDown' ? (i < last ? i + 1 : 0)
      : e.key === 'ArrowUp' ? (i > 0 ? i - 1 : last)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    items[next]?.focus()
  }
  const setList = (el: HTMLDivElement | null) => {
    if (listRef) listRef.current = el
  }
  return (
    <dialog
      ref={ref}
      className="dialog card actsheet"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : label}
    >
      {title && (
        <p className="menu__label actsheet__title" id={titleId}>
          {title}
        </p>
      )}
      <div className="actsheet__list" role="menu" aria-label={label ?? title} ref={setList} onKeyDown={onKeyDown}>
        {children}
        <button type="button" className="menu__item" role="menuitem" data-variant="cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  )
}
