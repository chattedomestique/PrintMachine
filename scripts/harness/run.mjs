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
  const opts = { heights: [300, 1000, 1800], docs: null, time: [], scale: [], parity: null, photoMp: undefined, runs: 3, hashes: true, out: null, png: null }
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
}
let failed = false

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
      if (!same) failed = true
      result.parity[`${doc}@${opts.parity}`] = { sync: a.sha256, async: b.sha256, same }
      console.log(`parity ${doc}@${opts.parity}`.padEnd(32), same ? 'SAME' : 'DIFFERS', a.sha256.slice(0, 12), b.sha256.slice(0, 12))
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
  console.error('the preview and export entry points disagree')
  process.exit(1)
}
