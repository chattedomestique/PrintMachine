/**
 * Separable box blur over a scalar field.
 *
 * Three passes approximate a Gaussian closely enough for anything here, and a
 * sliding-window sum makes each pass O(n) regardless of radius.
 *
 * The one thing to get right — and the playbook flags this as a bug that has
 * already shipped once in this family of apps (§5.6) — is seeding the running
 * sum. The window for x = 0 covers source indices [-r, r], which is r+1 real
 * samples plus r clamped copies of index 0. Seeding from a negative index, or
 * priming the sum by walking from -r, double-counts the edge sample and leaves
 * a bright rim. Seed it explicitly instead, then slide.
 */

/** One horizontal box pass with radius r, edges clamped. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    const row = y * w

    // Seed: the window at x=0 is (r+1) copies-or-samples from 0..r plus r
    // clamped repeats of index 0. Counted exactly once each.
    let sum = src[row] * (r + 1)
    for (let i = 1; i <= r; i++) sum += src[row + Math.min(i, w - 1)]

    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * norm
      const add = src[row + Math.min(x + r + 1, w - 1)]
      const drop = src[row + Math.max(x - r, 0)]
      sum += add - drop
    }
  }
}

/**
 * One vertical box pass. Same seeding rule, striding by w.
 *
 * Walked row by row with a running sum per column, not column by column: the
 * field is stored by rows, and a column walk touches one value per row — a
 * cache miss each on a sheet thousands of pixels wide (it was most of the
 * press's time on a 16 MP export). Each column's sum takes exactly the same
 * additions in the same order (held in float64, as the single sum was), so
 * the result is the same to the bit.
 */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, sums: Float64Array): void {
  const norm = 1 / (2 * r + 1)
  for (let x = 0; x < w; x++) sums[x] = src[x] * (r + 1)
  for (let i = 1; i <= r; i++) {
    const row = Math.min(i, h - 1) * w
    for (let x = 0; x < w; x++) sums[x] += src[row + x]
  }
  for (let y = 0; y < h; y++) {
    const out = y * w
    const add = Math.min(y + r + 1, h - 1) * w
    const drop = Math.max(y - r, 0) * w
    for (let x = 0; x < w; x++) {
      dst[out + x] = sums[x] * norm
      sums[x] += src[add + x] - src[drop + x]
    }
  }
}

/** 1 / the number of samples in each window of a pass shrunk at the edges:
 *  min(i + r, n - 1) - max(i - r, 0) + 1 for i in [0, n). */
function shrunkCounts(n: number, r: number): Float64Array {
  const inv = new Float64Array(n)
  for (let i = 0; i < n; i++) inv[i] = 1 / (Math.min(i + r, n - 1) - Math.max(i - r, 0) + 1)
  return inv
}

/**
 * One horizontal box pass with radius r, its window SHRUNK at the edges:
 * near an edge it averages only the samples there are, dividing by their
 * count (min(x + r, w - 1) - max(x - r, 0) + 1), so an edge is not pulled
 * toward a repeated edge sample. Border Studio's frosted pass, the sum seeded
 * from samples 0..min(r, w - 1) only.
 */
function boxHShrink(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, inv: Float64Array): void {
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let k = 0; k <= Math.min(r, w - 1); k++) sum += src[row + k]
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * inv[x]
      if (x - r >= 0) sum -= src[row + x - r]
      if (x + r + 1 < w) sum += src[row + x + r + 1]
    }
  }
}

/** One vertical box pass, its window shrunk at the edges (boxHShrink), row
 *  by row with a running sum per column, as boxV walks. */
function boxVShrink(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, sums: Float64Array, inv: Float64Array): void {
  sums.fill(0, 0, w)
  for (let k = 0; k <= Math.min(r, h - 1); k++) {
    const row = k * w
    for (let x = 0; x < w; x++) sums[x] += src[row + x]
  }
  for (let y = 0; y < h; y++) {
    const out = y * w
    const n = inv[y]
    for (let x = 0; x < w; x++) dst[out + x] = sums[x] * n
    if (y - r >= 0) {
      const drop = (y - r) * w
      for (let x = 0; x < w; x++) sums[x] -= src[drop + x]
    }
    if (y + r + 1 < h) {
      const add = (y + r + 1) * w
      for (let x = 0; x < w; x++) sums[x] += src[add + x]
    }
  }
}

/**
 * What a box pass does at the edge of the plane:
 *  - `clamp`: the window reaches past the edge and repeats the edge sample
 *    (every plate's blur: a tear, a bleed, the luminance);
 *  - `shrink`: the window holds only the samples there are and is divided
 *    by their count (Frosted's field, as Border Studio blurs it).
 */
