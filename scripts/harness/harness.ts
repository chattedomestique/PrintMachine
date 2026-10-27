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

import { draftSize, groundRect, isNativeRect, outputSize, plateGeometry, plateHalo, previewSize, renderPrint, renderPrintAsync, type AsyncRenderOptions, type RenderCache } from '../../src/engine/render.ts'
import { cssFont, layerFont, lineRects, planGlyphs } from '../../src/engine/text.ts'
import { tileGrid } from '../../src/engine/tiles.ts'
import { JpegEncoder } from '../../src/engine/encode/jpeg.ts'
import { PngEncoder } from '../../src/engine/encode/png.ts'
import { savePrint, type ExportFormat } from '../../src/engine/export.ts'
import { detachedCanvas } from '../../src/features/shell/page.ts'
import { ensureFrameInputs, needsFrost, pageFramePalettes, previewFrameInputs, storedFrameInputs } from '../../src/features/media/frameInputs.ts'
import { importMedia } from '../../src/features/media/importMedia.ts'
import { deleteMedia } from '../../src/state/mediaStore.ts'
import { PAGE_SOURCE_DEPS, frameSourceSize, frameSources, pageFrameSources } from '../../src/features/media/frameSource.ts'
import { frostFields } from '../../src/features/media/frostField.ts'
import { type FramePalette, type FrameSettings, type PrintSettings } from '../../src/engine/types.ts'
import { effectiveMode, sheetAspect, type FrameInputs } from '../../src/engine/frame.ts'
import { frostField } from '../../src/engine/frost.ts'
import { FROST_DRAFT_LONG, FROST_FIELD_LONG } from '../../src/engine/limits.ts'
import type { RgbaImage } from '../../src/engine/resample.ts'
import { decodeOriginal, previewArea, workingSize } from '../../src/features/media/decode.ts'
import { defaultSettings, makeMedia } from '../../src/state/defaults.ts'
import plain from './docs/plain.json'
import photoAsShot from './docs/photo-asshot.json'
import photoSecondInk from './docs/photo-second-ink.json'
import textFreePhoto from './docs/text-free-photo.json'
import frameOriginal from './docs/frame-original.json'
import frameFit from './docs/frame-fit.json'
import frameCorners from './docs/frame-corners.json'
import frameCropZoomed from './docs/frame-crop-zoomed.json'
import frameFrosted from './docs/frame-frosted.json'

/**
 * The frozen documents, plus some built live from the build under test:
 * `default` (whatever `defaultSettings()` is), `backing-photo` (the default
 * over the test photo, the first plate keeping its own ink as its second ink
 * and the second on a yellow backing), `small-2` / `small-4` (the default
 * with every plate at 20% / 40%, the band captions over a photo live in, where
 * the press's detail scaling is furthest from poster type), and four that
 * reach the corners of the press: `grain-photo`, `backing-second-ink`,
 * `press-max` and `native-photo` (each says what it is for below). Those
 * change on purpose when the defaults do, which is the point of rendering
 * them.
 */
const DOCS: Record<string, () => unknown> = {
  plain: () => plain,
  'photo-asshot': () => photoAsShot,
  'photo-second-ink': () => photoSecondInk,
  'text-free-photo': () => textFreePhoto,
  default: () => defaultSettings(),
  'backing-photo': () => {
    const s = withPhoto(defaultSettings(), 1600, 1200)
    s.layers[0] = { ...s.layers[0], contrastInkId: s.layers[0].inkId }
    s.layers[1] = { ...s.layers[1], backing: 'yellow' }
    return s
  },
  'small-2': () => smallType(0.02),
  'small-4': () => smallType(0.04),
  // Grain over the test photo, both plates with a second ink: the grain
  // stream feeds the switch mask as well as the plates.
  'grain-photo': () => {
    const s = withPhoto(defaultSettings(), 1600, 1200)
    s.press = { ...s.press, method: 'grain' }
    s.layers[0] = { ...s.layers[0], contrastInkId: 'blue' }
    s.layers[1] = { ...s.layers[1], contrastInkId: s.layers[1].inkId }
    return s
  },
  // Plate 1 on a backing; plate 2 (turned -4 degrees) with a second ink at a
  // switch point of its own, 0.4.
  'backing-second-ink': () => {
    const s = withPhoto(defaultSettings(), 1600, 1200)
    s.layers[0] = { ...s.layers[0], backing: 'yellow' }
    s.layers[1] = { ...s.layers[1], contrastInkId: 'fluorescentpink', contrastThreshold: 0.4, rotation: -4 }
    return s
  },
  // The press at its legal limits, over the photo: grain at screen 36,
  // misregistration 30, edge 1, wear 0.8, every plate's type at 0.16 of the
  // height (detail 1, so the tear and the shift reach their widest), the
  // first plate with a second ink so the knockout rides the largest shift.
  'press-max': () => {
    const s = withPhoto(defaultSettings(), 1600, 1200)
    s.press = { ...s.press, method: 'grain', screenPitch: 36, misregistration: 30, edge: 1, wear: 0.8 }
    s.layers = s.layers.map((l) => ({ ...l, size: 0.16 }))
    s.layers[0] = { ...s.layers[0], contrastInkId: 'blue' }
    return s
  },
  // A 2400x3000 photo on 4:5: at a height of 3000 the export is the photo's
  // own pixels, snapped (every other height resamples it).
  'native-photo': () => withPhoto(defaultSettings(), 2400, 3000),
  // The frame, text-free (one plate, its text cleared), each carrying its
  // photo's palette: Original at the first photo's width in the photo's own
  // colour; Fit on 4:5 with the matte and round corners, the veil off; an
  // Original portrait with round corners on bare Paper; Crop on 1:1 zoomed
  // and panned in the widest frame, half-round. Written for the frame (not
  // by an older build).
  'frame-original': () => frameOriginal,
  'frame-fit': () => frameFit,
  'frame-corners': () => frameCorners,
  'frame-crop-zoomed': () => frameCropZoomed,
  // Frosted, text-free: Original, a wide frame, half-round, Blur 120, the
  // veil on. Its field is made from the test photo generated at the frame
  // source's size (`inputsOf`), not decoded, so its hash does not depend on
  // the browser's decoder.
  'frame-frosted': () => frameFrosted,
}

