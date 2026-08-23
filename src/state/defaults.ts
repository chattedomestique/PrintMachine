import type { PrintSettings, TextLayer } from '../engine/types.ts'

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
    weight: 700,
    size: 0.16,
    lineHeight: 0.94,
    tracking: -0.02,
    align: 'center',
    x: 0.5,
    y: 0.5,
    rotation: 0,
    caps: true,
    opacity: 1,
    fitWidth: true,
    ...overrides,
  }
}

export function defaultSettings(): PrintSettings {
  return {
    aspect: '4:5',

    paperId: 'natural',
    paperTexture: 0.4,
    paperBlotch: 0.5,

    method: 'halftone',
    screenShape: 'circle',
    // Against the 1800px reference sheet. Finer than this and the rosette is
    // there but too small to read as print at phone-screen size.
    screenPitch: 9,
    screenSoftness: 0.7,
    ditherType: 'atkinson',
    ditherThreshold: 0.5,

    // A realistic single-pass ink film. Pushed a little under the ~0.88 a real
    // drum lays down so the screen stays visible inside solids — at 100% the
    // dots close up and the whole point of the thing disappears.
    density: 0.84,
    gamma: 1,
    mottle: 0.22,
    dropout: 0.012,
    banding: 0.5,
    // ~5px at the 1800px reference — clearly visible without looking broken.
    misregistration: 5,

    seed: 12345,
    layers: [
      makeLayer(),
      makeLayer({
        text: 'RISO',
        inkId: 'blue',
        size: 0.3,
        y: 0.76,
        rotation: -4,
        fitWidth: false,
        tracking: 0.04,
      }),
    ],
  }
}
