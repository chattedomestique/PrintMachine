/**
 * The very-large line in the dock (AppShell.tsx): where it sits and how it
 * takes its room, so that its coming and going moves nothing the open
 * panel shows and covers nothing in use.
 *
 * The line is drawn in a band of the dock whose height is set here, never by
 * the line's own layout (`--large-band`; the open panel's bound gives up as
 * much): the band follows the line's words, and only this code changes it,
 * measuring what that does to the panel and putting it back.
 *
 * - Where the open panel is shorter than its bound (100% text, most phones),
 *   the band takes the stage's room: the dock grows above the panel, which
 *   does not move.
 * - Where the panel is at its bound (large text on a small phone) the band
 *   takes the panel's own room, from the end away from the control in use:
 *   its top, the dock's first line, unless that would cover the control just
 *   touched or focused, then its foot, just above the tools. The panel's
 *   scroll moves by as much as its box did, so every row keeps its place on
 *   screen.
 * - When the line goes (or grows shorter), the panel takes back what its
 *   scroll can give without moving a row; the band keeps the rest, empty,
 *   until the person scrolls the panel (each scroll gives back what it can)
 *   or the tool or the tab changes.
 */

/** Which end of the open panel the line's band is at. */
export type LineAt = 'top' | 'foot'

/** A box's edges on screen, in CSS pixels. */
export interface Edges {
  top: number
  bottom: number
}

/** The room kept round the control in use: the focus ring and its offset
 *  (the style guide's --ring and --ring-offset, 3 px each). */
export const RING_ROOM = 6

/**
 * Where the band goes as the line comes: the panel's top unless that would
 * cover the control in use (`used`), then its foot when that does not. Only a
 * panel at its bound (`scrolls`) gives the band its own room; one under it
 * lets the dock grow above it, which covers nothing, so the top.
 */
export function lineEnd(panel: Edges & { scrolls: boolean }, need: number, used: Edges | null): LineAt {
  if (!panel.scrolls || !used) return 'top'
  if (used.top - RING_ROOM >= panel.top + need) return 'top'
  if (used.bottom + RING_ROOM <= panel.bottom - need) return 'foot'
  return 'top'
}

/**
 * How far the panel scrolls (positive: its rows go up) to bring the control
 * in use back whole, with its ring, when the band has hidden part of it: 0
 * when it is whole inside the panel (a control the person left at the
 * panel's edge stays where they left it). Only a fallback: `lineEnd` puts the
 * band where it covers nothing in use whenever the panel has the room.
 */
export function intoView(panel: Edges, used: Edges): number {
  if (used.top >= panel.top - 0.5 && used.bottom <= panel.bottom + 0.5) return 0
  const above = used.top - RING_ROOM - panel.top
  if (above < 0) return above
  return Math.min(used.bottom + RING_ROOM - panel.bottom, above)
}

/** The control a person is using, as a box: a radio's label rather than the
 *  radio itself (which is drawn by its label). */
function usedBox(el: Element): Edges {
  const r = (el.closest('label, button, [role="tab"]') ?? el).getBoundingClientRect()
  return { top: r.top, bottom: r.bottom }
}

/**
 * Lays the band out for a line of `h` px (0 when it is not shown) and puts
 * back what that moved in the open panel. `fresh`: the panel's rows have just
 * changed (a tool or tab opened or closed), so nothing is held and the band
 * is at the top. `used`: the control last touched or focused in the dock.
 */
export function placeLine(root: HTMLElement, band: HTMLElement, h: number, { fresh, used }: { fresh: boolean; used: Element | null }): void {
  const held = parseFloat(root.style.getPropertyValue('--large-band')) || 0
  const set = (px: number, at: LineAt) => {
    root.style.setProperty('--large-band', `${px}px`)
    band.dataset.at = at
  }
  const panel = root.querySelector<HTMLElement>('.app__panel--open .app__panel-inner')
  if (fresh || !panel) {
    set(h, 'top')
    return
  }
  const inUse = used && panel.contains(used) ? used : null
  // Where the panel's rows are on screen: its top less its scroll.
  const rows = () => panel.getBoundingClientRect().top - panel.scrollTop
  const was = rows()
  let at: LineAt = band.dataset.at === 'foot' ? 'foot' : 'top'
  if (held === 0 && h > 0) {
    const box = panel.getBoundingClientRect()
    at = lineEnd({ top: box.top, bottom: box.bottom, scrolls: panel.scrollHeight > panel.clientHeight + 1 }, h, inUse && usedBox(inUse))
  }
  set(h, at)
  // The rows moved by `moved` (down is positive): the scroll takes them back.
  const moved = rows() - was
  if (Math.abs(moved) > 0.5) {
    panel.scrollTop += moved
    const left = rows() - was
    // What the scroll could not give (at its start, or its end), the band
    // keeps: at the top a band that much taller than the panel's slack under
    // its bound moves the panel's top down by as much; at the foot it makes
    // that much more room to scroll into.
    if (left < -0.5 && at === 'top') {
      const slack = Math.max(0, parseFloat(getComputedStyle(panel).maxHeight) - panel.getBoundingClientRect().height)
      set(h + slack - left, at)
    } else if (left > 0.5 && at === 'foot') {
      set(h + left, at)
      panel.scrollTop += left
    }
  }
  if (inUse) {
    const box = panel.getBoundingClientRect()
    const by = intoView({ top: box.top, bottom: box.bottom }, usedBox(inUse))
    if (by !== 0) panel.scrollTop += by
  }
}
