import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether a box scrolls: its content taller than the box. A box that scrolls
 * and holds nothing focusable must itself be a stop for the keyboard (the
 * style guide's scroll region: `tabindex="0"`, `role="region"` and a name),
 * or only a finger can read what is past its edge: Chromium makes such a
 * box focusable on its own, Safari does not. Measured again whenever the box
 * or anything in it changes size (a sheet opening, a font arriving, larger
 * text).
 */
export function useScrolls(ref: RefObject<HTMLElement | null>, on = true): boolean {
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || !on) {
      setScrolls(false)
      return
    }
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    measure()
    return () => ro.disconnect()
  }, [ref, on])
  return scrolls
}
