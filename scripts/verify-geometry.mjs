/**
 * The dock's geometry and the style guide's measurable rules, in the built
 * app. Exits 1 if any check fails.
 *
 *   npm run build && node scripts/verify-geometry.mjs [--width 320] [--shots <dir>]
 *
 * Border Studio's README claims "the regression suite checks the photo's
 * rectangle across every tool and tab", and no such file exists in it. This
 * is that file. In Chromium, at 320x640, 375x812, 393x852 and 430x932, with a
 * photo chosen through the real file input (a 4:3, a 3:2 and a 1:3 photo, each
 * on its own Original sheet, the shape a first photo opens on), it opens every
 * tool and every sub-tab, and every state of Ink > Over photo (Off, Second
 * ink, Keep this ink, Backing), and checks:
 *
 *  - the sheet: its rectangle is the same, to a pixel, in every one of those
 *    states at one viewport. The photo never changes size or place between
 *    tools and tabs (Border Studio fcd91ff: one dock geometry);
 *  - the panel never overflows at 100% text: the dock's scroller
 *    (.app__panel-inner) is not taller inside than out, and the page does not
 *    scroll sideways;
 *  - tap targets, as the hit area each control still OWNS: for every visible,
 *    enabled button, input, select, tab and menu row in the app bar, the dock
 *    and the cards over the stage (or, with a dialog open, in the dialog),
 *    how far from its centre a tap still lands on it, each way, by
 *    elementFromPoint. That counts its box, its ::after hit area (the style
 *    guide draws small circles at 36px with a 44px ::after), and loses
 *    whatever a neighbour covers, so it must be 44px across both ways. This is
 *    the style guide's own probe (its tests/a11y.mjs) measured as a run rather
 *    than at two points, so a hit area that grows one way only (the strip's
 *    name line, dock.css) is measured as it is. It is also how "8px between
 *    targets" is checked: that gap is what lets two 36px circles each own a
 *    44px target, and a neighbour closer than that takes part of it. A
 *    control scrolled partly out of its scroller (a tab in a row wider than
 *    the dock) is reached by scrolling and is skipped while it is; a disabled
 *    one is not a target;
 *  - the Size slider's travel on the real track: pixels per 1% step, and what
 *    one pixel of drag changes at the smallest size (how touchy the slider
 *    is, measured where a thumb meets it: at least 1.5 px a step);
 *
 * then, with the 4:3 photo, the value modal, the parameter sheet, the plate
 * sheet, the Ink dialog and More: the same target check, and no sideways
 * scroll. Then all of it again at 200% text (font-size: 200% on <html>):
 * every state and dialog, no text cut off by a clipping box (the style
 * guide's probeClipped: text inside a scroller is reachable, not cut), no
 * sideways scroll, targets as above. The dock may scroll at 200%; the sheet
 * may shrink. Last, the app bar at every width from 320 to 430 px in 5 px
 * steps, at 100% and 200% text: SG.fit's layout (full, then compact, then
 * tight) never gets richer as the bar gets narrower, tight only when the
 * title needs its second line, the bar's actions stay one row, Save's word
 * (when shown) is one line, and nothing in the bar reaches past it. Then the
 * save states on a small phone (320x640 and 375x667) at 200% text, where the
 * cards over the stage are taller than the room they have (checkSaveStates):
 * Cancel, Share, the card's × and Choose again each answer a tap, and the
 * cards stay between the bar and the dock.
 *
 * Every state is measured at rest: once its transitions and animations have
 * run out and its scrollers have stopped (settle), never on a fixed delay, so
 * a slower machine measures the same thing. A target covered at its centre is
 * reported with what covers it, the scroll state of the scrollers around it,
 * its dialog's box and transform, and anything still moving.
 *
 * The DOM contract it reads (src/features/shell/AppShell.tsx and the panels):
 * tool buttons `[data-tool]` with `aria-pressed`, the open panel
 * `.controls__section[data-tool]` with its `[role=tab][data-tab]`, the content
 * area `.controls__panel[data-sub]`, the scroller `.app__panel-inner`, the
 * sheet `.sheet`, the bar `.app__bar` with `data-fit`.
 *
 * --shots <dir> also writes the review set: at 320 and 390 px, light and
 * dark, the dock closed, every sub-tab and Over photo state, the five dialogs
 * and sheets, and the save states (pressing with Cancel, waiting for the
 * photo, ready to Share, the photo that could not be loaded, the smaller-copy
 * question, the save that did not finish); at 390 px with 200% text, every
 * state and dialog; at 390 px in the style guide's wire palette, light and
 * dark, the dock closed and each tool (the guide's squint test); and the save
 * states at 200% text as they are checked.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const SHOTS = arg('--shots')
const ONLY_WIDTH = arg('--width') ? Number(arg('--width')) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const VIEWPORTS = [
  [320, 640],
  [375, 812],
  [393, 852],
  [430, 932],
].filter(([w]) => ONLY_WIDTH === null || w === ONLY_WIDTH)

/** Photos chosen through the file input: a camera's 4:3, a 3:2 and a 1:3. */
const PHOTOS = [
  [4032, 3024],
  [3000, 2000],
  [1000, 3000],
]