export type BoxEdge = 'clamp' | 'shrink'

/**
 * Three box passes (each horizontal, then vertical) at the integer radius
 * `r`, on `plane` in place, with `scratch` (the same size) as the other half
 * of the ping-pong. `clamp` is the plates' blur exactly (what
 * `blurInPlace` runs).
 */
export function boxBlurPlane(plane: Float32Array, scratch: Float32Array, w: number, h: number, r: number, edge: BoxEdge = 'clamp'): void {
  const sums = new Float64Array(w)
  const across = edge === 'shrink' ? shrunkCounts(w, r) : null
  const down = edge === 'shrink' ? shrunkCounts(h, r) : null
  for (let pass = 0; pass < 3; pass++) {
    if (across && down) {
      boxHShrink(plane, scratch, w, h, r, across)
      boxVShrink(scratch, plane, w, h, r, sums, down)
    } else {
      boxH(plane, scratch, w, h, r)
      boxV(scratch, plane, w, h, r, sums)
    }
  }
}

/** Three box passes at an integer radius, on `a` in place, with `b` as the
 *  other half of the ping-pong, edges clamped. */
const boxesInPlace = (a: Float32Array, b: Float32Array, w: number, h: number, r: number): void => boxBlurPlane(a, b, w, h, r, 'clamp')

/**
 * Above this a whole pixel of radius is a small change in blur strength and the
 * second blur is wasted work; below it the fraction is most of the answer.
 */
const FRACTIONAL_BELOW = 4

/** Whether `blurInPlace` at this radius needs its `spare` buffer: only to mix
 *  two blurs, for a fraction of a pixel below FRACTIONAL_BELOW. */
export function needsSpare(radius: number): boolean {
  if (radius <= 0.01) return false
  const lo = Math.floor(radius)
  return !(radius - lo < 0.01 || lo >= FRACTIONAL_BELOW)
}

/**
 * How many rows (or columns) one pass of `blurInPlace` at this radius reaches
 * either side: the larger of the integer radii it runs (a fraction under
 * FRACTIONAL_BELOW mixes floor and floor + 1), 0 when it does nothing. Three
 * passes reach three times this: a window of rows blurs exactly as the sheet
 * does wherever its edge is at least that far away (or is the sheet's own).
 */
export function blurReach(radius: number): number {
  if (radius <= 0.01) return 0
  const lo = Math.floor(radius)
  return radius - lo < 0.01 || lo >= FRACTIONAL_BELOW ? Math.max(1, lo) : lo + 1
}

/**
 * Blur a field by `radius` pixels, in place, with caller-owned buffers (an
 * export reuses one workspace for every plate): `scratch` is the box blur's
 * other half; `spare` holds the source for the second of two mixed blurs, and
 * is needed only when `needsSpare`. A radius of effectively zero leaves the
 * field as it is.
 *
 * Fractional radii are honoured by mixing the two neighbouring integer blurs.
 * Rounding instead is what made the preview and the saved file different
 * pictures: the same fraction-of-a-pixel tear the print asks for rounds to a
 * whole pixel at preview size and a whole pixel at print size, which is half
 * again as much blur relative to a sheet half again smaller — so the threshold
 * that cuts the edge back bit clean through letterforms on screen and left them
 * intact in the file.
 *
 * Mixing two blurs rather than widening the box by a fraction of a sample,
 * which is the obvious way and is worse on both counts: a three-tap kernel's
 * width falls off as the square root of the fraction rather than in step with
 * it, so a two-thirds-pixel radius still blurs like three-quarters of one, and
 * the clamped reads it needs in the inner loop cost more than the second blur
 * they were meant to save. Both were measured.
 */
export function blurInPlace(
  field: Float32Array,
  w: number,
  h: number,
  radius: number,
  scratch: Float32Array,
  spare?: Float32Array,
): void {
  if (radius <= 0.01) return

  const lo = Math.floor(radius)
  const frac = radius - lo
  if (frac < 0.01 || lo >= FRACTIONAL_BELOW) {
    boxesInPlace(field, scratch, w, h, Math.max(1, lo))
    return
  }
  if (!spare) throw new Error('blurInPlace: a fractional radius needs a spare buffer')

  // Radius zero is the field itself, so the low end of the mix is free below 1.
  spare.set(field)
  if (lo >= 1) boxesInPlace(field, scratch, w, h, lo)
  boxesInPlace(spare, scratch, w, h, lo + 1)
  for (let i = 0; i < field.length; i++) field[i] += (spare[i] - field[i]) * frac
}
