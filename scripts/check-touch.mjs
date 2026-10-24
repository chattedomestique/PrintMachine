/**
 * Tap-to-select on the sheet, in the BUILT app, touched like a person would.
 * Exits 1 if any check fails.
 *
 *   npm run build && node scripts/check-touch.mjs
 *
 * Serves dist/ (vite preview) and, in Chromium at 390x844 with a touch screen,
 * on the default print (PRINT MACHINE, selected, and RISO under it at -4°):
 *
 *  1. A tap on RISO selects it (the plate button says so) and changes nothing
 *     in the document: no undo step, no pixel moved.
 *  2. A finger that goes down on PRINT MACHINE and drags moves PRINT MACHINE
 *     by the drag from its own place, in one touch, and RISO stays put; one
 *     Undo takes back exactly that drag. (The plate the gesture moves is the
 *     one it picked at the pointer-down, before React has re-rendered the
 *     selection: plan FR-10.)
 *  3. A drag that starts on no plate moves the selected plate, as always.
 *  4. A tap just beside a small caption still picks it (the hit slop), and a
 *     tap inside one plate picks that plate, not a neighbour within the slop.
 *  5. With the Photo tool open, a touch on a plate moves nothing but the
 *     photo: the selection stays.
 *  6. The gesture hint, after the first photo: it says what the sheet's
 *     gestures do in the open tool (the photo with Photo open, the type
 *     otherwise); a tap leaves it, and the first drag dismisses it for good.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))
if (!existsSync(resolve(root, 'dist/index.html'))) {
  console.error('No dist/: run npm run build first.')
  process.exit(1)
}

const KEY = 'printmachine:settings:v1'
const failures = []
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' })
const APP = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath })

/** The stored document, once the debounced write has landed. */
const stored = async (page) => {
  await page.waitForTimeout(600)
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY)
}
/** The plate the plate button names. With `want`, given up to 2 s to become
 *  it: a touch reaches the page asynchronously, after the call that sends it
 *  returns. Without, read after 400 ms, so a change that should NOT happen
 *  has had the time to. */
const selected = async (page, want) => {
  const name = () => page.locator('.controls__layername').first().textContent()
  if (want === undefined) {
    await page.waitForTimeout(400)
    return name()
  }
  await page
    .waitForFunction((w) => document.querySelector('.controls__layername')?.textContent === w, want, { timeout: 2000 })
    .catch(() => undefined)
  return name()
}
const undoEnabled = (page) => page.locator('.app__bar button[aria-label="Undo"]').isEnabled()

/** The sheet's surface once it has stopped moving: opening a tool slides the
 *  dock up, and the sheet makes room as it goes. */
async function settledBox(page) {
  let last = null
  for (let i = 0; i < 50; i++) {
    const b = await page.locator('.drag-surface').boundingBox()
    if (last && ['x', 'y', 'width', 'height'].every((k) => b[k] === last[k])) return b
    last = b
    await page.waitForTimeout(100)
  }
  return last
}

/** One finger, through the browser's touch input: down at `from`, then moved
 *  in steps to each point of `path`, then up. */