/** The widths of the review screenshots. */
const SHOT_WIDTHS = [
  [320, 640],
  [390, 844],
]

/** The small phones the save states are checked on at 200% text. */
const SAVE_VIEWPORTS = [
  [320, 640],
  [375, 667],
].filter(([w]) => ONLY_WIDTH === null || w === ONLY_WIDTH)

const failures = []
const check = (ok, what) => {
  if (!ok) {
    console.log(`  FAIL ${what}`)
    failures.push(what)
  }
  return ok
}

const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' })
const APP = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath })

/**
 * Wait for the page to be at rest, then measure: no transition or animation
 * still running (a sheet still rising, the dock's panel still opening, a tab's
 * panel still sliding in), no scroller still moving, and then two painted
 * frames, so the overlay height is published and SG.fit has written its
 * layouts. Only motion with an end is waited for: the busy Save's spinner
 * turns for as long as the save runs.
 *
 * It used to be two frames and 60 ms, whatever was moving. The parameter sheet
 * rises for 320 ms, so the probe met it in flight, at whichever frame the
 * machine's speed made it land on. Held at each frame of that rise, the probe
 * fails at one, the fourth (66.7 ms in), with exactly the four failures CI
 * reported: at 200% text that frame puts Position Y's centre within half a
 * pixel of the screen's bottom edge, where elementFromPoint (it rounds to
 * whole pixels) finds nothing, and the probe called it covered. A target at
 * rest is what a person taps, so that is what is measured. If the page is
 * still moving after 5 s, that is a failure of its own, named.
 */
async function settle(page, where = 'the page') {
  const moving = await page.evaluate(atRest)
  check(moving === null, `${where}: still moving after 5 s (${moving}), measured anyway`)
}

/** The measurements of one state. */
const measure = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('.sheet')?.getBoundingClientRect()
    const inner = document.querySelector('.app__panel-inner')
    return {
      sheet: r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10) : null,
      overflow: inner ? inner.scrollHeight - inner.clientHeight : 0,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    }
  })

/* ── Page-side probes (run through page.evaluate, so self-contained) ── */

/** Resolves null once the page is at rest (see settle), or, after 5 s, with
 *  what is still moving. */
async function atRest() {
  const tag = (e) =>
    e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '?'
  const running = () =>
    document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
  const scrolled = () => {
    let s = ''
    const all = document.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) if (all[i].scrollTop || all[i].scrollLeft) s += `${i}:${all[i].scrollLeft},${all[i].scrollTop};`
    return s
  }
  const deadline = performance.now() + 5000
  const late = () => new Promise((r) => setTimeout(r, Math.max(0, deadline - performance.now())))
  for (;;) {
    const now = running()
    if (now.length && performance.now() < deadline) {
      await Promise.race([Promise.all(now.map((a) => a.finished.catch(() => undefined))), late()])
      continue
    }
    const before = scrolled()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))
    const still = running()
    if (!still.length && scrolled() === before) return null
    if (performance.now() >= deadline)
      return still.length
        ? still.map((a) => `${a.transitionProperty ?? a.animationName ?? 'an animation'} on ${tag(a.effect?.target)}${a.effect?.pseudoElement ?? ''}`).join(', ')
        : 'a scroller'
  }
}

/**
 * Every visible, enabled target in scope, and the hit area it owns through
 * its centre, horizontally and vertically. Scope: the open dialog, or the app
 * bar, the dock and the cards over the stage.
 */
