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
 *     one it picked at the pointer-down, seeded into the gesture there,
 *     before React has re-rendered the selection.)
 *  3. A drag that starts on no plate moves the selected plate, as always.
 *  4. A tap just beside a small caption still picks it (the hit slop), and a
 *     tap inside one plate picks that plate, not a neighbour within the slop.
 *  5. With the Frame tool open, a drag that starts on a plate neither picks
 *     it nor moves it (the gestures are the photo's there).
 *  6. The gesture hint, after the first photo: it says what the sheet's
 *     gestures do in the open tool (the photo with Frame open, the type
 *     otherwise); a tap leaves it, and so does a drag on a photo that cannot
 *     move (at 100% on its own sheet, inside the frame a first photo gets);
 *     the first drag that moves something dismisses it for good.
 *  7. A double tap on Type › Size's track (two touches 100 ms apart, where
 *     each alone would move the thumb) ends at the default, 40%, and one Undo
 *     goes back to where it was; a mouse's double-click the same. Then on a
 *     phone's CPU (throttled 4x), on Size and on Press › Screen size: two
 *     touches stamped 100 ms apart by their own timestamp, the second
 *     handled late (as behind a slow preview render), still reset. On a
 *     setting already at its default a double tap (touch or mouse) leaves
 *     no undo step: it went there and back. And after a typeface change, a
 *     double press whose first press wobbled Size's thumb a step and back
 *     (no step) resets as a step of its own: one Undo keeps the typeface.
 *  8. A double tap on a plate that is not selected only picks it (Border
 *     Studio's tap-to-select; nothing moves, no undo step); a double tap on
 *     the selected plate centres it and zeroes its turn; a mouse's
 *     double-click on a plate that is not selected only picks it too.
 *  9. The photo's keys, with the Frame tool open on its first photo: the
 *     sheet names them (aria-keyshortcuts); + three times zooms to 1.15^3,
 *     Right and Down move the view right and down (the photo's centre left
 *     and up); 0 resets it; one Undo takes back the 0 alone and one more the
 *     whole run (one step). In Fit the keys move nothing and none is named.
 * 10. The Frame tool's states, said: with no photo, Frame › Border keeps
 *     Width and Corners on its strip, unavailable (the track disabled, its
 *     − and + aria-disabled and in the tab order), each described by "No
 *     photo yet", beside Choose photo; Frame › Crop's ratio row is a group
 *     named "Sheet ratio" whose Original chip is aria-disabled, described by
 *     the line that says why, and a tap on it changes nothing. With a photo
 *     the fill row is a group named "Fill" of six chips and Width is
 *     available, described by nothing. On a 4:5 sheet in Fit the gesture
 *     hint names no gesture and says why, a drag on the photo moves nothing
 *     (and leaves the hint), and Place's Zoom says "Fit shows the whole
 *     photo" as its description; back in Crop the hint names the photo's.
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

/** Two fingers, through the browser's touch input: down `from` px apart
 *  across `at`, then in steps apart by `to` px with their centre moved by
 *  `shift`, then up. */
async function pinch(cdp, at, from, to, shift = { x: 0, y: 0 }) {
  const points = (spread, k) => [
    { x: at.x + shift.x * k - spread / 2, y: at.y + shift.y * k, id: 1, radiusX: 4, radiusY: 4, force: 1 },
    { x: at.x + shift.x * k + spread / 2, y: at.y + shift.y * k, id: 2, radiusX: 4, radiusY: 4, force: 1 },
  ]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from, 0) })
  for (let k = 1; k <= 12; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * k) / 12, k / 12) })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** Where a point of the photo is on screen, for a stored placement on a
 *  sheet `box` with a frame `width` of its long side: the photo's centre is
 *  `x`, `y` of the visible rectangle, drawn at `scale` times its cover fit
 *  (media.ts coverRect). `u`, `v` are fractions of the photo. */
