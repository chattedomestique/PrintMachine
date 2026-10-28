/**
 * One choice of several, as the style guide's chips on one scrolling line
 * (Border Studio's ratio row): each chip a button, the chosen one pressed
 * (aria-pressed), and a chosen chip that has another way round carries the
 * flip cue, a tap on it turning it over (chips.ts holds every rule). A chip
 * may show its choice's colour as a dot, or a glyph, before its name.
 *
 * Buttons, not the style guide's radio chips: a tap on a checked radio fires
 * nothing, and that tap is the flip. The style guide's chip script is not
 * loaded (React owns aria-pressed), so the keyboard is here: one tab stop,
 * as the dock's tabs have (the chosen chip, or the one the keys moved to),
 * the arrows, Home and End move focus along the row, and Enter and Space
 * press. A chip that takes focus, and the chosen chip when the choice
 * changes, is scrolled into view whole. A chip that cannot be chosen is
 * described by the caller's words for why (`whyId`); a chip whose choice is
 * still being made shows the style guide's spinner where its dot or glyph
 * goes, and the row is aria-busy meanwhile.
 *
 * App-agnostic: the caller supplies the choices and their words.
 */

import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
import { chipFace, chipKeyTarget, chipName, chipTabStop, chipTap, revealDelta, type ChipItem } from './chips.ts'
import { Icon } from './ui.tsx'

/** Scroll `row` so `chip` shows whole, if the row scrolls at all. */
function reveal(chip: Element, row: HTMLElement, behavior: ScrollBehavior): void {
  if (row.scrollWidth <= row.clientWidth) return
  const delta = revealDelta(chip.getBoundingClientRect(), row.getBoundingClientRect())
  if (delta !== 0) row.scrollBy({ left: delta, behavior })
}

export function ChipRow<T extends string>({
  label,
  items,
  value,
  onChange,
  whyId,
}: {
  /** The group's name: what the choice is ("Sheet ratio"). */
  label: string
  items: readonly ChipItem<T>[]
  value: T
  onChange: (v: T) => void
  /** The id of the visible words that say why a chip cannot be chosen. */
  whyId?: string
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(-1)
  const stop = chipTabStop(focused, items.findIndex((it) => chipFace(it, value).pressed))

  // The chosen chip in view when the choice changes (and when the row first
  // shows), at once: a choice made elsewhere (Undo) must not animate the row.
  useEffect(() => {
    const row = rowRef.current
    const el = row?.querySelector('[aria-pressed="true"]')
    if (row && el) reveal(el, row, 'auto')
  }, [value])

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    reveal(e.target, e.currentTarget, reduced ? 'auto' : 'smooth')
  }
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(-1)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const chips = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > .chip')]
    const next = chipKeyTarget(e.key, chips.indexOf(e.target as HTMLButtonElement), chips.length)
    if (next === null) return
    e.preventDefault()
    chips[next].focus()
  }

  return (
    <div
      className="chips scroller chiprow"
      role="group"
      aria-label={label}
      aria-busy={items.some((it) => it.busy) || undefined}
      ref={rowRef}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => {
        const f = chipFace(it, value)
        return (
          <button
            key={it.id}
            type="button"
            className="chip num"
            data-chip={f.id}
            aria-pressed={f.pressed}
            aria-label={chipName(it, value)}
            aria-disabled={it.disabled || undefined}
            aria-describedby={it.disabled ? whyId : undefined}
            tabIndex={i === stop ? 0 : -1}
            onFocus={() => setFocused(i)}
            onClick={() => {
              const v = chipTap(it, value)
              if (v !== null) onChange(v)
            }}
          >
            {it.busy ? (
              <span className="spinner" aria-hidden="true">
                <span className="spinner__ring" />
              </span>
            ) : (
              <>
                {it.swatch !== undefined && <span className="chiprow__swatch" style={{ '--swatch': it.swatch } as CSSProperties} aria-hidden="true" />}
                {it.icon !== undefined && <Icon name={it.icon} />}
              </>
            )}
            {f.label}
            {f.flips && <Icon name="refresh-cw" className="chiprow__flip" />}
          </button>
        )
      })}
    </div>
  )
}
