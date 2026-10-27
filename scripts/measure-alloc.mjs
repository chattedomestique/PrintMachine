/**
 * How much memory an export holds, measured deterministically.
 *
 *   node scripts/measure-alloc.mjs            (every case; exits 1 over a gate)
 *   FULL=1 node scripts/measure-alloc.mjs     (and case 8, the 61 MP worst press)
 *   node scripts/measure-alloc.mjs 1 3 7g     (just those cases)
 *
 * Each case runs in a process of its own, so nothing one case left behind is
 * counted in, or freed during, the next; up to four run at once (one per
 * core; MEASURE_JOBS sets it), which changes no number: each process is
 * single-threaded and counts only itself.
 *
 * Desktop Chromium's resident memory is not a faithful stand-in for an
 * iPhone's: V8 frees short-lived buffers eagerly where JavaScriptCore keeps
 * them. So this runs the REAL export path (`pressToSink`, the press Save
 * runs, into the real JPEG encoder, whose file is counted and dropped) in
 * node, where every typed array is counted: each constructor is wrapped, and
 * at every allocation over a threshold, and at every step of the press, a
 * full garbage collection runs and the bytes still live are read back
 * (`process.memoryUsage().arrayBuffers`). The threshold is a quarter of the
 * sheet's pixels for cases 1-5 (what they were always measured with) and
 * 512 KiB from case 6 on, where a quarter of the pixels (10 MB at 40 MP)
 * would miss every tile and band array. A buffer is live while anything can
 * still reach it — a local not yet out of scope included, which is how a
 * conservative collector like JavaScriptCore's sees it too. V8 runs
 * single-threaded here, so when a function is optimised (which can end a dead
 * local's life early) cannot vary between runs: every run gives the same
 * numbers.
 *
 * The gates (export-cases.mjs): cases 1-4 in bytes of typed arrays per output
 * pixel, at what they measured when the band engine landed x 1.25 (case 5 is
 * recorded, not gated); cases 6-10 in megabytes, of typed arrays and of the
 * whole (the typed arrays, the canvases, the decoded photo and the file at
 * FILE_BOUND bytes an output pixel, so the gate does not depend on how well
 * the fake print compresses); and the same-width pairs, a 4000x10000
 * sheet against a 4000x5000 one, whose peaks may differ by at most 1.15
 * times (the press holds what grows with the width, not the height).
 *
 * The canvas is a stand-in that rasterises nothing but hands back data of
 * the right size and plausible content (type-shaped strokes where glyphs
 * were drawn, a photo where the photo was), so the engine walks the same
 * branches it does in a browser. What lives OUTSIDE typed arrays is stated,
 * not measured: the export's canvases (the tile canvas at its largest tile,
 * the piece canvas a photo at its own pixels is blitted into a band at a
 * time; 4 bytes a pixel each), the decoded original photo (4 bytes per photo
 * pixel, held until the photo's last rows are read, at the last band) and the
 * file. The report adds them up.
 */

import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportCases } from './export-cases.mjs'

const args = process.argv.slice(2)
const child = args[0] === '--case'
/** The same-width gate: the taller sheet's peak typed bytes over the shorter's. */
const SAME_WIDTH = 1.15
/**
 * The file, in bytes an output pixel, so the gate does not depend on how
 * well the fake print compresses. 1.40 is what the app's own encoder (q95,
 * 4:4:4) writes for FLAT GREY with ±32 levels of uniform noise in every
 * pixel and channel. Real photographs saved through the app write less
 * unless they are grainy: 0.54-0.70 clean, about 1.18 with ±16 levels of
 * added noise, 1.49 with ±32. So the bound covers photographs with up to
 * about ±16 levels of noise per channel. Above it: a ±32-noise photograph
 * (1.49) adds about 4 MB at 40 MP, the synthetic fine-detail ground (1.76)
 * about 14 MB, which would put case 6 just over its 350 MB gate, and pure
 * noise, which no camera writes (2.42), about 41 MB.
 */