function onScreen(box, width, m, u, v) {
  const b = width * Math.max(box.width, box.height)
  const vis = { x: box.x + b, y: box.y + b, w: box.width - 2 * b, h: box.height - 2 * b }
  const cover = Math.max(vis.w / m.width, vis.h / m.height) * m.scale
  const dw = m.width * cover
  const dh = m.height * cover
  return { x: vis.x + m.x * vis.w - dw / 2 + u * dw, y: vis.y + m.y * vis.h - dh / 2 + v * dh }
}
/** The fraction of the photo at a point on screen (onScreen's inverse). */
function ofPhoto(box, width, m, pt) {
  const o = onScreen(box, width, m, 0, 0)
  const one = onScreen(box, width, m, 1, 1)
  return { u: (pt.x - o.x) / (one.x - o.x), v: (pt.y - o.y) / (one.y - o.y) }
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

  console.log('5. With the Frame tool open, a drag on a plate neither picks nor moves it')
  await page.locator('[data-tool="frame"]').click()
  await touch(cdp, at(riso.x, riso.y), [at(riso.x + 0.1, riso.y)])
  await page.locator('[data-tool="type"]').click()
  check((await selected(page)) === 'PRINT', 'the selection stayed on PRINT MACHINE')
  const afterPhoto = await stored(page)
  check(JSON.stringify(afterPhoto.layers[1]) === JSON.stringify(riso), 'RISO did not move')

  console.log('6. The gesture hint teaches what the sheet does, until a drag shows it is learned')
  const HINT = '.app__hint-text'
  await page.locator('[data-tool="frame"]').click()
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
  check(/^Drag to move the photo · pinch to zoom/.test(photoHint), `with Frame open it is about the photo ("${photoHint}")`)
  // The photo is at 100% on its own sheet: a drag on it moves nothing, so it
  // teaches nothing either, and the hint stays.
  const box1 = await settledBox(page)
  const mid = { x: box1.x + box1.width / 2, y: box1.y + box1.height / 2 }
  // The placement only: the photo's palette lands in the stored document on
  // its own time (a loaded machine has it land between the two reads).
  const placed = async () => {
    const m = (await stored(page)).media
    return m ? JSON.stringify({ x: m.x, y: m.y, scale: m.scale }) : 'none'
  }
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.media, KEY, { timeout: 30_000 })
  const still = await placed()
  await touch(cdp, mid, [{ x: mid.x + 40, y: mid.y }])
  await page.waitForTimeout(300)
  const after = await placed()
  check(
    (await page.locator(HINT).count()) === 1 && after === still,
    `a drag on a photo that cannot move writes nothing (not even a float's last bit) and leaves it`,
  )
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

  console.log('7. A double tap on a slider\'s track resets it, as one undo step')
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(APP)
    await page.waitForSelector('.sheet canvas')
    await page.locator('[data-tool="type"]').click()
    await page.locator('[role=tab][data-tab="size"]').click()
    await page.waitForSelector('.controls__panel[data-sub="size"]')
    const cdp = await ctx.newCDPSession(page)
    const readout = () => page.locator('.controls__panel[data-sub="size"] .controls__value').textContent()
    const size0 = (await stored(page)).layers[0].size
    const was = await readout()
    // Two taps 100 ms apart at 80% of the track: each would move the thumb
    // there on its own (the native range's answer to a tap).
    const track = await page.locator('.controls__panel[data-sub="size"] .slider__input').boundingBox()
    const spot = { x: track.x + 12 + 0.8 * (track.width - 24), y: track.y + track.height / 2 }
    for (let i = 0; i < 2; i++) {
      await touch(cdp, spot)
      await page.waitForTimeout(100)
    }
    await page.waitForTimeout(300)
    const tapped = await readout()
    const sizeTapped = (await stored(page)).layers[0].size
    check(tapped === '40%' && sizeTapped === 0.04, `a touch double tap at 80% of the track: ${was} -> ${tapped} (stored ${sizeTapped})`)
    await page.locator('.app__bar button[aria-label="Undo"]').click()
    const back = await readout()
    check(back === was && (await stored(page)).layers[0].size === size0 && !(await undoEnabled(page)), `one Undo: ${back}, and no step left`)
    // A mouse's double-click, the same.
    await page.mouse.dblclick(spot.x, spot.y)
    await page.waitForTimeout(300)
    const clicked = await readout()
    await page.locator('.app__bar button[aria-label="Undo"]').click()
    const back2 = await readout()
    check(clicked === '40%' && back2 === was && !(await undoEnabled(page)), `a double-click: ${was} -> ${clicked}; one Undo: ${back2}`)
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  }

  console.log('7b. The same on a phone\'s CPU: the two taps timed by when they touched, not when they were handled')
  {
    // The README's phone profile: the CPU throttled 4x. The first tap moves
    // the thumb and the preview re-renders on the main thread; a second tap
    // that lands meanwhile is handled after the render. So the two touches
    // are stamped 100 ms apart (the touch event's own timestamp), and the
    // second is sent only once the first tap's move is on screen and more
    // than DOUBLE_TAP_MS have passed: handled late, as behind a phone's
    // render, whatever this machine's speed. The slider must go by the
    // touches' time.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(APP)
    await page.waitForSelector('.sheet canvas')
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const stampedTap = async (pt, t) => {
      const points = [{ x: pt.x, y: pt.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }]
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points, timestamp: t })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t + 0.03 })
    }
    // Two taps at 80% of the track; returns what the readout said between
    // them (the first tap alone moves the thumb there) and after them, each
    // read once it is there (or after 15 s: a throttled CPU on a slow runner
    // takes its time).
    const shows = (sel, is, text) =>
      page
        .waitForFunction(([sel, is, text]) => (document.querySelector(sel)?.textContent === text) === is, [sel, is, text], { timeout: 15_000 })
        .catch(() => undefined)
    const doubleTapLate = async (panel, was, end) => {
      const value = `${panel} .controls__value`
      const track = await page.locator(`${panel} .slider__input`).boundingBox()
      const spot = { x: track.x + 12 + 0.8 * (track.width - 24), y: track.y + track.height / 2 }
      const t0 = Date.now() / 1000
      await stampedTap(spot, t0)
      await shows(value, false, was)
      await page.waitForTimeout(400)
      const between = await page.locator(value).first().textContent()
      await stampedTap(spot, t0 + 0.1)
      await shows(value, true, end)
      await page.waitForTimeout(300)
      return [between, await page.locator(value).first().textContent()]
    }
    // Type › Size from the headline's 90% (its default is 40%); Press ›
    // Screen size from its default, 9.0 px.
    for (const [tool, tab, label, field, want] of [
      ['type', 'size', 'Type › Size', (doc) => doc.layers[0].size, '40%'],
      ['press', 'screen', 'Press › Screen › Screen size', (doc) => doc.press.screenPitch, null],
    ]) {
      await page.locator(`[data-tool="${tool}"]`).click()
      await page.locator(`.controls__section[data-tool="${tool}"] [role=tab][data-tab="${tab}"]`).click()
      const panel = `.controls__panel[data-sub="${tab}"]`
      await page.waitForSelector(panel)
      const readout = () => page.locator(`${panel} .controls__value`).first().textContent()
      const was = await readout()
      const from = field(await stored(page))
      const end = want ?? was
      const [between, now] = await doubleTapLate(panel, was, end)
      check(
        between !== end && now === end,
        `${label}, CPU 4x, two taps stamped 100 ms apart, the second handled late: ${was} -> ${between} -> ${now} (want ${end}; stored ${from} -> ${field(await stored(page))})`,
      )
      if (want) {
        await page.locator('.app__bar button[aria-label="Undo"]').click()
        // The stored document, once the debounced write has landed (slower
        // on a throttled CPU).
        await page
          .waitForFunction(([k, from]) => JSON.parse(localStorage.getItem(k) ?? 'null')?.layers?.[0]?.size === from, [KEY, from], { timeout: 15_000 })
          .catch(() => undefined)
        const back = await readout()
        const kept = field(await stored(page))
        check(back === was && kept === from && !(await undoEnabled(page)), `${label}: one Undo goes back to ${was} (${back}, stored ${kept}), and no step is left`)
      } else {
        // At its default already: the double tap went there and back, which
        // is no change, so it leaves no undo step (an Undo would do nothing).
        check(!(await undoEnabled(page)), `${label}: a double tap on a setting at its default leaves no undo step`)
      }
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    {
      // A mouse's double-click on Screen size at its default: the same, no
      // step. In a fresh context (a fresh document and history; a reload
      // would bring back the document as this page left it), so this says
      // only what the double-click did.
      const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
      const page = await ctx2.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(APP)
      await page.waitForSelector('.sheet canvas')
      await page.locator('[data-tool="press"]').click()
      await page.locator('.controls__section[data-tool="press"] [role=tab][data-tab="screen"]').click()
      const panel = '.controls__panel[data-sub="screen"]'
      await page.waitForSelector(panel)
      const track = await page.locator(`${panel} .slider__input`).boundingBox()
      const was = await page.locator(`${panel} .controls__value`).first().textContent()
      await page.mouse.dblclick(track.x + 12 + 0.8 * (track.width - 24), track.y + track.height / 2)
      await page.waitForTimeout(600)
      const now = await page.locator(`${panel} .controls__value`).first().textContent()
      check(now === was && !(await undoEnabled(page)), `Press › Screen size at its default, a mouse double-click: ${was} -> ${now}, and no undo step`)
      await ctx2.close()
    }
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  }

  console.log('7c. A double tap whose first press wobbled the thumb and came back joins nothing: an earlier step survives')
  {
    // Type › Face › Serif (a step), then a mouse double press on Size's
    // thumb: the first press grabs it, moves it a step and back (a run that
    // ends where it began, so it leaves no step), the second press resets.
    // The reset may join only its own run's step, and there is none: one
    // Undo takes back the reset alone and the typeface stays. Every event is
    // stamped (CDP's own timestamp), so the two presses are 150 ms apart by
    // the events' own time however long this machine takes to send them.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(APP)
    await page.waitForSelector('.sheet canvas')
    const cdp = await ctx.newCDPSession(page)
    await page.locator('[data-tool="type"]').click()
    await page.locator('.controls__section[data-tool="type"] [role=tab][data-tab="face"]').click()
    await page.waitForSelector('.controls__panel[data-sub="face"]')
    const font0 = (await stored(page)).layers[0].fontId
    const font1 = font0 === 'serif' ? 'mono' : 'serif'
    await page.locator(`.controls__panel[data-sub="face"] input[type=radio][value="${font1}"]`).check({ force: true })
    check((await stored(page)).layers[0].fontId === font1, `Type › Face: ${font0} -> ${font1} (a step)`)
    await page.locator('.controls__section[data-tool="type"] [role=tab][data-tab="size"]').click()
    const panel = '.controls__panel[data-sub="size"]'
    await page.waitForSelector(panel)
    const readout = () => page.locator(`${panel} .controls__value`).first().textContent()
    const was = await readout()
    const size0 = (await stored(page)).layers[0].size
    const input = page.locator(`${panel} .slider__input`)
    const track = await input.boundingBox()
    const p = await input.evaluate((el) => (Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min)))
    // The thumb's centre (the style guide's thumb is 24 px wide).
    const x0 = track.x + 12 + p * (track.width - 24)
    const y = track.y + track.height / 2
    const t0 = Date.now() / 1000
    let t = t0
    const mouse = (type, x, buttons, dt) => {
      t += dt
      return cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, timestamp: t })
    }
    await mouse('mousePressed', x0, 1, 0)
    await mouse('mouseMoved', x0 + 5, 1, 0.02)
    const wob = await page
      .waitForFunction(([sel, was]) => document.querySelector(sel)?.textContent !== was, [`${panel} .controls__value`, was], { timeout: 5000 })
      .then(() => readout(), () => readout())
    // Back to exactly where it was (the grab point need not be the thumb's
    // centre, so try the pixels around it).
    let back = null
    for (const dx of [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2, -2.5, -3]) {
      await mouse('mouseMoved', x0 + dx, 1, 0.005)
      await page.waitForTimeout(60)
      back = await readout()
      if (back === was) break
    }
    await mouse('mouseReleased', x0, 0, 0.01)
    await mouse('mousePressed', x0, 1, Math.max(0.01, t0 + 0.15 - t))
    const apart = t - t0
    await mouse('mouseReleased', x0, 0, 0.03)
    await page
      .waitForFunction(([sel]) => document.querySelector(sel)?.textContent === '40%', [`${panel} .controls__value`], { timeout: 5000 })
      .catch(() => undefined)
    const reset = await readout()
    check(
      wob !== was && back === was && reset === '40%' && apart < 0.32,
      `the first press wobbled the thumb ${was} -> ${wob} -> ${back}, the second (${Math.round(apart * 1000)} ms after the first by the events' time) reset it: ${reset}`,
    )
    await page.locator('.app__bar button[aria-label="Undo"]').click()
    await page
      .waitForFunction(([k, from]) => JSON.parse(localStorage.getItem(k) ?? 'null')?.layers?.[0]?.size === from, [KEY, size0], { timeout: 5000 })
      .catch(() => undefined)
    const after = (await stored(page)).layers[0]
    check(
      (await readout()) === was && after.size === size0 && after.fontId === font1 && (await undoEnabled(page)),
      `one Undo takes back the reset alone: Size ${await readout()} (want ${was}), the typeface ${after.fontId} (want ${font1}), Undo still on for it`,
    )
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  }

  console.log('8. A double tap on a plate that is not selected only picks it; on the selected one it centres it')
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(APP)
    await page.waitForSelector('.sheet canvas')
    await page.locator('[data-tool="type"]').click()
    await page.waitForSelector('.controls__layername')
    const cdp = await ctx.newCDPSession(page)
    const box = await settledBox(page)
    const before = await stored(page)
    const [print, riso] = before.layers
    const on = (l) => ({ x: box.x + l.x * box.width, y: box.y + l.y * box.height })
    const doubleTap = async (pt) => {
      for (let i = 0; i < 2; i++) {
        await touch(cdp, pt)
        await page.waitForTimeout(90)
      }
    }
    await doubleTap(on(riso))
    const picked = await selected(page, 'RISO')
    const after = await stored(page)
    check(
      picked === 'RISO' && JSON.stringify(after.layers) === JSON.stringify(before.layers) && !(await undoEnabled(page)),
      `a double tap on RISO (not selected): ${picked} selected; RISO at ${after.layers[1].x}, ${after.layers[1].y}, ${after.layers[1].rotation}° (was ${riso.x}, ${riso.y}, ${riso.rotation}°); no undo step`,
    )
    await doubleTap(on(riso))
    await page.waitForTimeout(300)
    const centred = (await stored(page)).layers[1]
    check(
      centred.x === 0.5 && centred.y === 0.5 && centred.rotation === 0,
      `a double tap on RISO, now selected, centres it: ${centred.x}, ${centred.y}, ${centred.rotation}°`,
    )
    // RISO back where it was (centred, it lies over PRINT MACHINE); PRINT
    // MACHINE picked by a tap; then a mouse's double-click on RISO: picked
    // only, not centred.
    await page.locator('.app__bar button[aria-label="Undo"]').click()
    await touch(cdp, { x: on(print).x - 0.05 * box.width, y: on(print).y - 0.04 * box.height })
    await selected(page, 'PRINT')
    await page.waitForTimeout(600)
    await page.mouse.dblclick(on(riso).x, on(riso).y)
    const clicked = await selected(page, 'RISO')
    const r3 = (await stored(page)).layers[1]
    check(
      clicked === 'RISO' && JSON.stringify(r3) === JSON.stringify(riso),
      `a double-click on RISO (not selected): ${clicked} selected; RISO at ${r3.x}, ${r3.y}, ${r3.rotation}°`,
    )
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  }

  console.log("9. The photo's keys, with Frame open: the arrows move the view, + zooms, 0 resets; a run is one undo step; in Fit nothing moves")
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(APP)
    await page.waitForSelector('.sheet canvas')
    await page.locator('[data-tool="frame"]').click()
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
    await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.media, KEY, { timeout: 30_000 })
    const surface = page.locator('.drag-surface')
    await surface.focus()
    const shortcuts = await surface.getAttribute('aria-keyshortcuts')
    check(shortcuts === 'ArrowUp ArrowDown ArrowLeft ArrowRight + - 0', `the sheet names the photo's keys: "${shortcuts}"`)
    const start = (await stored(page)).media
    // A run: three zooms in and a step right and down, inside one burst.
    for (const key of ['+', '+', '+', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key)
    const run = (await stored(page)).media
    check(
      Math.abs(run.scale - 1.15 ** 3) < 1e-9 && run.x < 0.5 && run.y < 0.5,
      `+ three times zooms to ${run.scale.toFixed(4)} (1.15^3), and Right and Down move the view right and down: the photo's centre at ${run.x.toFixed(4)}, ${run.y.toFixed(4)}`,
    )
    await page.keyboard.press('0')
    const reset = (await stored(page)).media
    check(reset.scale === 1 && reset.x === 0.5 && reset.y === 0.5, `0 resets it: ${reset.scale}, ${reset.x}, ${reset.y}`)
    const undo = page.locator('.app__bar button[aria-label="Undo"]')
    await undo.click()
    const back = (await stored(page)).media
    check(JSON.stringify(back) === JSON.stringify(run), `one Undo takes back the 0 alone (a step of its own): ${back.scale.toFixed(4)}, ${back.x.toFixed(4)}`)
    await undo.click()
    const before = (await stored(page)).media
    check(JSON.stringify(before) === JSON.stringify(start), `and one more takes back the whole run (one step): ${before.scale}, ${before.x}, ${before.y}`)
    // + and − zoom about the middle of the frame: what is there stays there
    // (Border Studio's keys leave the view's centre where it is).
    {
      await surface.focus()
      for (const key of ['+', 'ArrowRight', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key)
      const box9 = await settledBox(page)
      const centre = { x: box9.x + box9.width / 2, y: box9.y + box9.height / 2 }
      const doc9 = await stored(page)
      const off = doc9.media
      const held = ofPhoto(box9, doc9.frame.width, off, centre)
      await page.keyboard.press('+')
      const zoomed = (await stored(page)).media
      const moved = onScreen(box9, doc9.frame.width, zoomed, held.u, held.v)
      const drift = Math.hypot(moved.x - centre.x, moved.y - centre.y)
      await page.keyboard.press('-')
      const back = (await stored(page)).media
      check(
        zoomed.scale > off.scale && off.x !== 0.5 && drift < 1 && Math.abs(back.x - off.x) < 1e-9 && Math.abs(back.y - off.y) < 1e-9,
        `panned off the middle (${off.x.toFixed(4)}, ${off.y.toFixed(4)}), + zooms about the middle of the frame (the point there moves ${drift.toFixed(2)} px) and − takes it back (${back.x.toFixed(4)}, ${back.y.toFixed(4)})`,
      )
      await page.keyboard.press('0')
      await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.media?.scale === 1, KEY, { timeout: 5_000 })
    }

    // A pinch on a detail away from the centre zooms about the fingers: the
    // point of the photo under them stays under them (Border Studio's crop
    // pinch), as it spreads and as the fingers move.
    {
      const cdp = await ctx.newCDPSession(page)
      const box = await settledBox(page)
      const doc = await stored(page)
      const at = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 }
      const shift = { x: 15, y: -10 }
      const was = ofPhoto(box, doc.frame.width, doc.media, at)
      await pinch(cdp, at, 60, 120, shift)
      await page.waitForTimeout(300)
      await surface.focus()
      const now = (await stored(page)).media
      const lands = onScreen(box, doc.frame.width, now, was.u, was.v)
      const off = Math.hypot(lands.x - (at.x + shift.x), lands.y - (at.y + shift.y))
      check(
        now.scale > 1.5 && off < 3,
        `a pinch spreading 60 -> 120 px on a point at 30%, 35% of the sheet zooms to ${now.scale.toFixed(3)} and that point of the photo stays under the fingers (${off.toFixed(1)} px off)`,
      )
      await page.keyboard.press('0')
      await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.media?.scale === 1, KEY, { timeout: 5_000 })
    }

    // Fit: the whole photo shows; the keys move nothing, and none is named.
    await page.locator('.controls__section[data-tool="frame"] [role=tab][data-tab="crop"]').click()
    await page.locator('.chiprow [data-chip="4:5"]').click()
    await page.locator('.controls__section[data-tool="frame"] input[type=radio][value="fit"]').check({ force: true })
    await surface.focus()
    const fitDoc = (await stored(page)).media
    for (const key of ['+', 'ArrowRight', '0']) await page.keyboard.press(key)
    const fitAfter = (await stored(page)).media
    const fitKeys = await surface.getAttribute('aria-keyshortcuts')
    check(
      JSON.stringify(fitAfter) === JSON.stringify(fitDoc) && fitKeys === null,
      `in Fit the keys move nothing (${JSON.stringify(fitAfter) === JSON.stringify(fitDoc) ? 'unchanged' : `moved: ${Object.keys(fitAfter).filter((k) => JSON.stringify(fitAfter[k]) !== JSON.stringify(fitDoc[k])).map((k) => `${k} ${JSON.stringify(fitDoc[k])} -> ${JSON.stringify(fitAfter[k])}`).join(', ')}`}) and none is named (${fitKeys})`,
    )
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  }
  console.log("10. The Frame tool's states, said: reasons described, chips in named groups, the hint in Fit")
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(APP)
    await page.waitForSelector('.sheet canvas')
    const tab = (sub) => page.locator(`.controls__section[data-tool="frame"] [role=tab][data-tab="${sub}"]`).click()
    // What a control is described by, in words (its aria-describedby's
    // elements, read), and whether it is aria-disabled.
    const said = (sel) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
        return {
          off: el.getAttribute('aria-disabled') === 'true' || el.disabled === true,
          focusable: el.tabIndex >= 0 && !el.disabled,
          why: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? `(no #${id})`).join(' '),
        }
      }, sel)
    await page.locator('[data-tool="frame"]').click()
    // No photo: the sheet is not the photo's. It says there is none, names
    // the plate's keys, and an arrow moves the selected plate (PRINT MACHINE,
    // at 0.5 across until something moves it).
    {
      const surface = page.locator('.drag-surface')
      const keys = await surface.getAttribute('aria-keyshortcuts')
      const name = (await surface.getAttribute('aria-label')) ?? ''
      const x = async () => (await stored(page))?.layers?.[0]?.x ?? 0.5
      const before = await x()
      await surface.focus()
      await page.keyboard.press('ArrowRight')
      const after = await x()
      check(
        keys === 'ArrowUp ArrowDown ArrowLeft ArrowRight + - [ ]' && /^Print preview\. No photo yet/.test(name) && !/move the photo|zoom/.test(name) && after > before,
        `no photo, Frame open: the sheet says "${name}", names the plate's keys ("${keys}"), and ArrowRight moves the plate (${before} -> ${after})`,
      )
    }
    await tab('border')
    const border = '.controls__panel[data-sub="border"]'
    const dec = await said(`${border} [aria-label="Decrease Width"]`)
    const track = await said(`${border} input[type=range]`)
    const choose = await page.locator(`${border} button`, { hasText: 'Choose photo' }).count()
    check(
      dec?.off && dec.focusable && dec.why === 'No photo yet' && track?.off && track.why === 'No photo yet' && choose === 1,
      `no photo, Frame › Border: Width is there, unavailable (− ${JSON.stringify(dec)}, track ${JSON.stringify(track)}), beside Choose photo (${choose})`,
    )
    await page.locator(`${border} .paramstrip__pick`).click()
    await page.locator('dialog[open] [data-key="corners"]').click()
    await page.waitForSelector('dialog[open]', { state: 'detached' })
    const corners = await said(`${border} [aria-label="Increase Corners"]`)
    check(corners?.off && corners.why === 'No photo yet', `and so is Corners (+ ${JSON.stringify(corners)})`)

    await tab('crop')
    const ratio = await page.evaluate(() => {
      const row = document.querySelector('.controls__panel[data-sub="crop"] .chiprow')
      return { role: row?.getAttribute('role'), name: row?.getAttribute('aria-label') }
    })
    const original = await said('.controls__panel[data-sub="crop"] [data-chip="original"]')
    const before = (await stored(page)).aspect
    // Tapped as a finger would: Playwright will not click an aria-disabled
    // control unless forced; the app must ignore the tap itself.
    await page.locator('.controls__panel[data-sub="crop"] [data-chip="original"]').click({ force: true })
    const after = (await stored(page)).aspect
    check(
      ratio.role === 'group' && ratio.name === 'Sheet ratio' && original?.off && original.why === 'No photo yet' && after === before,
      `Frame › Crop: the ratio row is a ${ratio.role} named "${ratio.name}"; Original is unavailable and says why ("${original?.why}"), and a tap on it changes nothing (${before} -> ${after})`,
    )

    // A photo: the fill row, and Width available.
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
    await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.media, KEY, { timeout: 30_000 })
    await tab('border')
    const fills = await page.evaluate(() => {
      const row = document.querySelector('.controls__panel[data-sub="border"] .chiprow')
      return { role: row?.getAttribute('role'), name: row?.getAttribute('aria-label'), chips: row?.querySelectorAll('.chip').length ?? 0 }
    })
    const width = await said(`${border} [aria-label="Decrease Width"]`)
    check(
      fills.role === 'group' && fills.name === 'Fill' && fills.chips === 6 && width && !width.off && width.why === '',
      `with a photo, Frame › Border: the fill row is a ${fills.role} named "${fills.name}" of ${fills.chips} chips; Width available, described by nothing (${JSON.stringify(width)})`,
    )
    // Choosing Frosted shows its one setting, Blur, on the strip (Border
    // Studio's Fill › Frosted leads with it); leaving Frosted, Width again.
    {
      const strip = page.locator(`${border} .paramstrip__pick`)
      await page.locator(`${border} [data-chip="frosted"]`).click()
      await page.waitForFunction((b) => document.querySelector(`${b} [data-chip="frosted"]`)?.getAttribute('aria-pressed') === 'true', border)
      const onFrosted = (await strip.textContent())?.trim()
      await page.locator(`${border} [data-chip="photo"]`).click()
      await page.waitForFunction((b) => document.querySelector(`${b} [data-chip="photo"]`)?.getAttribute('aria-pressed') === 'true', border)
      const onPhoto = (await strip.textContent())?.trim()
      check(onFrosted === 'Blur' && onPhoto === 'Width', `a tap on Frosted puts Blur on the strip ("${onFrosted}"), a tap on Photo puts Width back ("${onPhoto}")`)
    }

    // Fit, on a 4:5 sheet: no gesture to teach, nothing moves.
    await tab('crop')
    await page.locator('.controls__panel[data-sub="crop"] [data-chip="4:5"]').click()
    await page.locator('.controls__section[data-tool="frame"] input[type=radio][value="fit"]').check({ force: true })
    const HINT_SAID = '.app__float > p.sr-only[role=status]'
    await page.waitForFunction((H) => /^Fit shows/.test(document.querySelector(H)?.textContent ?? ''), HINT_SAID, { timeout: 5_000 }).catch(() => {})
    const fitHint = await page.locator(HINT_SAID).textContent()
    const box = await settledBox(page)
    const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const still = JSON.stringify((await stored(page)).media)
    await touch(cdp, mid, [{ x: mid.x + 40, y: mid.y + 30 }])
    const moved = JSON.stringify((await stored(page)).media) !== still
    check(
      fitHint === 'Fit shows the whole photo · choose Crop to move or zoom it' && !moved && (await page.locator('.app__hint').count()) === 1,
      `in Fit the hint names no gesture ("${fitHint}"), a drag moves nothing (${moved ? 'moved' : 'unchanged'}) and leaves it`,
    )
    await tab('place')
    const zoom = await said('.controls__panel[data-sub="place"] [aria-label="Decrease Zoom"]')
    check(zoom?.off && zoom.why === 'Fit shows the whole photo', `Frame › Place in Fit: Zoom unavailable, described by "${zoom?.why}"`)
    await tab('crop')
    await page.locator('.controls__section[data-tool="frame"] input[type=radio][value="crop"]').check({ force: true })
    await page.waitForFunction((H) => /^Drag/.test(document.querySelector(H)?.textContent ?? ''), HINT_SAID, { timeout: 5_000 }).catch(() => {})
    const cropHint = await page.locator(HINT_SAID).textContent()
    check(/^Drag to move the photo · pinch to zoom/.test(cropHint), `back in Crop it names the photo's gestures ("${cropHint}")`)

    // Keys only: Replace, Remove and Choose photo keep focus where the person
    // is (never the page's body): on the button while the file is read and
    // after, on Choose photo once Remove has gone, and on the fill row when
    // a photo chosen from Frame › Border takes Choose photo's place.
    {
      const focusIs = () =>
        page.evaluate(() => {
          const a = document.activeElement
          return a === document.body || !a ? 'body' : `${a.tagName.toLowerCase()} "${a.textContent?.trim() ?? ''}"${a.dataset?.chip ? ` [${a.dataset.chip}]` : ''}`
        })
      // The app's file input answers its click with a file at once, as a
      // chooser would (a native chooser opened from a key press is not
      // dependably reported to the driver): the keys' path is the app's own,
      // Enter on the button, its click, the input's click, the file read.
      await page.evaluate((b64) => {
        const input = document.querySelector('input[type=file]')
        input.click = () => {
          const dt = new DataTransfer()
          dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'again.jpg', { type: 'image/jpeg' }))
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, Buffer.from(bytes).toString('base64'))
      const pickWith = async (button) => {
        await button.focus()
        await page.keyboard.press('Enter')
        await page.waitForTimeout(1500)
      }
      const photoTab = '.controls__panel[data-sub="photo"]'
      await tab('photo')
      await pickWith(page.locator(`${photoTab} button`, { hasText: 'Replace' }))
      const afterReplace = await focusIs()
      await page.locator(`${photoTab} button`, { hasText: 'Remove' }).focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      const afterRemove = await focusIs()
      await tab('border')
      await pickWith(page.locator(`${border} button`, { hasText: 'Choose photo' }))
      const afterChoose = await focusIs()
      check(
        afterReplace === 'button "Replace"' && afterRemove === 'button "Choose photo"' && /^button "Photo" \[photo\]$/.test(afterChoose),
        `keys only: Replace and a file leaves focus on ${afterReplace}; Remove, on ${afterRemove}; Choose photo in Frame › Border and a file, on ${afterChoose}`,
      )
    }
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
    await ctx.close()
  }

} finally {
  await browser.close()
  await new Promise((r) => server.httpServer.close(r))
}

if (failures.length) {
  console.error(`\n${failures.length} touch check(s) failed.`)
  process.exit(1)
}
console.log("\nTouch: a tap picks the plate under it, the drag it starts moves that plate, the photo's keys move the photo, and the Frame tool says why what is off is off.")
