/**
 * Halftone screening — the single most load-bearing part of the riso look.
 *
 * A screen converts a continuous *tone* field (how dark this pixel wants to be,
 * 0..1) into a binary-ish *coverage* field (is there ink here, 0..1) by growing
 * a dot inside a rotated lattice cell. Each ink gets its own angle; the
 * interference between two differently-angled screens is the rosette your eye
 * reads as "printed", and it is why this cannot be faked with a noise overlay.
 *
 * Ported in spirit from p5.riso's `halftoneImage()` (Lavigne & Brain), but
 * reimplemented as a single pass over a typed array. The original rotates a
 * 2x-oversized graphics buffer, draws shapes into a second 2x buffer, then
 * rotates back — at our export size that is two ~51 MB canvases, which is the
 * iOS memory path the playbook's §4.2 exists to avoid. Rotating the *sample
 * coordinate* instead of the *image* gets the same result with one allocation.
 */

export interface ScreenOptions {
  /** Lattice pitch in output pixels. Larger = coarser, more visible dots. */
  pitch: number
  /** Screen angle in degrees. */
  angle: number
  /** Dot edge softness in pixels. 0 is aliased; ~0.7 reads like real ink. */
  softness: number
  /** Plate origin offset in pixels — see `misregister` in render.ts. The
   *  lattice travels with the plate, so shifting a plate shifts its dots. */
  originX: number
  originY: number
}

/** Smooth 1→0 ramp as `d` crosses `edge`, over `width` pixels. */
function falloff(d: number, edge: number, width: number): number {
  if (width <= 0) return d <= edge ? 1 : 0
  const t = (edge + width - d) / (2 * width)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/** A coverage field: 0..1 as floats, or 0..255 in bytes (what the press keeps:
 *  a quarter of the memory, and within half a level of the float). */
export type CoverageField = Float32Array | Uint8ClampedArray

/**
 * Screen a tone field into a coverage field with round dots.
 *
 * The dot's radius grows with sqrt(tone), so its area — and so perceived
 * darkness — tracks tone linearly. 0.72·pitch at tone 1 overshoots the 0.707
 * needed to close the corners, so shadows black out just before full tone.
 * That saturation *is* dot gain, and leaving it in is what keeps this from
 * looking like inkjet.
 *
 * @param tone  w*h values in [0,1] — 0 is bare paper, 1 is solid ink.
 * @param out   where to write: a new float field in [0,1] by default, or a
 *              byte field, written 0..255 (rounded).
 * @returns     the w*h coverage field.
 */
export function screenField<T extends CoverageField = Float32Array>(
  tone: Float32Array,
  w: number,
  h: number,
  opts: ScreenOptions,
  out: T = new Float32Array(w * h) as T,
): T {
  const { angle, softness, originX, originY } = opts
  const pitch = Math.max(1.2, opts.pitch)
  const unit = out instanceof Uint8ClampedArray ? 255 : 1

  const a = (angle * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const inv = 1 / pitch

  for (let y = 0; y < h; y++) {
    const py = y - originY
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const t = tone[i]
      if (t <= 0) continue
      if (t >= 1) {
        out[i] = unit
        continue
      }

      // Rotate the sample point into plate space rather than rotating pixels.
      const px = x - originX
      const rx = px * cos - py * sin
      const ry = px * sin + py * cos

      // Offset to the nearest lattice centre.
      const dx = (rx * inv - Math.round(rx * inv)) * pitch
      const dy = (ry * inv - Math.round(ry * inv)) * pitch

      const d = Math.sqrt(dx * dx + dy * dy)
      const r = Math.sqrt(t) * pitch * 0.72

      const cov = falloff(d, r, softness)
      out[i] = (cov > 1 ? 1 : cov) * unit
    }
  }

  return out
}

/**
 * Classic separation angles, in the order plates are usually pulled. Keeping
 * adjacent inks 30° apart is what avoids a moiré collision; yellow sits at 15°
 * from its neighbours because it is light enough not to beat against them.
 */
export const DEFAULT_ANGLES = [45, 75, 15, 0] as const

/** Screen angle for the nth plate, wrapping past four inks. */
export function defaultAngle(index: number): number {
  return DEFAULT_ANGLES[index % DEFAULT_ANGLES.length]
}