function probeTargets() {
  const dialogs = [...document.querySelectorAll('dialog[open]')]
  const scopes = dialogs.length ? [dialogs[dialogs.length - 1]] : [...document.querySelectorAll('.app__bar, .app__overlay, .app__float')]
  const SEL =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=radio], [role=checkbox], [role=slider], [role=menuitem], [role=menuitemradio], [role=option]'
  const name = (e) =>
    e.tagName.toLowerCase() +
    (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') +
    (e.getAttribute('aria-label') ? ` [${e.getAttribute('aria-label').slice(0, 32)}]` : ` "${(e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)}"`)
  // Where a covered target is, so a failure explains itself: each scroller it
  // is in (how far scrolled, of how far it can go), its scope's box and
  // transform (a dialog still rising is not at rest), and anything moving.
  const box = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : '')
  const scrollOf = (n) =>
    `scrolled ${Math.round(n.scrollTop)} of ${n.scrollHeight - n.clientHeight} px down, ${Math.round(n.scrollLeft)} of ${n.scrollWidth - n.clientWidth} across`
  const context = (el, scope) => {
    const parts = []
    for (let n = el.parentElement; n && n !== scope; n = n.parentElement) {
      const ns = getComputedStyle(n)
      if (/^(auto|scroll)$/.test(ns.overflowY) || /^(auto|scroll)$/.test(ns.overflowX)) parts.push(`in ${box(n)} ${scrollOf(n)}`)
    }
    const b = scope.getBoundingClientRect()
    parts.push(
      `${box(scope)} at y ${Math.round(b.top)}..${Math.round(b.bottom)} of ${innerHeight}, transform ${getComputedStyle(scope).transform}, ${scrollOf(scope)}`,
    )
    const moving = document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => `${a.transitionProperty ?? a.animationName ?? 'an animation'} on ${a.effect?.target ? box(a.effect.target) : '?'}${a.effect?.pseudoElement ?? ''}`)
    parts.push(moving.length ? `still moving: ${moving.join(', ')}` : 'nothing moving')
    return parts.join('; ')
  }
  const out = { measured: 0, scrolled: 0, disabled: 0, small: [] }
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || el.closest('.sr-only, [hidden], [inert]')) continue
      // A native radio drawn by its label is 1px; the style guide's own probe
      // skips it the same way (the segmented and swatch radios cover their
      // labels and are measured).
      if (el.matches('input[type=radio], input[type=checkbox]') && r.width < 4) continue
      if (el.matches(':disabled, [aria-disabled="true"]')) {
        out.disabled++
        continue
      }
      let clipped = false
      for (let n = el.parentElement; n && n !== scope.parentElement; n = n.parentElement) {
        const ns = getComputedStyle(n)
        if (ns.overflowX === 'visible' && ns.overflowY === 'visible') continue
        const b = n.getBoundingClientRect()
        if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) clipped = true
      }
      if (clipped) {
        out.scrolled++
        continue
      }
      out.measured++
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hits = (x, y) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true
        const t = document.elementFromPoint(x, y)
        return !!t && (t === el || el.contains(t))
      }
      const run = (dx, dy) => {
        let k = 0
        while (k < 40 && hits(cx + dx * (k + 1), cy + dy * (k + 1))) k++
        return k
      }
      if (!hits(cx, cy)) {
        const t = document.elementFromPoint(cx, cy)
        const by = t
          ? name(t)
          : `nothing: elementFromPoint finds no element there (it rounds to whole pixels; the screen is ${innerWidth}x${innerHeight})`
        out.small.push(`${name(el)}: covered at its centre (${cx.toFixed(1)}, ${cy.toFixed(1)}) by ${by}; ${context(el, scope)}`)
        continue
      }
      const w = Math.max(r.width >= 44 ? r.width : 0, run(-1, 0) + run(1, 0) + 1)
      const h = Math.max(r.height >= 44 ? r.height : 0, run(0, -1) + run(0, 1) + 1)
      if (w < 43.5 || h < 43.5) out.small.push(`${name(el)}: owns ${Math.round(w)}x${Math.round(h)} (drawn ${Math.round(r.width)}x${Math.round(r.height)})`)
    }
  }
  return out
}

/** Text that a clipping box (overflow hidden or clip) cuts off: the style
 *  guide's probeClipped, which scrollWidth checks and axe do not see. Text in
 *  a scroller is reachable, ellipsis is deliberate, a 1px visually hidden
 *  box (Save's word when it is an icon) is not shown at all. */
function probeClipped() {
  const out = []
  const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
  for (const box of document.querySelectorAll('*')) {
    const cs = getComputedStyle(box)
    if (!/^(clip|hidden)$/.test(cs.overflowX) && !/^(clip|hidden)$/.test(cs.overflowY)) continue
    if (box.closest('.sr-only, [hidden]')) continue
    const b = box.getBoundingClientRect()
    if (b.width <= 1 || b.height <= 1) continue
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let t; (t = walker.nextNode()); ) {
      if (!t.nodeValue.trim()) continue
      const host = t.parentElement
      const hs = getComputedStyle(host)
      if (hs.visibility === 'hidden' || hs.display === 'none' || host.closest('.sr-only, [aria-hidden="true"]') || hs.textOverflow === 'ellipsis') continue
      let hidden = false
      let scrollsX = false
      let scrollsY = false
      for (let n = host; n && n !== box; n = n.parentElement) {
        const nb = n.getBoundingClientRect()
        if (nb.width <= 1 && nb.height <= 1) hidden = true
        const ns = getComputedStyle(n)
        if (/^(auto|scroll)$/.test(ns.overflowX)) scrollsX = true
        if (/^(auto|scroll)$/.test(ns.overflowY)) scrollsY = true
      }
      if (hidden) continue
      const range = document.createRange()
      range.selectNodeContents(t)
      for (const q of range.getClientRects()) {
        if (!q.width) continue
        const cutX = !scrollsX && /^(clip|hidden)$/.test(cs.overflowX) && (q.right > b.right + 1 || q.left < b.left - 1)
        const cutY = !scrollsY && /^(clip|hidden)$/.test(cs.overflowY) && (q.bottom > b.bottom + 1 || q.top < b.top - 1)
        if (cutX || cutY) {
          out.push(`"${t.nodeValue.trim().slice(0, 28)}" cut off by ${name(box)}`)
          break
        }
      }
    }
  }
  return [...new Set(out)]
}