/** Every document is one tile of the band engine's glyph grid at every
 *  height recorded (300, 1000, 1800): the 4:5 ones are 1440 px wide at
 *  1800, and the frame documents at most 2291x1800 (4.12 MP, under the
 *  tile's 4.19 MP; frame-frosted is 2223x1800). A document of another shape
 *  needs its own check that the heights recorded stay one tile. */
function withPhoto(s: PrintSettings, width: number, height: number): PrintSettings {
  s.media = makeMedia({ id: 'harness-photo', width, height })
  return s
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
  ctx.putImageData(new ImageData(photoPixels(w, h), w, h), 0, 0)
  return c
}

/** The test photo's pixels, RGBA, w x h (`photoCanvas`). */
function photoPixels(w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const d = new Uint8ClampedArray(w * h * 4)
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
  return d
}

/** The test photo as the frame's source (features/media frameSource.ts):
 *  generated at the source's size, one per size, never decoded. */
const sources = new Map<string, RgbaImage>()
function frameSourceOf(media: { width: number; height: number }): RgbaImage {
  const { width: w, height: h } = frameSourceSize(media.width, media.height)
  const key = `${w}x${h}`
  let src = sources.get(key)
  if (!src) {
    src = { w, h, rgba: photoPixels(w, h) }
    sources.set(key, src)
  }
  return src
}

/** The harness's fields, kept as the page keeps them. */
const fields = frostFields()

/**
 * What a document's frame is drawn from: the palette it stores, and for
 * Frosted the field the page would make (`fieldLong`, the settled and the
 * saved size unless asked), from the test photo at the source's size.
 */
function inputsOf(s: PrintSettings, fieldLong = FROST_FIELD_LONG): FrameInputs {
  const inputs = storedFrameInputs(s)
  if (s.media && needsFrost(s)) inputs.frost = fields.field(s.media.id, frameSourceOf(s.media), sheetAspect(s), s.frame.blur, fieldLong)
  return inputs
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
  /** Whether the photo lands on this sheet at its own pixels (false without
   *  one): the ground then comes from the photo's own rows, not a resample. */
  native: boolean
  /** A PNG data URL of the render, when `png` was asked for. */
  png?: string
}

/** Options of a render through the export's entry point only: the preview
 *  always presses its sheet whole, in one tile. */
interface ExportOnly {
  /** Rows pressed at a time. */
  bandRows?: number
  /** The tile grid's budget, [edge, pixels]: `[512, 65536]` forces 512x128
   *  tiles, so a 1000 px sheet is many tiles. */
  tile?: [number, number]
}

function exportOptions(opts: ExportOnly & { async?: boolean }): AsyncRenderOptions {
  if ((opts.bandRows !== undefined || opts.tile !== undefined) && !opts.async) {
    throw new Error('bandRows and tile are export options: render through the export entry ({ async: true })')
  }
  return {
    bandRows: opts.bandRows,
    tileBudget: opts.tile ? { edge: opts.tile[0], pixels: opts.tile[1] } : undefined,
    makeCanvas: () => context(true),
  }
}

async function render(
  name: string,
  height: number,
  /** `async`: through the export's entry point, renderPrintAsync, instead of
   *  the preview's (the parity gate renders both). `bandRows`, `tile`: see
   *  ExportOnly. */
  opts: { photo?: number; png?: boolean; async?: boolean } & ExportOnly = {},
): Promise<RenderResult> {
  const exportOpts = exportOptions(opts)
  const settings = load(name)
  const media = settings.media
    ? await photoBitmap(settings.media.width, settings.media.height, opts.photo)
    : null
  const out = context(false)
  const scratch = context(true)
  const cacheRef: { current: RenderCache | null } = { current: null }

  const t0 = performance.now()
  if (opts.async) await renderPrintAsync(out, scratch, settings, height, media, inputsOf(settings), exportOpts)
  else renderPrint(out, scratch, settings, cacheRef, null, height, media, inputsOf(settings))
  const ms = performance.now() - t0

  const { width: w, height: h } = out.canvas
  const pixels = out.getImageData(0, 0, w, h).data
  const sha256 = hex(await crypto.subtle.digest('SHA-256', pixels))
  // For eyeballing: the render as a PNG, when asked.
  const png = opts.png ? out.canvas.toDataURL('image/png') : undefined
  // Let the big buffers go before the next render.
  out.canvas.width = 0
  scratch.canvas.width = 0
  return { sha256, ms, w, h, native: groundNative(settings, w, h), png }
}

/** A render through the export entry, its pixels and where any plate inked
 *  (coverage over 0 in any plane), for the seam report. */
