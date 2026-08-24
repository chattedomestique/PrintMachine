/**
 * Two ways of laying ink that are not screens.
 *
 * A halftone breaks tone into dots and a dither scatters it. Neither is how a
 * cut block or a drawn mark behaves, and both of those are printmaking too:
 *
 *  - **Woodcut.** Ink is carried by whatever the blade left standing. The
 *    interior of a shape is not flat — it is crossed by the grooves the gouge
 *    cut and by the grain of the block itself, and the ink sits unevenly on
 *    what remains.
 *  - **Scribble.** A shape filled by hatching rather than by flooding, in the
 *    manner of a pen. Parallel strokes that bow rather than run straight, with
 *    ends that overshoot, and a second pass crossing the first where the shape
 *    wants to be darker.
 *
 * The hatching here follows the technique in p5.scribble.js
 * ([generative-light](https://github.com/generative-light/p5.scribble.js)),
 * itself a port of Jo Wood's *handy* for Processing — bowing, roughness and
 * hachure fill. As with p5.riso the technique is reimplemented rather than
 * depended on: p5.scribble needs all of p5.js, and it draws primitives, not
 * text. What the app needs is a *fill rule for an arbitrary tone field*, which
 * is a different shape of problem and is expressed here as pure typed-array
 * maths with no canvas involved.
 */

/** Cheap deterministic hash noise in [0,1). Enough for jitter that has to be
 *  the same on every render but costs nothing per pixel. */
function hash2(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise from the hash above, one octave, bilinear. */
function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}

export interface CarveOptions {
  /** Spacing of the grooves or strokes, in pixels at this render size. */
  pitch: number
  /** Direction of the cut or the hatch, in degrees. */
  angle: number
  /** 0..1. How far the marks wander from straight. */
  roughness: number
  seed: number
}

/**
 * Woodcut: ink carried by what the blade left standing.
 *
 * Three things happen at once, and leaving any of them out is what makes a
 * "woodcut filter" look like a filter:
 *
 *  - **Gouge marks.** Narrow grooves running across the shape, cut *into* the
 *    ink area. They wander, because a blade pushed through timber does.
 *  - **Grain.** A much finer, much longer-wavelength variation along the same
 *    direction — the block's own figure, which the ink sits on unevenly.
 *  - **Tone.** A darker area is one the carver left more of, so the grooves
 *    narrow and eventually close; a pale one is nearly all groove.
 */
export function woodcutField(
  tone: Float32Array,
  w: number,
  h: number,
  opts: CarveOptions,
): Float32Array {
  const out = new Float32Array(w * h)
  const a = (opts.angle * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const pitch = Math.max(2, opts.pitch)
  const wander = opts.roughness * pitch * 1.6

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const t = tone[i]
      // A block either carries ink or it is bare. Coverage this faint is not a
      // pale mark, it is timber the blade took away.
      if (t <= 0.06) continue

      // Along the cut and across it.
      const along = x * cos + y * sin
      const across = -x * sin + y * cos

      // The groove wanders along its length; the blade does not run true.
      const drift = (smoothNoise(along / (pitch * 5), across / (pitch * 22), opts.seed) - 0.5) * wander
      const u = (across + drift) / pitch
      const frac = Math.abs(u - Math.round(u)) * 2 // 0 at a groove centre, 1 between


      // A darker area is one the carver left more of, so the groove narrows —
      // but it never closes. The solid areas of a woodcut are exactly where the
      // gouge marks and the grain show; a groove that shuts at full tone makes
      // the method a no-op on the shapes you actually print.
      //
      // At the other end it must close *completely*. The cut is binary — ink or
      // bare block — so faint tone left by a smear or a dropout has to carve
      // away to nothing rather than printing as a crisp thin line at full
      // strength. Getting this wrong drags hairlines off the bottom of every
      // letter, which is what the first render did.
      //
      // Gouges also vary: a real cut is not a ruled stripe, so each groove
      // takes its own width and wobbles along its length.
      // The variation belongs to how much is *left standing*, not to the width
      // itself — scaling the width directly lets it fall below 1 even at zero
      // tone, which reopens the groove and prints the faint smear tails the
      // closure was there to remove.
      const vary = smoothNoise(along / (pitch * 3), Math.round(u) * 7.3, opts.seed ^ 0x2545f491)
      const standing = t * (0.55 + 0.45 * vary)
      const grooveWidth = 1 - 0.9 * standing
      const cut = frac < grooveWidth ? 0 : 1

      // The block's own figure — long, fine, and along the grain.
      const grain =
        0.82 + 0.18 * smoothNoise(along / (pitch * 1.1), across / (pitch * 30), opts.seed ^ 0x5bf03635)

      out[i] = cut * grain
    }
  }
  return out
}

/**
 * Scribble: a shape hatched rather than flooded.
 *
 * Each stroke bows away from straight and its ends overshoot the shape, which
 * is what a hand does and what a plotter does not. Where the tone is darkest a
 * second pass crosses the first, because that is how you get darker with a pen
 * that only makes one weight of line.
 */
export function scribbleField(
  tone: Float32Array,
  w: number,
  h: number,
  opts: CarveOptions,
): Float32Array {
  const out = new Float32Array(w * h)
  const pitch = Math.max(2, opts.pitch)
  const bow = opts.roughness * pitch * 1.1

  const pass = (angle: number, seed: number, dst: Float32Array, floor: number) => {
    const a = (angle * Math.PI) / 180
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const t = tone[i]
        // Same closure the woodcut needs: a pen either touched the paper or it
        // did not. Without a floor the faint tone a smear leaves behind gets
        // hatched at full strength and trails off the bottom of every letter.
        if (t <= floor || t <= 0.08) continue

        const along = x * cos + y * sin
        const across = -x * sin + y * cos

        // Bowing: the stroke is displaced as a slow wave along its length, so
        // it curves instead of ruling straight.
        const wave = (smoothNoise(along / (pitch * 9), across / (pitch * 40), seed) - 0.5) * bow
        const u = (across + wave) / pitch
        const d = Math.abs(u - Math.round(u)) * 2

        // Darker tone means a fatter stroke rather than more strokes, which is
        // what a pen actually gives you on a second pass over the same line.
        // It has to reach nothing at nothing — a constant term leaves a visible
        // stroke wherever the tone is merely faint. Capped short of touching so
        // hatching never becomes a flood; the white between the strokes is what
        // makes it read as drawn.
        const width = 0.78 * Math.pow(Math.min(1, t), 0.75)
        if (d < width) {
          // Ends and edges break up: a drawn line is not uniformly dark.
          const ink = 0.75 + 0.25 * smoothNoise(along / 3, across / 3, seed ^ 0x9e3779b9)
          if (ink > dst[i]) dst[i] = ink
        }
      }
    }
  }

  pass(opts.angle, opts.seed, out, 0)
  // The cross pass only reaches the darker half, so light areas stay open.
  pass(opts.angle + 62, opts.seed ^ 0x85ebca6b, out, 0.55)
  return out
}