/** The app bar: its SG.fit layout, and whether it holds as one row. */
function probeBar() {
  const bar = document.querySelector('.app__bar')
  const b = bar.getBoundingClientRect()
  const actions = [...bar.querySelectorAll('.appbar__end > *')].map((e) => e.getBoundingClientRect())
  const centres = new Set(actions.map((q) => Math.round(q.top + q.height / 2)))
  const word = bar.querySelector('.app__save-word')
  const wb = word?.getBoundingClientRect()
  const range = document.createRange()
  if (word) range.selectNodeContents(word)
  const wordLines = word && wb.width > 1 ? new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size : 0
  const outside = [...bar.querySelectorAll('.appbar__title, .appbar__end > *')].filter((e) => {
    const q = e.getBoundingClientRect()
    return q.left < b.left - 0.5 || q.right > b.right + 0.5 || q.top < b.top - 0.5 || q.bottom > b.bottom + 0.5
  })
  const title = bar.querySelector('.appbar__title')
  const tr = document.createRange()
  tr.selectNodeContents(title)
  const titleLines = new Set([...tr.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size
  return { fit: bar.dataset.fit ?? null, rows: centres.size, wordLines, titleLines, outside: outside.length }
}

/* ── Driving the app ── */

/** A w x h JPEG made in the page and chosen through the real file input. */
async function choosePhoto(page, w, h) {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#2a5d9f')
      grad.addColorStop(1, '#f2b880')
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
      const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))
      c.width = 0
      return [...new Uint8Array(await b.arrayBuffer())]
    },
    [w, h],
  )
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await page.waitForFunction(
    ([w, h]) => {
      const m = JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.media
      return m && m.width === w && m.height === h
    },
    [w, h],
    { timeout: 30_000 },
  )
  // The preview's copy has landed when Save stops waiting for it.
  await page.waitForFunction(() => !document.querySelector('.app__save[aria-disabled="true"]'), null, { timeout: 30_000 })
}

/** Open a tool (a no-op when it is open). */
async function openTool(page, tool) {
  const btn = page.locator(`[data-tool="${tool}"][aria-pressed]`)
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click()
  await page.waitForSelector(`.controls__section[data-tool="${tool}"]`)
}

async function openTab(page, tool, tab) {
  await openTool(page, tool)
  await page.locator(`.controls__section[data-tool="${tool}"] [role=tab][data-tab="${tab}"]`).click()
  await page.waitForSelector(`.controls__panel[data-sub="${tab}"]`)
}

async function closeTools(page) {
  const open = page.locator('[data-tool][aria-pressed="true"]')
  if (await open.count()) await open.first().click()
}

/** A fresh page at a viewport, a photo chosen, the hint dismissed. */
async function newPage({ width, height, scheme = 'light', photo = PHOTOS[0], init }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (init) await page.addInitScript(init)
  await page.goto(APP)
  await page.waitForSelector('.sheet canvas')
  if (photo) {
    await openTool(page, 'photo')
    await choosePhoto(page, ...photo)
    // The hint covers the foot of the sheet until it is dismissed.
    await page.locator('.app__hint .btn').click()
  }
  return { ctx, page, errors }
}

/**
 * Every tool, every sub-tab, every Over photo state, in order, calling
 * `visit(name)` in each. Leaves the second ink on and the tools closed.
 */
async function eachState(page, visit) {
  await closeTools(page)
  await visit('closed')
  for (const tool of ['type', 'ink', 'photo', 'press']) {
    await openTool(page, tool)
    const tabs = await page.locator(`.controls__section[data-tool="${tool}"] [role=tab]`).evaluateAll((els) => els.map((e) => e.dataset.tab))
    for (const tab of tabs) {
      await openTab(page, tool, tab)
      if (tool === 'ink' && tab === 'over') {
        // Every state of Over photo: the strip comes and goes with them.
        const over = page.locator('.controls__panel[data-sub="over"]')
        for (const mode of ['off', 'second', 'backing']) {
          await over.locator(`input[type=radio][value="${mode}"]`).check({ force: true })
          await visit(`${tool}-${tab}-${mode}`)
          if (mode === 'second') {
            // Keep this ink: no Switch point (O-4), the strip gives way to a row.
            await over.locator('[data-ink-button]').first().click()
            await page.locator('dialog[open] input[type=radio][value="keep"]').check({ force: true })
            await page.locator('dialog[open] .dialog__actions .btn').click()
            await page.waitForSelector('dialog[open]', { state: 'detached' })
            await visit(`${tool}-${tab}-keep`)
            // Back to a second ink of its own, so the strip is there again.
            await over.locator('[data-ink-button]').first().click()
            await page.locator('dialog[open] input[type=radio][value="black"]').check({ force: true })
            await page.locator('dialog[open] .dialog__actions .btn').click()
            await page.waitForSelector('dialog[open]', { state: 'detached' })
          }
        }
        await over.locator('input[type=radio][value="second"]').check({ force: true })
        continue
      }
      await visit(`${tool}-${tab}`)
    }
  }
  await closeTools(page)
}

