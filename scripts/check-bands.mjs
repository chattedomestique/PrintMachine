/**
 * The band engine's cheap gate, for CI. Exits 1 if any check fails.
 *
 *   node scripts/check-bands.mjs
 *
 * In Chromium, through the render harness's page (scripts/harness), on real
 * glyphs and a real photo, through the EXPORT entry (renderPrintAsync, what
 * Save presses):
 *
 *  1. Bands: photo-second-ink and backing-second-ink (a second ink at its own
 *     switch point beside a backing, turned) at 1000 and 1800 px, pressed in
 *     bands of 7 and 97 rows and whole, on a grid of forced 512x128 tiles (so
 *     a 1000 px sheet is 16 tiles and every band reads across tile rows): the
 *     same bytes at every band height. And one framed: frame-fit (Fit on
 *     4:5, the matte, round corners on the photo), the same way.
 *  2. Tiles against one canvas: photo-second-ink at 1000 on those tiles, the
 *     type's share (the photo drawn once as one canvas draws it): at most 1%
 *     of the inked pixels differ, at most 0.05% by more than 128 levels, and
 *     every one that differs, by any amount, inside the box of a plate that
 *     crosses a seam.
 *  3. The font cap: a 9,800 px 'O' (over CANVAS_FONT_MAX, under Chromium's
 *     10,000 px clamp), measured as the engine measures type over the cap
 *     (at fontSize / k, times k), has the advance it has measured directly,
 *     in every face, within 1e-6 of it.
 *
 * The full sweep (every document, heights 600 to 3000, bands of 1 to 512,
 * real and forced tiles, and the seam report at the user's sizes) is
 * `scripts/harness/run.mjs --bands ... --tile ...` and `--seam ...`.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

const failures = []
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const server = await createServer({
  configFile: join(here, 'harness/vite.harness.config.ts'),
  cacheDir: join(tmpdir(), `printmachine-bands-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`),
  server: { port: 0, strictPort: false },
})
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/harness.html`
const browser = await chromium.launch({ executablePath })
const t0 = Date.now()
const TILE = [512, 65536]

try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url)
  await page.waitForFunction(() => window.H !== undefined, null, { timeout: 60_000 })

  console.log('1. Bands on forced 512x128 tiles, through the export entry: the same bytes at every band height')
  for (const doc of ['photo-second-ink', 'backing-second-ink', 'frame-fit']) {
    for (const height of [1000, 1800]) {
      const hashes = []
      for (const bandRows of [7, 97, null]) {
        const r = await page.evaluate(([d, h, b, t]) => window.H.render(d, h, { async: true, tile: t, ...(b === null ? {} : { bandRows: b }) }), [doc, height, bandRows, TILE])
        hashes.push(`${bandRows ?? 'whole'}:${r.sha256.slice(0, 12)}`)
      }
      check(new Set(hashes.map((x) => x.split(':')[1])).size === 1, `${doc}@${height}: ${hashes.join(' ')}`)
    }
  }

  console.log('\n2. Tiles against one canvas: the type\'s share, on forced 512x128 tiles')
  {
    const r = await page.evaluate(([t]) => window.H.seam('photo-second-ink', 1000, t, { glyphsOnly: true }), [TILE])
    check(
      r.inked > 0 && r.pctOfInked <= 1 && r.over128PctOfInked <= 0.05 && r.outside === 0,
      `photo-second-ink@1000 on ${r.tile} (${r.tiles} tiles): ${r.differ} of ${r.inked} inked pixels differ (${r.pctOfInked.toFixed(3)}%, at most 1%), ` +
        `${r.over128} by more than 128 levels (${r.over128PctOfInked.toFixed(4)}%, at most 0.05%), ${r.outside} (at any level) outside the boxes of the plates crossing a seam`,
    )
  }

  console.log('\n3. The font cap: type over 9216 px measured at fontSize / k keeps its advances')
  {
    const { rows, clamp } = await page.evaluate(() => window.H.fontCap())
    for (const r of rows) check(r.k > 1 && r.rel <= 1e-6, `${r.face}: 9800 px 'O' direct ${r.direct.toFixed(4)}, capped (k ${r.k.toFixed(4)}) ${r.capped.toFixed(4)}`)
    console.log(`  (this browser reads a 12000 px font back as "${clamp}")`)
  }

  check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
} finally {
  await browser.close()
  await server.close()
}

console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s`)
if (failures.length) {
  console.log(`\nFAILED:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('All checks pass.')
