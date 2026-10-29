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
 *   node scripts/harness/run.mjs --out c.json --no-hashes --chain   (the whole chain in Frosted: a photo imported for real, its
 *       palette stored, its PNG written by the app's own pressForSave at the photo's own size, 1800; the preview, the export and
 *       that file the same bytes; exits 1 if not)
 *   node scripts/harness/run.mjs --out c.json --no-hashes --frame-cost   (the frame's cost in the preview: photo documents framed
 *       (Crop, Fit, Frosted) against unframed and against the same framed render with its compose skipped, and Frosted with
 *       its field made again against unframed, settled and draft, each render the mean of its fastest samples over 15
 *       interleaved rounds (--runs n); a document and size with a row over its bound is measured again, up to twice, its
 *       samples pooled; exits 1 if a row is still over)
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
  const opts = { heights: [300, 1000, 1800], docs: null, time: [], scale: [], seam: [], parity: null, fileParity: null, retry: false, chain: false, bands: null, tile: null, frameCost: false, photoMp: undefined, runs: null, hashes: true, out: null, png: null }
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
    else if (a === '--chain') opts.chain = true
    else if (a === '--frame-cost') opts.frameCost = true
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
  // Poster set in a fallback would be a different print, and an A/B would
  // call it a change (harness.ts header).
  const faces = await page.evaluate(() => window.H.faces)
  if (faces !== 'loaded') throw new Error(`harness: Poster's face did not load (${faces})`)
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
  chain: null,
  bands: {},
  seam: {},
  frameCost: {},
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

  if (opts.chain) {
    // The whole chain in Frosted: a photo imported for real, its palette
    // stored, the file Save writes (the app's own pressForSave, at the
    // photo's own size); the preview, the export and that file, the same
    // bytes.
    const { page, errors } = await openPage()
    const r = await page.evaluate((h) => window.H.chain(h), 1800)
    if (!r.same) {
      failed = true
      failure = r.sameField ? 'the whole chain: the preview, the export and the file differ' : "the whole chain: the preview's field is not the one Save presses"
    }
    result.chain = r
    console.log(`chain frosted@1800`.padEnd(32), r.same ? 'SAME' : 'DIFFERS', `${r.w}x${r.h}`, r.preview.slice(0, 12), r.exported.slice(0, 12), r.file.slice(0, 12), r.sameField ? "the preview's field is Save's" : 'ANOTHER FIELD')
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

  if (opts.frameCost) {
    // The frame's cost in the preview: a photo document framed (the first
    // photo's width, round corners, the photo's own colour, in Crop and in
    // Fit; and Frosted at Blur 60 in Crop, its field made once, as the page
    // keeps it) at the settled and the draft size, rendered the way the
    // preview renders a frame (its canvases and cache kept; the photo drawn
    // and the frame composed every time), against two others:
    //  - the same document unframed: what a person waits for with the frame
    //    on, against without it;
    //  - the same framed render with its compose skipped (the preview's test
    //    seam): the photo drawn into the same rectangle, so the ratio is the
    //    frame's own work alone (in Fit the photo is drawn smaller than
    //    unframed, and that saving would hide the frame's cost).
    // Each bounded by FRAME_COST, the plan's 1.10x settled and 1.25x draft.
    // And Frosted with its field made again inside the render, against the
    // same document unframed (REMAKE_COST); and Frosted on Original with its
    // field made for a new sheet shape (a Width drag there), against the
    // same render with its field kept (RESHAPE_COST).
    //
    // A shared machine's interference only ever adds time, comes in spells
    // (a fixed piece of plain JavaScript, 145 ms at its fastest, took up to
    // 274 ms on the machine these numbers come from), and a spell can outlast
    // every round of a document and size taken back to back. So:
    //  - a sample is one render. The four documents and sizes are
    //    interleaved round by round, so each one's rounds spread over the
    //    whole measurement (15 rounds, `--runs n`; a draft render being
    //    ~8 ms, a draft round is 10 samples of each). Within a round the
    //    ten renders run in a cycle, started one further on each round and
    //    reversed every other round, and the first render of each round's
    //    turn is not timed (the first render after another document or size
    //    ran 2 to 6% slower);
    //  - a render's time is the mean of its fastest samples, a fifth of one
    //    measurement's (3 settled, 30 draft), from every sample taken of it;
    //  - a document and size with a row (Crop, Fit, Frosted, Frosted made
    //    again, or Frosted made for a new shape) over its bound is
    //    measured again, up to twice, its new samples added to its old, and
    //    every measurement is printed. A row fails if it is still over after
    //    the third. More samples only bring a render's time nearer its floor:
    //    a spell that slowed a framed render in one measurement is outweighed
    //    by the next, and so is one that slowed the render it is compared
    //    with, which would otherwise let a costly frame through.
    // The numbers this gives are in the README ("The frame is ground").
    const FRAME_COST = { settled: 1.1, draft: 1.25 }
    // Frosted with its field made again inside the render from the kept
    // cover (each frame of a Blur drag: the passes and the grade), against
    // the same document unframed: no bound of the plan's own, so what it
    // measured x 1.25 (1.12 to 1.26 settled, 1.21 to 1.28 draft, over 8
    // runs). The draft bound fails a drag that makes the cover again each
    // frame (2.67x, 3.32x); README "The frame is ground" says what the
    // settled one cannot see.
    const REMAKE_COST = { settled: 1.58, draft: 1.6 }
    // Frosted on Original with its field made again for a new sheet shape
    // inside the render (each frame of a Width drag there: the cover and
    // the field), against the same render with its field kept: the
    // making's own share, what it measured x 1.25 (RESHAPE_COST, set from
    // a batch at this code: 1.31 to 1.45 settled, 2.68 to 3.22 draft, over
    // 8 runs). The draft bound fails a drag whose cover is made twice
    // (4.26x to 5.21x); the settled one cannot see it (1.60x), as the
    // made-again row's cannot (README "The frame is ground").
    const RESHAPE_COST = { settled: 1.82, draft: 4.03 }
    const MEASUREMENTS = 3
    const DRAFT_SAMPLES = 10
    const rounds = Math.max(5, opts.runs ?? 15)
    const { page, errors } = await openPage()
    // No render next to its own bare or framed twin, either way round (a
    // precaution: measured, a bare render ran no faster straight after its
    // framed twin's canvases and cache than after another's).
    const kinds = [
      ['none', 'none', false, false],
      ['crop', 'crop', false, false],
      ['frosted', 'frosted', false, false],
      ['fit', 'fit', false, false],
      ['frosted-original', 'frosted-original', false, false],
      ['crop-bare', 'crop', true, false],
      ['frosted-remake', 'frosted', false, true],
      ['fit-bare', 'fit', true, false],
      ['frosted-bare', 'frosted', true, false],
      ['frosted-reshape', 'frosted-original', false, 'reshape'],
    ]
    const FRAMED = ['crop', 'fit', 'frosted']
    // Round i's turn of n timed renders, behind one untimed: the cycle,
    // reversed on odd rounds, from position i (each kind n / 5 times).
    const turnOf = (i, n) => {
      const cycle = i % 2 === 0 ? kinds : [...kinds].reverse()
      const at = (s) => cycle[(((i + s - 1) % cycle.length) + cycle.length) % cycle.length]
      return Array.from({ length: n + 1 }, (_, s) => at(s))
    }
    const meanOfFastest = (xs, n) => {
      const v = [...xs].sort((a, b) => a - b).slice(0, n)
      return v.reduce((s, x) => s + x, 0) / v.length
    }
    const phases = ['native-photo', 'photo-12mp'].flatMap((doc) =>
      [false, true].map((draft) => ({
        doc,
        draft,
        size: '',
        samples: Object.fromEntries(kinds.map(([k]) => [k, []])),
        measurements: [],
        ok: { crop: false, fit: false, frosted: false, 'frosted-remake': false, 'frosted-reshape': false },
      })),
    )
    // One measurement of some documents and sizes, their rounds interleaved.
    // The first round only warms the canvases and the cache.
    const measure = async (list) => {
      const times = new Map(list.map((p) => [p, Object.fromEntries(kinds.map(([k]) => [k, []]))]))
      for (let i = -1; i < rounds; i++) {
        for (const p of list) {
          const turn = turnOf(i, kinds.length * (p.draft ? DRAFT_SAMPLES : 1))
          for (let s = 0; s < turn.length; s++) {
            const [k, f, bare, remake] = turn[s]
            const r = await page.evaluate(([d, ff, dr, b, m]) => window.H.frameCost(d, ff, dr, b, m), [p.doc, f, p.draft, bare, remake])
            if (i >= 0 && s > 0) times.get(p)[k].push(r.ms)
            if (k === 'none') p.size = `${r.w}x${r.h}`
          }
        }
      }
      return times
    }
    let pending = phases
    for (let m = 1; m <= MEASUREMENTS && pending.length > 0; m++) {
      const times = await measure(pending)
      for (const p of pending) {
        for (const [k] of kinds) p.samples[k].push(...times.get(p)[k])
        const fastest = Math.max(1, Math.round(((p.draft ? DRAFT_SAMPLES : 1) * rounds) / 5))
        const at = Object.fromEntries(kinds.map(([k]) => [k, meanOfFastest(p.samples[k], fastest)]))
        const bound = p.draft ? FRAME_COST.draft : FRAME_COST.settled
        const remakeBound = p.draft ? REMAKE_COST.draft : REMAKE_COST.settled
        const reshapeBound = p.draft ? RESHAPE_COST.draft : RESHAPE_COST.settled
        const row = { unframed: Number(at.none.toFixed(2)) }
        for (const f of FRAMED) {
          const waits = at[f] / at.none
          const own = at[f] / at[`${f}-bare`]
          p.ok[f] = waits <= bound && own <= bound
          row[f] = { ms: Number(at[f].toFixed(2)), bare: Number(at[`${f}-bare`].toFixed(2)), ratio: Number(waits.toFixed(3)), own: Number(own.toFixed(3)), ok: p.ok[f] }
        }
        {
          const waits = at['frosted-remake'] / at.none
          p.ok['frosted-remake'] = waits <= remakeBound
          row['frosted-remake'] = { ms: Number(at['frosted-remake'].toFixed(2)), ratio: Number(waits.toFixed(3)), ok: p.ok['frosted-remake'] }
        }
        {
          const own = at['frosted-reshape'] / at['frosted-original']
          p.ok['frosted-reshape'] = own <= reshapeBound
          row['frosted-reshape'] = { ms: Number(at['frosted-reshape'].toFixed(2)), kept: Number(at['frosted-original'].toFixed(2)), own: Number(own.toFixed(3)), ok: p.ok['frosted-reshape'] }
        }
        // The verdict on every sample so far, and this measurement's own samples.
        p.measurements.push({ ...row, runs: times.get(p) })
        const done = Object.values(p.ok).every(Boolean)
        const name = { crop: 'Crop', fit: 'Fit', frosted: 'Frosted' }
        console.log(
          `frame-cost ${p.doc} ${p.draft ? 'draft' : 'settled'} ${p.size}${m > 1 ? ` (${m} measurements)` : ''}`.padEnd(40),
          `unframed ${at.none.toFixed(1)} ms;`,
          FRAMED.map((f) => `${name[f]} ${row[f].ms.toFixed(1)} ms (${row[f].ratio}x unframed, ${row[f].own}x its own compose skipped)${row[f].ok ? '' : ' over'}`).join('; '),
          `bound ${bound}x;`,
          `Frosted, its field made again ${row['frosted-remake'].ms.toFixed(1)} ms (${row['frosted-remake'].ratio}x unframed, bound ${remakeBound}x)${row['frosted-remake'].ok ? '' : ' over'};`,
          `on Original, made for a new shape ${row['frosted-reshape'].ms.toFixed(1)} ms (${row['frosted-reshape'].own}x its field kept, ${row['frosted-reshape'].kept.toFixed(1)} ms; bound ${reshapeBound}x)${row['frosted-reshape'].ok ? '' : ' over'}`,
          done ? 'ok' : m < MEASUREMENTS ? 'OVER, measured again' : `OVER after ${MEASUREMENTS} measurements`,
        )
      }
      pending = pending.filter((p) => !Object.values(p.ok).every(Boolean))
    }
    for (const p of phases) {
      result.frameCost[`${p.doc} ${p.draft ? 'draft' : 'settled'} ${p.size}`] = {
        bound: p.draft ? FRAME_COST.draft : FRAME_COST.settled,
        remakeBound: p.draft ? REMAKE_COST.draft : REMAKE_COST.settled,
        reshapeBound: p.draft ? RESHAPE_COST.draft : RESHAPE_COST.settled,
        ok: p.ok,
        measurements: p.measurements,
      }
    }
    if (pending.length > 0) {
      failed = true
      failure = 'a framed preview costs more than its bound'
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
    for (let i = 0; i < (opts.runs ?? 3); i++) {
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
