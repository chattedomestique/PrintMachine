/**
 * How much memory an export holds, measured deterministically.
 *
 *   node scripts/measure-alloc.mjs            (all cases; exits 1 over a gate)
 *   node scripts/measure-alloc.mjs 1 3        (just cases 1 and 3)
 *
 * Each case runs in a process of its own, so nothing one case left behind is
 * counted in, or freed during, the next.
 *
 * Desktop Chromium's resident memory is not a faithful stand-in for an
 * iPhone's: V8 frees short-lived buffers eagerly where JavaScriptCore keeps
 * them. So this runs the REAL export path (`renderPrintAsync`, the function
 * Save calls) in node, where every typed array is counted: each constructor
 * is wrapped, and at every allocation of a full-sheet-sized buffer a full
 * garbage collection runs and the bytes still live are read back
 * (`process.memoryUsage().arrayBuffers`). A buffer is live while anything can
 * still reach it — a local not yet out of scope included, which is how a
 * conservative collector like JavaScriptCore's sees it too. V8 runs
 * single-threaded here, so when a function is optimised (which can end a dead
 * local's life early) cannot vary between runs: every run gives the same
 * numbers. The peak of that,
 * over the output's pixel count, is the gate: <= 35 bytes per pixel for cases
 * 1-4 (case 5 is recorded, not gated).
 *
 * The canvas is a stand-in that rasterises nothing but hands back data of
 * the right size and plausible content (type-shaped strokes where glyphs
 * were drawn, a photo where the photo was), so the engine walks the same
 * branches it does in a browser. What lives OUTSIDE typed arrays is stated,
 * not measured: the export's two canvases (4 bytes per pixel each) and the
 * decoded original photo (4 bytes per photo pixel, held only until the photo
 * is in the ground). The report adds them up per phase.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportCases } from './export-cases.mjs'

const args = process.argv.slice(2)
const child = args[0] === '--case'
if (!child) {
  // One process per case, with the collector exposed (the accounting needs
  // it); the gate fails if any case does.
  const ids = args.map(Number).filter(Boolean)
  console.log(`Peak live typed-array bytes per output pixel; gate 35 B/px (cases 1-4).\n`)
  let status = 0
  for (const id of ids.length ? ids : [1, 2, 3, 4, 5]) {
    const r = spawnSync(process.execPath, ['--expose-gc', '--single-threaded', fileURLToPath(import.meta.url), '--case', String(id)], { stdio: 'inherit' })
    if (r.status !== 0) status = 1
  }
  process.exit(status)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = 35

/* ── Accounting ──────────────────────────────────────────────────────── */

const meter = { on: false, base: 0, n: 1, total: 0, peak: 0, phase: 'ground', peaks: { ground: 0, press: 0, print: 0 }, threshold: 1 }
const live = () => process.memoryUsage().arrayBuffers - meter.base
function sample() {
  globalThis.gc()
  const bytes = live()
  if (bytes > meter.peak) meter.peak = bytes
  if (bytes > meter.peaks[meter.phase]) meter.peaks[meter.phase] = bytes
}
/** Wrap every typed-array constructor, once the modules are loaded (the
 *  bundler checks `instanceof Uint8Array` on its own buffers while loading). */
function track() {
  for (const name of ['Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Int32Array', 'Uint32Array']) {
    const Orig = globalThis[name]
    const Tracked = class extends Orig {
      constructor(...args) {
        super(...args)
        if (!meter.on) return
        // A view over a buffer that already exists (`subarray`, or a typed
        // array made on another's buffer) allocates nothing.
        if (args[0] instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && args[0] instanceof SharedArrayBuffer)) return
        meter.total += this.byteLength
        if (this.byteLength >= meter.threshold) sample()
      }
      static [Symbol.hasInstance](x) {
        return x instanceof Orig
      }
    }
    Object.defineProperty(Tracked, 'name', { value: name })
    globalThis[name] = Tracked
  }
}

/* ── A canvas that draws nothing but answers like one ────────────────── */

/** A 2D context: records glyph boxes, rectangles and the photo's rectangle,
 *  and paints them into whatever getImageData returns. */
