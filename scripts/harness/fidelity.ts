/**
 * Does a saved print keep every pixel of the photo, framed or not? The REAL import
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
import { cornerCoverage, layoutSheet } from '../../src/engine/frame.ts'
import type { FrostField } from '../../src/engine/frost.ts'
import { groundRect } from '../../src/engine/render.ts'
import type { FrameSettings, PrintSettings } from '../../src/engine/types.ts'
import { decodeOriginal, decodeOriented, decodeResized } from '../../src/features/media/decode.ts'
import { ensureFrameInputs, storedFrameInputs } from '../../src/features/media/frameInputs.ts'
import { importMedia } from '../../src/features/media/importMedia.ts'
import { detachedCanvas } from '../../src/features/shell/page.ts'
import { copyRect } from '../../src/features/shell/useSave.ts'
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
 *  reaching 0.45 cycles per pixel at the corners. With `sky`, its rings fade
 *  out toward the edges over a smooth colour gradient (warm to cool across,
 *  dark to light down): what a frosted border must carry without a stair. */
function zonePlate(w: number, h: number, sky = false): HTMLCanvasElement {
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
      const o = (y * w + x) * 4
      if (sky) {
        const fade = Math.max(0, 1 - Math.hypot(dx / cx, dy / cy))
        const ring = 60 * fade * Math.cos(k * (dx * dx + dy * dy))
        d[o] = 60 + (150 * x) / w + ring
        d[o + 1] = 70 + (110 * y) / h + ring
        d[o + 2] = 210 - (130 * x) / w + ring
      } else {
        d[o] = d[o + 1] = d[o + 2] = 128 + 110 * Math.cos(k * (dx * dx + dy * dy))
      }
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
  // Zoomed (to crop) as Frame › Place would: centred, at `zoom` on the cover
  // fit.
  const layer = { ...imported, scale: zoom }
  const s = photoOnly(layer, aspect)
  const plan = planPrint(s)
  const original = await decodeOriginal(layer.id)
  const t0 = performance.now()
  // As Save presses it (useSave.ts): its own canvases, the photo closed once
  // its last rows are in the print.
  const pressed = await savePrint(s, original, storedFrameInputs(s), { format, makeCanvas: detachedCanvas, onGround: () => original.close() })
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
  const r = groundRect(s, plan.width, plan.height)
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
    const saved = await savePrint(s, again, storedFrameInputs(s), { format: 'jpeg', makeCanvas: detachedCanvas, onGround: () => again.close() })
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
    caption: describePlan(plan, s),
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
  const s = photoOnly(layer, '4:5')
  const plan = planPrint(s)
  const r = groundRect(s, plan.width, plan.height)
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

/** The palette the framed prints carry (the frame's colour is looked up in
 *  it; computing it from the photo is not what is measured here). */
const FRAME_PALETTE = { photo: '#2896c8', deep: '#152228', muted: '#90b1c1', comp: '#cb712e' }
const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/**
 * A zone plate of w x h through the real import and the real Save, framed:
 * `frame` on `aspect`, as a PNG (and, with `jpeg`, again as Save's JPEG for
 * its header). With `smaller`, a smaller copy at that fraction of the height,
 * decoded at the photo's contained rectangle as Save decodes one (useSave
 * `copyRect`, `decodeResized`) and drawn 1:1. Every pixel of the file is
 * checked against what it must be:
 *  - outside the photo's rectangle (`shown`): the fill's colour exactly (the
 *    paper veil is off); Frosted's, the field sampled at that pixel exactly
 *    and rounded once (`exactFrost`, not the engine's sampler), its field
 *    made as Save makes it (`ensureFrameInputs`: the photo's frame source
 *    decoded from the stored file, the field at the save's size);
 *  - inside it, away from the corners: the photo Save drew (the original, or
 *    the smaller copy), at its own pixels, every byte;
 *  - in the corners' patches: the photo over the fill at the corner's exact
 *    coverage, c P + (1 - c) F, rounded once (within half a level).
 * And the Laplacian energy of the photo's rectangle (the corners masked)
 * against the same rectangle of the photo itself. Frosted also measures its
 * banding: along the sheet's middle row through the left border, the longest
 * run of one value in each channel, against the run the field itself gives
 * there (sampled exactly, in float64, and rounded once).
 */
async function framed(w: number, h: number, aspect: PrintSettings['aspect'], frame: Partial<FrameSettings>, opts: { jpeg?: boolean; smaller?: number; sky?: boolean } = {}) {
  const file = await encode(zonePlate(w, h, opts.sky), 'image/jpeg', 0.92)
  const imported = (await importMedia(file)).layer
  const layer = { ...imported, palette: FRAME_PALETTE }
  const s = photoOnly(layer, aspect)
  s.frame = { ...s.frame, ...frame }
  const full = planPrint(s)
  const maxHeight = opts.smaller ? Math.round(full.height * opts.smaller) : undefined
  const plan = planPrint(s, { maxHeight })
  const layout = layoutSheet(s, plan.width, plan.height)
  // The photo as Save decodes it: the original, or a smaller copy decoded at
  // its rectangle.
  const rect = opts.smaller ? (copyRect(s, plan) ?? undefined) : undefined
  const decode = () => (rect ? decodeResized(layer.id, rect.dw, rect.dh) : decodeOriginal(layer.id))
  // What Save makes the frame from (useSave `pressForSave`): Frosted's
  // field made now, from the stored photo; a colour from the palette held.
  const t00 = performance.now()
  const inputs = s.frame.fill === 'frosted' ? await ensureFrameInputs(s) : storedFrameInputs(s)
  const inputsMs = performance.now() - t00
  const photo = await decode()
  const t0 = performance.now()
  const pressed = await savePrint(s, photo, inputs, { format: 'png', maxHeight, rect, makeCanvas: detachedCanvas, onGround: () => photo.close() })
  const ms = performance.now() - t0
  const out = await pixelsOf(pressed.blob)
  // The reference: the same decode, read at its own size.
  const refBmp = await decode()
  const rw = refBmp.width
  const rh = refBmp.height
  const rc = canvas(rw, rh)
  rc.drawImage(refBmp, 0, 0)
  refBmp.close()
  const ref = rc.getImageData(0, 0, rw, rh).data
  rc.canvas.width = 0
  const drawn = rect ?? layout.photo!
  const aligned = drawn.dw === rw && drawn.dh === rh && Number.isInteger(drawn.dx) && Number.isInteger(drawn.dy)
  // The fill at a pixel: the colour, or Frosted's field sampled there,
  // exactly (in float64, by code of its own, not the engine's sampler) and
  // rounded once: a sampler that rounds before it has mixed, or a field
  // rounded to bytes before it is stretched, is off by a level somewhere.
  const frost = inputs.frost ? exactFrost(inputs.frost, plan.width, plan.height) : null
  const flat = frost ? null : hexRgb(FRAME_PALETTE[s.frame.fill as keyof typeof FRAME_PALETTE])
  const fillRow = new Uint8ClampedArray(plan.width * 4)
  let fillY = -1
  const fillAt = (x: number, y: number): ArrayLike<number> => {
    if (!frost) return flat!
    if (fillY !== y) {
      frost(y, 0, plan.width, fillRow, 0)
      fillY = y
    }
    return fillRow.subarray(x * 4, x * 4 + 3)
  }
  const { x0, y0, w: sw, h: sh } = layout.shown
  const patch = Math.ceil(layout.radius)
  const W = out.w
  let notFill = 0
  let photoPx = 0
  let photoDiff = 0
  let maxDiff = 0
  let cornerPx = 0
  let cornerDev = 0
  const inPatch = (x: number, y: number) => patch > 0 && Math.min(x - x0, x0 + sw - 1 - x) < patch && Math.min(y - y0, y0 + sh - 1 - y) < patch
  const same = out.w === plan.width && out.h === plan.height
  if (same && aligned) {
    for (let y = 0; y < out.h; y++) {
      for (let x = 0; x < out.w; x++) {
        const o = (y * W + x) * 4
        if (x < x0 || x >= x0 + sw || y < y0 || y >= y0 + sh) {
          const fill = fillAt(x, y)
          if (out.data[o] !== fill[0] || out.data[o + 1] !== fill[1] || out.data[o + 2] !== fill[2]) notFill++
          continue
        }
        const r = ((y - drawn.dy) * rw + (x - drawn.dx)) * 4
        if (inPatch(x, y)) {
          const c = cornerCoverage(layout.radius, Math.min(x - x0, x0 + sw - 1 - x), Math.min(y - y0, y0 + sh - 1 - y))
          const fill = fillAt(x, y)
          for (let k = 0; k < 3; k++) cornerDev = Math.max(cornerDev, Math.abs(out.data[o + k] - (c * ref[r + k] + (1 - c) * fill[k])))
          cornerPx++
          continue
        }
        let d = 0
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(out.data[o + k] - ref[r + k]))
        if (d) photoDiff++
        maxDiff = Math.max(maxDiff, d)
        photoPx++
      }
    }
  }
  // The finest detail of the photo's rectangle, the corners and the border
  // pixel round it masked, against the photo's own.
  const lumaAt = (d: Uint8ClampedArray, i: number) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
  let eOut = 0
  let eRef = 0
  if (same && aligned) {
    for (let y = y0 + 1; y < y0 + sh - 1; y++) {
      for (let x = x0 + 1; x < x0 + sw - 1; x++) {
        if (inPatch(x, y) || inPatch(x - 1, y) || inPatch(x + 1, y) || inPatch(x, y - 1) || inPatch(x, y + 1)) continue
        const i = y * W + x
        const j = (y - drawn.dy) * rw + (x - drawn.dx)
        const a = 4 * lumaAt(out.data, i) - lumaAt(out.data, i - 1) - lumaAt(out.data, i + 1) - lumaAt(out.data, i - W) - lumaAt(out.data, i + W)
        const b = 4 * lumaAt(ref, j) - lumaAt(ref, j - 1) - lumaAt(ref, j + 1) - lumaAt(ref, j - rw) - lumaAt(ref, j + rw)
        eOut += a * a
        eRef += b * b
      }
    }
  }
  // Frosted's banding, along the middle row through the left border; and
  // how much of the field Save pressed sits on a whole level (a field kept
  // in float has next to none; one rounded to bytes, all of it).
  const banding = inputs.frost && same ? { ...bandingOf(out.data, W, plan.height, layout.shown.x0, inputs.frost), whole: wholeShare(inputs.frost) } : null
  let jpeg: (ReturnType<typeof frameOf> & { bytes: number; ms: number }) | null = null
  if (opts.jpeg) {
    const again = await decode()
    const t1 = performance.now()
    const saved = await savePrint(s, again, inputs, { format: 'jpeg', maxHeight, rect, makeCanvas: detachedCanvas, onGround: () => again.close() })
    jpeg = { ...frameOf(new Uint8Array(await saved.blob.arrayBuffer())), bytes: saved.blob.size, ms: Math.round(performance.now() - t1) }
  }
  await deleteMedia(layer.id)
  // Fit's contained rectangle: the side that binds is the visible
  // rectangle's exactly; the other is the photo's shape times it, rounded:
  // off by under a pixel.
  const aspectError = layout.shown.w / layout.shown.h > w / h ? Math.abs(layout.shown.w - (layout.shown.h * w) / h) : Math.abs(layout.shown.h - (layout.shown.w * h) / w)
  return {
    photo: `${w}x${h}`,
    plan: { width: plan.width, height: plan.height, limit: plan.limit, border: plan.border },
    file: `${out.w}x${out.h}`,
    dimsMatch: same,
    shown: `${sw}x${sh} at (${x0}, ${y0})`,
    drawn: `${rw}x${rh} at (${drawn.dx}, ${drawn.dy})`,
    aligned,
    radius: layout.radius,
    border: { pixels: out.w * out.h - sw * sh, notFill },
    photoRect: { pixels: photoPx, differ: photoDiff, maxDiff },
    corners: { pixels: cornerPx, maxDev: cornerDev },
    lapRatio: eRef > 0 ? eOut / eRef : NaN,
    aspectError,
    ms: Math.round(ms),
    inputsMs: Math.round(inputsMs),
    banding,
    jpeg,
  }
}

