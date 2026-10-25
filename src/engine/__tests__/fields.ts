/**
 * Deterministic synthetic inputs for the press's pure tests: a glyph-like
 * tone and a photo ground, made in plain JavaScript (vitest runs in node,
 * which has no 2D context).
 *
 *  - `makeGlyphTone`: what a plate's tone looks like coming off the glyph
 *    canvas: alpha bytes (0..255) of lines of "letters" (rings, stems, bars)
 *    with a one-pixel antialiased edge, sized by the font size, so the tear,
 *    the shift and the screen have real edges, counters and strokes to work
 *    on. With `backing`, the solid blocks behind those lines instead.
 *  - `makeGround`: an RGBA photo at sheet size: a dark-to-light ramp (so a
 *    second ink switches both ways), a zone plate whose rings run to the pixel
 *    pitch, a little seeded grain, and a transparent hole with a soft rim
 *    (a PNG's own transparency, which reads as paper).
 *
 * Same inputs, same bytes, every run: a seeded generator and plain
 * arithmetic, with the same Math functions the press itself calls.
 */

import { mulberry32 } from '../rng.ts'

export interface GlyphToneOptions {
  /** Degrees, clockwise, about the block's centre (a plate's rotation). */
  rotation?: number
  /** The blocks behind each line (a backing) instead of the letters. */
  backing?: boolean
}

/** A shape, in the block's own (unrotated) coordinates. */
type Shape =
  | { kind: 'ring'; cx: number; cy: number; r: number; t: number }
  | { kind: 'bar'; x0: number; y0: number; x1: number; y1: number; t: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }

/** Distance from (px, py) to the segment (x0, y0)-(x1, y1). */
function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const vx = x1 - x0
  const vy = y1 - y0
  const len2 = vx * vx + vy * vy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / len2)) : 0
  const dx = px - (x0 + t * vx)
  const dy = py - (y0 + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

/** Ink coverage of one shape at a point in block coordinates, 0..1, with a
 *  one-pixel ramp across the edge. */
function coverage(s: Shape, x: number, y: number): number {
  let inside: number
  if (s.kind === 'ring') {
    const d = Math.sqrt((x - s.cx) * (x - s.cx) + (y - s.cy) * (y - s.cy))
    inside = s.t / 2 - Math.abs(d - s.r)
  } else if (s.kind === 'bar') {
    inside = s.t / 2 - segmentDistance(x, y, s.x0, s.y0, s.x1, s.y1)
  } else {
    inside = Math.min(x - s.x0, s.x1 - x, y - s.y0, s.y1 - y)
  }
  const c = inside + 0.5
  return c <= 0 ? 0 : c >= 1 ? 1 : c
}

/**
 * A plate's tone: lines of letter-like shapes at `fontSize` px, placed by
 * the seed, as the alpha bytes a glyph canvas hands back.
 */
export function makeGlyphTone(w: number, h: number, seed: number, fontSize: number, opts: GlyphToneOptions = {}): Uint8Array {
  const rand = mulberry32(seed)
  const em = Math.max(2, fontSize)
  const stroke = Math.max(1.2, em * 0.16)
  const advance = em * 0.62
  const lead = em * 1.05
  const lines = 1 + Math.floor(rand() * 3)
  const perLine = Math.max(1, Math.min(14, Math.floor((w * 0.8) / advance)))

  // The block, centred on a seeded point in the sheet's middle half.
  const blockW = perLine * advance
  const blockH = lines * lead
  const cx = w * (0.3 + 0.4 * rand())
  const cy = h * (0.3 + 0.4 * rand())
  const left = cx - blockW / 2
  const top = cy - blockH / 2

  const shapes: Shape[] = []
  for (let l = 0; l < lines; l++) {
    const base = top + (l + 1) * lead - em * 0.2
    const capTop = base - em * 0.72
    const count = Math.max(1, perLine - Math.floor(rand() * 3))
    if (opts.backing) {
      const pad = em * 0.12
      shapes.push({ kind: 'box', x0: left - pad, y0: capTop - pad, x1: left + count * advance + pad, y1: base + pad })
      continue
    }
    for (let g = 0; g < count; g++) {
      const gx = left + g * advance + advance * 0.5
      const kind = Math.floor(rand() * 4)
      if (kind === 0) {
        shapes.push({ kind: 'ring', cx: gx, cy: (base + capTop) / 2, r: em * 0.3, t: stroke })
      } else if (kind === 1) {
        shapes.push({ kind: 'bar', x0: gx, y0: capTop, x1: gx, y1: base, t: stroke })
      } else if (kind === 2) {
        shapes.push({ kind: 'bar', x0: gx - em * 0.22, y0: capTop, x1: gx - em * 0.22, y1: base, t: stroke })
        shapes.push({ kind: 'bar', x0: gx - em * 0.22, y0: base, x1: gx + em * 0.22, y1: base, t: stroke })
      } else {
        shapes.push({ kind: 'bar', x0: gx - em * 0.25, y0: base, x1: gx + em * 0.05, y1: capTop, t: stroke })
        shapes.push({ kind: 'bar', x0: gx + em * 0.05, y0: capTop, x1: gx + em * 0.25, y1: base, t: stroke })
      }
    }
  }

  // Rotated about the block's centre: each sheet pixel is turned back into
  // block coordinates (a clockwise turn of the drawing).
  const a = ((opts.rotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const reach = Math.max(blockW, blockH) * 0.75 + em
  const cov = new Float32Array(w * h)
  const x0 = Math.max(0, Math.floor(cx - reach))
  const x1 = Math.min(w, Math.ceil(cx + reach))
  const y0 = Math.max(0, Math.floor(cy - reach))
  const y1 = Math.min(h, Math.ceil(cy + reach))
  for (const s of shapes) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const bx = cx + dx * cos + dy * sin
        const by = cy - dx * sin + dy * cos
        const c = coverage(s, bx, by)
        const i = y * w + x
        if (c > cov[i]) cov[i] = c
      }
    }
  }
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(cov[i] * 255)
  return out
}

