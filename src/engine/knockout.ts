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

import { shiftField } from './ink.ts'

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
    /** The screened "ground is light" mask the split used, 0..1. */
    light: Float32Array
    /** Luminance of the ink laid where the ground is light, and where dark. */
    onLightLuma: number
    onDarkLuma: number
  }
}

/** Below this the shifted tone is the anti-aliased skirt; above, it is the hole. */
const HOLE = 0.14

/**
 * How much of the ground to take away under one plate, 0..1 per pixel.
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
export function knockoutMask(
  roughened: Float32Array,
  groundLum: Float32Array | null,
  p: KnockoutParams,
): Float32Array {
  const { w, h, split } = p
  const moved = shiftField(roughened, w, h, p.dx, p.dy)
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const solid = moved[i] > HOLE ? 1 : moved[i]
    if (!split || !groundLum) {
      out[i] = solid
      continue
    }
    const g = groundLum[i]
    const need =
      (split.onLightLuma > g ? split.light[i] : 0) + (split.onDarkLuma > g ? 1 - split.light[i] : 0)
    out[i] = solid * need
  }
  return out
}
