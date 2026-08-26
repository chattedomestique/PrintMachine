/**
 * Typewriter simulation.
 *
 * The thing almost every "typewriter effect" gets wrong is randomising per
 * *keystroke*. A typewriter's misalignment is not random per strike — it is a
 * property of the **type slug**. Every `e` is struck by the same little piece
 * of metal on the same worn arm, so if that arm sits a hair low, every `e` on
 * the page sits a hair low. Random jitter reads as noise; consistent per-slug
 * offset reads as a machine.
 *
 * That distinction is the one [OverType](https://uniqcode.com/typewriter/) also
 * arrives at — each character takes a vertical offset chosen once, not per
 * keypress. It is not open source and states no licence, so nothing is taken
 * from it but the observation, which is a fact about typewriters rather than
 * anything of theirs.
 *
 * What *is* per strike is how hard the key was hit. That varies with the
 * typist, so ink density does belong to the instance.
 *
 * Both together give the real thing: the same letter always leaning the same
 * way, but darker in one word than the next.
 */

/** Deterministic hash in [0,1) from two integers. */
function hash(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

export interface SlugOptions {
  /** 0..1. How far out of true the type bars have worn. */
  wear: number
  /** 0..1. How unevenly the typist hits the keys. */
  strike: number
  seed: number
}

export interface Strike {
  /** Offset from the character cell, in ems. */
  dx: number
  dy: number
  /** Slug rotation in radians. */
  rot: number
  /** Ink laid down by this particular strike, 0..1. */
  density: number
}

/**
 * How one character lands.
 *
 * `code` decides the slug and therefore the geometry — the same letter is
 * always struck by the same piece of metal. `index` decides only the force,
 * because that is the part that belongs to the keystroke rather than the
 * machine.
 */
export function strikeFor(code: number, index: number, opts: SlugOptions): Strike {
  const w = opts.wear
  // Geometry: keyed on the character alone, so it repeats everywhere that
  // letter appears. This is the whole difference between a typewriter and
  // noise.
  const dy = (hash(code, opts.seed) - 0.5) * 0.09 * w
  const dx = (hash(code, opts.seed ^ 0x9e3779b9) - 0.5) * 0.05 * w
  const rot = (hash(code, opts.seed ^ 0x85ebca6b) - 0.5) * 0.06 * w

  // Force: keyed on where in the text it falls, so the same letter is darker
  // in one word than the next.
  const hit = hash(index * 2654435761, opts.seed ^ 0x27d4eb2d)
  // A typist's weak strikes are further from the mean than their strong ones —
  // it is easy to under-hit a key and hard to over-hit one — so the draw is
  // skewed toward a full strike rather than uniform.
  //
  // Two numbers here are the difference between this reading as a machine and
  // reading as either nothing or noise. Squaring the draw put nearly every
  // strike at full ink and the effect vanished; leaving it unfloored dropped
  // whole letters, because the stencil is cut by a threshold and a tone under
  // that threshold is not a faint letter, it is no letter. The floor sits above
  // where the tear cuts, so a light strike always leaves a mark and the wear is
  // what breaks it up — which is the right way round: the ribbon decides how
  // much ink comes through the hole, never whether the hole is there.
  const density = 1 - opts.strike * 0.38 * Math.pow(hit, 1.5)

  return { dx, dy, rot, density }
}

/**
 * What the slug and the ribbon do to the ink once it lands.
 *
 * Two effects, both of which need the *distance to the edge of the stroke*,
 * which is why this runs on the tone rather than at draw time:
 *
 *  - **Impression.** The slug presses the ribbon into the paper and ink is
 *    squeezed outward, so a struck character is darker around its edge than
 *    through its middle. Push it far enough and the centre drops out
 *    altogether, which is what a worn slug on hard paper actually does.
 *  - **Ribbon weave.** A fabric ribbon is a woven mesh and the ink comes
 *    through the gaps, so the fill is fibrous at a scale far finer than any
 *    ink mottle. Without it the letters read as vector shapes that happen to
 *    be wobbly.
 */
export function ribbonInk(
  tone: Float32Array,
  w: number,
  h: number,
  opts: { impression: number; ribbon: number; seed: number; scale: number },
): Float32Array {
  const out = new Float32Array(tone.length)
  const imp = opts.impression
  const rib = opts.ribbon
  // The weave is a physical thread count, so it holds its size against the
  // sheet rather than against the render resolution.
  const weave = Math.max(1.2, 2.2 * opts.scale)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const t = tone[i]
      if (t <= 0) continue

      let v = t

      if (imp > 0) {
        // Cheap interior test: a pixel whose four neighbours are all inked is
        // in the middle of a stroke; one with a bare neighbour is at its edge.
        const l = x > 0 ? tone[i - 1] : 0
        const r = x < w - 1 ? tone[i + 1] : 0
        const u = y > 0 ? tone[i - w] : 0
        const d = y < h - 1 ? tone[i + w] : 0
        const interior = Math.min(l, r, u, d)
        // Edges gain what the middle loses, so the total ink is about the same
        // — the slug moved it, it did not add any.
        v = t * (1 + imp * 0.45) - interior * imp * 0.7
      }

      if (rib > 0) {
        // Two crossed threads, plus a little noise so the weave is not a
        // perfect grid.
        const wu = Math.sin((x / weave) * Math.PI) * Math.sin((y / weave) * Math.PI)
        const n = hash(x + y * 7919, opts.seed)
        // Centred on zero, so the weave *modulates* the ink rather than only
        // ever taking it away. A one-sided texture stacks with every other
        // reduction in the press and quietly erases the lightest strikes.
        const weft = 0.55 * (1 - Math.abs(wu)) + 0.45 * n
        v *= 1 + rib * (0.5 - weft)
      }

      out[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return out
}
