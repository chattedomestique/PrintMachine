/**
 * A row of chips with one pressed (ChipRow.tsx), and the rules it follows.
 * Pure: no React, no DOM, so each rule has a test (chips.test.ts).
 *
 * A chip may have another way round (`alt`): the same choice turned on its
 * side, 9:16 and 16:9. Border Studio's ratio row shows one chip for the pair,
 * labelled with whichever way is chosen; a tap on a chip that is not chosen
 * chooses it, and a tap on the chosen chip turns it to its other way round
 * (its flip cue says so). A chosen chip with no other way round does nothing.
 *
 * Knows nothing about what the choices are (ui/ is app-agnostic): the caller
 * supplies the ids and the words.
 */

export interface ChipFace<T extends string> {
  id: T
  label: string
}

export interface ChipItem<T extends string> extends ChipFace<T> {
  /** The same choice the other way round, when it has one. */
  alt?: ChipFace<T>
  /** The choice's colour, shown as a dot before its name (data, as a
   *  swatch's colour is): the name is always there too, so nobody has to
   *  tell two colours apart by eye. */
  swatch?: string
  /** A glyph before the name, for a choice that is not one colour. */
  icon?: string
  /** Shown but not choosable (aria-disabled, so it can still be found with
   *  the keys); the caller says why nearby, and names those words to the row
   *  (ChipRow's `whyId`), so they are said with the chip. */
  disabled?: boolean
  /** What the choice shows is still being made (the colour a chip stands
   *  for, say): a spinner in place of its dot or glyph, and said. */
  busy?: boolean
}

/** What a chip shows for the chosen value: the way round that is chosen (its
 *  first way when neither is), whether it is pressed, and whether a tap
 *  flips it. */
export function chipFace<T extends string>(item: ChipItem<T>, value: T): ChipFace<T> & { pressed: boolean; flips: boolean } {
  const turned = item.alt !== undefined && item.alt.id === value
  const face = turned ? item.alt! : item
  const pressed = turned || item.id === value
  return { id: face.id, label: face.label, pressed, flips: pressed && item.alt !== undefined }
}

/** The name a screen reader hears: the label, that the choice is still
 *  being made ("Deep, preparing", its spinner said), and on the chosen chip
 *  that flips, what a tap does ("9:16, tap to flip"), since its cue is a
 *  glyph. */
export function chipName<T extends string>(item: ChipItem<T>, value: T): string {
  const f = chipFace(item, value)
  return `${f.label}${item.busy ? ', preparing' : ''}${f.flips ? ', tap to flip' : ''}`
}

/** The value a tap on `item` chooses, or null when it changes nothing (the
 *  chosen chip, with no other way round; a chip that cannot be chosen). */
export function chipTap<T extends string>(item: ChipItem<T>, value: T): T | null {
  if (item.disabled) return null
  const f = chipFace(item, value)
  if (!f.pressed) return item.id
  if (!f.flips) return null
  return f.id === item.id ? item.alt!.id : item.id
}

/**
 * Where a key moves focus in a row of `count` chips from chip `index`: the
 * arrows step one chip and stop at the ends, Home and End go to the ends (as
 * the dock's tabs do). Null for any other key, and for a step that goes
 * nowhere. Focus only: Enter and Space press the chip (a button's own keys),
 * because choosing as focus moves would remake the print at every step.
 */
export function chipKeyTarget(key: string, index: number, count: number): number | null {
  const last = count - 1
  const next =
    key === 'ArrowRight' ? Math.min(last, index + 1)
    : key === 'ArrowLeft' ? Math.max(0, index - 1)
    : key === 'Home' ? 0
    : key === 'End' ? last
    : null
  return next === null || next === index || count < 1 ? null : next
}

/**
 * The row's one tab stop: the chip that has focus while focus is in the row
 * (so Tab leaves the row from where the arrows took it), else the chosen
 * chip, else the first. `focused` and `chosen` are indexes, -1 for none.
 */
export const chipTabStop = (focused: number, chosen: number): number => (focused >= 0 ? focused : Math.max(0, chosen))

/** How much of the neighbour a revealed chip leaves showing, so the row
 *  still says it goes on (the style guide's SG.revealInline, 24 px). */
export const REVEAL_PAD_PX = 24

/**
 * How far a scrolling row must scroll so a chip shows whole, with `pad` of
 * its neighbour beside it: 0 when it already does. Edges in one coordinate
 * space (client pixels). A browser leaves a partly hidden chip where it is
 * when it takes focus, which cuts its focus ring in half (WCAG 2.4.7); this
 * is the style guide's SG.revealInline, which its chip script calls and
 * which is not loaded here (scripts/sync-styleguide.mjs).
 */
export function revealDelta(
  chip: { left: number; right: number },
  row: { left: number; right: number },
  pad = REVEAL_PAD_PX,
): number {
  if (chip.left < row.left + pad) return chip.left - row.left - pad
  if (chip.right > row.right - pad) return chip.right - row.right + pad
  return 0
}

/** How far the cut may narrow every chip (px, both sides together): a row
 *  that misses fitting by a few pixels is tightened until it fits. */
export const CUT_SHRINK = -8
/** How far it may widen every chip, looking for a cut it can keep. */
export const CUT_GROW = 48

/**
 * The style guide's chip cut (42-chip `cut()`, which Border Studio runs on
 * every scrolling chip row): the chip that peeks in at the row's end is the
 * sign the row goes on, so where it is cut is chosen, not luck. At rest every
 * chip's side padding changes by one amount (`grow`, both sides together, the
 * row's `--_grow`) until the first chip not whole shows between 30% and 60%
 * of itself and at least 24 px: never a sliver, never a chip missing only its
 * round end. A row that misses fitting by no more than `CUT_SHRINK` is
 * tightened until it fits. Null: no change (the row fits, or no amount gives
 * a fair cut). Pure, as the script's own arithmetic is.
 *
 * @param items each chip's start (from the content's start, at rest) and width
 * @param room the row's inner width (its padding box less its padding)
 * @param edge where the row clips, at rest, from the content's start
 */
export function chipCut(items: readonly { s: number; w: number }[], room: number, edge: number): number | null {
  // The first chip that is not whole inside the row when every chip is
  // `grow` wider: how much of it shows, and its width.
  const at = (grow: number) => {
    for (let i = 0; i < items.length; i++) {
      const s = items[i].s + i * grow
      const w = items[i].w + grow
      if (s + w > room + 0.5) return { v: edge - s, w }
    }
    return null
  }
  if (!at(CUT_SHRINK)) {
    for (let f = 0; f >= CUT_SHRINK; f -= 0.5) if (!at(f)) return f === 0 ? null : f
    return null
  }
  for (let d = 0; d <= CUT_GROW; d += 0.5) {
    for (const grow of [d, -d]) {
      if (grow < CUT_SHRINK) continue
      const c = at(grow)
      if (c && c.v >= Math.max(24, 0.3 * c.w) && c.v <= 0.6 * c.w) return grow === 0 ? null : grow
    }
  }
  return null
}
