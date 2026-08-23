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

/**
 * Blur a field by `radius` pixels. Returns a new array; the input is untouched.
 * A radius below 1 is a no-op copy.
 */
export function blurField(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.round(radius)
  if (r < 1) return src.slice()

  const a = src.slice()
  const b = new Float32Array(src.length)

  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, r)
    boxV(b, a, w, h, r)
  }
  return a
}