/** The sheets and dialogs, each opened and closed: `visit(name)` with each
 *  open. */
async function eachDialog(page, visit) {
  const close = async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog[open]', { state: 'detached' })
  }
  await openTab(page, 'type', 'size')
  await page.locator('.controls__panel[data-sub="size"] .controls__value').click()
  await page.waitForSelector('dialog[open]')
  await visit('value-modal')
  await close()
  await openTab(page, 'type', 'place')
  await page.locator('.controls__panel[data-sub="place"] .paramstrip__pick').click()
  await page.waitForSelector('dialog[open]')
  await visit('picker')
  await close()
  await page.locator('.controls__section[data-tool="type"] .controls__layerbtn').click()
  await page.waitForSelector('dialog[open]')
  await visit('plates')
  await close()
  await openTab(page, 'ink', 'ink')
  await page.locator('.controls__panel[data-sub="ink"] [data-ink-button]').click()
  await page.waitForSelector('dialog[open]')
  await visit('ink-dialog')
  await close()
  await closeTools(page)
  await page.locator('.app__bar [aria-label="More"]').click()
  await page.waitForSelector('dialog[open]')
  await visit('more')
  await close()
}

/** Check the targets of the state on screen. */
async function checkTargets(page, where) {
  const t = await page.evaluate(probeTargets)
  for (const s of t.small) check(false, `${where}: a target under 44px: ${s}`)
  return t
}

const shotName = (...parts) => parts.join('-').replace(/[^a-z0-9-]+/gi, '-') + '.png'

