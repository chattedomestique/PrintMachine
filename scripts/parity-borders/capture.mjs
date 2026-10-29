/**
 * Border Studio's frame, frozen: the references the frame engine is checked
 * against (scripts/parity-borders/README). Run once, by hand; CI never runs
 * it and never fetches the Borders repo. Its output is committed:
 * refs/*.png and refs.json.
 *
 *   BORDERS_SRC=/path/to/a/copy node scripts/parity-borders/capture.mjs
 *
 * BORDERS_SRC is a COPY of the Borders tree at 597ce7a with its own
 * node_modules (`git -C <checkout> archive 597ce7a | tar -x -C <copy>`, then
 * `npm ci` in the copy). The script refuses a git checkout (a directory with
 * a .git), so it can never patch or build the repo itself; it checks the copy
 * is 597ce7a by the SHA-256 of the two files it patches. It builds the copy
 * (`vite build`, into the copy's own dist/), serves that build from 127.0.0.1
 * and drives it in Chromium with service workers blocked. It never contacts
 * the live site and writes nothing to either repo but this script's output.
 *
 * The patch, applied to the copy only (each replacement must match once):
 *  1. src/palette.js: `function samplePixels(` becomes `export function
 *     samplePixels(` (it is module-private, and its array is what the
 *     palette port is tested on).
 *  2. src/components/BorderCanvas/BorderCanvas.jsx:
 *     a. imports samplePixels beside buildBorderSuggestions and makes one
 *        record, `window.__parity = { renders, geo, sample, suggestions }`;
 *     b. `redraw` counts each render and copies `geoRef` after it (the
 *        sheet's size and where the photo landed);
 *     c. the image's `onload` records `samplePixels(img)` (the pixels with
 *        alpha >= 125, as [r, g, b]) and `buildBorderSuggestions(img)` on the
 *        same element the app decodes the photo into.
 *     Nothing else changes: the render, the palette and the presets are
 *     Border Studio's own.
 *
 * The route: one fresh browser context per case. Before the app loads, the
 * case's settings go into localStorage['border-studio:presets:v1'] as a
 * preset (a preset carries the whole look but the zoom and pan); the photo is
 * chosen through the app's own file input (Uploader: decoded, passed through
 * as the original PNG); More > Presets > the preset applies the look; once
 * the canvas has rendered at the case's size and stopped re-rendering, its
 * pixels are read back. The fill colours are Border Studio's own Photo,
 * Deep, Muted and Comp hex for the photo, recorded first by loading the
 * photo with no preset.
 *
 * The photos are generated (photos.mjs, which the parity gate generates
 * them with too; never committed): flat blocks of known population (a 3x2
 * grid of six saturated colours of unequal area), one smooth gradient band
 * along the bottom, and a flat square of side one sixth of the short side at
 * each corner, so every corner patch is flat colour in both apps even where
 * one of them resamples. Border Studio draws the media at 1800 px on its
 * long side, so 1800x1200 and 1200x1800 land 1:1.
 *
 * Every PNG is written by this script (zlib, no colour chunks: plain sRGB)
 * and decoded back by Chromium before it is kept: it must give the captured
 * bytes exactly.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { PHOTOS, blockPhoto } from './photos.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REFS = resolve(here, 'refs')
const BORDERS_SHA = '597ce7aad3c71ed61e835dfd4bf783ba820077a6'
const PRESETS_KEY = 'border-studio:presets:v1'

const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

// ── the copy ────────────────────────────────────────────────────────────────

const SRC = process.env.BORDERS_SRC
if (!SRC || !existsSync(join(SRC, 'package.json'))) throw new Error('BORDERS_SRC must name a copy of the Borders tree at 597ce7a.')
if (existsSync(join(SRC, '.git'))) throw new Error(`${SRC} is a git checkout: make a copy (git archive) and point BORDERS_SRC at it.`)
if (JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).name !== 'borders') throw new Error(`${SRC} is not the Borders tree.`)
if (!existsSync(join(SRC, 'node_modules/vite'))) throw new Error(`Run npm ci in ${SRC} first.`)

/** Each patched file: its SHA-256 at 597ce7a, and the replacements. */
const PATCH = {
  'src/palette.js': {
    sha256: '6b75f0993bab242213ae2d901a915ef1ad5638808c0f2574b209af343e90ba67',
    edits: [['function samplePixels(source, maxDim = 84) {', 'export function samplePixels(source, maxDim = 84) {']],
  },
  'src/components/BorderCanvas/BorderCanvas.jsx': {
    sha256: '03e409269bb15381f60c0ef4d432c7a43845e4a01607cc9a29714a9e60b53600',
    edits: [
      [
        "import { buildBorderSuggestions } from '../../palette'\n",
        "import { buildBorderSuggestions, samplePixels } from '../../palette'\n" +
          'window.__parity = { renders: 0, geo: null, sample: null, suggestions: null } // parity capture\n',
      ],
      [
        '    renderFrame(canvasRef.current, sourceRef.current, settingsRef.current, cacheRef.current, geoRef, textBBoxesRef.current)\n  }, [])',
        '    renderFrame(canvasRef.current, sourceRef.current, settingsRef.current, cacheRef.current, geoRef, textBBoxesRef.current)\n' +
          '    window.__parity.renders++; window.__parity.geo = { ...geoRef.current } // parity capture\n  }, [])',
      ],
      [
        '        sourceRef.current = img; redraw(); setReady(true)\n',
        '        window.__parity.sample = samplePixels(img); window.__parity.suggestions = buildBorderSuggestions(img) // parity capture\n' +
          '        sourceRef.current = img; redraw(); setReady(true)\n',
      ],
    ],
  },
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

function applyPatch() {
  for (const [file, { sha256: want, edits }] of Object.entries(PATCH)) {
    const path = join(SRC, file)
    let text = readFileSync(path, 'utf8')
    // Undo a patch an earlier run applied, so the check is of the pristine file.
    for (const [from, to] of edits) if (text.includes(to)) text = text.replace(to, from)
    const got = sha256(text)
    if (got !== want) throw new Error(`${file} is not the file at 597ce7a (sha256 ${got}).`)
    for (const [from, to] of edits) {
      if (text.split(from).length !== 2) throw new Error(`${file}: the patch's anchor does not occur exactly once:\n${from}`)
      text = text.replace(from, to)
    }
    writeFileSync(path, text)
  }
}

// ── PNG (8-bit RGBA or RGB, no colour chunks) ───────────────────────────────

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A PNG of w x h pixels, `px` RGBA. Written as RGB when every pixel is
 *  opaque. Each row takes the filter (of the five) whose output has the
 *  smallest sum of absolute values. */
function encodePng(px, w, h) {
  let opaque = true
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) opaque = false
  const n = opaque ? 3 : 4
  const stride = w * n
  const rows = Buffer.alloc((stride + 1) * h)
  const line = (y) => {
    const out = Buffer.alloc(stride)
    for (let x = 0; x < w; x++) for (let c = 0; c < n; c++) out[x * n + c] = px[(y * w + x) * 4 + c]
    return out
  }
  let prev = Buffer.alloc(stride)
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride))
  for (let y = 0; y < h; y++) {
    const cur = line(y)
    for (let i = 0; i < stride; i++) {
      const a = i >= n ? cur[i - n] : 0
      const b = prev[i]
      const c = i >= n ? prev[i - n] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      cand[0][i] = cur[i]
      cand[1][i] = cur[i] - a
      cand[2][i] = cur[i] - b
      cand[3][i] = cur[i] - ((a + b) >> 1)
      cand[4][i] = cur[i] - paeth
    }
    let best = 0
    let bestSum = Infinity
    for (let f = 0; f < 5; f++) {
      let s = 0
      for (const v of cand[f]) s += v < 128 ? v : 256 - v
      if (s < bestSum) {
        bestSum = s
        best = f
      }
    }
    rows[y * (stride + 1)] = best
    cand[best].copy(rows, y * (stride + 1) + 1)
    prev = cur
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = opaque ? 2 : 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── the photos ──────────────────────────────────────────────────────────────

// photos.mjs: generated here and by the parity gate alike.

// ── the cases ───────────────────────────────────────────────────────────────

/** Border Studio's settings with nothing on but the frame (App.jsx
 *  DEFAULT_SETTINGS at 597ce7a, its frost grade at the shipped values). */
const LOOK = {
  borderThickness: 150,
  bgMode: 'color',
  bgColor: '#ffffff',
  blurAmount: 60,
  frostBrightness: -15,
  frostContrast: 0,
  frostSaturation: 60,
  frostVibrance: 0,
  cornerRadius: 0,
  cropRatio: 'free',
  aspectMode: 'crop',
  showMedia: true,
  grainAmount: 0,
  grainVariability: 0,
  grainMonochrome: true,
  grainSpread: 0,
  textLayers: [],
  highlightLayers: [],
}

/**
 * Each case: Border Studio's look (its fill a hex id from the photo's own
 * suggestions, or Frosted) and what it is in Print Machine's document (the
 * frame's width as a fraction of the sheet's long side: 150 of 2100 on the
 * free sheet, 150 of 1800 on a Fit sheet; corners 0..1 for 0..100).
 */
const CASES = [
  { id: 'free-photo', photo: 'block-land', look: { fill: 'photo' }, pm: { aspect: 'original', width: 150 / 2100, corners: 0, fill: 'photo', mode: 'crop' } },
  { id: 'free-corners-deep', photo: 'block-land', look: { fill: 'deep', cornerRadius: 100 }, pm: { aspect: 'original', width: 150 / 2100, corners: 1, fill: 'deep', mode: 'crop' } },
  { id: 'free-frosted-60', photo: 'block-land', look: { bgMode: 'frosted', blurAmount: 60 }, pm: { aspect: 'original', width: 150 / 2100, corners: 0, fill: 'frosted', blur: 60, mode: 'crop' } },
  { id: 'free-frosted-240', photo: 'block-land', look: { bgMode: 'frosted', blurAmount: 240 }, pm: { aspect: 'original', width: 150 / 2100, corners: 0, fill: 'frosted', blur: 240, mode: 'crop' } },
  { id: 'fit-4x5-muted', photo: 'block-land', look: { fill: 'muted', cropRatio: '4:5', aspectMode: 'fit' }, pm: { aspect: '4:5', width: 150 / 1800, corners: 0, fill: 'muted', mode: 'fit' } },
  { id: 'fit-9x16-corners-comp', photo: 'block-land', look: { fill: 'comp', cropRatio: '9:16', aspectMode: 'fit', cornerRadius: 50 }, pm: { aspect: '9:16', width: 150 / 1800, corners: 0.5, fill: 'comp', mode: 'fit' } },
]

// ── serving the build ───────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
}

