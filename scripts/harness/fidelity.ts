/**
 * Does a saved print keep every pixel of the photo? The REAL import
 * (`importMedia`, into this page's IndexedDB), the REAL decode for Save
 * (`decodeOriginal`) and the REAL `savePrint`, on generated photos, with the
 * type taken off and the paper veil off so that the print IS the photo
 * ground. Driven by scripts/measure-fidelity.mjs, which holds the gates.
 *
 * The photos are made here, so there are no binary fixtures: a zone plate
 * (rings that run up to 0.45 cycles per pixel at the corners, so any
 * resampling shows), a JPEG whose EXIF says "rotate me", and a PNG with a
 * transparent hole.
 */

import { MissingPhotoError, describePlan, planPrint, savePrint, type ExportFormat } from '../../src/engine/export.ts'
import { groundRect } from '../../src/engine/render.ts'
import type { PrintSettings } from '../../src/engine/types.ts'
import { decodeOriginal, decodeOriented } from '../../src/features/media/decode.ts'
import { importMedia } from '../../src/features/media/importMedia.ts'
import { detachedCanvas } from '../../src/features/shell/page.ts'
import { defaultSettings } from '../../src/state/defaults.ts'
import { deleteMedia, getMedia } from '../../src/state/mediaStore.ts'

function canvas(w: number, h: number, willReadFrequently = true): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently })
  if (!ctx) throw new Error('no 2D context')
  return ctx
}

const encode = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error(`could not encode ${type}`))), type, quality))

/** A zone plate: cos(k r^2) about the centre, its local frequency k r / pi
 *  reaching 0.45 cycles per pixel at the corners. */
function zonePlate(w: number, h: number): HTMLCanvasElement {
  const ctx = canvas(w, h)
  const img = ctx.createImageData(w, h)
  const d = img.data
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const k = (0.45 * Math.PI) / Math.hypot(cx, cy)
  for (let y = 0; y < h; y++) {
    const dy = y - cy
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const v = 128 + 110 * Math.cos(k * (dx * dx + dy * dy))
      const o = (y * w + x) * 4
      d[o] = d[o + 1] = d[o + 2] = v
      d[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return ctx.canvas
}

/** A JPEG with an EXIF APP1 that says Orientation = `orientation`, inserted
 *  after the SOI marker of the browser's own encode. */
async function withOrientation(jpeg: Blob, orientation: number): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer())
  // "Exif\0\0", a big-endian TIFF header, one IFD with one SHORT entry.
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const len = payload.length + 2
  const app1 = [0xff, 0xe1, len >> 8, len & 255, ...payload]
  return new Blob([bytes.subarray(0, 2), new Uint8Array(app1), bytes.subarray(2)], { type: 'image/jpeg' })
}

async function sha256(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function luma(d: Uint8ClampedArray): Float32Array {
  const n = d.length / 4
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
  return out
}

/** Sum of the squared 4-neighbour Laplacian over the interior: the energy in
 *  the finest detail, which any resampling takes down. */
function laplacian(l: Float32Array, w: number, h: number): number {
  let e = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = 4 * l[i] - l[i - 1] - l[i + 1] - l[i - w] - l[i + w]
      e += v * v
    }
  }
  return e
}

function correlation(a: Float32Array, b: Float32Array, where?: (i: number) => boolean): number {
  let n = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.length; i++) {
    if (where && !where(i)) continue
    n++
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    if (where && !where(i)) continue
    const x = a[i] - ma
    const y = b[i] - mb
    ab += x * y
    aa += x * x
    bb += y * y
  }
  return ab / Math.sqrt(aa * bb)
}

/** The document the print is only the photo in: every plate's text empty,
 *  the paper veil off. */
function photoOnly(media: PrintSettings['media'], aspect: PrintSettings['aspect']): PrintSettings {
  const s = defaultSettings()
  s.layers = s.layers.map((l) => ({ ...l, text: '' }))
  s.paperVeil = false
  s.aspect = aspect
  s.media = media
  return s
}

