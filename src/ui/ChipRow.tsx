/**
 * One choice of several, as the style guide's chips on one scrolling line
 * (Border Studio's ratio row): each chip a button, the chosen one pressed
 * (aria-pressed), and a chosen chip that has another way round carries the
 * flip cue, a tap on it turning it over (chips.ts holds every rule).
 *
 * Buttons, not the style guide's radio chips: a tap on a checked radio fires
 * nothing, and that tap is the flip. The style guide's chip script is not
 * loaded (React owns aria-pressed), so the keyboard is here: one tab stop,
 * as the dock's tabs have (the chosen chip, or the one the keys moved to),
 * the arrows, Home and End move focus along the row, and Enter and Space
 * press. A chip that takes focus, and the chosen chip when the choice
 * changes, is scrolled into view whole.
 *
 * App-agnostic: the caller supplies the choices and their words.
 */

import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
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
}: {
  /** The group's name: what the choice is ("Sheet ratio"). */
  label: string
  items: readonly ChipItem<T>[]
  value: T
  onChange: (v: T) => void
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
            tabIndex={i === stop ? 0 : -1}
            onFocus={() => setFocused(i)}
            onClick={() => {
              const v = chipTap(it, value)
              if (v !== null) onChange(v)
            }}
          >
            {f.label}
            {f.flips && <Icon name="refresh-cw" className="chiprow__flip" />}
          </button>
        )
      })}
    </div>
  )
}
