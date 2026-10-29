/**
 * The two block photos the parity references were captured on
 * (scripts/parity-borders/README), generated, never committed: capture.mjs
 * hands them to Border Studio, and scripts/parity-borders.mjs to Print
 * Machine's engine, so both apps frame the same pixels.
 *
 * Flat blocks of known population (a 3x2 grid of six saturated colours of
 * unequal area), one smooth gradient band along the bottom, and a flat
 * square of side one sixth of the short side at each corner, so every corner
 * patch is flat colour in both apps even where one of them resamples.
 */

/** Six saturated colours, in the grid's order (largest block first). Each
 *  photo puts a different one in the largest block, and that one is the most
 *  "photogenic" by Border Studio's score (area, chroma, mid lightness) by a
 *  clear margin, so the two photos key two different heroes. */
const SKY = [40, 150, 200]
const RED = [210, 70, 60]
const YELLOW = [240, 190, 40]
const BLUE = [60, 80, 190]
const PURPLE = [150, 60, 170]
const GREEN = [90, 170, 70]
/** The flat square at each corner. */
export const CORNER = [244, 241, 234]
const RAMP = [
  [30, 45, 110],
  [235, 140, 70],
]

/**
 * A w x h photo: the bottom `c` rows a horizontal ramp (c = one sixth of the
 * short side), above it a 3x2 grid (columns 55%, 27%, 18% of the width, rows
 * 65%, 35% of the grid's height) of `blocks`, and a c x c CORNER square at each
 * corner. Opaque. RGBA, and `corner`, c.
 */
export function blockPhoto(w, h, blocks) {
  const c = Math.round(Math.min(w, h) / 6)
  const gridH = h - c
  const cols = [0, Math.round(w * 0.55), Math.round(w * 0.82), w]
  const rows = [0, Math.round(gridH * 0.65), gridH]
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rgb
      if ((x < c || x >= w - c) && (y < c || y >= h - c)) rgb = CORNER
      else if (y >= gridH) {
        const t = x / (w - 1)
        rgb = RAMP[0].map((v, i) => Math.round(v + (RAMP[1][i] - v) * t))
      } else {
        const col = x < cols[1] ? 0 : x < cols[2] ? 1 : 2
        const row = y < rows[1] ? 0 : 1
        rgb = blocks[row * 3 + col]
      }
      const o = (y * w + x) * 4
      px[o] = rgb[0]
      px[o + 1] = rgb[1]
      px[o + 2] = rgb[2]
      px[o + 3] = 255
    }
  }
  return { px, corner: c }
}

export const PHOTOS = [
  { id: 'block-land', width: 1800, height: 1200, blocks: [SKY, RED, YELLOW, BLUE, PURPLE, GREEN] },
  { id: 'block-port', width: 1200, height: 1800, blocks: [RED, SKY, GREEN, PURPLE, YELLOW, BLUE] },
]