async function exportPixels(settings: PrintSettings, height: number, opts: ExportOnly & { photo?: number }, ground?: ImageBitmap) {
  const media = ground ?? (settings.media ? await photoBitmap(settings.media.width, settings.media.height, opts.photo) : null)
  const out = context(false)
  const scratch = context(true)
  let inked: Uint8Array | null = null
  await renderPrintAsync(out, scratch, settings, height, media, inputsOf(settings), {
    ...exportOptions({ ...opts, async: true }),
    onBand: (layers, y0, y1) => {
      const w = out.canvas.width
      inked ??= new Uint8Array(w * out.canvas.height)
      const n = (y1 - y0) * w
      for (const l of layers) for (let i = 0; i < n; i++) if (l.coverage[i] > 0) inked[y0 * w + i] = 1
    },
  })
  const { width: w, height: h } = out.canvas
  const data = out.getImageData(0, 0, w, h).data
  out.canvas.width = 0
  scratch.canvas.width = 0
  return { data, w, h, inked: inked ?? new Uint8Array(w * h) }
}

/**
 * Tiles against one canvas (P-4): the document through the export entry on
 * the tile grid `tile` and on a single tile as large as the sheet, compared
 * pixel by pixel. Reports the differing output pixels against the inked ones
 * (where any plate's coverage is over 0 in the single-tile render), how many
 * differ by more than 128 levels, the plates whose box crosses a seam of the
 * grid, and whether every differing pixel lies inside the box of such a plate
 * (its line boxes turned and placed as drawn, widened by its halo and half its
 * font size): every pixel, at any level, except over a resampled ground, which
 * differs by a level along its own seams wherever they run (those one-level
 * differences are let off the box test there, and only there).
 */
async function seam(name: string, height: number, tile: [number, number], opts: { photo?: number; glyphsOnly?: boolean } = {}) {
  const settings = load(name)
  // `glyphsOnly`: the type's share alone. The photo is drawn once, as one
  // canvas would draw it, and both renders take that same ground at its own
  // pixels (a copy, the same bytes on any grid), so only the glyphs' tiles
  // differ.
  let ground: ImageBitmap | undefined
  let pressed = settings
  if (opts.glyphsOnly && settings.media) {
    const { w, h } = outputSize(sheetAspect(settings), height)
    const c = context(true)
    c.canvas.width = w
    c.canvas.height = h
    const photo = await photoBitmap(settings.media.width, settings.media.height, opts.photo)
    c.imageSmoothingQuality = 'high'
    const r = groundRect(settings, w, h)
    c.drawImage(photo, r.dx, r.dy, r.dw, r.dh)
    ground = await createImageBitmap(c.canvas)
    c.canvas.width = 0
    pressed = { ...settings, media: { ...settings.media, width: w, height: h, scale: 1, x: 0.5, y: 0.5 } }
  }
  const a = await exportPixels(pressed, height, { tile, photo: opts.photo }, ground)
  const b = await exportPixels(pressed, height, { tile: [1 << 20, 2 ** 40], photo: opts.photo }, ground)
  ground?.close()
  const { w, h } = a
  const grid = tileGrid(w, h, { edge: tile[0], pixels: tile[1] })
  // Every plate's box on the sheet, as drawn, and whether it crosses a seam.
  const measureCtx = context(true)
  const plates: { id: string; kind: string; box: { x0: number; y0: number; x1: number; y1: number }; crosses: boolean; widened: { x0: number; y0: number; x1: number; y1: number } }[] = []
  let index = 0
  for (const layer of settings.layers) {
    const plan = planGlyphs(measureCtx, layer, h)
    const rects = lineRects(plan.layout, layer.align, plan.blockLeft, plan.firstBaseline)
    const turn = (layer.rotation * Math.PI) / 180
    const [c, sn] = [Math.cos(turn), Math.sin(turn)]
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of rects) {
      for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
        const X = layer.x * w + px * c - py * sn
        const Y = layer.y * h + px * sn + py * c
        x0 = Math.min(x0, X)
        y0 = Math.min(y0, Y)
        x1 = Math.max(x1, X)
        y1 = Math.max(y1, Y)
      }
    }
    for (const kind of layer.backing ? ['backing', 'type'] : ['type']) {
      const g = plateGeometry(settings.press, { fontSize: plan.fontSize, index }, settings.seed, h)
      const pad = plateHalo(g).total + plan.fontSize / 2
      const crosses = rects.length > 0 && (Math.floor(y0 / grid.tileH) !== Math.floor((y1 - 1) / grid.tileH) || Math.floor(x0 / grid.tileW) !== Math.floor((x1 - 1) / grid.tileW))
      plates.push({ id: layer.id, kind, box: { x0, y0, x1, y1 }, crosses, widened: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad } })
      index++
    }
  }
  measureCtx.canvas.width = 0
  // A photo that is not at its own pixels is drawn on the tile grid too, and
  // a resampled ground differs from one canvas's by a level here and there
  // along a seam; through the second ink's switch and the knockout that
  // reaches the type over it, wherever the type is. So with such a ground
  // the type's differences are looked for in every plate's box.
  const resampled = !!pressed.media && !groundNative(pressed, w, h)
  let inked = 0
  let differ = 0
  let differBytes = 0
  let over1 = 0
  let over128 = 0
  let maxDiff = 0
  let outside = 0
  for (let i = 0; i < w * h; i++) {
    if (b.inked[i]) inked++
    let d = 0
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(a.data[i * 4 + k] - b.data[i * 4 + k])
      if (e) differBytes++
      d = Math.max(d, e)
    }
    if (d === 0) continue
    differ++
    if (d > 128) over128++
    maxDiff = Math.max(maxDiff, d)
    if (d > 1) over1++
    else if (resampled) continue
    const x = i % w
    const y = (i - x) / w
    if (!plates.some((p) => (p.crosses || resampled) && x >= p.widened.x0 && x < p.widened.x1 && y >= p.widened.y0 && y < p.widened.y1)) outside++
  }
  return {
    name,
    height,
    glyphsOnly: !!opts.glyphsOnly,
    w,
    h,
    tile: `${grid.tileW}x${grid.tileH}`,
    tiles: grid.cols * grid.rows,
    resampled,
    inked,
    differ,
    differBytes,
    bytes: w * h * 3,
    over1,
    over128,
    maxDiff,
    outside,
    pctOfInked: inked ? (100 * differ) / inked : 0,
    over128PctOfInked: inked ? (100 * over128) / inked : 0,
    pctOfBytes: (100 * differBytes) / (w * h * 3),
    crossing: plates.filter((p) => p.crosses).map((p) => `${p.kind} ${p.id}`),
  }
}

