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

/** One vertical box pass. Same seeding rule, striding by w. */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1)
  for (let x = 0; x < w; x++) {
    let sum = src[x] * (r + 1)
    for (let i = 1; i <= r; i++) sum += src[Math.min(i, h - 1) * w + x]

    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm
      const add = src[Math.min(y + r + 1, h - 1) * w + x]
      const drop = src[Math.max(y - r, 0) * w + x]
      sum += add - drop
    }
  }
}

/** Three box passes at an integer radius, on `a` in place, with `b` as the
 *  other half of the ping-pong. */
function boxesInPlace(a: Float32Array, b: Float32Array, w: number, h: number, r: number): void {
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, r)
    boxV(b, a, w, h, r)
  }
}

/**
 * Above this a whole pixel of radius is a small change in blur strength and the
 * second blur is wasted work; below it the fraction is most of the answer.
 */
const FRACTIONAL_BELOW = 4

/**
 * Blur a field by `radius` pixels. Returns a new array; the input is untouched.
 * A radius of effectively zero is a no-op copy.
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
export function blurField(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const out = src.slice()
  blurInPlace(out, w, h, radius, new Float32Array(src.length), needsSpare(radius) ? new Float32Array(src.length) : undefined)
  return out
}

/** Whether `blurInPlace` at this radius needs its `spare` buffer: only to mix
 *  two blurs, for a fraction of a pixel below FRACTIONAL_BELOW. */
export function needsSpare(radius: number): boolean {
  if (radius <= 0.01) return false
  const lo = Math.floor(radius)
  return !(radius - lo < 0.01 || lo >= FRACTIONAL_BELOW)
}

/**
 * `blurField`, on `field` itself: the same numbers, with caller-owned
 * buffers instead of fresh ones (an export reuses one workspace for every
 * plate). `scratch` is the box blur's other half; `spare` holds the source
 * for the second of two mixed blurs, and is needed only when `needsSpare`.
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