async function touch(cdp, from, path = []) {
  const point = ({ x, y }) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) })
  let at = from
  for (const to of path) {
    for (let k = 1; k <= 8; k++) {
      const p = { x: at.x + ((to.x - at.x) * k) / 8, y: at.y + ((to.y - at.y) * k) / 8 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(p) })
    }
    at = to
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(APP)
  await page.waitForSelector('.sheet canvas')
  await page.locator('[data-tool="type"]').click()
  await page.waitForSelector('.controls__layername')
  const cdp = await ctx.newCDPSession(page)

  const box = await settledBox(page)
  const at = (x, y) => ({ x: box.x + x * box.width, y: box.y + y * box.height })
  const before = await stored(page)
  const [print, riso] = before.layers

  console.log('1. A tap on a plate picks it, and writes nothing')
  const atLaunch = await selected(page)
  check(atLaunch === 'PRINT', `PRINT MACHINE is selected at launch (${atLaunch})`)
  await touch(cdp, at(riso.x, riso.y), [{ ...at(riso.x, riso.y), x: at(riso.x, riso.y).x + 1 }])
  const tapped = await selected(page, 'RISO')
  check(tapped === 'RISO', `a tap on RISO selects it (the plate button reads ${tapped})`)
  const afterTap = await stored(page)
  check(JSON.stringify(afterTap.layers) === JSON.stringify(before.layers), 'the tap (with a pixel of wobble) moved nothing')
  check(!(await undoEnabled(page)), 'the tap pushed no undo step')

  console.log('2. A drag that starts on another plate moves THAT plate, from its own place')
  const dx = 40
  const dy = -30
  // PRINT MACHINE's first line, a little left of its centre: on PRINT, not
  // on the crosshair of RISO.
  const start = at(print.x - 0.05, print.y - 0.04)
  await touch(cdp, start, [{ x: start.x + dx, y: start.y + dy }])
  const dragged = await selected(page, 'PRINT')
  check(dragged === 'PRINT', `the drag selected PRINT MACHINE (${dragged})`)
  const afterDrag = await stored(page)
  const [p2, r2] = afterDrag.layers
  const wantX = print.x + dx / box.width
  const wantY = print.y + dy / box.height
  check(
    Math.abs(p2.x - wantX) < 0.002 && Math.abs(p2.y - wantY) < 0.002,
    `PRINT MACHINE moved by the drag: ${p2.x.toFixed(4)}, ${p2.y.toFixed(4)} (want ${wantX.toFixed(4)}, ${wantY.toFixed(4)})`,
  )
  check(JSON.stringify(r2) === JSON.stringify(riso), 'RISO, selected when the finger went down, did not move')
  await page.locator('.app__bar button[aria-label="Undo"]').click()
  const undone = await stored(page)
  check(JSON.stringify(undone.layers) === JSON.stringify(before.layers), 'one Undo takes back exactly that drag')
  check(!(await undoEnabled(page)), 'and that was the only undo step')

  console.log('3. A drag that starts on no plate moves the selected one')
  const corner = at(0.08, 0.08)
  await touch(cdp, corner, [{ x: corner.x + 20, y: corner.y + 20 }])
  const afterCorner = await stored(page)
  check((await selected(page)) === 'PRINT', 'the selection stayed on PRINT MACHINE')
  check(
    Math.abs(afterCorner.layers[0].x - (print.x + 20 / box.width)) < 0.002,
    `PRINT MACHINE moved with it (${afterCorner.layers[0].x.toFixed(4)})`,
  )
  check(JSON.stringify(afterCorner.layers[1]) === JSON.stringify(riso), 'RISO did not')

  console.log('4. The hit slop: beside a caption picks it, inside a plate picks that plate')
  // RISO is 6% of the sheet tall; its box ends about 0.32 em + the backing's
  // pad below its baseline. 8 px under that is beside it.
  const em = riso.size * box.height
  const below = at(riso.x, riso.y)
  below.y += em * (0.32 + 0.12) + 8
  await touch(cdp, below)
  const beside = await selected(page, 'RISO')
  check(beside === 'RISO', `a tap 8 px under RISO picks it (${beside})`)
  await touch(cdp, at(print.x + 20 / box.width, print.y - 0.04))
  check((await selected(page, 'PRINT')) === 'PRINT', 'a tap on PRINT MACHINE picks PRINT MACHINE')

  console.log('5. With the Photo tool open, the sheet moves the photo, not the plates')
  await page.locator('[data-tool="photo"]').click()
  await touch(cdp, at(riso.x, riso.y), [at(riso.x + 0.1, riso.y)])
  await page.locator('[data-tool="type"]').click()
  check((await selected(page)) === 'PRINT', 'the selection stayed on PRINT MACHINE')
  const afterPhoto = await stored(page)
  check(JSON.stringify(afterPhoto.layers[1]) === JSON.stringify(riso), 'RISO did not move')

  console.log('6. The gesture hint teaches what the sheet does, until a drag shows it is learned')
  const HINT = '.app__hint-text'
  await page.locator('[data-tool="photo"]').click()
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 1500
    const g = c.getContext('2d')
    g.fillStyle = '#5a7fa8'
    g.fillRect(0, 0, 1200, 1500)
    const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))
    return [...new Uint8Array(await b.arrayBuffer())]
  })
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await page.waitForSelector(HINT, { timeout: 30_000 })
  const photoHint = await page.locator(HINT).textContent()
  check(/zoom the photo/.test(photoHint), `with Photo open it is about the photo ("${photoHint}")`)
  await page.locator('[data-tool="type"]').click()
  const typeHint = await page.locator(HINT).textContent()
  check(/Tap type to pick it/.test(typeHint), `with Type open it is about the type ("${typeHint}")`)
  const box2 = await settledBox(page)
  const at2 = (x, y) => ({ x: box2.x + x * box2.width, y: box2.y + y * box2.height })
  await touch(cdp, at2(0.5, 0.3))
  check((await page.locator(HINT).count()) === 1, 'a tap leaves it')
  const from = at2(0.5, 0.3)
  await touch(cdp, from, [{ x: from.x + 30, y: from.y }])
  check((await page.locator(HINT).count()) === 0, 'the first drag dismisses it')
  await page.reload()
  await page.waitForSelector('.sheet canvas')
  await page.waitForTimeout(800)
  check((await page.locator(HINT).count()) === 0, 'for good: it is not back after a reload')

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
  await ctx.close()
} finally {
  await browser.close()
  await new Promise((r) => server.httpServer.close(r))
}

if (failures.length) {
  console.error(`\n${failures.length} touch check(s) failed.`)
  process.exit(1)
}
console.log('\nTouch: a tap picks the plate under it, and the drag it starts moves that plate.')
