/**
 * Proves the app boots with no network.
 *
 * The playbook makes this a non-negotiable (N2) and says explicitly that
 * "works offline" is a claim you must *verify*. It was previously verified by
 * reading the precache manifest and concluding it looked right — which is not
 * verification, it is inspection, and it is how a broken offline story ships.
 *
 * This serves the built `dist/` at the real GitHub Pages sub-path, lets the
 * service worker install and claim, cuts the network, and then loads the app
 * in a brand-new tab. Serving at `/` instead would test a different app: the
 * sub-path is precisely where `navigateFallback` and the precache URLs go
 * wrong, and it survives every localhost test that skips it.
 *
 * On the first, online load the face is served half the app's wait late,
 * and every `measureText` and `fillText` in Poster's stack is recorded with
 * the face's status then: the app must mount with the face loaded and
 * measure or draw nothing in Poster before it is (main.tsx waits for it; an
 * app that mounts at once measures in the fallback and fails here).
 *
 * Then it proves the bundled face is there offline, not vacuously:
 * `document.fonts.check('40px Tanklager')` is true when no such face is
 * declared at all, so it is not used. In the cold offline tab
 * `document.fonts.load` must answer with the face, loaded; a string set
 * in Poster's stack must measure differently from the same string in the
 * stack without the face (equal when the face never loaded); the advance must
 * be the one the online tab measured; and the face's `o` must rise at most 0.9
 * of its `O` (face-checks.mjs: a face whose lowercase is capitals fails).
 * And the cold tab's More sheet carries the build stamp, a commit and a day.
 *
 * Run: npm run verify:offline   (builds with PAGES=1 first: this serves the
 * build only under the Pages sub-path, so a build for `/` would 404 every
 * asset and time out)
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { FACE_WAIT_MS, LOWERCASE_MAX, POSTER_FALLBACK, POSTER_FAMILY, faceSetsStack, lowercaseVerdict, measureFaces } from './face-checks.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const BASE = '/PrintMachine/'
const PORT = 4181
const ORIGIN = `http://127.0.0.1:${PORT}`
const URL = `${ORIGIN}${BASE}`

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  // The style guide's Archivo, and Poster's Tanklager. Chromium loads a font
  // served as application/octet-stream anyway; a test server should still be
  // honest.
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/** What step 5 measures: Poster's stack, the same without its face, and the
 *  face alone (for its ink), each at 40 px. */
const FACE_PROBE = {
  fonts: [`40px ${POSTER_FAMILY}, ${POSTER_FALLBACK}`, `40px ${POSTER_FALLBACK}`, `40px ${POSTER_FAMILY}`],
  chars: ['o', 'O'],
  text: 'RISO Print Machine 0123',
}

let faceServedLate = false

/** Serve dist/ under the Pages sub-path, and nothing outside it. */
function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = req.url.split('?')[0]
      if (!path.startsWith(BASE)) {
        res.writeHead(404)
        return res.end('outside base')
      }
      let rel = path.slice(BASE.length) || 'index.html'
      if (rel.endsWith('/')) rel += 'index.html'
      const file = join(ROOT, rel)
      try {
        await stat(file)
        // The face, the first time it is asked for, half the app's wait
        // late: what a slow first load looks like (step 1 checks nothing is
        // measured or drawn in it before it is in).
        if (extname(file) === '.woff' && !faceServedLate) {
          faceServedLate = true
          await new Promise((r) => setTimeout(r, FACE_WAIT_MS / 2))
        }
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        res.end(await readFile(file))
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}

const server = await serve()

// Last-resort ceiling so nothing can wedge the gate.
const watchdog = setTimeout(() => {
  console.error('✗ offline verification timed out after 90s')
  process.exit(1)
}, 90_000)