async function pixelsOf(blob: Blob): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const bmp = await createImageBitmap(blob)
  const { width: w, height: h } = bmp
  const ctx = canvas(w, h)
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const data = ctx.getImageData(0, 0, w, h).data
  ctx.canvas.width = 0
  return { data, w, h }
}

/** Import `file` for real, then save `settings` (built from the imported
 *  layer) for real, as Save does. */
async function importAndSave(file: Blob, aspect: PrintSettings['aspect'], format: ExportFormat, zoom = 1) {
  const imported = (await importMedia(file)).layer
  const stored = await getMedia(imported.id)
  const byteForByte = !!stored && stored.size === file.size && (await sha256(stored)) === (await sha256(file))
  // Zoomed (to crop) as the Photo tool would: centred, at `zoom` on the cover
  // fit.
  const layer = { ...imported, scale: zoom }
  const s = photoOnly(layer, aspect)
  const plan = planPrint(s)
  const original = await decodeOriginal(layer.id)
  const t0 = performance.now()
  // As Save presses it (useSave.ts): its own canvases, the photo closed once
  // its last rows are in the print.
  const pressed = await savePrint(s, original, { format, makeCanvas: detachedCanvas, onGround: () => original.close() })
  const ms = performance.now() - t0
  return { layer, byteForByte, s, plan, pressed, ms }
}

/**
 * A zone plate of w x h through import and Save on `aspect`, at `zoom`,
 * compared with the part of the original the sheet shows, drawn at its own
 * pixels.
 */
async function zone(w: number, h: number, aspect: PrintSettings['aspect'], format: ExportFormat = 'png', zoom = 1, alsoJpeg = false) {
  const file = await encode(zonePlate(w, h), 'image/jpeg', 0.92)
  const { layer, byteForByte, s, plan, pressed, ms } = await importAndSave(file, aspect, format, zoom)
  const out = await pixelsOf(pressed.blob)
  const r = groundRect(layer, plan.width, plan.height)
  const aligned = r.dw === layer.width && r.dh === layer.height && Number.isInteger(r.dx) && Number.isInteger(r.dy)
  // The reference: the original, decoded as Save decodes it, drawn at the
  // sheet's rectangle (when that is the photo's own pixels, an integer
  // offset at scale 1: the integer-aligned crop).
  const ref = canvas(plan.width, plan.height)
  const bmp = await decodeOriented(file)
  ref.imageSmoothingQuality = 'high'
  ref.drawImage(bmp, r.dx, r.dy, r.dw, r.dh)
  bmp.close()
  const refData = ref.getImageData(0, 0, plan.width, plan.height).data
  ref.canvas.width = 0
  const same = out.w === plan.width && out.h === plan.height
  const a = luma(out.data)
  const b = luma(refData)
  // The largest difference in any channel of any pixel: 0 is the photo's own
  // pixels, exactly.
  let maxDiff = 0
  if (same) for (let i = 0; i < refData.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out.data[i] - refData[i]))
  // The same print saved as Save saves it by default, a JPEG: its size and
  // its sampling, read from its own frame header.
  let jpeg: (ReturnType<typeof frameOf> & { bytes: number; ms: number }) | null = null
  if (alsoJpeg) {
    const again = await decodeOriginal(layer.id)
    const t1 = performance.now()
    const saved = await savePrint(s, again, { format: 'jpeg', makeCanvas: detachedCanvas, onGround: () => again.close() })
    jpeg = { ...frameOf(new Uint8Array(await saved.blob.arrayBuffer())), bytes: saved.blob.size, ms: Math.round(performance.now() - t1) }
  }
  await deleteMedia(layer.id)
  return {
    photo: `${w}x${h}`,
    aspect,
    zoom,
    format,
    stored: { byteForByte, fileBytes: file.size, layer: `${layer.width}x${layer.height}` },
    plan: { width: plan.width, height: plan.height, limit: plan.limit },
    caption: describePlan(plan, s.media),
    file: `${out.w}x${out.h}`,
    dimsMatch: same,
    aligned,
    lapRatio: same ? laplacian(a, out.w, out.h) / laplacian(b, out.w, out.h) : NaN,
    corr: same ? correlation(a, b) : NaN,
    maxDiff: same ? maxDiff : NaN,
    ms: Math.round(ms),
    jpeg,
  }
}