/**
 * Frosted's field as a W x H sheet's fill, sampled exactly: each pixel's
 * centre on the field (the field stretched over the sheet and 2% of its long
 * side past each edge, a texel's centre at i + 0.5, held inside), bilinear
 * in float64 from the field's float values (across each field row, then
 * down), rounded once. Written from the definition, apart from the engine's
 * `frostSampler`, which mixes down first, so the two agree only if neither
 * rounds early.
 */
function exactFrost(field: FrostField, W: number, H: number): (y: number, x0: number, x1: number, out: Uint8ClampedArray, o: number) => void {
  const pad = Math.round(0.02 * Math.max(W, H))
  const at = (v: number, n: number, f: number) => Math.min(f - 1, Math.max(0, ((v + 0.5 + pad) / (n + 2 * pad)) * f - 0.5))
  const planes = [field.r, field.g, field.b]
  return (y, x0, x1, out, o) => {
    const fy = at(y, H, field.h)
    const j0 = Math.floor(fy)
    const j1 = Math.min(field.h - 1, j0 + 1)
    const s = fy - j0
    for (let x = x0, q = o; x < x1; x++, q += 4) {
      const fx = at(x, W, field.w)
      const i0 = Math.floor(fx)
      const i1 = Math.min(field.w - 1, i0 + 1)
      const t = fx - i0
      for (let c = 0; c < 3; c++) {
        const p = planes[c]
        const top = p[j0 * field.w + i0] + (p[j0 * field.w + i1] - p[j0 * field.w + i0]) * t
        const bottom = p[j1 * field.w + i0] + (p[j1 * field.w + i1] - p[j1 * field.w + i0]) * t
        out[q + c] = top + (bottom - top) * s
      }
      out[q + 3] = 255
    }
  }
}