// playwright-core ships no browsers; use whatever Chromium this machine has.
const executablePath =
  process.env.CHROMIUM_PATH ??
  [
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find((candidate) => existsSync(candidate))

const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chromium' })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

try {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  // Every measure and draw of text in Poster, with the face's status then,
  // and its status when the app first mounts: nothing may be measured or
  // drawn in the fallback while the face is on its way (main.tsx waits for
  // it; the first load serves it late).
  await page.addInitScript((family) => {
    const status = () => [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === family).map((f) => f.status).join() || 'none'
    window.__poster = { early: [], calls: 0, atMount: null }
    for (const proto of [CanvasRenderingContext2D.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean)) {
      for (const name of ['measureText', 'fillText']) {
        const real = proto[name]
        proto[name] = function (...args) {
          if (this.font.includes(family)) {
            window.__poster.calls++
            const now = status()
            if (now !== 'loaded') window.__poster.early.push(`${name}(${JSON.stringify(String(args[0]).slice(0, 12))}) in ${this.font} while the face is ${now}`)
          }
          return real.apply(this, args)
        }
      }
    }
    new MutationObserver((_, obs) => {
      const root = document.getElementById('root')
      if (root?.firstChild) {
        window.__poster.atMount = status()
        obs.disconnect()
      }
    }).observe(document, { subtree: true, childList: true })
  }, POSTER_FAMILY)

  // 1. Online, and wait for the worker to actually take control.
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sheet canvas', { state: 'attached', timeout: FACE_WAIT_MS + 3000 }).catch(() => {})
  const poster = await page.evaluate(() => window.__poster)
  if (!faceServedLate) fail('the face was never asked for on the first load')
  else if (poster.atMount !== 'loaded' || poster.early.length || poster.calls === 0)
    fail(`with the face served ${FACE_WAIT_MS / 2} ms late, the app mounted with it ${poster.atMount} and measured or drew ${poster.early.length} times in Poster before it loaded: ${poster.early.slice(0, 3).join('; ')}`)
  else console.log(`✓ the face served ${FACE_WAIT_MS / 2} ms late: the app mounted with it loaded, and measured or drew in Poster only after (${poster.calls} times)`)
  // Every wait here is bounded. `navigator.serviceWorker.ready` neither
  // rejects nor resolves when there is no worker to become ready, so an
  // unbounded await turns a failing check into a hung one — in CI that means a
  // job burning its whole timeout instead of saying what broke.
  const sw = await page.evaluate(async () => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000))
    const reg = await Promise.race([navigator.serviceWorker.ready, timeout])
    if (!reg) return { scope: null, controlled: false, reason: 'no worker became ready' }
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return { scope: reg.scope, controlled: !!navigator.serviceWorker.controller }
  })
  if (!sw.controlled) fail(`service worker never took control${sw.reason ? ` — ${sw.reason}` : ''}`)
  else console.log(`✓ service worker active and controlling (scope ${sw.scope})`)

  // 2. The precache must hold the real hashed assets, not just the shell.
  const { entries, bytes } = await page.evaluate(async () => {
    const all = []
    let size = 0
    for (const n of await caches.keys()) {
      const cache = await caches.open(n)
      for (const req of await cache.keys()) {
        all.push(req.url)
        size += (await (await cache.match(req)).arrayBuffer()).byteLength
      }
    }
    return { entries: all, bytes: size }
  })
  const hashed = entries.filter((u) => /\/assets\/index-[A-Za-z0-9_-]+\.(js|css)$/.test(u))
  if (hashed.length < 2) fail(`precache is missing the hashed JS/CSS (found ${hashed.length})`)
  else console.log(`✓ precached ${entries.length} entries, ${(bytes / 2 ** 20).toFixed(3)} MiB (${bytes} B), including the hashed bundle`)
  const face = entries.filter((u) => new RegExp(`/assets/${POSTER_FAMILY}-[A-Za-z0-9_-]+\\.woff$`).test(u))
  if (face.length !== 1) fail(`precache should hold Poster's face once (found ${face.length})`)
  else console.log(`✓ the face is precached (${face[0].slice(face[0].lastIndexOf('/') + 1)})`)
  const online = (await page.evaluate(measureFaces, FACE_PROBE))[0]

  // 3. The app has to say it is ready, or the readiness signal is a lie. The
  // contract is a DOM attribute, not a look: `data-offline-state` on whatever
  // node carries the signal, which need not be visible (`attached`, not the
  // default `visible`: the More sheet's row is in the DOM but not shown).
  try {
    await page.waitForSelector('[data-offline-state="ready"]', { state: 'attached', timeout: 10_000 })
    console.log('✓ app reports itself offline-ready')
  } catch {
    const stuck = await page.evaluate(() => document.querySelector('[data-offline-state]')?.getAttribute('data-offline-state') ?? 'no node')
    fail(`offline signal never reached "ready" (stuck at ${stuck})`)
  }

  // 4. Airplane mode.
  await ctx.setOffline(true)

  // A brand-new tab, because that is what launching from the home screen is.
  // Reloading an already-loaded page can pass on memory cache alone.
  const cold = await ctx.newPage()
  const coldErrors = []
  cold.on('pageerror', (e) => coldErrors.push(String(e)))

  let loaded = true
  try {
    await cold.goto(URL, { waitUntil: 'load', timeout: 20_000 })
  } catch (e) {
    loaded = false
    fail(`cold launch offline did not load: ${String(e).split('\n')[0]}`)
  }

  // Only probe the DOM if something actually loaded — evaluating against a
  // failed navigation throws, which would bury the diagnostics above under a
  // stack trace and make a clear failure look like a crash.
  if (loaded) {
    // Booting means the app rendered, not merely that a document arrived. The
    // app mounts once Poster's face is in (main.tsx, two seconds at most), so
    // the sheet is waited for, that long and a little more, never longer.
    const booted = await cold
      .waitForSelector('.sheet canvas', { state: 'attached', timeout: FACE_WAIT_MS + 3000 })
      .then(() => true)
      .catch(() => false)
    if (!booted) fail('offline cold launch produced a document but the app did not render')
    else console.log('✓ cold launch with no network boots and renders')
    // The More sheet's offline row says which build this is (vite.config.ts
    // `define`): the copy kept for offline carries its stamp, a commit and a
    // day ('dev' outside a git checkout).
    const stamp = await cold.evaluate(() => document.querySelector('[data-build]')?.getAttribute('data-build') ?? null)
    if (!stamp || !/^([0-9a-f]{7,40}|dev) · \d{4}-\d{2}-\d{2}$/.test(stamp)) fail(`the offline copy has no build stamp ("${stamp}")`)
    else console.log(`✓ the offline copy says which build it is: ${stamp}`)
  }

  // 5. The face, offline, really there (see the header).
  if (loaded) {
    // First what the app itself did: it mounts only after its own wait for
    // the face, so by now the declared FontFace is loaded, before this check
    // asks for anything.
    const declaredFaces = (family) => [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === family).map((f) => f.status)
    const byApp = await cold.evaluate(declaredFaces, POSTER_FAMILY)
    const loadedFaces = await cold.evaluate(async (family) => {
      const faces = await document.fonts.load(`40px ${family}`).catch(() => [])
      return faces.map((f) => ({ family: f.family, status: f.status }))
    }, POSTER_FAMILY)
    const declared = await cold.evaluate(declaredFaces, POSTER_FAMILY)
    const faceIn = loadedFaces.length > 0 && loadedFaces.every((f) => f.status === 'loaded') && declared.length === 1 && declared[0] === 'loaded'
    if (byApp.length !== 1 || byApp[0] !== 'loaded') fail(`the app's own FontFace is not loaded offline: ${JSON.stringify(byApp)}`)
    else if (loadedFaces.length === 0) fail(`document.fonts.load('40px ${POSTER_FAMILY}') answered with no face: none is declared`)
    else if (!faceIn) fail(`the face did not load offline: ${JSON.stringify({ loadedFaces, declared })}`)
    else console.log(`✓ the face loads with no network (the app's FontFace ${POSTER_FAMILY}: ${declared[0]})`)
    const [stack, fallback, alone] = await cold.evaluate(measureFaces, FACE_PROBE)
    if (!faceSetsStack(stack.advance, fallback.advance)) {
      fail(`Poster's stack measures as its fallback (${stack.advance} against ${fallback.advance}): the face is not what sets it`)
    } else console.log(`✓ the face sets Poster: "${FACE_PROBE.text}" is ${stack.advance.toFixed(2)} px wide, ${fallback.advance.toFixed(2)} without it`)
    if (stack.advance !== online.advance) fail(`the face measures differently offline (${stack.advance}) and online (${online.advance})`)
    else console.log('✓ and the same width it measured online')
    // A face that never loaded is measured in whatever the page falls back
    // to, whose lowercase says nothing about the face's.
    const lower = lowercaseVerdict((ch) => alone.ascents[ch])
    if (!faceIn) fail("the face's lowercase is not measured: the face is not loaded")
    else if (!lower.ok) fail(`the face's lowercase is not its own: o rises ${lower.ratio.toFixed(3)} of O (at most ${LOWERCASE_MAX})`)
    else console.log(`✓ the face draws a lowercase: o rises ${lower.ratio.toFixed(3)} of O (at most ${LOWERCASE_MAX})`)
  }

  if (coldErrors.length) fail(`offline launch logged errors: ${coldErrors.slice(0, 3).join(' | ')}`)
  if (errors.length) fail(`online load logged errors: ${errors.slice(0, 3).join(' | ')}`)
} finally {
  clearTimeout(watchdog)
  await browser.close()
  server.close()
}

if (process.exitCode) console.error('\nOFFLINE VERIFICATION FAILED')
else console.log('\nOffline verification passed.')
