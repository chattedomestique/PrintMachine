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
 * Run: npm run verify:offline   (after a PAGES=1 build)
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

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
}

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

  // 1. Online, and wait for the worker to actually take control.
  await page.goto(URL, { waitUntil: 'networkidle' })
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
  const entries = await page.evaluate(async () => {
    const names = await caches.keys()
    const all = []
    for (const n of names) all.push(...(await (await caches.open(n)).keys()).map((r) => r.url))
    return all
  })
  const hashed = entries.filter((u) => /\/assets\/index-[A-Za-z0-9_-]+\.(js|css)$/.test(u))
  if (hashed.length < 2) fail(`precache is missing the hashed JS/CSS (found ${hashed.length})`)
  else console.log(`✓ precached ${entries.length} entries including the hashed bundle`)

  // 3. The app has to say it is ready, or the readiness signal is a lie.
  try {
    await page.waitForSelector('.offline-dot[data-state="ready"]', { timeout: 10_000 })
    console.log('✓ app reports itself offline-ready')
  } catch {
    fail(`offline indicator never reached "ready" (stuck at ${await page.getAttribute('.offline-dot', 'data-state')})`)
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
    // Booting means the app rendered, not merely that a document arrived.
    const booted = await cold.evaluate(() => !!document.querySelector('.sheet canvas'))
    if (!booted) fail('offline cold launch produced a document but the app did not render')
    else console.log('✓ cold launch with no network boots and renders')
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