function serve(dist) {
  const root = resolve(dist)
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (!path.startsWith('/Borders/')) {
      res.writeHead(404)
      return res.end()
    }
    let file = resolve(root, '.' + path.slice('/Borders'.length))
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403)
      return res.end()
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

// ── the capture ─────────────────────────────────────────────────────────────

/** Load the photo into the app in a fresh context (with `presets` in its
 *  storage), and run `then(page)`. */
async function withPhoto(browser, url, file, presets, then) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  try {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.clear()
        sessionStorage.clear()
        if (value) localStorage.setItem(key, value)
      },
      [PRESETS_KEY, presets ? JSON.stringify(presets) : null],
    )
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => {
      if (!r.url().startsWith(url.origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) errors.push(`request to ${r.url()}`)
    })
    await page.goto(url.href)
    await page.setInputFiles('input[type=file]', file)
    await page.waitForFunction(() => window.__parity?.suggestions && window.__parity.renders > 0, null, { timeout: 60_000 })
    const out = await then(page)
    if (errors.length) throw new Error(`the page reported: ${errors.join('; ')}`)
    return out
  } finally {
    await context.close()
  }
}

/** Wait until the canvas has rendered at w x h and has not rendered again
 *  for a while; read its pixels back (base64 RGBA). */
async function settledPixels(page, w, h) {
  await page.waitForFunction(([w, h]) => window.__parity.geo?.totalW === w && window.__parity.geo?.totalH === h, [w, h], { timeout: 30_000 })
  let last = -1
  for (;;) {
    const n = await page.evaluate(() => window.__parity.renders)
    if (n === last) break
    last = n
    await page.waitForTimeout(400)
  }
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.border-canvas__el')
    const { width: w, height: h } = canvas
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data
    let s = ''
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
    return { w, h, rgba: btoa(s), geo: window.__parity.geo }
  })
}

