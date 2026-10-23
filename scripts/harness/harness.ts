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

import { renderPrint, renderPrintAsync, type RenderCache } from '../../src/engine/render.ts'
import { savePrint, type ExportFormat } from '../../src/engine/export.ts'
import type { PrintSettings } from '../../src/engine/types.ts'
import { defaultSettings, makeMedia } from '../../src/state/defaults.ts'
import plain from './docs/plain.json'
import photoAsShot from './docs/photo-asshot.json'
import photoSecondInk from './docs/photo-second-ink.json'
import textFreePhoto from './docs/text-free-photo.json'

/**
 * The frozen documents, plus some built live from the build under test:
 * `default` (whatever `defaultSettings()` is), `backing-photo` (the default
 * over the test photo, the first plate keeping its own ink as its second ink
 * and the second on a yellow backing), and `small-2` / `small-4` (the default
 * with every plate at 20% / 40%, the band captions over a photo live in, where
 * the press's detail scaling is furthest from poster type). Those change on
 * purpose when the defaults do, which is the point of rendering them.
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
  'small-2': () => smallType(0.02),
  'small-4': () => smallType(0.04),
}

function smallType(size: number): PrintSettings {
  const s = defaultSettings()
  s.layers = s.layers.map((l) => ({ ...l, size }))
  return s
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
  /** `async`: through the export's entry point, renderPrintAsync, instead of
   *  the preview's (the parity gate renders both). */
  opts: { photo?: number; png?: boolean; async?: boolean } = {},
): Promise<RenderResult> {
  const settings = load(name)
  const media = settings.media
    ? await photoBitmap(settings.media.width, settings.media.height, opts.photo)
    : null
  const out = context(false)
  const scratch = context(true)
  const cacheRef: { current: RenderCache | null } = { current: null }

  const t0 = performance.now()
  if (opts.async) await renderPrintAsync(out, scratch, settings, height, media)
  else renderPrint(out, scratch, settings, cacheRef, null, height, media)
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

/** Rec. 709 luma of an RGBA buffer, 0..255. */
function lumaOf(rgba: Uint8ClampedArray): Float64Array {
  const out = new Float64Array(rgba.length / 4)
  for (let i = 0; i < out.length; i++) {
    const o = i * 4
    out[i] = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]
  }
  return out
}

function correlation(a: Float64Array, b: Float64Array): number {
  let ma = 0
  let mb = 0
  for (let i = 0; i < a.length; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= a.length
  mb /= b.length
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    ab += x * y
    aa += x * x
    bb += y * y
  }
  return ab / Math.sqrt(aa * bb)
}

async function pixels(name: string, height: number): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const settings = load(name)
  const media = settings.media ? await photoBitmap(settings.media.width, settings.media.height) : null
  const out = context(false)
  const scratch = context(true)
  renderPrint(out, scratch, settings, { current: null }, null, height, media)
  const { width: w, height: h } = out.canvas
  const data = out.getImageData(0, 0, w, h).data
  out.canvas.width = 0
  scratch.canvas.width = 0
  return { data, w, h }
}

/**
 * Is a larger render the same print? The document at `height` and at twice
 * it; the larger box-averaged 2x2 down to the smaller's size, and the two
 * correlated on luminance. 1 is the same picture; a quantity held in pixels
 * rather than in sheet fractions decorrelates it.
 */
async function scaleCorrelation(name: string, height: number): Promise<{ corr: number; w: number; h: number }> {
  const small = await pixels(name, height)
  const big = await pixels(name, height * 2)
  if (big.w !== small.w * 2 || big.h !== small.h * 2) throw new Error(`${name}: ${big.w}x${big.h} is not twice ${small.w}x${small.h}`)
  const a = lumaOf(small.data)
  const b = lumaOf(big.data)
  const down = new Float64Array(a.length)
  for (let y = 0; y < small.h; y++) {
    for (let x = 0; x < small.w; x++) {
      const i = 2 * y * big.w + 2 * x
      down[y * small.w + x] = (b[i] + b[i + 1] + b[i + big.w] + b[i + big.w + 1]) / 4
    }
  }
  return { corr: correlation(down, a), w: small.w, h: small.h }
}

/**
 * The real Save, minus the share sheet: `savePrint` at the planned size, with
 * the test photo at `photo` pixels (the document's own size if omitted, which
 * then becomes the photo's true size). Returns the plan, the file's size and
 * the size the file decodes to.
 */
async function save(
  name: string,
  opts: { photo?: [number, number]; format?: ExportFormat } = {},
): Promise<{ plan: { width: number; height: number; limit: string }; bytes: number; decoded: [number, number]; ms: number; steps: string[] }> {
  const settings = load(name)
  if (settings.media && opts.photo) settings.media = { ...settings.media, width: opts.photo[0], height: opts.photo[1] }
  const media = settings.media ? await createImageBitmap(photoCanvas(settings.media.width, settings.media.height)) : null
  const steps: string[] = []
  const t0 = performance.now()
  const pressed = await savePrint(context(false), context(true), settings, media, {
    format: opts.format,
    onProgress: (p) => steps.push(`${p.step} ${p.pass}/${p.passes}`),
    onGround: () => media?.close(),
  })
  const ms = performance.now() - t0
  const bmp = await createImageBitmap(pressed.blob)
  const decoded: [number, number] = [bmp.width, bmp.height]
  bmp.close()
  return { plan: pressed.plan, bytes: pressed.blob.size, decoded, ms, steps }
}

declare global {
  interface Window {
    H: {
      docs: string[]
      render: typeof render
      scaleCorrelation: typeof scaleCorrelation
      save: typeof save
      normalized: boolean
    }
  }
}

window.H = { docs: Object.keys(DOCS), render, scaleCorrelation, save, normalized: !!normalizeSettings }
