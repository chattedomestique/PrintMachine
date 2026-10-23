/**
 * The whole-document gate: the REAL `renderPrint`, in a real browser, over
 * frozen documents.
 *
 * vitest runs in node, which has no 2D context, so anything that rasterises
 * text or blits a photo can only be checked here. The documents in `docs/` were
 * written by the build before the simplification and are never edited: from the
 * commit that adds `src/state/normalize.ts`, they are loaded through it exactly
 * as an old save would be, so an A/B run between two commits shows what an old
 * print looks like after each.
 *
 * Text depends on the fonts installed, so a hash of a text-bearing render only
 * means something compared against another run ON THE SAME MACHINE. That is how
 * `run.mjs` and `compare.mjs` are used: record the parent, record the commit,
 * compare. Only the text-free document's hashes are committed.
 *
 * The photo is generated in the page (a luminance ramp with a zone plate in it),
 * so there are no binary fixtures and the same pixels come back every run.
 */

import { renderPrint, type RenderCache } from '../../src/engine/render.ts'
import type { PrintSettings } from '../../src/engine/types.ts'
import { defaultSettings, makeMedia } from '../../src/state/defaults.ts'
import plain from './docs/plain.json'
import photoAsShot from './docs/photo-asshot.json'
import photoSecondInk from './docs/photo-second-ink.json'
import textFreePhoto from './docs/text-free-photo.json'

/**
 * The frozen documents, plus two built live from the build under test:
 * `default` (whatever `defaultSettings()` is) and `backing-photo` (the default
 * over the test photo, the first plate keeping its own ink as its second ink
 * and the second on a yellow backing). Those change on purpose when the
 * defaults do, which is the point of rendering them.
 */
const DOCS: Record<string, () => unknown> = {
  plain: () => plain,
  'photo-asshot': () => photoAsShot,
  'photo-second-ink': () => photoSecondInk,
  'text-free-photo': () => textFreePhoto,
  default: () => defaultSettings(),
  'backing-photo': () => {
    const s = defaultSettings()
    s.media = makeMedia({ id: 'harness-photo', width: 1600, height: 1200 })
    s.layers[0] = { ...s.layers[0], contrastInkId: s.layers[0].inkId }
    s.layers[1] = { ...s.layers[1], backing: 'yellow' }
    return s
  },
}

type Normalize = (raw: unknown, env: { measure?: unknown }) => PrintSettings

// Globbed rather than imported so this file runs on builds that predate the
// normaliser: absent, the glob is empty and the document is used as stored.
const normalizers = import.meta.glob<{ normalizeSettings?: Normalize }>(
  '../../src/state/normalize.ts',
  { eager: true },
)
const persisters = import.meta.glob<{ canvasMeasure?: () => unknown }>(
  '../../src/state/persist.ts',
  { eager: true },
)
const normalizeSettings = Object.values(normalizers)[0]?.normalizeSettings
const canvasMeasure = Object.values(persisters)[0]?.canvasMeasure

function load(name: string): PrintSettings {
  const make = DOCS[name]
  if (!make) throw new Error(`unknown document "${name}"`)
  // A deep copy, so a render can never edit the frozen original.
  const raw: unknown = JSON.parse(JSON.stringify(make()))
  return normalizeSettings ? normalizeSettings(raw, { measure: canvasMeasure?.() }) : (raw as PrintSettings)
}

/** A deterministic test photo: a dark-to-light ramp so the second ink switches
 *  both ways, a warm/cool tint down the sheet, and a zone plate across the
 *  middle whose rings run to the pixel pitch, so any resampling shows. */
function photoCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('no 2D context')
  const img = ctx.createImageData(w, h)
  const d = img.data
  const cx = w / 2
  const cy = h / 2
  const k = Math.PI / (2 * Math.max(w, h))
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1)
      const ramp = 0.06 + 0.88 * u
      const dx = x - cx
      const dy = y - cy
      const r2 = dx * dx + dy * dy
      const inPlate = r2 < (0.3 * h) * (0.3 * h)
      const zone = inPlate ? 0.5 + 0.5 * Math.cos(k * r2) : 0.5
      const l = Math.min(1, Math.max(0, ramp + (zone - 0.5) * 0.5))
      const o = (y * w + x) * 4
      d[o] = Math.round(255 * Math.min(1, l * (0.9 + 0.2 * v)))
      d[o + 1] = Math.round(255 * l)
      d[o + 2] = Math.round(255 * Math.min(1, l * (1.1 - 0.2 * v)))
      d[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

const photos = new Map<string, ImageBitmap>()
async function photoBitmap(w: number, h: number, megapixels?: number): Promise<ImageBitmap> {
  // A larger photo keeps the document's aspect, so the cover geometry (which
  // reads the stored width and height) is unchanged and only the source
  // resolution moves.
  const k = megapixels ? Math.sqrt((megapixels * 1e6) / (w * h)) : 1
  const pw = Math.round(w * k)
  const ph = Math.round(h * k)
  const key = `${pw}x${ph}`
  let bmp = photos.get(key)
  if (!bmp) {
    bmp = await createImageBitmap(photoCanvas(pw, ph))
    photos.set(key, bmp)
  }
  return bmp
}

function context(willReadFrequently: boolean): CanvasRenderingContext2D {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently })
  if (!ctx) throw new Error('no 2D context')
  return ctx
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export interface RenderResult {
  sha256: string
  ms: number
  w: number
  h: number
  /** A PNG data URL of the render, when `png` was asked for. */
  png?: string
}

async function render(
  name: string,
  height: number,
  opts: { photo?: number; png?: boolean } = {},
): Promise<RenderResult> {
  const settings = load(name)
  const media = settings.media
    ? await photoBitmap(settings.media.width, settings.media.height, opts.photo)
    : null
  const out = context(false)
  const scratch = context(true)
  const cacheRef: { current: RenderCache | null } = { current: null }

  const t0 = performance.now()
  renderPrint(out, scratch, settings, cacheRef, null, height, media)
  const ms = performance.now() - t0

  const { width: w, height: h } = out.canvas
  const pixels = out.getImageData(0, 0, w, h).data
  const sha256 = hex(await crypto.subtle.digest('SHA-256', pixels))
  // For eyeballing: the render as a PNG, when asked.
  const png = opts.png ? out.canvas.toDataURL('image/png') : undefined
  // Let the big buffers go before the next render.
  out.canvas.width = 0
  scratch.canvas.width = 0
  return { sha256, ms, w, h, png }
}

declare global {
  interface Window {
    H: { docs: string[]; render: typeof render; normalized: boolean }
  }
}

window.H = { docs: Object.keys(DOCS), render, normalized: !!normalizeSettings }