/** Chromium decodes `png` to exactly `rgba`. */
async function decodesTo(page, png, rgba) {
  return page.evaluate(
    async ([b64, want]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')
      ctx.drawImage(bmp, 0, 0)
      const got = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      const w = Uint8Array.from(atob(want), (ch) => ch.charCodeAt(0))
      if (got.length !== w.length) return false
      for (let i = 0; i < got.length; i++) if (got[i] !== w[i]) return false
      return true
    },
    [png.toString('base64'), Buffer.from(rgba).toString('base64')],
  )
}

async function main() {
  console.log(`Borders copy: ${SRC}`)
  applyPatch()
  // Its vite.config asks git for a build stamp; a copy is not a checkout, so
  // that prints a complaint and stamps "dev". Shown only if the build fails.
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'error'], { cwd: SRC, encoding: 'utf8' })
  if (build.status !== 0) throw new Error(`vite build failed in the copy:\n${build.stdout}\n${build.stderr}`)
  const server = await serve(join(SRC, 'dist'))
  const url = new URL(`http://127.0.0.1:${server.address().port}/Borders/`)
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
  const tmp = join(SRC, 'parity-photos')
  mkdirSync(tmp, { recursive: true })
  mkdirSync(REFS, { recursive: true })
  try {
    // The photos, and Border Studio's own sample and suggestions for each.
    const photos = []
    for (const p of PHOTOS) {
      const { px, corner } = blockPhoto(p.width, p.height, p.blocks)
      const file = join(tmp, `${p.id}.png`)
      writeFileSync(file, encodePng(px, p.width, p.height))
      const got = await withPhoto(browser, url, file, null, (page) => page.evaluate(() => ({ sample: window.__parity.sample, suggestions: window.__parity.suggestions })))
      const hex = {}
      for (const id of ['photo', 'deep', 'muted', 'comp']) {
        const s = got.suggestions.find((x) => x.id === id)
        if (!s) throw new Error(`${p.id}: Border Studio gave no "${id}" suggestion (dropped as a duplicate hex)`)
        hex[id] = s.hex
      }
      photos.push({ id: p.id, width: p.width, height: p.height, file, corner, sample: got.sample, hex })
      console.log(`  ${p.id}: ${got.sample.length} sampled pixels; photo ${hex.photo} deep ${hex.deep} muted ${hex.muted} comp ${hex.comp}`)
    }

    // The cases, each through a preset.
    const cases = []
    for (const k of CASES) {
      const photo = photos.find((p) => p.id === k.photo)
      const { fill, ...over } = k.look
      const look = { ...LOOK, ...over, ...(fill ? { bgMode: 'color', bgColor: photo.hex[fill] } : {}) }
      const preset = { id: `p-${k.id}`, name: `parity ${k.id}`, look }
      const { w, h } = expectedSheet(look, photo)
      const shot = await withPhoto(browser, url, photo.file, [preset], async (page) => {
        await page.getByRole('button', { name: 'More' }).click()
        await page.getByRole('menuitem', { name: 'Presets' }).click()
        await page.getByRole('button', { name: preset.name, exact: true }).click()
        const s = await settledPixels(page, w, h)
        const rgba = Buffer.from(s.rgba, 'base64')
        const png = encodePng(rgba, s.w, s.h)
        if (!(await decodesTo(page, png, rgba))) throw new Error(`${k.id}: the PNG does not decode to the captured pixels`)
        return { ...s, png }
      })
      if (Math.abs(k.pm.width - look.borderThickness / Math.max(shot.w, shot.h)) > 1e-12) throw new Error(`${k.id}: the recorded width is not the border over the sheet's long side`)
      const name = `${k.id}.png`
      writeFileSync(join(REFS, name), shot.png)
      const g = shot.geo
      cases.push({
        id: k.id,
        photo: k.photo,
        png: `refs/${name}`,
        sheet: { width: shot.w, height: shot.h },
        // The frame's width, as Print Machine stores it: the border over the
        // sheet's long side.
        width: k.pm.width,
        width_fraction: `${look.borderThickness}/${Math.max(shot.w, shot.h)}`,
        border_studio: {
          borderThickness: look.borderThickness,
          bgMode: look.bgMode,
          bgColor: look.bgMode === 'color' ? look.bgColor : null,
          blurAmount: look.blurAmount,
          frost: { brightness: look.frostBrightness, contrast: look.frostContrast, saturation: look.frostSaturation, vibrance: look.frostVibrance },
          cornerRadius: look.cornerRadius,
          cropRatio: look.cropRatio,
          aspectMode: look.aspectMode,
        },
        shown: { x: g.offsetX, y: g.offsetY, w: g.scaledW, h: g.scaledH },
        radius: look.cornerRadius > 0 ? (Math.min(g.scaledW, g.scaledH) / 2) * (look.cornerRadius / 400) : 0,
        print_machine: { aspect: k.pm.aspect, frame: { width: k.pm.width, corners: k.pm.corners, fill: k.pm.fill, blur: k.pm.blur ?? 60, mode: k.pm.mode } },
      })
      console.log(`  ${k.id}: ${shot.w}x${shot.h}, photo ${g.scaledW}x${g.scaledH} at (${g.offsetX}, ${g.offsetY}), ${shot.png.length} B`)
    }

    const refs = {
      about: 'Border Studio 597ce7a, its frame rendered at its own preview scale (S = 1, media long side 1800), captured by capture.mjs. Each case: the whole canvas as a lossless PNG and its size (sheet), the frame\'s width as Print Machine stores it (width: the border over the sheet\'s long side), Border Studio\'s settings, where the photo landed (shown) and the corner radius, and the same frame in Print Machine\'s document. Each photo: Border Studio\'s own 84 px sample (samplePixels, the pixels with alpha >= 125, as [r, g, b]) and its Photo, Deep, Muted and Comp hex.',
      borders_sha: BORDERS_SHA,
      chromium: browser.version(),
      photos: photos.map(({ id, width, height, corner, hex, sample }) => ({ id, width, height, corner, hex, sample })),
      cases,
    }
    writeFileSync(join(here, 'refs.json'), formatRefs(refs))
    const total = cases.reduce((s, k) => s + statSync(join(here, k.png)).size, 0)
    console.log(`  ${cases.length} cases, ${total} B of PNG in all`)
  } finally {
    await browser.close()
    server.close()
  }
}

