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

export type ScreenShape = 'circle' | 'square' | 'line' | 'ellipse' | 'cross' | 'diamond'

export interface ScreenOptions {
  shape: ScreenShape
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

/**
 * Distance metric per shape, and the radius that a given tone should grow to.
 * Radius scales with sqrt(tone) for area-proportional shapes so that perceived
 * darkness tracks tone linearly; line/cross scale linearly because they grow in
 * one dimension only.
 */
function dotRadius(shape: ScreenShape, tone: number, pitch: number): number {
  switch (shape) {
    case 'circle':
    case 'ellipse':
      // 0.72·pitch at tone 1 overshoots the 0.707 needed to close the corners,
      // so shadows black out just before full tone. That saturation *is* dot
      // gain, and leaving it in is what keeps this from looking like inkjet.
      return Math.sqrt(tone) * pitch * 0.72
    case 'square':
    case 'diamond':
      return Math.sqrt(tone) * pitch * 0.5
    case 'line':
    case 'cross':
      return tone * pitch * 0.5
  }
}

function dotDistance(shape: ScreenShape, dx: number, dy: number): number {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  switch (shape) {
    case 'circle':
      return Math.sqrt(dx * dx + dy * dy)
    case 'ellipse':
      // Elongated dot — the classic "chain" screen at midtones.
      return Math.sqrt((dx / 0.72) * (dx / 0.72) + dy * dy)
    case 'square':
      return Math.max(ax, ay)
    case 'diamond':
      return ax + ay
    case 'line':
      return ay
    case 'cross':
      return Math.min(ax, ay)
  }
}

/**
 * Screen a tone field into a coverage field.
 *
 * @param tone  w*h values in [0,1] — 0 is bare paper, 1 is solid ink.
 * @returns     a new w*h coverage field in [0,1].
 */
export function screenField(
  tone: Float32Array,
  w: number,
  h: number,
  opts: ScreenOptions,
): Float32Array {
  const { shape, angle, softness, originX, originY } = opts
  const pitch = Math.max(1.2, opts.pitch)
  const out = new Float32Array(w * h)

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
        out[i] = 1
        continue
      }

      // Rotate the sample point into plate space rather than rotating pixels.
      const px = x - originX
      const rx = px * cos - py * sin
      const ry = px * sin + py * cos

      // Offset to the nearest lattice centre.
      const dx = (rx * inv - Math.round(rx * inv)) * pitch
      const dy = (ry * inv - Math.round(ry * inv)) * pitch

      const d = dotDistance(shape, dx, dy)
      const r = dotRadius(shape, t, pitch)

      let cov = falloff(d, r, softness)

      if (shape === 'cross') {
        // A cross is the union of a horizontal and a vertical bar, so the
        // single min() distance above needs the second arm added back.
        const d2 = Math.max(Math.abs(dx), Math.abs(dy))
        cov = Math.max(cov, falloff(d2, r, softness) * (d2 <= pitch * 0.5 ? 1 : 0))
      }

      out[i] = cov > 1 ? 1 : cov
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
