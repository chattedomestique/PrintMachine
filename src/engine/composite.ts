/**
 * Subtractive overprint compositing.
 *
 * This is the piece that people usually get wrong, and it is why "two coloured
 * halftone layers" often fails to look like a print. Riso ink is *transparent*.
 * Where pink prints over blue you get a deep purple, because each ink filters
 * the light coming back off the paper. Alpha compositing models ink as opaque
 * paint and gives you the top layer only, which reads as a sticker.
 *
 * The model here is straightforward transmittance. Each ink has a transmission
 * per channel of `ink/255`; laying it down at coverage `c` multiplies what is
 * underneath by `1 - c·(1 - ink/255)`. At c=0 that is 1 (nothing happens); at
 * c=1 it is exactly `ink/255`. Applying that per layer over the paper colour
 * gives real overprint, in the right order, for free.
 */

export interface CompositeLayer {
  /** w*h coverage in [0,1]. */
  coverage: Float32Array
  /** The ink's printed colour at full coverage on white. */
  rgb: readonly [number, number, number]
  /** Layer master opacity in [0,1] — scales coverage uniformly. */
  opacity: number
}

export interface PaperInput {
  shade: Float32Array
  rgb: readonly [number, number, number]
}

/**
 * Composite paper + N ink layers into RGBA bytes, in place.
 *
 * Layers are applied in array order (index 0 is the first colour down). Order
 * is visible in the result — pink over blue and blue over pink differ slightly,
 * because the second ink sits on a darker base — which is exactly the behaviour
 * a real press has.
 *
 * @param out RGBA byte buffer of length w*h*4, written in full (alpha = 255).
 */
export function compositeLayers(
  out: Uint8ClampedArray,
  w: number,
  h: number,
  paper: PaperInput,
  layers: readonly CompositeLayer[],
): void {
  const n = w * h
  const pr = paper.rgb[0] / 255
  const pg = paper.rgb[1] / 255
  const pb = paper.rgb[2] / 255

  // Precompute each ink's absorption (1 - transmission) per channel so the
  // inner loop is three multiply-adds per layer and nothing else.
  const count = layers.length
  const absR = new Float32Array(count)
  const absG = new Float32Array(count)
  const absB = new Float32Array(count)
  const alpha = new Float32Array(count)
  for (let l = 0; l < count; l++) {
    const { rgb, opacity } = layers[l]
    absR[l] = 1 - rgb[0] / 255
    absG[l] = 1 - rgb[1] / 255
    absB[l] = 1 - rgb[2] / 255
    alpha[l] = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity
  }

  for (let i = 0; i < n; i++) {
    const s = paper.shade[i]
    let r = pr * s
    let g = pg * s
    let b = pb * s

    for (let l = 0; l < count; l++) {
      const c = layers[l].coverage[i] * alpha[l]
      if (c <= 0) continue
      r *= 1 - c * absR[l]
      g *= 1 - c * absG[l]
      b *= 1 - c * absB[l]
    }

    const o = i * 4
    out[o] = r * 255
    out[o + 1] = g * 255
    out[o + 2] = b * 255
    out[o + 3] = 255
  }
}
