/**
 * Grain — the press's second screen, beside the halftone.
 *
 * Where a screen clusters ink into regular dots, error diffusion scatters it.
 * Riso drivers screen with one or the other, so one diffusion earns its place
 * as the second choice: Atkinson, which diffuses only 6/8 of the error and so
 * blows out highlights and crushes shadows — the crunchy duplicator look. The
 * threshold is fixed at the neutral 0.5.
 *
 * Ported in spirit from p5.riso's `ditherImage()` (Lavigne & Brain).
 */

/** Atkinson's kernel as [dx, dy, weight]: six neighbours, an eighth each. */
const ATKINSON: readonly (readonly [number, number, number])[] = [
  [1, 0, 1 / 8], [2, 0, 1 / 8],
  [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
  [0, 2, 1 / 8],
]

/** The cut point: 0.5 is neutral. */
const THRESHOLD = 0.5

export interface DitherOptions {
  /**
   * Size of one grain cell in output pixels, fraction and all.
   *
   * At 1 the pattern is one pixel per cell, which at export resolution is far
   * too fine to see and reads as flat tone; the chunky duplicator look is a
   * grain several pixels across. Implemented by dithering a reduced grid and
   * expanding the result.
   *
   * Not rounded. The cell rides the render height (a third of the screen size
   * times height / reference), and a cell rounded to whole pixels is a
   * different grain on every sheet: 1.68 px rounds to 2 (+19%). A fractional
   * cell maps pixel x to grid column floor(x / cell), so some cells are a
   * pixel wider than others and the grain's average size is exact. A whole
   * number gives exactly the grid it always did.
   */
  scale?: number
}

/**
 * Grain a tone field into a coverage field: one `GrainStream` drained over the
 * whole sheet, so a sheet grained at once and one grained in bands run the
 * same code and print the same bytes.
 *
 * @param out where to write: a new float field of 0s and 1s by default, or a
 *            byte field of 0s and 255s.
 * @returns the w*h field.
 */
export function ditherField<T extends Float32Array | Uint8ClampedArray = Float32Array>(
  tone: Float32Array,
  w: number,
  h: number,
  opts: DitherOptions = {},
  out: T = new Float32Array(w * h) as T,
): T {
  new GrainStream(w, h, opts.scale ?? 1).run(tone, 0, 0, h, out)
  return out
}

/**
 * Where each grid cell starts along an axis of `n` pixels: cell k holds the
 * pixels with floor(x / cell) === k. One past the last cell is `n`, so cell k
 * runs from starts[k] up to (not including) starts[k + 1]. Every cell holds at
 * least one pixel, since cell >= 1.
 */
export function cellStarts(n: number, cell: number): Int32Array {
  const count = Math.floor((n - 1) / cell) + 1
  const starts = new Int32Array(count + 1)
  let k = 0
  for (let x = 0; x < n; x++) {
    const c = Math.floor(x / cell)
    if (c >= k) starts[k++] = x
  }
  starts[count] = n
  return starts
}

/** The cell row (index into `rows`, cellStarts' output) holding pixel row y. */
export function cellRowOf(rows: Int32Array, y: number): number {
  let lo = 0
  let hi = rows.length - 2
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (rows[m] <= y) lo = m
    else hi = m - 1
  }
  return lo
}

/** How many cell rows ahead of the one being grained must hold their tone:
 *  Atkinson's kernel reaches two rows down. */
const LOOK_AHEAD = 2

/**
 * The tone rows [a, b) a grain stream reads to deliver the sheet's rows
 * [y0, y1), given that the band before ended at y0 (bands run top to bottom,
 * each starting where the last ended): the cell rows from the first one not
 * yet loaded through two past the band's last cell row, as pixel rows. Empty
 * (a === b) when everything the band needs was loaded for an earlier band.
 * A function of the grid and the band only, so a press can size its windows
 * before it grains anything.
 */
export function grainRows(rows: Int32Array, y0: number, y1: number): { a: number; b: number } {
  const last = rows.length - 2
  const loaded = y0 <= 0 ? -1 : Math.min(last, cellRowOf(rows, y0 - 1) + LOOK_AHEAD)
  const upTo = Math.min(last, cellRowOf(rows, y1 - 1) + LOOK_AHEAD)
  if (upTo <= loaded) return { a: y0, b: y0 }
  return { a: rows[loaded + 1], b: rows[upTo + 1] }
}

/**
 * Atkinson grain, one band of rows at a time, with exactly the bytes graining
 * the whole sheet at once gives.
 *
 * Error diffusion is the one stage of the press whose output at a pixel
 * depends on everything above it, so a band cannot be grained on its own. It
 * does not need the rows above, though, only what they left behind: the error
 * they pushed into the next two cell rows. So the stream keeps those three
 * cell rows (a ring of float32 rows, the one being grained and the two the
 * kernel reaches) and the bits of the last cell row it grained, and a band
 * picks up where the last one stopped.
 *
 * Each cell row's tone is loaded (its cells' means: the reduction graining
 * always did) the moment it first comes within the kernel's reach, never
 * earlier and never twice, which is why a band reads the tone two cell rows
 * past its own end (`grainRows`). Loading before any error lands on a row,
 * and adding the error in the same order, is what makes every float32
 * addition the same as graining the whole field does.
 *
 * Bands must run top to bottom, each starting where the last ended.
 */
