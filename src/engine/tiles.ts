/**
 * The tile grid an export draws on, and the ring of tile rows it reads from.
 *
 * Two things in a print come off a canvas: the glyphs (and the backing blocks
 * behind them) and a photo that is not at its own pixels (resampled). Neither
 * is the same bytes when the canvas is moved: a glyph rasterised into a band
 * of rows differs from the same glyph on one sheet-sized canvas at its
 * antialiased edge, because the rasteriser flattens a curve differently under
 * another clip. So they are never drawn per band. They are drawn on a FIXED
 * grid of tiles, each a canvas of its own whose pixels depend on the tile's
 * place on the sheet and nothing else, and every band, of any height, takes
 * its rows from the tiles. A tile row is drawn once and held in a small ring
 * (`TileRowCache`) while the bands that read it are pressed.
 *
 * A sheet of up to TILE_PIXELS and at most TILE_EDGE wide is ONE tile, the
 * sheet itself: drawn as it always was.
 *
 * Pure: no canvas here. The loaders that draw a tile row are handed in.
 *
 * A broken invariant here is a bug, thrown as a plain Error: never a
 * RangeError, which Save reads as memory running out (export.ts `savePrint`)
 * and would answer with a smaller copy.
 */

import { TILE_EDGE, TILE_PIXELS } from './limits.ts'

export interface TileBudget {
  /** The widest a tile may be. */
  edge: number
  /** The most pixels a tile may hold. */
  pixels: number
}

export const TILE_BUDGET: TileBudget = { edge: TILE_EDGE, pixels: TILE_PIXELS }

export interface TileGrid {
  /** The sheet. */
  w: number
  h: number
  /** A whole tile's size; the last column and the last row are clipped to
   *  the sheet. */
  tileW: number
  tileH: number
  cols: number
  rows: number
}

/** One tile: column `cx` of tile row `ty`, at (x0, y0) on the sheet, its
 *  size clipped to the sheet. */
export interface Tile {
  cx: number
  ty: number
  x0: number
  y0: number
  w: number
  h: number
}

/**
 * The grid: tiles as wide as the sheet up to `budget.edge`, and as tall as
 * `budget.pixels` allows at that width. Tile (cx, ty) covers columns
 * [cx tileW, min(w, (cx + 1) tileW)) and rows [ty tileH, min(h, (ty + 1) tileH)).
 */
export function tileGrid(w: number, h: number, budget: TileBudget = TILE_BUDGET): TileGrid {
  if (!(w >= 1 && h >= 1)) throw new Error(`tileGrid: not a sheet: ${w}x${h}`)
  const tileW = Math.max(1, Math.min(w, Math.floor(budget.edge)))
  const tileH = Math.max(1, Math.floor(budget.pixels / tileW))
  return { w, h, tileW, tileH, cols: Math.ceil(w / tileW), rows: Math.ceil(h / tileH) }
}

/** Tile (cx, ty) of the grid. */
export function tileAt(grid: TileGrid, cx: number, ty: number): Tile {
  const x0 = cx * grid.tileW
  const y0 = ty * grid.tileH
  return { cx, ty, x0, y0, w: Math.min(grid.tileW, grid.w - x0), h: Math.min(grid.tileH, grid.h - y0) }
}

/** The tile rows that rows [a, b) of the sheet lie in: [first, last]. */
export function tileRowsOf(grid: TileGrid, a: number, b: number): [number, number] {
  return [Math.floor(a / grid.tileH), Math.floor((b - 1) / grid.tileH)]
}

/** How many tile rows a ring must hold so that a window of `rows` rows of
 *  the sheet is always in it at once: the tile rows such a window can span,
 *  never more than the grid has. */
export function ringRows(grid: TileGrid, rows: number): number {
  return Math.max(1, Math.min(grid.rows, Math.ceil(Math.max(1, rows) / grid.tileH) + 1))
}

/**
 * A fixed ring of tile rows: `capacity` slots made once, at construction,
 * each filled by `load(ty, slot)` when a row not held is asked for, the
 * least recently used one given up for it. Every slot holds a whole tile row
 * of the sheet (all its columns), so nothing is allocated after
 * construction, however many bands read it.
 *
 * A row given up and asked for again is drawn again (`loads` counts the
 * draws): the same bytes, since a tile depends on its place and nothing
 * else. So a capacity is a speed knob; the ring's correctness does not rest
 * on it.
 */
export class TileRowCache<T> {
  private readonly slots: { ty: number; used: number; slot: T }[]
  private clock = 0
  /** Tile rows drawn so far. */
  loads = 0

  constructor(
    capacity: number,
    make: () => T,
    private readonly load: (ty: number, slot: T) => void,
  ) {
    if (!(capacity >= 1)) throw new Error(`TileRowCache: capacity ${capacity}`)
    this.slots = Array.from({ length: capacity }, () => ({ ty: -1, used: 0, slot: make() }))
  }

  get capacity(): number {
    return this.slots.length
  }

  /** Tile row `ty`, drawn if it is not held. */
  row(ty: number): T {
    let pick = this.slots[0]
    for (const s of this.slots) {
      if (s.ty === ty) {
        s.used = ++this.clock
        return s.slot
      }
      if (s.used < pick.used) pick = s
    }
    // Marked empty while it is drawn, so a load that throws leaves no row
    // that claims to be held.
    pick.ty = -1
    pick.used = 0
    this.load(ty, pick.slot)
    this.loads++
    pick.ty = ty
    pick.used = ++this.clock
    return pick.slot
  }
}

/**
 * Rows [a, b) of a sheet held as a ring of tile rows: a view of the one tile
 * row they lie in, or, when they cross into the next, copied into `span`
 * (each part straight from its tile row, so the rows need not all be held
 * at once). `channels` values a pixel: 1 for a glyph's alpha, 4 for RGBA.
 */
export function rowsFromTiles<T extends Uint8Array | Uint8ClampedArray>(
  grid: TileGrid,
  cache: TileRowCache<T>,
  channels: number,
  span: T,
  a: number,
  b: number,
): T {
  if (a < 0 || b > grid.h || b < a) throw new Error(`rowsFromTiles: rows [${a}, ${b}) of ${grid.h}`)
  const stride = grid.w * channels
  if (b === a) return span.subarray(0, 0) as T
  const [first, last] = tileRowsOf(grid, a, b)
  if (first === last) {
    const y0 = first * grid.tileH
    return cache.row(first).subarray((a - y0) * stride, (b - y0) * stride) as T
  }
  if (span.length < (b - a) * stride) throw new Error(`rowsFromTiles: rows [${a}, ${b}) do not fit the span of ${span.length / stride}`)
  for (let ty = first; ty <= last; ty++) {
    const y0 = ty * grid.tileH
    const from = Math.max(a, y0)
    const to = Math.min(b, y0 + grid.tileH)
    span.set(cache.row(ty).subarray((from - y0) * stride, (to - y0) * stride), (from - a) * stride)
  }
  return span.subarray(0, (b - a) * stride) as T
}