try {
  // ── 1. Every viewport, every photo, at 100% text ──
  for (const [vw, vh] of VIEWPORTS) {
    for (const [pw, ph] of PHOTOS) {
      const where = `${vw}x${vh}, a ${pw}x${ph} photo`
      const { ctx, page, errors } = await newPage({ width: vw, height: vh, photo: [pw, ph] })
      const states = []
      let targets = 0
      await eachState(page, async (name) => {
        await settle(page, `${where}, ${name}`)
        states.push({ name, ...(await measure(page)) })
        targets += (await checkTargets(page, `${where}, ${name}`)).measured
        if (name === 'type-size' && vw === 320) {
          const travel = await page.evaluate(() => {
            const input = document.querySelector('.controls__panel[data-sub="size"] .slider__input')
            const thumb = parseFloat(getComputedStyle(input.closest('.slider')).getPropertyValue('--_thumb')) || 24
            const w = input.getBoundingClientRect().width
            const steps = Math.round((Number(input.max) - Number(input.min)) / Number(input.step))
            return { width: w, thumb, steps, pxPerStep: (w - thumb) / steps }
          })
          // At the smallest size (10%) one step is a tenth of the size.
          const perPx = 0.1 / travel.pxPerStep
          console.log(
            `  Size slider at 320 px: ${travel.width.toFixed(1)} px track, ${(travel.width - travel.thumb).toFixed(1)} px of travel, ` +
              `${travel.steps} steps, ${travel.pxPerStep.toFixed(2)} px a step; at 10% one pixel of drag is ${(perPx * 100).toFixed(1)}% of the size`,
          )
          check(travel.steps === 90, `${where}: the Size slider has 90 steps (has ${travel.steps})`)
          check(travel.pxPerStep >= 1.5, `${where}: a Size step is at least 1.5 px of travel (${travel.pxPerStep.toFixed(2)})`)
        }
      })
      if (pw === PHOTOS[0][0]) {
        await eachDialog(page, async (name) => {
          await settle(page, `${where}, ${name}`)
          targets += (await checkTargets(page, `${where}, ${name}`)).measured
          const side = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
          check(side <= 0, `${where}: the page scrolls sideways by ${side} px with ${name} open`)
        })
      }

      // With every tool closed the sheet takes the dock's room as well: the
      // gesture for a full-height sheet. Every open state holds still.
      const open = states.filter((s) => s.name !== 'closed')
      const first = open[0]
      for (const s of open) {
        const same = s.sheet && first.sheet && s.sheet.every((v, i) => Math.abs(v - first.sheet[i]) <= 1)
        check(same, `${where}: the sheet moved in ${s.name}: ${JSON.stringify(s.sheet)} against ${JSON.stringify(first.sheet)} in ${first.name}`)
        check(s.overflow <= 0.5, `${where}: the panel overflows by ${s.overflow} px in ${s.name}`)
        check(s.sideways <= 0, `${where}: the page scrolls sideways by ${s.sideways} px in ${s.name}`)
      }
      check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
      console.log(`${where}: ${open.length} open states, sheet ${JSON.stringify(first.sheet)}, ${targets} targets measured`)
      await ctx.close()
    }
  }

  // ── 2. 200% text, the 4:3 photo ──
  for (const [vw, vh] of VIEWPORTS) {
    const where = `${vw}x${vh} at 200% text`
    const { ctx, page, errors } = await newPage({ width: vw, height: vh })
    await page.addStyleTag({ content: 'html { font-size: 200% }' })
    let n = 0
    let targets = 0
    const visit = async (name) => {
      await settle(page, `${where}, ${name}`)
      n++
      for (const c of await page.evaluate(probeClipped)) check(false, `${where}, ${name}: ${c}`)
      const side = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      check(side <= 0, `${where}, ${name}: the page scrolls sideways by ${side} px`)
      targets += (await checkTargets(page, `${where}, ${name}`)).measured
    }
    await eachState(page, visit)
    await eachDialog(page, visit)
    check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
    console.log(`${where}: ${n} states and dialogs, no text cut off, ${targets} targets measured`)
    await ctx.close()
  }

  // ── 3. The app bar at every width ──
  {
    const ORDER = ['full', 'compact', 'tight']
    const { ctx, page } = await newPage({ width: 430, height: 900, photo: null })
    for (const text of [100, 200]) {
      if (text === 200) await page.addStyleTag({ content: 'html { font-size: 200% }' })
      const seen = []
      let last = -1
      for (let w = 430; w >= 320; w -= 5) {
        await page.setViewportSize({ width: w, height: 900 })
        await settle(page, `the app bar at ${w} px, ${text}% text`)
        const bar = await page.evaluate(probeBar)
        const at = `the app bar at ${w} px, ${text}% text`
        const rank = ORDER.indexOf(bar.fit)
        check(rank >= 0, `${at}: no layout (${bar.fit})`)
        check(rank >= last, `${at}: ${bar.fit} is richer than ${ORDER[last]} at a wider width`)
        check(bar.rows === 1, `${at}: its actions are on ${bar.rows} rows`)
        check(bar.wordLines <= 1, `${at}: Save's word wraps (${bar.wordLines} lines)`)
        check(bar.outside === 0, `${at}: ${bar.outside} of its parts reach past it`)
        // Tight differs from compact only in letting the title wrap: tight
        // with the title on one line means compact was refused for something
        // that is not the title (a hit area read as overflow, once).
        check(bar.fit !== 'tight' || bar.titleLines > 1, `${at}: tight, though the title is on one line (compact should fit)`)
        last = Math.max(last, rank)
        if (seen[seen.length - 1]?.fit !== bar.fit) seen.push({ fit: bar.fit, from: w })
      }
      console.log(`The app bar at ${text}% text: ${seen.map((s) => `${s.fit} from ${s.from} px`).join(', ')}`)
    }
    await ctx.close()
  }

  // ── 4. The save states on a small phone at 200% text ──
  for (const [vw, vh] of SAVE_VIEWPORTS) {
    for (const tool of [null, 'photo']) await checkSaveStates(vw, vh, tool)
  }

  // ── 5. The review screenshots ──
  if (SHOTS) {
    for (const [vw, vh] of SHOT_WIDTHS) {
      for (const scheme of ['light', 'dark']) {
        const { ctx, page } = await newPage({ width: vw, height: vh, scheme })
        const shoot = async (name) => {
          await settle(page, `screenshot ${vw} ${scheme} ${name}`)
          await page.waitForTimeout(250)
          await page.screenshot({ path: join(SHOTS, shotName(vw, scheme, name)) })
        }
        await eachState(page, shoot)
        await eachDialog(page, shoot)
        await ctx.close()
        await shootSaveStates(vw, vh, scheme)
      }
    }
    {
      const { ctx, page } = await newPage({ width: 390, height: 844 })
      await page.addStyleTag({ content: 'html { font-size: 200% }' })
      const shoot = async (name) => {
        await settle(page, `screenshot 390 200% ${name}`)
        await page.waitForTimeout(250)
        await page.screenshot({ path: join(SHOTS, shotName(390, 'light', '200pct', name)) })
      }
      await eachState(page, shoot)
      await eachDialog(page, shoot)
      await ctx.close()
    }
    for (const scheme of ['light', 'dark']) {
      const { ctx, page } = await newPage({ width: 390, height: 844, scheme })
      await page.evaluate(() => document.documentElement.setAttribute('data-palette', 'wire'))
      await closeTools(page)
      await settle(page, `screenshot 390 ${scheme} wire closed`)
      await page.screenshot({ path: join(SHOTS, shotName(390, scheme, 'wire', 'closed')) })
      for (const tool of ['type', 'ink', 'photo', 'press']) {
        await openTool(page, tool)
        await settle(page, `screenshot 390 ${scheme} wire ${tool}`)
        await page.waitForTimeout(250)
        await page.screenshot({ path: join(SHOTS, shotName(390, scheme, 'wire', tool)) })
      }
      await ctx.close()
    }
    console.log(`Screenshots: ${SHOTS}`)
  }
} finally {
  await browser.close()
  await new Promise((r) => server.httpServer.close(r))
}