export class GrainStream {
  readonly cell: number
  /** Where each cell column and cell row starts (cellStarts). */
  readonly cols: Int32Array
  readonly rows: Int32Array
  private readonly sw: number
  private readonly sh: number
  /** Cell rows j, j + 1 and j + 2 at ring[k % 3]. */
  private readonly ring: [Float32Array, Float32Array, Float32Array]
  /** The bits (0 or 1) of the last cell row grained, `next - 1`. */
  private readonly last: Uint8Array
  /** The first cell row not yet grained. */
  private next = 0
  /** The last cell row whose tone is loaded. */
  private loaded = -1
  /** Where the last band ended: the next must start there. */
  private at = 0

  constructor(
    private readonly w: number,
    h: number,
    cell: number,
  ) {
    this.cell = Math.max(1, cell)
    this.cols = cellStarts(w, this.cell)
    this.rows = cellStarts(h, this.cell)
    this.sw = this.cols.length - 1
    this.sh = this.rows.length - 1
    this.ring = [new Float32Array(this.sw), new Float32Array(this.sw), new Float32Array(this.sw)]
    this.last = new Uint8Array(this.sw)
  }

  /** The tone rows this stream reads for the band [y0, y1) (`grainRows`). */
  need(y0: number, y1: number): { a: number; b: number } {
    return grainRows(this.rows, y0, y1)
  }

  /**
   * Grain the sheet's rows [y0, y1) into `out` (row y at out[(y - y0) * w]),
   * 0 or `unit` (255 for bytes, 1 for floats; by default from the array).
   * `tone` holds the sheet's rows from `toneRow0` on and must cover
   * `need(y0, y1)`; no other row of it is read.
   */
  run(
    tone: Float32Array,
    toneRow0: number,
    y0: number,
    y1: number,
    out: Float32Array | Uint8ClampedArray,
    unit: number = out instanceof Uint8ClampedArray ? 255 : 1,
  ): void {
    if (y0 !== this.at || y1 <= y0) throw new Error(`GrainStream: band [${y0}, ${y1}) does not follow row ${this.at}`)
    this.at = y1
    const { rows, sh, ring, last } = this
    const j0 = cellRowOf(rows, y0)
    const j1 = cellRowOf(rows, y1 - 1)
    // A cell row the band before began: its bits are already made.
    if (j0 < this.next) this.paint(j0, y0, y1, out, unit)
    for (let j = this.next; j <= j1; j++) {
      const reach = Math.min(sh - 1, j + LOOK_AHEAD)
      for (let k = this.loaded + 1; k <= reach; k++) this.load(k, tone, toneRow0)
      this.loaded = Math.max(this.loaded, reach)
      const cur = ring[j % 3]
      const r1 = ring[(j + 1) % 3]
      const r2 = ring[(j + 2) % 3]
      this.diffuse(j, cur, r1, r2, last)
      this.next = j + 1
      this.paint(j, y0, y1, out, unit)
    }
  }

  /** Cell row k's tone: each cell the mean of its pixels, summed row by row. */
  private load(k: number, tone: Float32Array, toneRow0: number): void {
    const { w, cols, rows, sw } = this
    const r = this.ring[k % 3]
    for (let x = 0; x < sw; x++) {
      let sum = 0
      let n = 0
      for (let sy = rows[k]; sy < rows[k + 1]; sy++) {
        const row = (sy - toneRow0) * w
        for (let sx = cols[x]; sx < cols[x + 1]; sx++) {
          sum += tone[row + sx]
          n++
        }
      }
      r[x] = n > 0 ? sum / n : 0
    }
  }

  /** Grain cell row j in raster order: its bits into `bits`, its error into
   *  the row's remaining cells and the two rows below (Atkinson). */
  private diffuse(j: number, cur: Float32Array, r1: Float32Array, r2: Float32Array, bits: Uint8Array): void {
    const { sw, sh } = this
    for (let x = 0; x < sw; x++) {
      const old = cur[x]
      const next = old >= THRESHOLD ? 1 : 0
      bits[x] = next
      const err = old - next
      if (err === 0) continue
      for (const [kx, ky, weight] of ATKINSON) {
        const nx = x + kx
        if (nx < 0 || nx >= sw || j + ky >= sh) continue
        const row = ky === 0 ? cur : ky === 1 ? r1 : r2
        row[nx] += err * weight
      }
    }
  }

  /** Cell row j's bits, expanded to its pixels, for the rows of [y0, y1) it
   *  covers. */
  private paint(j: number, y0: number, y1: number, out: Float32Array | Uint8ClampedArray, unit: number): void {
    const { w, cols, rows, sw, last } = this
    const top = Math.max(rows[j], y0)
    const bottom = Math.min(rows[j + 1], y1)
    for (let y = top; y < bottom; y++) {
      const o = (y - y0) * w
      for (let x = 0; x < sw; x++) {
        const v = last[x] * unit
        for (let sx = cols[x]; sx < cols[x + 1]; sx++) out[o + sx] = v
      }
    }
  }
}