const FILE_BOUND = 1.4
if (!child) {
  // One process per case, with the collector exposed (the accounting needs
  // it); the gate fails if any case does.
  const all = exportCases({ defaultSettings: () => ({}), makeLayer: () => ({}), makeMedia: () => ({}), contrastPartner: () => '' })
  const named = args.filter((a) => a !== '')
  const ids = named.length ? named : all.filter((c) => !c.full || process.env.FULL === '1').map((c) => c.id)
  const unknown = ids.filter((id) => !all.some((c) => c.id === id))
  if (unknown.length) {
    console.error(`No such case: ${unknown.join(', ')} (cases: ${all.map((c) => c.id).join(', ')})`)
    process.exit(2)
  }
  const jobs = Math.max(1, Number(process.env.MEASURE_JOBS) || Math.min(4, availableParallelism()))
  console.log(
    'Peak live typed-array bytes; gates: cases 1-4 per output pixel, cases 6-10 in MB (typed, and with the canvases, photo and file), ' +
      `the same-width pairs <= ${SAME_WIDTH}x. ${jobs} at a time.\n`,
  )
  const run = (id) =>
    new Promise((done) => {
      const p = spawn(process.execPath, ['--expose-gc', '--single-threaded', fileURLToPath(import.meta.url), '--case', id], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (status) => {
        const line = out.split('\n').find((l) => l.startsWith('RESULT '))
        done({ id, status, text: out.split('\n').filter((l) => !l.startsWith('RESULT ')).join('\n'), result: line ? JSON.parse(line.slice(7)) : null })
      })
    })
  // A pool of `jobs`; the reports print in the cases' order.
  const results = new Array(ids.length)
  let next = 0
  let printed = 0
  const flush = () => {
    while (printed < ids.length && results[printed]) process.stdout.write(results[printed++].text)
  }
  await Promise.all(
    Array.from({ length: Math.min(jobs, ids.length) }, async () => {
      while (next < ids.length) {
        const i = next++
        results[i] = await run(ids[i])
        flush()
      }
    }),
  )
  let status = results.some((r) => r.status !== 0) ? 1 : 0
  const pairs = new Map()
  for (const r of results) if (r.result?.pair) pairs.set(r.result.pair, [...(pairs.get(r.result.pair) ?? []), r.result])
  for (const [pair, [a, b]] of pairs) {
    if (!b) continue
    const [short, tall] = a.height < b.height ? [a, b] : [b, a]
    const ratio = tall.peak / short.peak
    const ok = ratio <= SAME_WIDTH
    if (!ok) status = 1
    console.log(
      `same width (${pair}): ${tall.sheet} peaks at ${(tall.peak / 1e6).toFixed(1)} MB typed, ${short.sheet} at ${(short.peak / 1e6).toFixed(1)} MB: ` +
        `${ratio.toFixed(3)}x ${ok ? `ok (<= ${SAME_WIDTH})` : `OVER the ${SAME_WIDTH} gate`}`,
    )
  }
  process.exit(status)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ── Accounting ──────────────────────────────────────────────────────── */

const meter = { on: false, base: 0, n: 1, total: 0, peak: 0, threshold: 1, gcs: 0 }
const live = () => process.memoryUsage().arrayBuffers - meter.base
function sample() {
  globalThis.gc()
  meter.gcs++
  const bytes = live()
  if (bytes > meter.peak) meter.peak = bytes
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
    // The font cap draws type over CANVAS_FONT_MAX under scale(k, k).
    scale: (sx, sy) => (m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]]),
    imageSmoothingEnabled: true,
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
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
const load = (p) => server.ssrLoadModule(resolve(root, p))
const { pressToSink } = await load('src/engine/render.ts')
const { JpegEncoder } = await load('src/engine/encode/jpeg.ts')
const { planPrint } = await load('src/engine/export.ts')
const { defaultSettings, makeLayer, makeMedia } = await load('src/state/defaults.ts')
const { contrastPartner } = await load('src/engine/inks.ts')
// The modules are loaded; the server (its file watcher, its bundler) is shut
// before anything is counted, so nothing in the background allocates while
// the export runs.
await server.close()
track()

const CASES = exportCases({ defaultSettings, makeLayer, makeMedia, contrastPartner })