/**
 * A photo ground at sheet size, RGBA: ramp, zone plate, grain, and a
 * transparent hole with a soft rim.
 */
export function makeGround(w: number, h: number, seed: number): Uint8ClampedArray {
  const rand = mulberry32(seed)
  const out = new Uint8ClampedArray(w * h * 4)
  const zx = w * (0.4 + 0.2 * rand())
  const zy = h * (0.4 + 0.2 * rand())
  const zr = 0.3 * Math.min(w, h)
  const k = Math.PI / (2 * Math.max(w, h))
  const hx = w * (0.15 + 0.2 * rand())
  const hy = h * (0.6 + 0.2 * rand())
  const hr = 0.12 * Math.min(w, h)
  for (let y = 0; y < h; y++) {
    const v = y / Math.max(1, h - 1)
    for (let x = 0; x < w; x++) {
      const u = x / Math.max(1, w - 1)
      const ramp = 0.06 + 0.88 * u
      const r2 = (x - zx) * (x - zx) + (y - zy) * (y - zy)
      const zone = r2 < zr * zr ? 0.5 + 0.5 * Math.cos(k * r2) : 0.5
      const grain = (rand() - 0.5) * 0.03
      const l = Math.min(1, Math.max(0, ramp + (zone - 0.5) * 0.5 + grain))
      const o = (y * w + x) * 4
      out[o] = 255 * Math.min(1, l * (0.9 + 0.2 * v))
      out[o + 1] = 255 * l
      out[o + 2] = 255 * Math.min(1, l * (1.1 - 0.2 * v))
      const d = Math.sqrt((x - hx) * (x - hx) + (y - hy) * (y - hy))
      const alpha = d <= hr ? 0 : d >= hr + 2 ? 1 : (d - hr) / 2
      out[o + 3] = 255 * alpha
    }
  }
  return out
}