function fakeContext() {
  const canvas = { width: 0, height: 0 }
  let m = [1, 0, 0, 1, 0, 0]
  const stack = []
  let boxes = []
  let photo = null
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const box = (x, y, w, h) => {
    const pts = [apply(x, y), apply(x + w, y), apply(x, y + h), apply(x + w, y + h)]
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return { x0: Math.floor(Math.min(...xs)), y0: Math.floor(Math.min(...ys)), x1: Math.ceil(Math.max(...xs)), y1: Math.ceil(Math.max(...ys)) }
  }
  const px = (font) => Number(/([\d.]+)px/.exec(font)?.[1] ?? 10)
  const ctx = {
    canvas,
    font: '10px sans-serif',
    fillStyle: '#000',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    letterSpacing: '0px',
    imageSmoothingQuality: 'low',
    save: () => stack.push(m.slice()),
    restore: () => (m = stack.pop() ?? [1, 0, 0, 1, 0, 0]),
    translate: (x, y) => (m = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y]),
    rotate: (a) => {
      const c = Math.cos(a)
      const s = Math.sin(a)
      m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]]
    },
    clearRect: () => {
      boxes = []
      photo = null
    },
    measureText: (text) => ({ width: 0.55 * px(ctx.font) * [...text].length }),
    // A glyph: an em-tall box (textBaseline 'middle'), stroked.
    fillText: (text, x, y) => {
      const size = px(ctx.font)
      boxes.push({ ...box(x, y - size * 0.36, 0.55 * size * [...text].length, size * 0.72), stroke: Math.max(1, size * 0.14) })
    },
    fillRect: (x, y, w, h) => boxes.push({ ...box(x, y, w, h), stroke: 0 }),
    drawImage: (_img, dx, dy, dw, dh) => (photo = box(dx, dy, dw, dh)),
    getImageData: (sx, sy, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4)
      if (photo) {
        for (let y = Math.max(sy, photo.y0); y < Math.min(sy + h, photo.y1); y++) {
          for (let x = Math.max(sx, photo.x0); x < Math.min(sx + w, photo.x1); x++) {
            const o = ((y - sy) * w + (x - sx)) * 4
            const v = 20 + ((215 * (x - photo.x0)) / Math.max(1, photo.x1 - photo.x0)) + 18 * Math.sin(x / 9) * Math.cos(y / 13)
            data[o] = v
            data[o + 1] = v * 0.95
            data[o + 2] = 255 - v * 0.6
            data[o + 3] = 255
          }
        }
      }
      for (const b of boxes) {
        for (let y = Math.max(sy, b.y0); y < Math.min(sy + h, b.y1); y++) {
          for (let x = Math.max(sx, b.x0); x < Math.min(sx + w, b.x1); x++) {
            // Strokes: vertical bars a stroke wide, a stroke apart.
            if (b.stroke && Math.floor((x - b.x0) / b.stroke) % 2 === 1) continue
            const o = ((y - sy) * w + (x - sx)) * 4
            data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 255
          }
        }
      }
      return { data, width: w, height: h }
    },
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
  }
  return ctx
}

/* ── The cases (export-cases.mjs) ───────────────────────────────────── */

const { createServer } = await import('vite')
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
const load = (p) => server.ssrLoadModule(resolve(root, p))
const { renderPrintAsync } = await load('src/engine/render.ts')
const { planPrint } = await load('src/engine/export.ts')
const { defaultSettings, makeLayer, makeMedia } = await load('src/state/defaults.ts')
const { contrastPartner } = await load('src/engine/inks.ts')
// The modules are loaded; the server (its file watcher, its bundler) is shut
// before anything is counted, so nothing in the background allocates while
// the export runs.
await server.close()
track()

const CASES = exportCases({ defaultSettings, makeLayer, makeMedia, contrastPartner })

const only = Number(args[1])
const fmt = (v) => v.toFixed(1)
let failed = false
for (const c of CASES.filter((k) => k.id === only)) {
  const s = c.doc()
  const plan = planPrint(s)
  const n = plan.width * plan.height
  const photoBytes = s.media ? s.media.width * s.media.height * 4 : 0
  const out = fakeContext()
  const scratch = fakeContext()
  const photo = s.media ? { width: s.media.width, height: s.media.height } : null

  globalThis.gc()
  meter.base = process.memoryUsage().arrayBuffers
  Object.assign(meter, { on: true, n, total: 0, peak: 0, phase: 'ground', peaks: { ground: 0, press: 0, print: 0 }, threshold: Math.floor(n / 4) })
  const t0 = performance.now()
  await renderPrintAsync(out, scratch, s, plan.height, photo, {
    onGround: () => {
      sample()
      meter.phase = 'press'
    },
    onProgress: (p) => {
      // What the print holds, read as it starts.
      if (p.step === 'print' && meter.phase !== 'print') {
        meter.phase = 'print'
        sample()
      }
    },
  })
  const ms = performance.now() - t0
  meter.on = false

  // The export's two canvases, 4 B/px each, until the plates are pressed;
  // then the glyph canvas is let go (its width set to 0) and only the output
  // canvas is left for the print and the encode.
  const released = scratch.canvas.width === 0
  const decode = photoBytes / n
  const groundPhase = meter.peaks.ground / n + 8 + decode
  const pressPhase = meter.peaks.press / n + 8
  const printPhase = meter.peaks.print / n + (released ? 4 : 8)
  const peak = meter.peak / n
  const over = c.gated && peak > GATE
  if (over) failed = true
  console.log(`case ${c.id}: ${c.name}`)
  console.log(`  ${plan.width}x${plan.height} (${(n / 1e6).toFixed(1)} MP), ${s.layers.length} plates, ${ms.toFixed(0)} ms in node`)
  console.log(`  typed arrays: peak ${fmt(peak)} B/px (${(meter.peak / 1e6).toFixed(0)} MB)${c.gated ? (over ? `  OVER the ${GATE} B/px gate` : '  ok') : '  (recorded)'}; allocated in all ${fmt(meter.total / n)} B/px`)
  const total = Math.max(groundPhase, pressPhase, printPhase)
  console.log(`  typed arrays by phase: laying the photo down ${fmt(meter.peaks.ground / n)}, pressing ${fmt(meter.peaks.press / n)}, printing ${fmt(meter.peaks.print / n)} B/px`)
  console.log(`  with the canvases (8 B/px; 4 once ${released ? 'the glyph canvas is let go, before the print' : 'pressed — NOT let go'}) and the decoded photo (${fmt(decode)} B/px, until it is in the ground):`)
  console.log(`    laying the photo down ${fmt(groundPhase)}, pressing ${fmt(pressPhase)}, printing ${fmt(printPhase)} B/px: peak ${fmt(total)} B/px (${((total * n) / 1e6).toFixed(0)} MB)\n`)
}
process.exit(failed ? 1 : 0)