const only = args[1]
const fmt = (v) => v.toFixed(1)
const mb = (v) => (v / 1e6).toFixed(1)
let failed = false
for (const c of CASES.filter((k) => k.id === only)) {
  const s = c.doc()
  const plan = planPrint(s)
  const n = plan.width * plan.height
  const photoBytes = s.media ? s.media.width * s.media.height * 4 : 0
  const scratch = fakeContext()
  const photo = s.media ? { width: s.media.width, height: s.media.height } : null
  // Cases 1-5 keep the threshold they were always measured with.
  const legacy = Number(c.id) <= 5

  // The canvases the press makes, at their largest: the tile canvas is
  // sized to each tile in turn, the piece canvas once.
  const largest = { tile: 0, piece: 0 }
  const measured = (ctx, key) => {
    let w = 0
    let h = 0
    Object.defineProperties(ctx.canvas, {
      width: { get: () => w, set: (v) => ((w = v), (largest[key] = Math.max(largest[key], w * h))) },
      height: { get: () => h, set: (v) => ((h = v), (largest[key] = Math.max(largest[key], w * h))) },
    })
    return ctx
  }
  measured(scratch, 'tile')

  globalThis.gc()
  meter.base = process.memoryUsage().arrayBuffers
  Object.assign(meter, { on: true, n, total: 0, peak: 0, gcs: 0, threshold: legacy ? Math.floor(n / 4) : 512 * 1024 })
  let samples = 0
  // The real encoder, at Save's quality; its file is counted and dropped.
  let fileBytes = 0
  const t0 = performance.now()
  const jpeg = new JpegEncoder(plan.width, plan.height, 95, (chunk) => (fileBytes += chunk.length))
  const sink = { put: (rgba, rows) => jpeg.push(rgba, rows), settled: async () => {}, finish: async () => jpeg.finish(), abort: () => {} }
  await pressToSink(s, { w: plan.width, h: plan.height }, photo, {}, sink, {
    canvases: { tile: scratch, piece: () => measured(fakeContext(), 'piece') },
    onGround: () => sample(),
    onProgress: () => {
      samples++
      sample()
    },
  })
  await sink.finish()
  sample()
  const ms = performance.now() - t0
  meter.on = false

  const canvasBytes = 4 * largest.tile + 4 * largest.piece
  const peak = meter.peak / n
  console.log(`case ${c.id}: ${c.name}`)
  console.log(
    `  ${plan.width}x${plan.height} (${(n / 1e6).toFixed(1)} MP), ${s.layers.length} plates, ${ms.toFixed(0)} ms in node, ` +
      `${samples} steps sampled, ${meter.gcs} collections (at every allocation of ${legacy ? 'a quarter of the pixels' : '512 KiB'} or more)`,
  )
  const canvasesSaid = `the tile canvas at its largest ${mb(4 * largest.tile)} MB, the photo's piece canvas ${mb(4 * largest.piece)} MB`
  if (typeof c.gate === 'number' || (c.gate === undefined && !c.pair)) {
    // Cases 1-5: per output pixel.
    const over = typeof c.gate === 'number' && peak > c.gate
    if (over) failed = true
    console.log(
      `  typed arrays: peak ${peak.toFixed(2)} B/px (${mb(meter.peak)} MB)${typeof c.gate === 'number' ? (over ? `  OVER the ${c.gate} B/px gate` : `  ok (<= ${c.gate})`) : '  (recorded)'}; ` +
        `allocated in all ${fmt(meter.total / n)} B/px`,
    )
    const total = meter.peak + canvasBytes + photoBytes + fileBytes
    console.log(
      `  with the canvases (${canvasesSaid}), the decoded photo (${mb(photoBytes)} MB, until its last rows are read) and the file (${mb(fileBytes)} MB of the fake print):\n` +
        `    peak ${fmt(total / n)} B/px (${(total / 1e6).toFixed(0)} MB)\n`,
    )
  } else if (c.gate) {
    // Cases 6-10: in megabytes, the file at FILE_BOUND.
    const file = FILE_BOUND * n
    const total = meter.peak + canvasBytes + photoBytes + file
    const typedOver = meter.peak > c.gate.typed * 1e6
    const totalOver = total > c.gate.total * 1e6
    if (typedOver || totalOver) failed = true
    console.log(
      `  typed arrays: peak ${mb(meter.peak)} MB (${peak.toFixed(2)} B/px)  ${typedOver ? `OVER the ${c.gate.typed} MB gate` : `ok (<= ${c.gate.typed} MB)`}; allocated in all ${(meter.total / 1e6).toFixed(0)} MB`,
    )
    console.log(
      `  with the canvases (${canvasesSaid}), the decoded photo (${mb(photoBytes)} MB, until its last rows are read) and the file at its bound ` +
        `(${mb(file)} MB; the fake print's was ${mb(fileBytes)}):\n    ${mb(total)} MB  ${totalOver ? `OVER the ${c.gate.total} MB gate` : `ok (<= ${c.gate.total} MB)`}\n`,
    )
  } else {
    // A same-width pair's half: the parent compares the two.
    console.log(`  typed arrays: peak ${mb(meter.peak)} MB (${peak.toFixed(2)} B/px)\n`)
  }
  console.log(`RESULT ${JSON.stringify({ id: c.id, pair: c.pair ?? null, sheet: `${plan.width}x${plan.height}`, height: plan.height, peak: meter.peak })}`)
}
process.exit(failed ? 1 : 0)
