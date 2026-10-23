/**
 * Reference implementations, for the tests only: the plain versions of two
 * passes the press runs in place, kept as oracles (the app never imports this
 * folder, so the build never ships it).
 *
 *  - `shiftField`: the bilinear shift into a NEW field. `shiftInPlace`
 *    (ink.ts) gets the same numbers by walking against the shift, which is
 *    easy to get wrong for one direction; this is what it is checked against.
 *  - `knockoutMask`: the knockout as a float field of its own, where the
 *    press cuts it straight into the sheet's running bytes (`cutKnockout`).
 *    Its behaviour tests and the golden recorded when the knockout became a
 *    stage of its own (WP1 1.4) are written against this shape.
 */

import { holeAt, type KnockoutParams } from '../knockout.ts'

export function shiftField(src: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  if (dx === 0 && dy === 0) return src.slice()

  const out = new Float32Array(w * h)
  const at = (x: number, y: number): number => (x < 0 || x >= w || y < 0 || y >= h ? 0 : src[y * w + x])

  for (let y = 0; y < h; y++) {
    const sy = y - dy
    const y0 = Math.floor(sy)
    const fy = sy - y0

    for (let x = 0; x < w; x++) {
      const sx = x - dx
      const x0 = Math.floor(sx)
      const fx = sx - x0

      const a = at(x0, y0)
      const b = at(x0 + 1, y0)
      const c = at(x0, y0 + 1)
      const d = at(x0 + 1, y0 + 1)

      const top = a + (b - a) * fx
      const bot = c + (d - c) * fx
      out[y * w + x] = top + (bot - top) * fy
    }
  }
  return out
}

/** How much of the ground to take away under one plate, 0..1 per pixel, as a
 *  new float field (see knockout.ts `cutKnockout` for the rule). */
export function knockoutMask(roughened: Float32Array, groundLum: Float32Array | null, p: KnockoutParams): Float32Array {
  const { w, h } = p
  const moved = shiftField(roughened, w, h, p.dx, p.dy)
  const out = new Float32Array(w * h)
  const split = groundLum ? p.split : undefined
  const unit = split?.light instanceof Uint8ClampedArray ? 255 : 1
  for (let i = 0; i < out.length; i++) out[i] = holeAt(moved[i], groundLum, split, unit, i)
  return out
}