/** The share of a field's values that sit on a whole level. */
function wholeShare(field: FrostField): number {
  let whole = 0
  for (const p of [field.r, field.g, field.b]) for (const v of p) if (v === Math.round(v)) whole++
  return whole / (3 * field.w * field.h)
}

/**
 * The longest run of one value along the middle row of a W x H print, over
 * its first `border` pixels (the left border), in each channel; and the same
 * for the field itself along that row: sampled there exactly (bilinear, in
 * float64, from the field's own float values) and rounded once. A print that
 * rounded the field to bytes before stretching it over the sheet would show
 * runs as long as a field pixel is wide.
 */
function bandingOf(data: Uint8ClampedArray, W: number, H: number, border: number, field: FrostField) {
  const y = H >> 1
  const pad = Math.round(0.02 * Math.max(W, H))
  const at = (v: number, n: number, f: number) => Math.min(f - 1, Math.max(0, ((v + 0.5 + pad) / (n + 2 * pad)) * f - 0.5))
  const fy = at(y, H, field.h)
  const j0 = Math.floor(fy)
  const j1 = Math.min(field.h - 1, j0 + 1)
  const s = fy - j0
  const runs = (value: (x: number, c: number) => number) =>
    [0, 1, 2].map((c) => {
      let longest = 1
      let run = 1
      for (let x = 1; x < border; x++) {
        run = value(x, c) === value(x - 1, c) ? run + 1 : 1
        longest = Math.max(longest, run)
      }
      return longest
    })
  const planes = [field.r, field.g, field.b]
  const exact = (x: number, c: number) => {
    const fx = at(x, W, field.w)
    const i0 = Math.floor(fx)
    const i1 = Math.min(field.w - 1, i0 + 1)
    const t = fx - i0
    const p = planes[c]
    const top = p[j0 * field.w + i0] + (p[j0 * field.w + i1] - p[j0 * field.w + i0]) * t
    const bottom = p[j1 * field.w + i0] + (p[j1 * field.w + i1] - p[j1 * field.w + i0]) * t
    return Uint8ClampedArray.of(top + (bottom - top) * s)[0]
  }
  return { row: y, pixels: border, print: runs((x, c) => data[(y * W + x) * 4 + c]), field: runs(exact) }
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
  const { layer, byteForByte, s, plan, pressed } = await importAndSave(file, 'original', 'png')
  const out = await pixelsOf(pressed.blob)
  const r = groundRect(s, plan.width, plan.height)
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
  const saveError = await savePrint(s, null, storedFrameInputs(s), {
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
      framed: typeof framed
    }
  }
}

window.F = { zone, controls, orientation, pngAlpha, missingPhoto, framed }
