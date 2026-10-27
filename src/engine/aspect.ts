/**
 * The sheet's shape as a choice: the order the ratio chips show, and the
 * flip a second tap on the chosen chip makes (Border Studio's chips, with
 * its Free as Original).
 *
 * Pure: the ratios themselves live in types.ts (`ASPECTS`).
 */

import { ASPECTS, type FixedAspect, type PrintSettings } from './types.ts'

export type AspectKey = PrintSettings['aspect']

/** The ratio chips, in order: Original, then square and the portrait
 *  ratios. Each portrait chip reaches its landscape twin by `flipOf`. */
export const CHIP_RATIOS: readonly AspectKey[] = ['original', '1:1', '4:5', '3:4', '9:16', '2:3']

const isFixed = (key: string): key is FixedAspect => Object.prototype.hasOwnProperty.call(ASPECTS, key)

/**
 * The same ratio the other way round: '4:5' is '5:4' and back. Square and
 * Original have no other way round and are themselves.
 */
export function flipOf(key: AspectKey): AspectKey {
  if (key === 'original') return key
  const [w, h] = key.split(':')
  const twin = `${h}:${w}`
  return isFixed(twin) ? twin : key
}