/**
 * The save states, for the review set: pressing with Cancel and then ready to
 * Share (an encoder slowed to 3 s, as a phone's is), waiting for the photo (a
 * preview decode held back), the photo that could not be loaded (its stored
 * bytes deleted), the smaller-copy question (canvases over 5 MP read back
 * blank) and the save that did not finish (the in-flight mark left set).
 */
async function shootSaveStates(vw, vh, scheme) {
  const shoot = async (page, name) => {
    await settle(page, `screenshot ${vw} ${scheme} save ${name}`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, shotName(vw, scheme, 'save', name)) })
  }
  const slowEncoder = `
    const real = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) { return real.call(this, (b) => setTimeout(() => cb(b), 3000), ...rest) }
    navigator.canShare = () => true
    navigator.share = async () => {}
  `
  const blankAbove5MP = `
    const real = CanvasRenderingContext2D.prototype.getImageData
    CanvasRenderingContext2D.prototype.getImageData = function (...a) {
      const d = real.apply(this, a)
      if (!this.canvas.isConnected && this.canvas.width * this.canvas.height > 5e6) d.data.fill(0)
      return d
    }
  `
  const slowDecode = `
    const real = window.createImageBitmap
    window.createImageBitmap = (src, ...rest) =>
      rest.some((o) => o && typeof o === 'object' && 'resizeWidth' in o)
        ? new Promise((r) => setTimeout(r, 4000)).then(() => real(src, ...rest))
        : real(src, ...rest)
  `
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme, photo: null, init: slowEncoder })
    await page.locator('.app__save').click()
    await page.waitForFunction(() => document.querySelector('.app__status-text')?.textContent?.includes('plate'), null, { timeout: 60_000 })
    await shoot(page, 'pressing')
    await page.waitForFunction(() => document.querySelector('.app__save')?.textContent === 'Share', null, { timeout: 120_000 })
    await shoot(page, 'ready')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme, photo: null, init: blankAbove5MP })
    await page.locator('.app__save').click()
    await page.waitForFunction(() => document.querySelector('dialog.savequestion')?.open, null, { timeout: 120_000 })
    await shoot(page, 'smaller-copy')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme, photo: null })
    await page.evaluate(() => localStorage.setItem('printmachine:export-in-flight', JSON.stringify({ height: 3600, format: 'jpeg' })))
    await page.reload()
    await page.waitForFunction(() => document.querySelector('dialog.savequestion')?.open, null, { timeout: 30_000 }).catch(() => undefined)
    await shoot(page, 'did-not-finish')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme })
    await page.addInitScript(slowDecode)
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForTimeout(1200)
    await shoot(page, 'loading-photo')
    await page.evaluate(
      () =>
        new Promise((res) => {
          const id = JSON.parse(localStorage.getItem('printmachine:settings:v1')).media.id
          const r = indexedDB.open('printmachine')
          r.onsuccess = () => {
            const t = r.result.transaction('media', 'readwrite')
            t.objectStore('media').delete(id)
            t.oncomplete = res
          }
        }),
    )
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForTimeout(1500)
    await shoot(page, 'missing-photo')
    await ctx.close()
  }
}

/**
 * Where the save's cards are, and whether their actions answer a tap: the
 * floating column lies between the app bar and the dock, and the control
 * `sel` is on screen and is what a tap at its centre lands on.
 */