/**
 * The canvas font cap in this browser: a 9,800 px 'O' (over CANVAS_FONT_MAX,
 * under Chromium's own 10,000 px clamp) measured directly and as the engine
 * measures it over the cap (at fontSize / k, times k), in each face; and
 * what this browser does with a font over its clamp (12,000 px read back).
 */
function fontCap() {
  const ctx = context(true)
  const faces = defaultSettings().layers.map((l) => l.fontId)
  const rows = []
  for (const fontId of [...new Set([...faces, 'poster', 'grotesk', 'serif', 'mono'] as const)]) {
    for (const bold of [false, true]) {
      const layer = { ...defaultSettings().layers[0], fontId, bold, text: 'O', size: 1, tracking: 0 }
      const px = 9800
      ctx.font = cssFont(layerFont(layer, px))
      const direct = ctx.measureText('O').width
      const plan = planGlyphs(ctx, layer, px)
      const capped = plan.layout.lines[0].glyphs[0].width
      rows.push({ face: `${fontId}${bold ? ' bold' : ''}`, direct, capped, k: plan.k, rel: Math.abs(capped - direct) / direct })
    }
  }
  ctx.font = cssFont({ stack: 'serif', weight: 700, px: 12000 })
  const clamp = ctx.font
  ctx.canvas.width = 0
  return { rows, clamp }
}

/** Whether the document's photo lands on a w x h sheet at its own pixels. */
function groundNative(s: PrintSettings, w: number, h: number): boolean {
  if (!s.media) return false
  return isNativeRect(groundRect(s, w, h), s.media.width, s.media.height)
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
  renderPrint(out, scratch, settings, { current: null }, null, height, media, inputsOf(settings))
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
  const pressed = await savePrint(settings, media, inputsOf(settings), {
    format: opts.format,
    makeCanvas: detachedCanvas,
    onProgress: (p) => steps.push(`${p.step} ${p.band}/${p.bands}`),
    onGround: () => media?.close(),
  })
  const ms = performance.now() - t0
  const bmp = await createImageBitmap(pressed.blob)
  const decoded: [number, number] = [bmp.width, bmp.height]
  bmp.close()
  return { plan: pressed.plan, bytes: pressed.blob.size, decoded, ms, steps }
}

/**
 * A document and its photo, made ready before a measurement starts, so the
 * test photo's own canvas and decode are not counted against the press
 * (scripts/measure-export.mjs).
 */
let prepared: { settings: PrintSettings; media: ImageBitmap | null } | null = null
async function prepare(settings: PrintSettings): Promise<void> {
  prepared?.media?.close()
  let media: ImageBitmap | null = null
  if (settings.media) {
    const c = photoCanvas(settings.media.width, settings.media.height)
    media = await createImageBitmap(c)
    c.width = 0
  }
  prepared = { settings, media }
}

/** Press the prepared document through the real savePrint; the photo is
 *  closed once its last rows are in the print, as Save does. `pressMs` is
 *  the time to the last band, `ms` to the file, and `encodeMs` the JPEG
 *  encoder's own share of it (every row it took, and its finish), timed
 *  around its two methods. */
async function press(format: ExportFormat = 'jpeg'): Promise<{ w: number; h: number; bytes: number; ms: number; pressMs: number; encodeMs: number }> {
  if (!prepared) throw new Error('nothing prepared')
  const { settings, media } = prepared
  prepared = null
  let encodeMs = 0
  const proto = JpegEncoder.prototype as unknown as Record<'push' | 'finish', (this: unknown, ...a: unknown[]) => void>
  const real = { push: proto.push, finish: proto.finish }
  for (const name of ['push', 'finish'] as const) {
    proto[name] = function (this: unknown, ...a: unknown[]) {
      const t = performance.now()
      try {
        real[name].apply(this, a)
      } finally {
        encodeMs += performance.now() - t
      }
    }
  }
  const t0 = performance.now()
  let pressMs = 0
  try {
    const pressed = await savePrint(settings, media, inputsOf(settings), {
      format,
      makeCanvas: detachedCanvas,
      onGround: () => media?.close(),
      onProgress: (p) => {
        if (p.step === 'write') pressMs = performance.now() - t0
      },
    })
    return { w: pressed.plan.width, h: pressed.plan.height, bytes: pressed.blob.size, ms: performance.now() - t0, pressMs, encodeMs }
  } finally {
    Object.assign(proto, real)
  }
}