/** A JPEG's frame header (SOFn): which one, the image's size, and each
 *  component's sampling factors, horizontal and vertical ("11 11 11" is
 *  4:4:4, every colour sample kept). */
function frameOf(b: Uint8Array): { marker: string; file: string; sampling: string } {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6]
      const w = (b[i + 7] << 8) | b[i + 8]
      const factors: string[] = []
      for (let c = 0; c < b[i + 9]; c++) factors.push(b[i + 11 + 3 * c].toString(16).padStart(2, '0'))
      return { marker: `SOF${m - 0xc0}`, file: `${w}x${h}`, sampling: factors.join(' ') }
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3])
  }
  return { marker: 'none', file: '?', sampling: '?' }
}

/**
 * The gates can fail: the same zone plate, 4032x3024 on 4:5, drawn the two
 * ways this app used to draw it — half a pixel off its grid (the unsnapped
 * cover fit), and from a 2048 px copy enlarged back (the old import) —
 * scored against the same reference as `zone`.
 */
async function controls() {
  const w = 4032
  const h = 3024
  const file = await encode(zonePlate(w, h), 'image/jpeg', 0.92)
  const layer = { id: 'control', width: w, height: h, scale: 1, x: 0.5, y: 0.5 }
  const plan = planPrint(photoOnly(layer, '4:5'))
  const r = groundRect(layer, plan.width, plan.height)
  const bmp = await decodeOriented(file)
  const draw = (src: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) => {
    const ctx = canvas(plan.width, plan.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, dx, dy, dw, dh)
    const l = luma(ctx.getImageData(0, 0, plan.width, plan.height).data)
    ctx.canvas.width = 0
    return l
  }
  const ref = draw(bmp, r.dx, r.dy, r.dw, r.dh)
  const score = (l: Float32Array) => ({
    lapRatio: laplacian(l, plan.width, plan.height) / laplacian(ref, plan.width, plan.height),
    corr: correlation(l, ref),
  })
  const halfPixel = score(draw(bmp, r.dx + 0.5, r.dy, r.dw, r.dh))
  const copy = await createImageBitmap(bmp, { resizeWidth: 2048, resizeHeight: 1536, resizeQuality: 'high' })
  const oldImport = score(draw(copy, r.dx, r.dy, r.dw, r.dh))
  copy.close()
  bmp.close()
  return { halfPixel, oldImport }
}

/** A JPEG stored sideways with EXIF Orientation 6 (rotate 90 clockwise): its
 *  left half red, its right half blue, so upright the top is red. */
async function orientation() {
  const W = 2400
  const H = 1800
  const ctx = canvas(W, H)
  ctx.fillStyle = 'rgb(220, 30, 30)'
  ctx.fillRect(0, 0, W / 2, H)
  ctx.fillStyle = 'rgb(30, 30, 220)'
  ctx.fillRect(W / 2, 0, W / 2, H)
  const file = await withOrientation(await encode(ctx.canvas, 'image/jpeg', 0.92), 6)
  ctx.canvas.width = 0
  const { layer, byteForByte, plan, pressed } = await importAndSave(file, 'original', 'png')
  const out = await pixelsOf(pressed.blob)
  const mean = (y0: number, y1: number) => {
    let r = 0
    let b = 0
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < out.w; x++) {
        r += out.data[(y * out.w + x) * 4]
        b += out.data[(y * out.w + x) * 4 + 2]
      }
    }
    const n = (y1 - y0) * out.w
    return { r: Math.round(r / n), b: Math.round(b / n) }
  }
  await deleteMedia(layer.id)
  return {
    stored: { byteForByte, layer: `${layer.width}x${layer.height}` },
    plan: `${plan.width}x${plan.height} ${plan.limit}`,
    file: `${out.w}x${out.h}`,
    topQuarter: mean(0, Math.floor(out.h / 4)),
    bottomQuarter: mean(out.h - Math.floor(out.h / 4), out.h),
  }
}

