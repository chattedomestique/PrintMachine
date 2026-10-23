/**
 * Knockouts: where the photo is cut back to paper under a plate.
 *
 * Riso ink is transparent, so it can darken what it lands on and never lighten
 * it: a light ink over solid black is still solid black. A real job that wants
 * a colour to read over a dark part of a photograph does not paint it on
 * opaque — it cuts a hole in the photo's plate and prints the ink onto paper
 * there. That is what this computes: per pixel, how much of the photo to take
 * away (0 keeps it, 1 is bare paper), which the renderer applies to the photo's
 * alpha so the paper underneath comes back through.
 *
 * Pure, and fed by the plate's OWN press: `roughened` is the torn, bled tone
 * `pressPlate` already made, and the offset is the one it moved the plate by.
 * Re-roughening the tone here would cost a full blur pass for a field that is
 * already sitting in memory, byte for byte the same.
 */

import { shiftInPlace } from './ink.ts'

export interface KnockoutParams {
  w: number
  h: number
  /** The plate's registration offset: the hole travels with the plate. */
  dx: number
  dy: number
  /**
   * A plate split into two inks by the ground (the second ink). Omitted, the
   * plate is cut out wherever it prints — a backing block, which prints on
   * paper everywhere so the type can overprint it into a third colour.
   */
  split?: {
    /** The screened "ground is light" mask the split used: 0..1 as floats,
     *  or 0..255 in bytes (what the press keeps). */
    light: Float32Array | Uint8ClampedArray
    /** Luminance of the ink laid where the ground is light, and where dark. */
    onLightLuma: number
    onDarkLuma: number
  }
}

/** Below this the shifted tone is the anti-aliased skirt; above, it is the hole. */
const HOLE = 0.14

/**
 * How much of the ground to take away under one plate, cut straight into the
 * sheet's running knockout: bytes, 0..255 (0 keeps the photo, 255 is bare
 * paper), each pixel keeping the deepest cut any plate made there. Shifts
 * `roughened` IN PLACE to the plate's offset, so the caller hands over a
 * buffer it is done with.
 *
 * The hole is cut from the plate's roughened TONE, not from its screened
 * coverage: knocking out with the halftone would leave the photo standing in
 * every gap between the type's own dots, and the light ink would print onto a
 * still-black ground. A stencil has a solid hole in it.
 *
 * No trap. The hole travels with the plate, so there is nothing to trap
 * against — and what the eye reads as a reversed word is the *hole*, not the
 * ink: bare paper and a light ink are nearly the same colour, so the letterform
 * you see is the shape of the cut. Spreading it does not protect the letter, it
 * fattens it, and at text size that closes every counter and prints a row of
 * blobs. The cut is only hardened: anything past the anti-aliased skirt is a
 * whole hole.
 *
 * With a split, the photo is cut only where the ink chosen there is lighter
 * than what it lands on — the case a transparent ink physically cannot print.
 * Tying the hole to the dark half of the mask instead is only right when the
 * second ink happens to be the light one. With the plate's own ink as its
 * second ink this reduces to "the photo is darker than the ink", which is how
 * one colour stays readable over a whole photograph the riso way.
 */
export function cutKnockout(
  into: Uint8ClampedArray,
  roughened: Float32Array,
  groundLum: Float32Array | null,
  p: KnockoutParams,
): void {
  const { w, h } = p
  shiftInPlace(roughened, w, h, p.dx, p.dy)
  const split = groundLum ? p.split : undefined
  const unit = split?.light instanceof Uint8ClampedArray ? 255 : 1
  for (let i = 0; i < into.length; i++) {
    const v = Math.fround(holeAt(roughened[i], groundLum, split, unit, i)) * 255
    if (v > into[i]) into[i] = v
  }
}

/** How much of the ground one pixel of a plate takes away, 0..1, from the
 *  plate's tone at that pixel once moved to its offset (see cutKnockout). */
export function holeAt(
  moved: number,
  groundLum: Float32Array | null,
  split: KnockoutParams['split'],
  unit: number,
  i: number,
): number {
  const solid = moved > HOLE ? 1 : moved
  if (!split || !groundLum) return solid
  const g = groundLum[i]
  const light = split.light[i] / unit
  const need = (split.onLightLuma > g ? light : 0) + (split.onDarkLuma > g ? 1 - light : 0)
  return solid * need
}