/** The RGBA a file decodes to, and its sha256. */
async function fileDigest(blob: Blob): Promise<{ sha256: string; w: number; h: number }> {
  const bmp = await createImageBitmap(blob)
  const { width: w, height: h } = bmp
  const ctx = context(true)
  ctx.canvas.width = w
  ctx.canvas.height = h
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const data = ctx.getImageData(0, 0, w, h).data
  ctx.canvas.width = 0
  return { sha256: hex(await crypto.subtle.digest('SHA-256', data)), w, h }
}

/**
 * File == canvas (P-5): the real savePrint, as a PNG (lossless), no taller
 * than `height`, decoded, against the export entry painting the same print
 * into a canvas at that height. The same pixels, or the file is not the
 * print the press made.
 */
async function fileParity(name: string, height: number): Promise<{ file: string; canvas: string; same: boolean; w: number; h: number }> {
  const settings = load(name)
  const media = settings.media ? await photoBitmap(settings.media.width, settings.media.height) : null
  const pressed = await savePrint(settings, media, inputsOf(settings), { format: 'png', maxHeight: height, makeCanvas: detachedCanvas })
  const file = await fileDigest(pressed.blob)
  const canvas = await render(name, pressed.plan.height, { async: true })
  return { file: file.sha256, canvas: canvas.sha256, same: file.sha256 === canvas.sha256 && file.w === canvas.w && file.h === canvas.h, w: file.w, h: file.h }
}

/**
 * The allocation retry (P-6): the real savePrint with the typed-array
 * constructors made to throw a RangeError ONCE, at set-up (the first array
 * of a megabyte or more) or mid-press (the first of 256 KB or more once the
 * second band has begun), against the same save with no fault. The same
 * file, pressed again from the first band in bands half as tall.
 */
async function retry(
  name: string,
  height: number,
  at: 'setup' | 'mid',
): Promise<{ clean: string; faulted: string; same: boolean; thrown: boolean; cleanBands: number; faultedBands: number }> {
  const run = async (fault: boolean) => {
    const settings = load(name)
    const media = settings.media ? await createImageBitmap(photoCanvas(settings.media.width, settings.media.height)) : null
    let bands = 0
    let band = 0
    let thrown = false
    const names = ['Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Int32Array'] as const
    const g = globalThis as unknown as Record<string, new (...a: unknown[]) => { byteLength: number }>
    const saved = names.map((n) => [n, g[n]] as const)
    if (fault) {
      for (const [n, Orig] of saved) {
        g[n] = class extends (Orig as unknown as new (...a: unknown[]) => { byteLength: number }) {
          constructor(...a: unknown[]) {
            super(...a)
            const big = at === 'setup' ? this.byteLength >= 1 << 20 : this.byteLength >= 1 << 18 && band >= 1
            if (!thrown && big && !(a[0] instanceof ArrayBuffer)) {
              thrown = true
              throw new RangeError('Array buffer allocation failed (injected)')
            }
          }
          static [Symbol.hasInstance](x: unknown) {
            return x instanceof (Orig as unknown as typeof Object)
          }
        } as unknown as new (...a: unknown[]) => { byteLength: number }
      }
    }
    try {
      const pressed = await savePrint(settings, media, inputsOf(settings), {
        maxHeight: height,
        makeCanvas: detachedCanvas,
        onGround: () => media?.close(),
        onProgress: (p) => {
          band = p.band
          bands = p.bands
        },
      })
      const bytes = new Uint8Array(await pressed.blob.arrayBuffer())
      return { sha: hex(await crypto.subtle.digest('SHA-256', bytes)), thrown, bands }
    } finally {
      for (const [n, Orig] of saved) g[n] = Orig
    }
  }
  const clean = await run(false)
  const faulted = await run(true)
  return { clean: clean.sha, faulted: faulted.sha, same: clean.sha === faulted.sha, thrown: faulted.thrown, cleanBands: clean.bands, faultedBands: faulted.bands }
}

/**
 * The save's encoders, checked by decoding what they write
 * (scripts/check-encode.mjs). The pixels, by name: a smooth gradient; a
 * saturated halftone (pink dots on paper with a little noise, 1023x771, not a
 * multiple of 8 either way: the case 4:2:0 smears); a real print
 * (photo-second-ink at 1000 px).
 */
async function encodeSource(kind: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  if (kind === 'print') return pixels('photo-second-ink', 1000)
  if (kind === 'gradient') {
    const w = 640
    const h = 480
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data.set([(x * 255) / (w - 1), (y * 255) / (h - 1), 128 + 60 * Math.sin((x + y) / 90), 255], (y * w + x) * 4)
    }
    return { data, w, h }
  }
  if (kind === 'halftone') {
    const w = 1023
    const h = 771
    const data = new Uint8ClampedArray(w * h * 4)
    let s = 1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        const u = (x * 0.7071 + y * 0.7071) / 12
        const v = (x * 0.7071 - y * 0.7071) / 12
        const dot = Math.hypot(u - Math.round(u), v - Math.round(v)) < 0.32 + 0.2 * Math.sin(x / 300)
        const n = ((s >>> 24) - 128) * 0.05
        data.set(dot ? [255 + n, 72 + n, 176 + n, 255] : [244 + n, 238 + n, 225 + n, 255], (y * w + x) * 4)
      }
    }
    return { data, w, h }
  }
  throw new Error(`unknown pixels "${kind}"`)
}

/** Decoded by the browser, as RGBA. */
async function decodeRgba(blob: Blob, w: number, h: number): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(blob)
  if (bmp.width !== w || bmp.height !== h) throw new Error(`decoded ${bmp.width}x${bmp.height}, not ${w}x${h}`)
  const ctx = context(true)
  ctx.canvas.width = w
  ctx.canvas.height = h
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const data = ctx.getImageData(0, 0, w, h).data
  ctx.canvas.width = 0
  return data
}