/** A PNG with a transparent hole: the hole prints as paper, never black, and
 *  the rest is the photo's own pixels. */
async function pngAlpha() {
  const W = 1600
  const H = 2000
  const ctx = canvas(W, H)
  ctx.drawImage(zonePlate(W, H), 0, 0)
  const hole = { x0: 500, y0: 700, x1: 1100, y1: 1300 }
  ctx.clearRect(hole.x0, hole.y0, hole.x1 - hole.x0, hole.y1 - hole.y0)
  const file = await encode(ctx.canvas, 'image/png')
  ctx.canvas.width = 0
  const { layer, byteForByte, plan, pressed } = await importAndSave(file, 'original', 'png')
  const out = await pixelsOf(pressed.blob)
  const r = groundRect(layer, plan.width, plan.height)
  const ref = canvas(plan.width, plan.height)
  const bmp = await decodeOriented(file)
  ref.drawImage(bmp, r.dx, r.dy, r.dw, r.dh)
  bmp.close()
  const refData = ref.getImageData(0, 0, plan.width, plan.height).data
  ref.canvas.width = 0
  const l = luma(out.data)
  // Inside the hole, inset 4 px from its edge (where the type would have been
  // anti-aliased had there been any).
  const inHole = (i: number) => {
    const x = (i % out.w) - r.dx
    const y = Math.floor(i / out.w) - r.dy
    return x >= hole.x0 + 4 && x < hole.x1 - 4 && y >= hole.y0 + 4 && y < hole.y1 - 4
  }
  const opaque = (i: number) => refData[i * 4 + 3] === 255
  let min = 255
  let sum = 0
  let n = 0
  for (let i = 0; i < l.length; i++) {
    if (!inHole(i)) continue
    min = Math.min(min, l[i])
    sum += l[i]
    n++
  }
  await deleteMedia(layer.id)
  return {
    stored: { byteForByte, layer: `${layer.width}x${layer.height}` },
    plan: `${plan.width}x${plan.height} ${plan.limit}`,
    file: `${out.w}x${out.h}`,
    hole: { meanLuma: Math.round(sum / n), minLuma: Math.round(min), pixels: n },
    corrOpaque: correlation(l, luma(refData), opaque),
  }
}

/** A document whose stored photo has gone: Save's decode refuses, and so
 *  does savePrint, rather than print the type on bare paper. */
async function missingPhoto() {
  const file = await encode(zonePlate(400, 300), 'image/jpeg', 0.9)
  const { layer } = await importMedia(file)
  await deleteMedia(layer.id)
  const decodeError = await decodeOriginal(layer.id).then(
    () => null,
    (e: unknown) => e,
  )
  const s = photoOnly(layer, '4:5')
  s.layers = defaultSettings().layers
  let canvases = 0
  const saveError = await savePrint(s, null, {
    makeCanvas: () => {
      canvases++
      return canvas(0, 0)
    },
  }).then(
    () => null,
    (e: unknown) => e,
  )
  return {
    decodeRefused: decodeError instanceof MissingPhotoError,
    saveRefused: saveError instanceof MissingPhotoError,
    message: saveError instanceof Error ? saveError.message : null,
    // Refused before any canvas was made: nothing was pressed.
    canvasTouched: canvases !== 0,
  }
}

declare global {
  interface Window {
    F: {
      zone: typeof zone
      controls: typeof controls
      orientation: typeof orientation
      pngAlpha: typeof pngAlpha
      missingPhoto: typeof missingPhoto
    }
  }
}

window.F = { zone, controls, orientation, pngAlpha, missingPhoto }
