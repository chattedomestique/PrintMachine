import type { MediaLayer, PressProfile, PrintSettings, TextLayer } from '../engine/types.ts'

/**
 * Opinionated defaults. Every one of these is a decision made once here so it
 * doesn't have to be made again every time the app opens (playbook §1.3) —
 * the app should look like a good print the instant it loads, not like a
 * control panel waiting for input.
 */

let seq = 0
export const nextLayerId = (): string => `layer-${Date.now().toString(36)}-${seq++}`

export function makeLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id: nextLayerId(),
    text: 'PRINT\nMACHINE',
    inkId: 'fluorescentpink',
    fontId: 'poster',
    bold: true,
    size: 0.2,
    lineHeight: 0.94,
    tracking: -0.02,
    contrastInkId: null,
    contrastThreshold: 0.5,
    align: 'center',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    backing: null,
    ...overrides,
  }
}

/**
 * A photo's placement, as an import creates it: as shot, filling the sheet,
 * centred. The one shape of a media layer — the importer builds from it and
 * the normaliser checks a stored one against it.
 */
export function makeMedia({
  id,
  width,
  height,
  ...over
}: Partial<MediaLayer> & Pick<MediaLayer, 'id' | 'width' | 'height'>): MediaLayer {
  return {
    id,
    width,
    height,
    scale: 1,
    x: 0.5,
    y: 0.5,
    ...over,
  }
}

/** The press a new document pulls with. */
export function pressProfile(): PressProfile {
  return {
    method: 'halftone',
    screenShape: 'circle',
    // Against the 1800px reference sheet. Finer than this and the rosette is
    // there but too small to read as print at phone-screen size.
    screenPitch: 9,
    screenSoftness: 0.7,
    ditherType: 'atkinson',
    ditherThreshold: 0.5,
    // One pixel per cell is invisible at export size and reads as flat tone;
    // the chunky duplicator look lives at several pixels per cell.
    ditherScale: 3,

    carvePitch: 14,
    carveAngle: 45,
    carveRoughness: 0.5,

    // A realistic single-pass ink film. Pushed a little under the ~0.88 a real
    // drum lays down so the screen stays visible inside solids — at 100% the
    // dots close up and the whole point of the thing disappears.
    density: 0.84,
    gamma: 1,
    mottle: 0.22,
    dropout: 0.012,
    banding: 0.5,

    // The wear. A Riso that prints perfectly clean is a Riso nobody would
    // choose over a laser printer, so these are on by default — enough to
    // read as a real pull without tipping into pastiche.
    roughness: 0.55,
    roughScale: 3,
    bleed: 0.35,
    streaks: 0.3,
    smear: 0.18,
    patches: 0.22,
    // ~5px at the 1800px reference — clearly visible without looking broken.
    misregistration: 5,
    detailScaling: true,
  }
}

export function defaultSettings(): PrintSettings {
  return {
    aspect: '4:5',

    media: null,
    // Full stock character by default — with no photo this is what the paper
    // has always done, and with one it is what makes the photo and the type
    // read as printed on the same sheet.
    paperVeil: true,

    paperId: 'natural',
    paperTexture: 0.4,
    paperBlotch: 0.5,

    press: pressProfile(),

    seed: 12345,
    layers: [
      makeLayer(),
      makeLayer({
        text: 'RISO',
        inkId: 'blue',
        size: 0.3,
        y: 0.76,
        rotation: -4,
        tracking: 0.04,
      }),
    ],
  }
}
