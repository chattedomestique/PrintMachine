/**
 * The device spike page (scripts/device-spike/spike.html) still loads, runs
 * and prints its table, in Chromium. The page is meant for a phone; this keeps
 * it from rotting between the times someone opens it there. Exits 1 if any
 * check fails, and prints the table either way.
 *
 *   node scripts/check-spike.mjs
 *
 * Served from 127.0.0.1 (one file, nothing else), at 390 px wide:
 *
 *  1. It asks for nothing but itself: no request to any other URL.
 *  2. A <title> of two to four words; at 320, 390 and 430 px wide no
 *     horizontal scroll and every control at least 44 x 44 px; the colours
 *     change under a dark colour scheme and the body has a background.
 *  3. A test that was running when the tab went away is reported as such
 *     after the reload (iOS reloads a tab it killed for memory).
 *  4. With a picked photo (a 3000 x 2000 JPEG the page itself makes) and the
 *     default 40 MP synthetic photo, "Run all tests" finishes; no row failed;
 *     the 1:1 blit is identical across tile origins with smoothing off; the
 *     largest canvas font is at least 9216 px; every canvas sentinel reads
 *     back; the decode of the synthetic 40 MP photo passes rule (a).
 *  5. "Copy results" puts the table on the clipboard; when the clipboard
 *     refuses, the whole table is selected for the system's Copy.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const PAGE = resolve(here, 'device-spike/spike.html')
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

const failures = []
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const html = readFileSync(PAGE)
const server = createServer((req, res) => {
  if (req.url === '/spike.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const url = `${origin}/spike.html`

const browser = await chromium.launch({ executablePath })
const t0 = Date.now()
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  const page = await context.newPage()
  const requests = []
  const errors = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(url)
  await page.waitForFunction(() => document.body.dataset.state === 'ready')

  console.log('Page shape')
  const title = await page.title()
  const words = title.trim().split(/\s+/).length
  check(words >= 2 && words <= 4, `title "${title}" is two to four words`)
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    const shape = await page.evaluate(() => {
      const doc = document.documentElement
      const small = []
      for (const el of document.querySelectorAll('button, select, .file-button')) {
        const r = el.getBoundingClientRect()
        if (r.width < 44 || r.height < 44) small.push(`${el.id || el.className} ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
      return { scroll: doc.scrollWidth, client: doc.clientWidth, small }
    })
    check(shape.scroll <= shape.client, `at ${width} px no horizontal scroll (${shape.scroll} <= ${shape.client})`)
    check(shape.small.length === 0, `at ${width} px every control is at least 44 x 44${shape.small.length ? `: ${shape.small.join(', ')}` : ''}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const bg = async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.emulateMedia({ colorScheme: 'light' })
  const light = await bg()
  await page.emulateMedia({ colorScheme: 'dark' })
  const dark = await bg()
  await page.emulateMedia({ colorScheme: 'light' })
  const opaque = (c) => c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)
  check(opaque(light) && opaque(dark) && light !== dark, `body background ${light} light, ${dark} dark`)

  console.log('A test the tab did not survive')
  await page.evaluate(() =>
    sessionStorage.setItem('pm-spike-v1:inflight', JSON.stringify({ id: '2a', test: 'decode synthetic 7728x5152', decode: true })),
  )
  await page.reload()
  await page.waitForFunction(() => document.body.dataset.state === 'ready')
  const afterReload = await page.inputValue('#table')
  check(/DID NOT FINISH/.test(afterReload) && /\(a\)[^\n]*FAIL/.test(afterReload), 'after a reload mid-test the row says it did not finish, and (a) fails')
  await page.click('#clear')
  check(!/DID NOT FINISH/.test(await page.inputValue('#table')), 'Clear results empties the table')

  console.log('Run all tests')
  const b64 = await page.evaluate(() => window.spike.jpegBase64(3000, 2000))
  await page.setInputFiles('#pick', { name: 'test-3000x2000.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') })
  const tRun = Date.now()
  await page.click('#run')
  await page.waitForFunction(() => document.body.dataset.state === 'done', null, { timeout: 180_000 })
  const runMs = Date.now() - tRun
  const table = await page.inputValue('#table')
  console.log('\n' + table.replace(/^/gm, '    ') + '\n')
  const row = (id) => table.split('\n').find((l) => l.startsWith(id.padEnd(5)))
  for (const id of ['1', '1b', '2', '2a', '2ab', '3', '4', '5', '6']) check(!!row(id), `row ${id} is there`)
  check(!/FAILED|DID NOT FINISH/.test(table), 'no row failed')
  check(/smoothing off: identical/.test(row('1b') ?? ''), 'blit of the picked photo: identical across origins, smoothing off')
  check(/smoothing off: identical/.test(row('2ab') ?? ''), 'blit of the 40 MP synthetic photo: identical across origins, smoothing off')
  const largest = Number(/largest (\d+) px/.exec(row('4') ?? '')?.[1] ?? 0)
  check(largest >= 9216, `largest canvas font honoured: ${largest} px (>= 9216)`)
  check((row('5') ?? '').split(';').every((p) => / ok$/.test(p.trim())), 'every canvas sentinel reads back')
  check(/7728x5152 \(39\.8 MP\)/.test(row('2a') ?? ''), 'the synthetic photo decodes at 7728x5152')
  check(/\(a\)[^\n]*PASS/.test(table) && /\(b\)[^\n]*PASS/.test(table) && /\(d\)[^\n]*PASS/.test(table), 'decision hints (a), (b) and (d) pass here')
  check(/\(c\) estimated 40 MP save = 33 s x R: \d+ s/.test(table), 'decision hint (c) is computed')
  console.log(`  (run all: ${(runMs / 1000).toFixed(1)} s)`)

  console.log('Copy results')
  await page.click('#copy')
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  const shown = await page.inputValue('#table')
  check(clip === shown && clip.startsWith('Print Machine device spike'), 'Copy results puts the table on the clipboard')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } })
  })
  await page.click('#copy')
  const sel = await page.evaluate(() => {
    const ta = document.getElementById('table')
    return { focused: document.activeElement === ta, start: ta.selectionStart, end: ta.selectionEnd, length: ta.value.length }
  })
  check(sel.focused && sel.start === 0 && sel.end === sel.length && sel.length > 0, 'with the clipboard refused, the whole table is selected')
  check(/[Ss]elected|Copied/.test(await page.textContent('#copy-note')), 'and the note says what to do')

  const others = requests.filter((r) => r !== url)
  check(others.length === 0, `no request but the page itself${others.length ? `: ${others.join(', ')}` : ''}`)
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  server.close()
}

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : 'all checks passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
process.exit(failures.length ? 1 : 0)
