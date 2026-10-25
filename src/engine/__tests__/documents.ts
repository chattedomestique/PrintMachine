/**
 * The press's synthetic documents: eight literal documents (never
 * `defaultSettings()`, which changes on purpose) that between them reach
 * every stage of the press: halftone and grain, one and two switch points,
 * a backing, turned and small type, the press at its limits, a ground with a
 * transparent hole. golden.test.ts pins what each prints; the band tests
 * press them in bands and must get the same bytes.
 */

import type { ToneSource } from '../render.ts'
import type { PressProfile, PrintSettings, TextLayer } from '../types.ts'
import { makeGlyphTone } from './fields.ts'

const press = (over: Partial<PressProfile> = {}): PressProfile => ({
  method: 'halftone',
  screenPitch: 9,
  density: 0.84,
  misregistration: 5,
  edge: 0.55,
  wear: 0.22,
  ...over,
})

const layer = (id: string, over: Partial<TextLayer> = {}): TextLayer => ({
  id,
  text: 'PRINT',
  inkId: 'fluorescentpink',
  fontId: 'poster',
  bold: true,
  size: 0.09,
  lineHeight: 0.94,
  tracking: -0.02,
  contrastInkId: null,
  contrastThreshold: 0.5,
  align: 'center',
  x: 0.5,
  y: 0.5,
  rotation: 0,
  backing: null,
  ...over,
})

const doc = (over: Partial<PrintSettings>): PrintSettings => ({
  aspect: '4:5',
  media: null,
  paperVeil: true,
  paperId: 'natural',
  press: press(),
  seed: 12345,
  layers: [],
  ...over,
})

const photo = { id: 'golden-photo', width: 1600, height: 1200, scale: 1, x: 0.5, y: 0.5 }

/** The documents. `ground`: pressed over the synthetic photo. */
export const DOCS: Record<string, { settings: PrintSettings; ground: boolean }> = {
  // Halftone on paper, two plates, the second turned.
  halftone: {
    ground: false,
    settings: doc({ layers: [layer('a'), layer('b', { inkId: 'blue', size: 0.06, rotation: -4 })] }),
  },
  // Grain on paper.
  grain: {
    ground: false,
    settings: doc({ press: press({ method: 'grain' }), seed: 777, layers: [layer('a'), layer('b', { inkId: 'blue', size: 0.06 })] }),
  },
  // One switch point shared by two plates (one keeps its own ink).
  'switch-one': {
    ground: true,
    settings: doc({
      media: photo,
      layers: [
        layer('a', { contrastInkId: 'blue' }),
        layer('b', { inkId: 'blue', size: 0.05, contrastInkId: 'blue', rotation: -4 }),
      ],
    }),
  },
  // Two switch points, 0.5, 0.4, 0.5: the mask is rebuilt and rebuilt back.
  'switch-two': {
    ground: true,
    settings: doc({
      media: photo,
      paperVeil: false,
      seed: 4242,
      layers: [
        layer('a', { size: 0.07, contrastInkId: 'black' }),
        layer('b', { inkId: 'blue', size: 0.05, contrastInkId: 'yellow', contrastThreshold: 0.4 }),
        layer('c', { inkId: 'green', size: 0.03, contrastInkId: 'fluorescentpink' }),
      ],
    }),
  },
  // Grain with a second ink: the switch mask is grained too.
  'grain-switch': {
    ground: true,
    settings: doc({
      media: photo,
      paperVeil: false,
      press: press({ method: 'grain', screenPitch: 12 }),
      layers: [layer('a', { contrastInkId: 'blue' }), layer('b', { inkId: 'blue', size: 0.06, contrastInkId: 'blue', contrastThreshold: 0.6 })],
    }),
  },
  // A backing (its own plate, and a knockout under it) beside a second ink.
  backing: {
    ground: true,
    settings: doc({
      media: photo,
      layers: [layer('a', { backing: 'yellow', size: 0.08 }), layer('b', { inkId: 'blue', size: 0.06, contrastInkId: 'blue', y: 0.76 })],
    }),
  },
  // Small, turned type, where the detail factor is furthest from 1.
  'small-rotated': {
    ground: true,
    settings: doc({
      media: photo,
      seed: 99,
      layers: [
        layer('a', { size: 0.012, rotation: -4, contrastInkId: 'blue' }),
        layer('b', { inkId: 'blue', size: 0.02, rotation: 7, backing: 'yellow' }),
      ],
    }),
  },
  // The press at its limits: misregistration 30, screen 36, edge 1, wear
  // 0.8, full density, type at 0.16 of the height (detail 1), four passes.
  'press-max': {
    ground: true,
    settings: doc({
      media: photo,
      seed: 31337,
      press: press({ screenPitch: 36, density: 1, misregistration: 30, edge: 1, wear: 0.8 }),
      layers: [
        layer('a', { size: 0.16, backing: 'fluorescentpink' }),
        layer('b', { inkId: 'blue', size: 0.16, contrastInkId: 'yellow', rotation: -4 }),
        layer('c', { inkId: 'black', size: 0.05, y: 0.8 }),
      ],
    }),
  },
}

export const SIZES: [number, number][] = [
  [300, 400],
  [233, 517],
]

/** A number from a string, for the tones' seeds. */
const seedOf = (s: string) => {
  let x = 2166136261
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619)
  return x >>> 0
}

/** The synthetic tones a document's plates press: one field per plate. */
export function syntheticTones(name: string, w: number, h: number): ToneSource {
  const tone = (l: TextLayer, backing: boolean) => {
    const fontSize = Math.max(1, l.size * h)
    return { field: makeGlyphTone(w, h, seedOf(`${name}:${l.id}`), fontSize, { rotation: l.rotation, backing }), fontSize }
  }
  return { type: (l) => tone(l, false), backing: (l) => tone(l, true) }
}