/** Border Studio's sheet for a look (BC renderFrame at S = 1), to know when
 *  the preset has rendered. */
function expectedSheet(look, photo) {
  const OUT = 1800
  const b = look.borderThickness
  if (look.aspectMode === 'fit' && look.cropRatio !== 'free') {
    const [tw, th] = look.cropRatio.split(':').map(Number)
    const r = tw / th
    return r >= 1 ? { w: OUT, h: Math.round(OUT / r) } : { w: Math.round(OUT * r), h: OUT }
  }
  const s = OUT / Math.max(photo.width, photo.height)
  return { w: Math.round(photo.width * s) + 2 * b, h: Math.round(photo.height * s) + 2 * b }
}

/** refs.json, readable: two-space JSON with each sample written a row of
 *  the 84 px sample per line. */
function formatRefs(refs) {
  const rowLen = (p) => Math.round(p.width * Math.min(1, 84 / Math.max(p.width, p.height)))
  const marks = refs.photos.map((p, i) => {
    const n = rowLen(p)
    const lines = []
    for (let k = 0; k < p.sample.length; k += n) lines.push(p.sample.slice(k, k + n).map((t) => `[${t.join(',')}]`).join(','))
    return { key: `"@@sample${i}@@"`, text: `[\n        ${lines.join(',\n        ')}\n      ]` }
  })
  const json = JSON.stringify({ ...refs, photos: refs.photos.map((p, i) => ({ ...p, sample: `@@sample${i}@@` })) }, null, 2)
  return marks.reduce((s, m) => s.replace(m.key, m.text), json) + '\n'
}

await main()