/** RMSE and the largest error over the colour channels. */
function errorOf(a: Uint8ClampedArray, b: Uint8ClampedArray): { rmse: number; max: number } {
  let se = 0
  let max = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const e = a[i + k] - b[i + k]
      se += e * e
      if (Math.abs(e) > max) max = Math.abs(e)
      n++
    }
  }
  return { rmse: Math.sqrt(se / n), max }
}

/** The frame header's sampling factors, e.g. "11 11 11" for 4:4:4. */
function samplingOf(bytes: Uint8Array): string {
  for (let i = 2; i + 3 < bytes.length; ) {
    if (bytes[i] !== 0xff) return '?'
    const marker = bytes[i + 1]
    const len = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker === 0xc0 || marker === 0xc2) {
      const n = bytes[i + 9]
      return Array.from({ length: n }, (_, c) => bytes[i + 11 + 3 * c].toString(16)).join(' ')
    }
    i += 2 + len
  }
  return '?'
}

async function encodeCheck(kind: string) {
  const { data, w, h } = await encodeSource(kind)
  const chunks: Uint8Array[] = []
  const t0 = performance.now()
  const jpeg = new JpegEncoder(w, h, 95, (c) => chunks.push(c))
  for (let y = 0; y < h; y += 64) {
    const n = Math.min(64, h - y)
    jpeg.push(data.subarray(y * w * 4, (y + n) * w * 4), n)
  }
  jpeg.finish()
  const ms = performance.now() - t0
  const blob = new Blob(chunks as BlobPart[], { type: 'image/jpeg' })
  const ours = errorOf(data, await decodeRgba(blob, w, h))
  // Chromium's own JPEG at 0.95, from a canvas of the same pixels.
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0)
  const theirs = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.95))
  c.width = 0
  return {
    kind,
    w,
    h,
    bytes: blob.size,
    msPerMP: Math.round(ms / ((w * h) / 1e6)),
    ...ours,
    sampling: samplingOf(new Uint8Array(await blob.arrayBuffer())),
    chromium: { ...errorOf(data, await decodeRgba(theirs, w, h)), bytes: theirs.size, sampling: samplingOf(new Uint8Array(await theirs.arrayBuffer())) },
  }
}

/** The PNG encoder on the same pixels: decoded by the browser it must be the
 *  input exactly, compressed (CompressionStream) and stored; its size beside
 *  Chromium's own PNG of the same pixels. The rows go in as a band loop pushes
 *  them, 150 at a time with `settled()` between, so each band fills several
 *  batches that the encoder fills again once Chromium's compressor has taken
 *  them. */
async function pngCheck(kind: string) {
  const { data, w, h } = await encodeSource(kind)
  const result: Record<string, { bytes: number; ms: number; rmse: number; max: number }> = {}
  const band = 150
  for (const compression of ['deflate', 'stored'] as const) {
    const chunks: Uint8Array[] = []
    const t0 = performance.now()
    const png = new PngEncoder(w, h, (c) => chunks.push(c), { compression, bandRows: band })
    for (let y = 0; y < h; y += band) {
      const n = Math.min(band, h - y)
      png.push(data.subarray(y * w * 4, (y + n) * w * 4), n)
      await png.settled()
    }
    await png.finish()
    const ms = performance.now() - t0
    const blob = new Blob(chunks as BlobPart[], { type: 'image/png' })
    result[compression] = { bytes: blob.size, ms: Math.round(ms), ...errorOf(data, await decodeRgba(blob, w, h)) }
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0)
  const theirs = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
  c.width = 0
  return { kind, w, h, deflate: result.deflate, stored: result.stored, chromiumBytes: theirs.size }
}

const b64 = (bytes: Uint8Array | Uint8ClampedArray): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string): Uint8ClampedArray<ArrayBuffer> => Uint8ClampedArray.from(atob(s), (c) => c.charCodeAt(0))

/** One case of the Border Studio parity gate (scripts/parity-borders.mjs). */
export interface ParityCase {
  aspect: PrintSettings['aspect']
  frame: FrameSettings
  /** The block photo, RGBA, base64, at its own size; and the hex Border
   *  Studio keyed from it, which the document carries as its palette. */
  photo: { width: number; height: number; rgba: string; palette: FramePalette }
  /** The reference's height: the sheet is rendered at the reference's size. */
  height: number
  /** The reference PNG, base64. */
  ref: string
}

/**
 * The frame through the real engine (the export's entry, renderPrintAsync,
 * what Save presses) against Border Studio's frozen render of the same frame:
 * the paper veil off and one plate with no text, so the sheet is the ground
 * alone, the photo the block photo Border Studio framed and the palette the
 * hex it keyed. Returns both as RGBA (base64); the gate's numbers are the
 * script's.
 */
