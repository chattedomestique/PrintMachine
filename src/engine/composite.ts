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
  /**
   * Optional per-pixel ground, RGBA, already blitted at sheet size — a photo
   * standing in for the paper stock. When present the paper's colour and tooth
   * become a *veil* over it rather than the base itself, at `paperAmount`
   * strength, so 0 prints straight onto the photo and 1 lets the stock tint and
   * texture it the way printing on toned paper actually does.
   */
  base?: Uint8ClampedArray
  /** 0..1. Ignored without `base`, where the paper is the ground by definition. */
  paperAmount?: number
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

  const base = paper.base
  // Without a photo the paper *is* the ground, so the veil is fully on and the
  // arithmetic below collapses back to exactly `rgb × shade`.
  const amount = base ? Math.max(0, Math.min(1, paper.paperAmount ?? 1)) : 1

  for (let i = 0; i < n; i++) {
    let r: number
    let g: number
    let b: number

    if (base) {
      const o = i * 4
      // Alpha, not just colour. A photo moved or scaled off the trim leaves
      // bare sheet, and getImageData hands those pixels back as transparent
      // *black* — reading the colour alone prints a black border round a photo
      // that has simply been panned. Uncovered sheet is paper, so the ground is
      // the photo composited over white and the veil is forced fully on there,
      // which is exactly the paper this function draws without a photo at all.
      const a = base[o + 3] / 255
      const veil = amount * a + (1 - a)
      const s = 1 - veil * (1 - paper.shade[i])
      r = ((base[o] / 255) * a + (1 - a)) * (1 - veil * (1 - pr)) * s
      g = ((base[o + 1] / 255) * a + (1 - a)) * (1 - veil * (1 - pg)) * s
      b = ((base[o + 2] / 255) * a + (1 - a)) * (1 - veil * (1 - pb)) * s
    } else {
      const s = paper.shade[i]
      r = pr * s
      g = pg * s
      b = pb * s
    }

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
