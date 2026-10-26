/**
 * Render the frozen documents through the real engine in Chromium and write
 * every hash (and, on request, timings) to a JSON file.
 *
 *   node scripts/harness/run.mjs --out a.json
 *   node scripts/harness/run.mjs --out a.json --heights 300,1000 --docs plain,default
 *   node scripts/harness/run.mjs --out t.json --no-hashes --time photo-second-ink@3780 --photo-mp 12 --runs 3   (through the export entry)
 *   node scripts/harness/run.mjs --out a.json --heights 1000 --png shots/   (also writes each render as a PNG)
 *   node scripts/harness/run.mjs --out s.json --no-hashes --scale default@900,small-2@1800   (h against 2h)
 *   node scripts/harness/run.mjs --out p.json --no-hashes --parity 1000   (preview and export entry points agree; exits 1 if not)
 *   node scripts/harness/run.mjs --out b.json --no-hashes --bands 1,7,97,full --heights 600,1000   (the export pressed in bands of
 *       each height gives the same bytes as pressed whole; bands of 1 and 7 only at heights up to 600; exits 1 if any differ)
 *   ... --bands 1,7,97,full --tile 512,65536   (the same on a grid of forced 512x128 tiles: --tile edge,pixels)
 *   node scripts/harness/run.mjs --out f.json --no-hashes --file-parity 1000 --retry   (P-5: the real savePrint's PNG decodes to
 *       the export entry's canvas, every document; P-6: a RangeError injected once at set-up and once mid-press gives the same file)
 *   node scripts/harness/run.mjs --out s.json --no-hashes --seam photo-second-ink@3000,default@3600 [--tile 512,65536]
 *       (tiles against one canvas: the export on the tile grid, the real one or --tile's, against the same on a single tile;
 *       prints the differing pixels against the inked ones and the plates whose box crosses a seam; exits 1 outside the bounds)
 *
 * Then `node scripts/harness/compare.mjs a.json b.json`. Hashes of documents
 * with text depend on the installed fonts, so compare runs from ONE machine
 * (a commit against its parent, via `git worktree`), never against a hash
 * recorded elsewhere. See README in this folder.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

function parseArgs(argv) {
  const opts = { heights: [300, 1000, 1800], docs: null, time: [], scale: [], seam: [], parity: null, fileParity: null, retry: false, bands: null, tile: null, photoMp: undefined, runs: 3, hashes: true, out: null, png: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--out') opts.out = next()
    else if (a === '--heights') opts.heights = next().split(',').map(Number)
    else if (a === '--docs') opts.docs = next().split(',')
    else if (a === '--time') opts.time.push(next())
    else if (a === '--scale') opts.scale.push(...next().split(','))
    else if (a === '--parity') opts.parity = Number(next())
    else if (a === '--file-parity') opts.fileParity = Number(next())
    else if (a === '--retry') opts.retry = true
    else if (a === '--bands') opts.bands = next().split(',').map((b) => (b === 'full' ? null : Number(b)))
    else if (a === '--tile') opts.tile = next().split(',').map(Number)
    else if (a === '--seam') opts.seam.push(...next().split(','))
    else if (a === '--photo-mp') opts.photoMp = Number(next())
    else if (a === '--runs') opts.runs = Number(next())
    else if (a === '--no-hashes') opts.hashes = false
    else if (a === '--png') opts.png = next()
    else throw new Error(`unknown argument ${a}`)
  }
  if (!opts.out) throw new Error('--out <file.json> is required')
  return opts
}

const opts = parseArgs(process.argv.slice(2))

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

// Same convention as scripts/verify-offline.mjs: playwright-core ships no
// browser, so use whichever Chromium this machine has.
const executablePath =
  process.env.CHROMIUM_PATH ??
  [
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find((candidate) => existsSync(candidate))

// One dependency cache per checkout, so a commit and its parent worktree never
// share (or fight over) one. HARNESS_CACHE_DIR puts it somewhere specific.
const cacheDir =
  process.env.HARNESS_CACHE_DIR ??
  join(tmpdir(), `printmachine-harness-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`)

const server = await createServer({
  configFile: join(here, 'vite.harness.config.ts'),
  cacheDir,
  server: { port: 0, strictPort: false },
})
await server.listen()
const address = server.httpServer.address()
const url = `http://127.0.0.1:${address.port}/harness.html`

const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chromium' })

async function openPage() {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(url)
  await page.waitForFunction(() => window.H !== undefined, null, { timeout: 30_000 }).catch(() => {
    throw new Error(`harness did not load: ${errors.join(' | ') || 'no error reported'}`)
  })
  return { page, errors }
}

const result = {
  meta: {
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: (git('status', '--porcelain', '--', 'src', 'scripts/harness') ?? '') !== '',
    chromium: browser.version(),
    date: new Date().toISOString(),
  },
  normalized: null,
  renders: {},
  timings: {},
  scale: {},
  parity: {},
  fileParity: {},
  retry: {},
  bands: {},
  seam: {},
}
let failed = false
let failure = ''


try {
  if (opts.hashes) {
    const { page, errors } = await openPage()
    const info = await page.evaluate(() => ({ docs: window.H.docs, normalized: window.H.normalized }))
    result.normalized = info.normalized
    const docs = opts.docs ?? info.docs
    for (const doc of docs) {
      for (const height of opts.heights) {
        const r = await page.evaluate(([d, h, png]) => window.H.render(d, h, { png }), [doc, height, !!opts.png])
        result.renders[`${doc}@${height}`] = { sha256: r.sha256, w: r.w, h: r.h, ms: Math.round(r.ms) }
        if (opts.png && r.png) {
          mkdirSync(opts.png, { recursive: true })
          writeFileSync(join(opts.png, `${doc}@${height}.png`), Buffer.from(r.png.split(',')[1], 'base64'))
        }
        console.log(`${doc}@${height}`.padEnd(28), r.sha256.slice(0, 16), `${r.w}x${r.h}`, `${Math.round(r.ms)} ms`)
      }
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  if (opts.scale.length) {
    // The same print at twice the height: corr(box2(render(2h)), render(h)).
    const { page, errors } = await openPage()
    for (const spec of opts.scale) {
      const [doc, h] = spec.split('@')
      const r = await page.evaluate(([d, hh]) => window.H.scaleCorrelation(d, hh), [doc, Number(h)])
      result.scale[spec] = { corr: Number(r.corr.toFixed(4)), w: r.w, h: r.h }
      console.log(`scale ${spec} vs ${Number(h) * 2}`.padEnd(32), `corr ${r.corr.toFixed(4)}`)
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  if (opts.parity) {
    // The preview and the export must give the same pixels, so the preview
    // stays a true picture of the print: every document through renderPrint
    // and through renderPrintAsync (the export's entry point), overlay off,
    // must give the same bytes.
    const { page, errors } = await openPage()
    const docs = opts.docs ?? (await page.evaluate(() => window.H.docs))
    for (const doc of docs) {
      const a = await page.evaluate(([d, h]) => window.H.render(d, h), [doc, opts.parity])
      const b = await page.evaluate(([d, h]) => window.H.render(d, h, { async: true }), [doc, opts.parity])
      const same = a.sha256 === b.sha256 && a.w === b.w && a.h === b.h
      if (!same) {
        failed = true
        failure = 'the preview and export entry points disagree'
      }
      result.parity[`${doc}@${opts.parity}`] = { sync: a.sha256, async: b.sha256, same }
      console.log(`parity ${doc}@${opts.parity}`.padEnd(32), same ? 'SAME' : 'DIFFERS', a.sha256.slice(0, 12), b.sha256.slice(0, 12))
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  if (opts.fileParity) {
    // P-5: the file is the canvas. The real savePrint as a PNG no taller than
    // the height, decoded, against the export entry at the same height.
    const { page, errors } = await openPage()
    const docs = opts.docs ?? (await page.evaluate(() => window.H.docs))
    for (const doc of docs) {
      const r = await page.evaluate(([d, h]) => window.H.fileParity(d, h), [doc, opts.fileParity])
      if (!r.same) {
        failed = true
        failure = 'a saved file is not the print the export entry paints'
      }
      result.fileParity[`${doc}@${opts.fileParity}`] = r
      console.log(`file ${doc}@${opts.fileParity}`.padEnd(32), r.same ? 'SAME' : 'DIFFERS', `${r.w}x${r.h}`, r.file.slice(0, 12), r.canvas.slice(0, 12))
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  if (opts.retry) {
    // P-6: an allocation that fails once, at set-up or mid-press, is pressed
    // again in bands half as tall: the same file.
    const { page, errors } = await openPage()
    for (const [doc, h] of [['photo-second-ink', 3000], ['grain-photo', 3000], ['default', 3600]]) {
      for (const at of ['setup', 'mid']) {
        const r = await page.evaluate(([d, hh, a]) => window.H.retry(d, hh, a), [doc, h, at])
        // Pressed again in bands half as tall: more of them.
        const ok = r.same && r.thrown && r.faultedBands > r.cleanBands
        if (!ok) {
          failed = true
          failure = 'a press that ran out of memory once did not give the same file'
        }
        result.retry[`${doc}@${h} ${at}`] = r
        console.log(`retry ${doc}@${h} ${at}`.padEnd(32), ok ? 'SAME' : 'FAILED', `${r.cleanBands} bands, after the fault ${r.faultedBands}`, r.clean.slice(0, 12), r.faulted.slice(0, 12))
      }
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  if (opts.bands) {
    // Pressed in bands of every height asked for, through the export entry:
    // each must give the bytes the sheet pressed whole (one band) gives.
    // Bands of 1 and 7 only at heights up to 600 (a band of one row repeats
    // the halo for every row).
    const { page, errors } = await openPage()
    const docs = opts.docs ?? (await page.evaluate(() => window.H.docs))
    for (const doc of docs) {
      for (const height of opts.heights) {
        const hashes = []
        for (const bandRows of opts.bands) {
          if (bandRows !== null && bandRows < 8 && height > 600) continue
          const r = await page.evaluate(
            ([d, h, b, t]) => window.H.render(d, h, { async: true, ...(b === null ? {} : { bandRows: b }), ...(t ? { tile: t } : {}) }),
            [doc, height, bandRows, opts.tile],
          )
          hashes.push([bandRows ?? 'full', r.sha256])
        }
        const same = hashes.every(([, h]) => h === hashes[0][1])
        if (!same) {
          failed = true
          failure = 'a band height prints different bytes'
        }
        result.bands[`${doc}@${height}${opts.tile ? ` tile ${opts.tile.join(',')}` : ''}`] = Object.fromEntries(hashes)
        console.log(`bands ${doc}@${height}${opts.tile ? ` tile ${opts.tile.join(',')}` : ''}`.padEnd(44), same ? 'SAME' : 'DIFFERS', hashes.map(([b, h]) => `${b}:${h.slice(0, 8)}`).join(' '))
      }
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  if (opts.seam.length) {
    // P-4, tiles against one canvas: on the grid (the real budget, or
    // --tile's) and on a single tile.
    //  - The type's share (over a photo at its own pixels, or none; over a
    //    resampled photo, with that photo drawn once as one canvas draws it, so
    //    only the glyphs' tiles differ): at most 1% of the inked pixels may
    //    differ, at most 0.05% by more than 128 levels, and every pixel that
    //    differs, by any amount, lies inside the widened box of a plate that
    //    crosses a seam (its ground is the same bytes on both grids, so no
    //    difference is let off).
    //  - A resampled photo's share (a print with no type inked): at most a
    //    level anywhere, and on the real grid at most 0.1% of the bytes (with
    //    forced small tiles the seams are many times as dense: printed).
    //  - A print with type over a resampled photo, both on the grid: printed.
    const tile = opts.tile ?? [4096, 4194304]
    const real = !opts.tile
    const { page, errors } = await openPage()
    const line = (r) =>
      r.inked
        ? `${r.differ} of ${r.inked} inked differ (${r.pctOfInked.toFixed(3)}%; ${r.over1} by more than a level), ${r.over128} over 128 ` +
          `(${r.over128PctOfInked.toFixed(4)}%), largest ${r.maxDiff}; outside the boxes ${r.outside}; crossing a seam: ${r.crossing.join(', ') || 'none'}`
        : `no type: ${r.differBytes} of ${r.bytes} bytes differ (${r.pctOfBytes.toFixed(4)}%), largest ${r.maxDiff}`
    for (const spec of opts.seam) {
      const [doc, h] = spec.split('@')
      const run = (glyphsOnly) => page.evaluate(([d, hh, t, mp, g]) => window.H.seam(d, hh, t, { photo: mp, glyphsOnly: g }), [doc, Number(h), tile, opts.photoMp, glyphsOnly])
      const r = await run(false)
      const runs = [r]
      let ok
      if (!r.inked) ok = r.maxDiff <= 1 && (!real || r.pctOfBytes <= 0.1)
      else {
        const g = r.resampled ? await run(true) : r
        if (g !== r) runs.push(g)
        ok = g.outside === 0 && g.pctOfInked <= 1 && g.over128PctOfInked <= 0.05
      }
      if (!ok) {
        failed = true
        failure = 'tiles differ from one canvas outside the bounds'
      }
      result.seam[`${spec} tile ${tile.join(',')}`] = runs
      const head = `seam ${spec} on ${r.tile} (${r.tiles} tiles)`.padEnd(40)
      if (runs.length === 1) console.log(head, r.resampled && !r.inked ? 'photo resampled,' : '', line(r), ok ? 'ok' : 'OUT OF BOUNDS')
      else {
        console.log(head, `type alone: ${line(runs[1])}`, ok ? 'ok' : 'OUT OF BOUNDS')
        console.log(' '.repeat(40), `with the resampled photo on the grid too: ${line(r)}`)
      }
    }
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await page.close()
  }

  for (const spec of opts.time) {
    const [doc, h] = spec.split('@')
    const height = Number(h)
    const runs = []
    // A fresh page per run, so one render's garbage is not the next one's cost.
    // Through the EXPORT entry (renderPrintAsync, no cache): a timing is of
    // what Save runs, not of the preview's cached path.
    for (let i = 0; i < opts.runs; i++) {
      const { page, errors } = await openPage()
      const r = await page.evaluate(([d, hh, mp]) => window.H.render(d, hh, { photo: mp, async: true }), [doc, height, opts.photoMp])
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
      runs.push(Math.round(r.ms))
      await page.close()
    }
    const sorted = [...runs].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    result.timings[`${spec}${opts.photoMp ? `+photo${opts.photoMp}MP` : ''}`] = { runs, median }
    console.log(`time ${spec}`.padEnd(28), `runs ${runs.join(', ')} ms`, `median ${median} ms`)
  }
} finally {
  await browser.close()
  await server.close()
}

writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n')
console.log(`wrote ${opts.out}`)
if (failed) {
  console.error(failure)
  process.exit(1)
}
