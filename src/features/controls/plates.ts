import { MAX_PRESSED_PASSES, MAX_TEXT_PLATES } from '../../engine/limits.ts'
import type { TextLayer } from '../../engine/types.ts'

/** Why Add and Backing stop: the plate budget, in words. */
export const BUDGET = `Up to ${MAX_TEXT_PLATES} plates and ${MAX_PRESSED_PASSES} passes (a backing is a pass of its own).`

/** The short form, for a menu row's meta. */
export const BUDGET_SHORT = `Up to ${MAX_TEXT_PLATES} plates, ${MAX_PRESSED_PASSES} passes`

/** A plate as a person names it: its first line of type (cut to 18
 *  characters), or "Plate 2" when it has none. */
export function plateName(layer: Pick<TextLayer, 'text'>, index: number): string {
  const first = layer.text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return `Plate ${index + 1}`
  return first.length > 18 ? `${first.slice(0, 17)}…` : first
}