function probeSaveCard(sel) {
  const box = (s) => document.querySelector(s)?.getBoundingClientRect()
  const bar = box('.app__bar')
  const dock = box('.app__overlay')
  const float = box('.app__float')
  const el = document.querySelector(sel)
  let action = 'missing'
  if (el) {
    const b = el.getBoundingClientRect()
    const x = b.left + b.width / 2
    const y = b.top + b.height / 2
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) action = `off the screen at ${Math.round(x)},${Math.round(y)}`
    else {
      const t = document.elementFromPoint(x, y)
      action = t === el || el.contains(t) ? 'ok' : `covered by ${t ? t.tagName.toLowerCase() + '.' + String(t.className).split(' ').join('.') : 'nothing'}`
    }
  }
  return {
    between: float.top >= bar.bottom - 0.5 && float.bottom <= dock.top + 0.5,
    column: `${Math.round(float.top)}..${Math.round(float.bottom)} (bar ends ${Math.round(bar.bottom)}, dock starts ${Math.round(dock.top)})`,
    action,
    toast: document.querySelector('.app__toast--show')?.textContent ?? null,
    text: document.querySelector('.app__status-text')?.textContent ?? null,
  }
}

/**
 * The save states at 200% text on a small phone, where the cards are taller
 * than the room between the bar and the dock: a 5712×4284 photo on its own
 * sheet (the longest reason the planner gives: "capped at 16.7 MP, ...;
 * photo is 5712×4284", in the toast as the press starts), its encoder slowed
 * to 3 s as a phone's is, with the dock closed and with the Photo tool open
 * (where it is right after a photo is chosen). Pressing, with that toast
 * shown: Cancel answers a tap. Ready: Share in the bar answers a tap, and so
 * does the card's ×. The stored photo gone: Choose again answers a tap. In
 * each, the cards stay between the bar and the dock.
 */
async function checkSaveStates(vw, vh, tool) {
  const where = `${vw}x${vh} at 200% text, ${tool ? `the ${tool} tool open` : 'the dock closed'}`
  const slowEncoder = `
    const real = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) { return real.call(this, (b) => setTimeout(() => cb(b), 3000), ...rest) }
    navigator.canShare = () => true
    navigator.share = async () => { window.__shared = (window.__shared ?? 0) + 1 }
  `
  const { ctx, page, errors } = await newPage({ width: vw, height: vh, photo: [5712, 4284], init: slowEncoder })
  const large = () => page.addStyleTag({ content: 'html { font-size: 200% }' })
  const shoot = async (name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, shotName(vw, 'light', '200pct', tool ?? 'closed', 'save', name)) })
  }
  const state = async (name, sel, extra = () => true) => {
    await settle(page, `${where}, ${name}`)
    const p = await page.evaluate(probeSaveCard, sel)
    check(p.between, `${where}, ${name}: the cards reach past the bar or the dock: ${p.column}`)
    check(p.action === 'ok', `${where}, ${name}: ${sel} does not answer a tap: ${p.action}`)
    check(extra(p), `${where}, ${name}: ${JSON.stringify(p)}`)
    await shoot(name)
    return p
  }
  await large()
  if (tool) await openTool(page, tool)
  else await closeTools(page)
  await page.locator('.app__save').click()
  await page.waitForFunction(() => document.querySelector('.app__status-text')?.textContent?.startsWith('Pressing'), null, { timeout: 60_000 })
  // The press's first moments, with the save's toast up.
  const pressing = await state('pressing', '.app__status .btn', (p) => p.toast?.includes('capped at 16.7 MP') === true)
  await page.waitForFunction(() => document.querySelector('.app__save')?.textContent === 'Share', null, { timeout: 180_000 })
  await state('ready', '.app__save')
  await state('ready', '.app__status .btn')
  const share = await page.locator('.app__save').boundingBox()
  await page.mouse.click(share.x + share.width / 2, share.y + share.height / 2)
  await page.waitForFunction(() => (window.__shared ?? 0) > 0, null, { timeout: 5_000 }).catch(() => undefined)
  check((await page.evaluate(() => window.__shared ?? 0)) === 1, `${where}: a tap on Share did not share`)

  // The stored photo gone: the card says so, with Choose again.
  await page.evaluate(
    () =>
      new Promise((res) => {
        const id = JSON.parse(localStorage.getItem('printmachine:settings:v1')).media.id
        const r = indexedDB.open('printmachine')
        r.onsuccess = () => {
          const t = r.result.transaction('media', 'readwrite')
          t.objectStore('media').delete(id)
          t.oncomplete = res
        }
      }),
  )
  await page.reload()
  await page.waitForSelector('.sheet canvas')
  await large()
  if (tool) await openTool(page, tool)
  await page.waitForFunction(() => document.querySelector('.app__status[data-action="choose"]'), null, { timeout: 30_000 })
  await state('missing-photo', '.app__status .btn')
  check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
  console.log(`${where}: pressing (${pressing.text}, with the toast), ready and the missing photo: every action answers, the cards stay between bar and dock`)
  await ctx.close()
}

if (failures.length) {
  console.error(`\n${failures.length} geometry check(s) failed.`)
  process.exit(1)
}
console.log(
  '\nGeometry: the sheet holds still across every tool and tab, no panel overflows, every target owns 44px, ' +
    'nothing is cut off at 200% text, and the app bar holds one row at every width.',
)