async function parityBorders(c: ParityCase): Promise<{ w: number; h: number; pm: string; refW: number; refH: number; ref: string }> {
  const base = defaultSettings()
  const raw: PrintSettings = {
    ...base,
    aspect: c.aspect,
    paperVeil: false,
    frame: c.frame,
    layers: [{ ...base.layers[0], text: '' }],
    media: makeMedia({ id: 'parity-photo', width: c.photo.width, height: c.photo.height, native: true, palette: c.photo.palette }),
  }
  // Through the normaliser, as a stored print would come: what the app can
  // hold, and nothing it would change.
  const settings = normalizeSettings ? normalizeSettings(JSON.parse(JSON.stringify(raw)), { measure: canvasMeasure?.() }) : raw
  if (JSON.stringify(settings.frame) !== JSON.stringify(c.frame) || JSON.stringify(settings.media?.palette) !== JSON.stringify(c.photo.palette)) {
    throw new Error(`the normaliser changed the parity document: ${JSON.stringify(settings.frame)} ${JSON.stringify(settings.media?.palette)}`)
  }
  const pixels = new ImageData(unb64(c.photo.rgba), c.photo.width, c.photo.height)
  const photo = await createImageBitmap(pixels)
  // Frosted's field as the app makes it: the photo's bytes (a PNG of the
  // block photo, lossless) through the app's own frame source (decoded at
  // its fixed size and read back), then the field at the save's size.
  const inputs = storedFrameInputs(settings)
  if (settings.frame.fill === 'frosted') {
    const png = context(true)
    png.canvas.width = c.photo.width
    png.canvas.height = c.photo.height
    png.putImageData(pixels, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => png.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
    png.canvas.width = 0
    const src = await frameSources({ ...PAGE_SOURCE_DEPS, getBlob: async () => blob }).load(settings.media!)
    inputs.frost = frostField(src, sheetAspect(settings), FROST_FIELD_LONG, settings.frame.blur)
  }
  const out = context(false)
  const scratch = context(true)
  await renderPrintAsync(out, scratch, settings, c.height, photo, inputs, { makeCanvas: () => context(true) })
  photo.close()
  const { width: w, height: h } = out.canvas
  const pm = out.getImageData(0, 0, w, h).data
  out.canvas.width = 0
  scratch.canvas.width = 0
  // The reference, decoded as capture.mjs proved Chromium decodes it: the
  // captured bytes exactly.
  const bmp = await createImageBitmap(new Blob([unb64(c.ref)], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const { width: refW, height: refH } = bmp
  const r = context(true)
  r.canvas.width = refW
  r.canvas.height = refH
  r.drawImage(bmp, 0, 0)
  const ref = r.getImageData(0, 0, refW, refH).data
  bmp.close()
  r.canvas.width = 0
  return { w, h, pm: b64(pm), refW, refH, ref: b64(ref) }
}

/**
 * The whole chain, Frosted (the one fill that needs the photo's own pixels at
 * Save): a photo imported for real (into this page's IndexedDB), its palette
 * made by the page's maker from it and stored with it (as `setPalette` does,
 * then through the normaliser, as a reopened document is), a document with a
 * plate over it in Frosted. The preview's inputs as the page's preview makes
 * them (`previewFrameInputs`: the frame source decoded from the stored file,
 * the settled field), Save's as Save makes them (`ensureFrameInputs`); the
 * same field, kept. Then the preview's render, the export's and the file the
 * real `savePrint` writes (a PNG), at one height: the same bytes from all
 * three, or the preview is not the print.
 */
async function chain(height: number): Promise<{ preview: string; exported: string; file: string; same: boolean; sameField: boolean; w: number; h: number; palette: FramePalette | null }> {
  const c = photoCanvas(1600, 1200)
  const png = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
  c.width = 0
  const { layer } = await importMedia(png)
  try {
    const palette = await pageFramePalettes.palette(layer)
    if (!palette) throw new Error('chain: the photo keyed no palette')
    const base = defaultSettings()
    const raw: PrintSettings = {
      ...base,
      aspect: 'original',
      media: { ...layer, palette },
      frame: { ...base.frame, width: 0.1, corners: 0.6, fill: 'frosted', blur: 150 },
      layers: [base.layers[0]],
    }
    const settings = normalizeSettings ? normalizeSettings(JSON.parse(JSON.stringify(raw)), { measure: canvasMeasure?.() }) : raw
    if (JSON.stringify(settings.media?.palette) !== JSON.stringify(palette)) throw new Error('chain: the stored palette did not survive the normaliser')
    // Save's inputs, then the settled preview's, as each is made in the page.
    const inputs = await ensureFrameInputs(settings)
    const shown = previewFrameInputs(settings, { id: layer.id, src: await pageFrameSources.load(layer) }, false)
    if (!inputs.frost || !shown.frost) throw new Error('chain: no frost field made')
    const photo = await decodeOriginal(layer.id)
    const pressed = await savePrint(settings, photo, inputs, { format: 'png', maxHeight: height, makeCanvas: detachedCanvas })
    const file = await fileDigest(pressed.blob)
    const at = pressed.plan.height
    const media = await decodeOriginal(layer.id)
    const shaOf = async (ctx: CanvasRenderingContext2D) => {
      const d = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data
      return hex(await crypto.subtle.digest('SHA-256', d))
    }
    const a = context(false)
    renderPrint(a, context(true), settings, { current: null }, null, at, media, shown)
    const preview = await shaOf(a)
    const b = context(false)
    await renderPrintAsync(b, context(true), settings, at, media, inputs, { makeCanvas: () => context(true) })
    const exported = await shaOf(b)
    const w = b.canvas.width
    const h = b.canvas.height
    for (const ctx of [a, b]) ctx.canvas.width = 0
    media.close()
    const sameField = shown.frost === inputs.frost
    return { preview, exported, file: file.sha256, same: sameField && preview === exported && exported === file.sha256 && file.w === w && file.h === h, sameField, w, h, palette }
  } finally {
    await deleteMedia(layer.id)
  }
}

/** The palette the frame-cost documents carry. */
const COST_PALETTE: FramePalette = { photo: '#3d7fa6', deep: '#16222b', muted: '#9fb3c0', comp: '#c4783a' }

/** The frame-cost gate's documents, each with the photo the preview draws
 *  it from: `native-photo` with its own 2400x3000 photo, and a 12 MP photo
 *  (4032x3024 on 4:5) from the working copy the preview decodes of it. */
const COST_DOCS: Record<string, () => { settings: PrintSettings; copy: boolean }> = {
  'native-photo': () => ({ settings: load('native-photo'), copy: false }),
  'photo-12mp': () => ({ settings: withPhoto(defaultSettings(), 4032, 3024), copy: true }),
}

/** What the frame-cost gate frames a document with: the first photo's
 *  width, round corners, the photo's own colour, in Crop or in Fit; or
 *  Frosted at its default Blur, in Crop. */
const COST_FRAMES: Record<string, Partial<FrameSettings> | null> = {
  none: null,
  crop: { width: 1 / 14, corners: 1, fill: 'photo', mode: 'crop' },
  fit: { width: 1 / 14, corners: 1, fill: 'photo', mode: 'fit' },
  frosted: { width: 1 / 14, corners: 1, fill: 'frosted', blur: 60, mode: 'crop' },
}

const costRigs = new Map<
  string,
  { settings: PrintSettings; media: ImageBitmap; height: number; out: CanvasRenderingContext2D; scratch: CanvasRenderingContext2D; cache: { current: RenderCache | null }; inputs: FrameInputs; fieldLong: number }
>()

/**
 * A preview render of a document, framed or not, at the settled or the
 * draft size, timed (ms a render): what a person waits for at each change
 * of the frame. Each (document, frame, size) keeps its canvases and its
 * render cache across calls, as the preview does, and is rendered once
 * untimed first; so a timing is the steady cost of a frame of the preview,
 * the photo drawn and the frame composed afresh every time. Frosted's field
 * is made once, as the page keeps it (480 settled, 160 draft). `bare` renders
 * the same framed document with the same canvases and cache, its frame's
 * compose skipped (the preview's test seam, README "Test seams"): the photo
 * drawn into the same rectangle, so the two differ by the frame's own work
 * alone. `remake` (Frosted) makes the field again inside the timed render,
 * at a blur one off the last, as a Blur change (or a Width change on
 * Original, which changes the sheet's shape) does.
 */
async function frameCost(doc: string, frame: string, draft: boolean, bare = false, remake = false): Promise<{ ms: number; w: number; h: number }> {
  const key = `${doc}|${frame}|${draft}`
  let rig = costRigs.get(key)
  if (!rig) {
    const made = COST_DOCS[doc]?.()
    if (!made || !(frame in COST_FRAMES)) throw new Error(`unknown frame-cost case ${key}`)
    const { settings, copy } = made
    const f = COST_FRAMES[frame]
    if (f) {
      settings.frame = { ...settings.frame, ...f }
      settings.media = { ...settings.media!, palette: COST_PALETTE }
    }
    const m = settings.media!
    const aspect = sheetAspect(settings)
    const size = copy ? (workingSize(m.width, m.height, previewArea(m, aspect, { width: settings.frame.width, mode: effectiveMode(settings) })) ?? { width: m.width, height: m.height }) : { width: m.width, height: m.height }
    const c = photoCanvas(size.width, size.height)
    const media = await createImageBitmap(c)
    c.width = 0
    const fieldLong = draft ? FROST_DRAFT_LONG : FROST_FIELD_LONG
    rig = { settings, media, height: (draft ? draftSize(aspect) : previewSize(aspect)).h, out: context(false), scratch: context(true), cache: { current: null }, inputs: inputsOf(settings, fieldLong), fieldLong }
    costRigs.set(key, rig)
    renderPrint(rig.out, rig.scratch, settings, rig.cache, null, rig.height, media, rig.inputs)
  }
  const seam = globalThis as { __PM_TEST__?: unknown }
  const before = seam.__PM_TEST__
  if (bare) seam.__PM_TEST__ = { skipFrameCompose: true }
  try {
    const r = rig
    const t0 = performance.now()
    if (remake) {
      // A blur one off the last: a field that is not kept, made now.
      const blur = r.settings.frame.blur === 60 ? 61 : 60
      r.settings = { ...r.settings, frame: { ...r.settings.frame, blur } }
      r.inputs = { ...r.inputs, frost: frostField(frameSourceOf(r.settings.media!), sheetAspect(r.settings), r.fieldLong, blur) }
    }
    renderPrint(r.out, r.scratch, r.settings, r.cache, null, r.height, r.media, r.inputs)
    const ms = performance.now() - t0
    return { ms, w: r.out.canvas.width, h: r.out.canvas.height }
  } finally {
    seam.__PM_TEST__ = before
  }
}

declare global {
  interface Window {
    H: {
      docs: string[]
      render: typeof render
      seam: typeof seam
      fontCap: typeof fontCap
      fileParity: typeof fileParity
      retry: typeof retry
      scaleCorrelation: typeof scaleCorrelation
      save: typeof save
      prepare: typeof prepare
      press: typeof press
      encodeCheck: typeof encodeCheck
      pngCheck: typeof pngCheck
      parityBorders: typeof parityBorders
      frameCost: typeof frameCost
      chain: typeof chain
      normalized: boolean
    }
  }
}

window.H = { docs: Object.keys(DOCS), render, seam, fontCap, fileParity, retry, scaleCorrelation, save, prepare, press, encodeCheck, pngCheck, parityBorders, frameCost, chain, normalized: !!normalizeSettings }
