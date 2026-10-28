/**
 * The save flow in the BUILT app, tapped like a person would. Exits 1 if any
 * check fails.
 *
 *   npm run build && node scripts/check-save.mjs
 *
 * Serves dist/ (vite preview, at whatever base the build was made for) and,
 * in Chromium at phone size:
 *
 *  1. A 12 MP photo on 4:5, in the frame a first photo gets (2822x3528, its
 *     border 252 px), Save: within 100 ms of the tap Save reads Saving
 *     and the status card above the dock offers Cancel, the card counts the
 *     press in pixels and percent and says when it writes the file, the file
 *     is the size the More sheet and Save's name promised, and the in-flight
 *     mark is set while it presses and gone after.
 *  2. Canvases wider than 2000 px that read back blank (what an iOS canvas
 *     over its limit does; the 12 MP print's tiles are 2822 wide, its smaller
 *     copy's 2117): Save asks, in numbers, for a smaller copy before pressing
 *     anything (focus on Save smaller), and Save smaller saves a file that
 *     size. Blank over 100 px wide: it says this device cannot save the
 *     print.
 *  3. The tab closed mid-press: the next launch says the last save did not
 *     finish, with Try again (focused) and a smaller copy; Escape dismisses
 *     it, the launch after says nothing. Killed again, and the photo's
 *     preview decode held back: the question waits for the photo (its
 *     choices aria-disabled, focus still on Try again, a tap on it starting
 *     nothing, "Loading the photo…"), then the smaller copy saves.
 *  4. The stored photo deleted: with every tool closed, the status card says
 *     so (an alert, with Choose again) and so does Save's name; the Frame
 *     tool's Photo tab says so; Save cannot be tapped, and no file appears;
 *     the More sheet promises no size (its first row says why, the PNG row
 *     is unavailable and shows no size).
 *  5. Cancel tapped while the file is written (its writing held 1.5 s by the
 *     test seam, README "Test seams", as a phone's can take): no file, no
 *     "Saved" toast, Save again and no card, with a share sheet and without
 *     one.
 *  6. Ctrl+Z while the print is pressed: the document does not change (the
 *     page is inert, and so is keyboard undo), the file is the print on
 *     screen, and Ctrl+Z works again once the press is over.
 *  7. Focus while the print is pressed: on the card's Cancel (the one thing
 *     that answers), also for a press started from the More sheet's PNG,
 *     whose dialog is still open as the card appears; on Save after.
 *  8. The gesture hint across two saves: its card hides while each press
 *     runs and is back after, and its live region (every change of which a
 *     screen reader reads out) says the hint once, not again after each
 *     save; it changes once more when the tool changes.
 *  9. A 40 MP photo (7728x5152) on Original, in the frame a first photo gets:
 *     More and Save's name promise 9016x6440 (every pixel of the photo, and a
 *     644 px border); within 100 ms of the tap Save reads Saving and the card
 *     offers Cancel; the percent moves; Cancel then leaves no file and no
 *     in-flight mark; Save again writes a file that is 9016x6440, a baseline
 *     JPEG (SOF0) with every component sampled 1x1 (4:4:4), read from its
 *     own header; the in-flight mark is set while it presses and gone after.
 * 10. The frame's inputs (the stored document is given the frame each case
 *     starts from, its palette left out): with the photo's frame source held
 *     back, the border is Paper and no palette is stored; released, the palette is
 *     stored with the photo and the border drawn in its colour. Under
 *     Frosted the palette is stored too, from the one decode. Under Paper,
 *     Save tapped while that decode is held decodes nothing and writes no
 *     file until it is released (the two decodes never run together), and
 *     so does Save tapped back on a photo by an Undo (its palette stored,
 *     needing nothing made) while the replaced photo's decode is held. With a frame
 *     source that will not decode, for a palette colour and for Frosted: the
 *     card and Save's name say the photo could not be loaded, Save cannot be
 *     tapped and no file appears, and the border stays Paper (Frosted on a
 *     photo whose palette is stored, so Frosted's own attempt is the one
 *     that reports it); another photo whose source decodes is drawn and
 *     offered, and an Undo back to the first, while it is decoded again,
 *     shows no card and offers Save, and decoded and working, draws it and
 *     offers Save. A Replace undone while the replaced photo's source still
 *     decodes: when that decode ends, the photo shown keeps its Frosted
 *     border, and the file Save writes has it.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { existsSync, readFileSync } from 'node:fs'
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

const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' })
const APP = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath })

// The app bar's Save, and the save's status card above the dock (its words
// and its one action).
const SAVE = '.app__save'
const LINE = '.app__status-text'
const CANCEL = '.app__status .btn'
// What Save makes, as the More sheet says it (always in the DOM).
const CAPTION = '[data-export-size]'
const QUESTION = 'dialog.savequestion'
const FLAG = 'printmachine:export-in-flight'
const failures = []
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const newContext = () =>
  browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', acceptDownloads: true })

/** Open the app; record every page error, and every change to the Save
 *  button and the line above it, with its time. */
async function open(ctx, stub) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (stub) await page.addInitScript(stub)
  await page.goto(APP)
  await page.waitForSelector('.sheet canvas')
  await page.evaluate(
    ([SAVE, LINE, CANCEL]) => {
      window.__labels = []
      const rec = () => {
        const b = document.querySelector(SAVE)?.textContent ?? ''
        const l = document.querySelector(LINE)?.textContent ?? ''
        const c = document.querySelector(CANCEL)?.textContent ?? ''
        const last = window.__labels[window.__labels.length - 1]
        if (!last || last.b !== b || last.l !== l || last.c !== c) window.__labels.push({ t: performance.now(), b, l, c })
      }
      new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true })
      rec()
    },
    [SAVE, LINE, CANCEL],
  )
  return { page, errors }
}

/** What Save makes now ("2822×3528"), from the More sheet. */
const captionOf = (page) => page.evaluate((C) => document.querySelector(C)?.getAttribute('data-export-size') ?? null, CAPTION)

/** Open a tool (a no-op when it is open) and one of its sub-tabs. */
async function openTool(page, tool, sub) {
  const btn = page.locator(`[data-tool="${tool}"][aria-pressed]`)
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click()
  if (sub) await page.locator(`.controls__section[data-tool="${tool}"] [role=tab][data-tab="${sub}"]`).click()
}
async function closeTools(page) {
  const open = page.locator('[data-tool][aria-pressed="true"]')
  if (await open.count()) await open.first().click()
}

/**
 * The sheet set to `aspect` with the Frame tool's ratio chips, as a person
 * taps them: a chip not chosen chooses its first way round; a landscape
 * twin is its portrait chip's second tap. Nothing is tapped when the sheet
 * is already `aspect` (a second tap on the chosen chip would flip it).
 */
async function setAspect(page, aspect) {
  const now = await page.evaluate(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.aspect ?? '4:5')
  if (now === aspect) return
  await openTool(page, 'frame', 'crop')
  const twin = aspect.includes(':') ? aspect.split(':').reverse().join(':') : aspect
  const chips = page.locator('.controls__section[data-tool="frame"] .chiprow')
  const own = chips.locator(`[data-chip="${aspect}"]`)
  if (await own.count()) await own.click()
  else {
    // The twin's chip, chosen first if it is not, then tapped to flip.
    const other = chips.locator(`[data-chip="${twin}"]`)
    if ((await other.getAttribute('aria-pressed')) !== 'true') await other.click()
    await chips.locator(`[data-chip="${twin}"]`).click()
  }
  await page.waitForFunction((a) => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.aspect === a, aspect, { timeout: 5_000 })
}

/** A w x h JPEG made in the page, chosen through the real file input, the
 *  sheet set to `aspect` (4:5 unless said). */
async function choosePhoto(page, w, h, aspect = '4:5') {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, w, 0)
      grad.addColorStop(0, '#000')
      grad.addColorStop(1, '#fff')
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
      c.width = 0
      return [...new Uint8Array(await b.arrayBuffer())]
    },
    [w, h],
  )
  await openTool(page, 'frame')
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.media, null, { timeout: 30_000 })
  await setAspect(page, aspect)
  await closeTools(page)
  await page.waitForFunction(
    (SAVE) => document.querySelector(SAVE)?.textContent === 'Save' && !document.querySelector(SAVE)?.hasAttribute('aria-disabled'),
    SAVE,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(600)
}

/** A saved file's pixel size, from its own header (JPEG SOFn, PNG IHDR). */
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const m = buf[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}
/** A JPEG's frame header (SOFn): which one, the image's size, and each
 *  component's sampling factors, horizontal and vertical ("11 11 11" is
 *  4:4:4, every colour sample kept). */
function frameOf(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const m = buf[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const sampling = Array.from({ length: buf[i + 9] }, (_, c) => buf[i + 11 + 3 * c].toString(16).padStart(2, '0')).join(' ')
      return { marker: `SOF${m - 0xc0}`, size: `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`, sampling, bytes: buf.length }
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return { marker: 'none', size: null, sampling: null, bytes: buf.length }
}
const saved = async (download) => imageSize(readFileSync(await download.path()))
const pixels = (s) => s.replace('×', 'x')
const question = (page) =>
  page.evaluate((Q) => {
    const d = document.querySelector(Q)
    return {
      open: !!d?.open,
      text: d?.querySelector('.card__text')?.textContent ?? null,
      buttons: [...(d?.querySelectorAll('.dialog__actions button') ?? [])].map((b) => b.textContent),
      // Which of them has focus: the save the question offers first.
      focus: d?.contains(document.activeElement) ? document.activeElement.textContent : null,
    }
  }, QUESTION)
const waitForQuestion = (page) => page.waitForFunction((Q) => document.querySelector(Q)?.open, QUESTION, { timeout: 60_000 })
/** The press under way: the card counts its bands, or writes the file. */
const pressing = (page) => page.waitForFunction((LINE) => /%|writing the file/.test(document.querySelector(LINE)?.textContent ?? ''), LINE, { timeout: 60_000 })

/** Detached canvases (the press's, not the on-screen preview) wider than
 *  `px` read back blank. */
const blankWider = (px) => `
  const real = CanvasRenderingContext2D.prototype.getImageData
  CanvasRenderingContext2D.prototype.getImageData = function (...a) {
    const d = real.apply(this, a)
    if (!this.canvas.isConnected && this.canvas.width > ${px}) d.data.fill(0)
    return d
  }
`

/** The test seam (README "Test seams"): the file's writing held `ms`, the
 *  moment it starts recorded. */
const slowWrite = (ms) => `
  window.__encodeStarted = null
  window.__PM_TEST__ = { finishDelayMs: ${ms}, onFinishStart: () => (window.__encodeStarted = performance.now()) }
`

try {
  console.log(`${APP}\n\n1. A 12 MP photo on 4:5`)
  {
    const ctx = await newContext()
    const { page, errors } = await open(ctx)
    await choosePhoto(page, 4032, 3024)
    const size = (await captionOf(page)) ?? '?'
    const name = await page.locator(SAVE).getAttribute('aria-label')
    await page.evaluate(() => (window.__labels.length = 0))
    const t0 = await page.evaluate((SAVE) => {
      const t = performance.now()
      document.querySelector(SAVE).click()
      return t
    }, SAVE)
    const mark = await page.evaluate((FLAG) => new Promise((res) => {
      const f = () => (localStorage.getItem(FLAG) ? res(localStorage.getItem(FLAG)) : setTimeout(f, 5))
      f()
    }), FLAG)
    const file = await saved(await page.waitForEvent('download', { timeout: 120_000 }))
    await page.waitForTimeout(300)
    const labels = await page.evaluate(() => window.__labels.slice())
    const first = labels.find((x) => x.b !== 'Save')
    const lines = [...new Set(labels.map((x) => x.l).filter((l) => l.startsWith('Pressing')))]
    const ms = first ? Math.round(first.t - t0) : Infinity
    check(size === '2822×3528' && name === 'Save 2822×3528 JPEG', `before the tap: More says "Saves ${size}", Save is named "${name}"`)
    check(first?.b === 'Saving' && first?.c === 'Cancel' && ms < 100, `Save read "${first?.b}" and the card offered "${first?.c}" ${ms} ms after the tap (< 100 ms)`)
    check(
      lines.some((l) => new RegExp(`^Pressing ${size}, \\d+%$`).test(l)) && lines.some((l) => l.endsWith('writing the file')),
      `the line counted the press: ${lines.join(' / ')}`,
    )
    check(file === pixels(size), `the file is ${file}, the caption's ${size}`)
    check(mark === JSON.stringify({ height: 3528, format: 'jpeg' }) && (await page.evaluate((F) => localStorage.getItem(F), FLAG)) === null, `in flight ${mark}, gone after`)
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()
  }

  console.log('\n2. A device whose canvases come back blank wider than 2500 px')
  {
    const ctx = await newContext()
    const { page, errors } = await open(ctx, blankWider(2500))
    await choosePhoto(page, 4032, 3024)
    const files = []
    page.on('download', (d) => files.push(d))
    await page.locator(SAVE).click()
    await waitForQuestion(page)
    const q = await question(page)
    const pressed = await page.evaluate(() => window.__labels.some((x) => x.l.includes('%') || x.l.endsWith('writing the file')))
    check(
      q.text === "This device couldn't press 2822×3528 (a canvas came back blank). Save a smaller 2117×2646 copy instead?",
      `asked: "${q.text}"`,
    )
    check(q.buttons.join('|') === 'Cancel|Save smaller' && q.focus === 'Save smaller', `choices: ${q.buttons.join(', ')}; focus on "${q.focus}"`)
    check(!pressed && files.length === 0, 'nothing pressed, no file, before the answer')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByRole('button', { name: 'Save smaller' }).click()])
    const file = await saved(download)
    await page.waitForTimeout(300)
    const toast = await page.locator('.app__toast').allTextContents()
    check(file === '2117x2646' && toast.includes('Downloaded 2117×2646, a smaller copy'), `Save smaller: a ${file} file, "${toast.join('')}"`)
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()

    const ctx2 = await newContext()
    const { page: p2 } = await open(ctx2, blankWider(100))
    await choosePhoto(p2, 4032, 3024)
    await p2.locator(SAVE).click()
    await waitForQuestion(p2)
    const none = await question(p2)
    check(
      none.text === "This device couldn't press 2822×3528 (a canvas came back blank), nor a copy smaller than it: it cannot save this print." &&
        none.buttons.join('|') === 'OK',
      `blank wider than 100 px: "${none.text}" [${none.buttons.join(', ')}]`,
    )
    await ctx2.close()
  }

  console.log('\n3. The tab closed mid-press')
  {
    const ctx = await newContext()
    const { page } = await open(ctx)
    await choosePhoto(page, 4032, 3024)
    await page.locator(SAVE).click()
    await pressing(page)
    await page.close({ runBeforeUnload: false })
    const { page: next, errors } = await open(ctx)
    await waitForQuestion(next)
    const q = await question(next)
    check(q.text === 'The last save, 2822×3528, did not finish.', `the next launch: "${q.text}"`)
    check(
      q.buttons.join('|') === 'Cancel|Try again|Save smaller (2117×2646)' && q.focus === 'Try again',
      `choices: ${q.buttons.join(', ')}; focus on "${q.focus}"`,
    )
    check((await next.evaluate((F) => localStorage.getItem(F), FLAG)) === null, 'reading the mark cleared it')
    await next.keyboard.press('Escape')
    await next.waitForTimeout(200)
    check(!(await question(next)).open, 'Escape dismissed it')
    await next.close()
    const { page: third } = await open(ctx)
    await third.waitForTimeout(800)
    check(!(await question(third)).open, 'the launch after said nothing')
    await third.locator(SAVE).click()
    await pressing(third)
    await third.close({ runBeforeUnload: false })
    // The preview's decode of the photo (the one call with a resize) held
    // back 2 s, so the question is always asked before the photo is back.
    const slowPreviewDecode = `
      const real = window.createImageBitmap
      window.createImageBitmap = (src, ...rest) =>
        rest.some((o) => o && typeof o === 'object' && 'resizeWidth' in o)
          ? new Promise((r) => setTimeout(r, 2000)).then(() => real(src, ...rest))
          : real(src, ...rest)
    `
    const { page: fourth, errors: later } = await open(ctx, slowPreviewDecode)
    await waitForQuestion(fourth)
    // Asked at launch, before the photo is back: its saves wait for it, and
    // say so (E21).
    const early = await fourth.evaluate((Q) => ({
      disabled: [...document.querySelectorAll(`${Q} button`)].filter((b) => b.getAttribute('aria-disabled') === 'true').map((b) => b.textContent),
      note: document.querySelector(`${Q} .savequestion__wait`)?.textContent ?? null,
    }), QUESTION)
    check(
      early.disabled.join('|') === 'Try again|Save smaller (2117×2646)' && early.note === 'Loading the photo…',
      `asked before the photo is back: disabled ${early.disabled.join(', ') || 'none'}; note "${early.note ?? ''}"`,
    )
    // The first save has focus even while it waits (aria-disabled, as Save
    // is), and a tap on it then does nothing.
    const smaller = fourth.getByRole('button', { name: 'Save smaller (2117×2646)' })
    const waitFocus = await fourth.evaluate(() => document.activeElement?.textContent ?? null)
    await fourth.getByRole('button', { name: 'Try again' }).click({ force: true })
    await fourth.waitForTimeout(100)
    const tapWaiting = await fourth.evaluate((LINE) => document.querySelector(LINE)?.textContent ?? null, LINE)
    check(
      waitFocus === 'Try again' && (await question(fourth)).open && tapWaiting === 'Loading the photo…',
      `while it waits: focus on "${waitFocus}", a tap on it leaves the question open and starts nothing (card: "${tapWaiting}")`,
    )
    await fourth.waitForFunction((Q) => !document.querySelector(`${Q} [aria-disabled="true"]`), QUESTION, { timeout: 30_000 })
    const [download] = await Promise.all([fourth.waitForEvent('download', { timeout: 120_000 }), smaller.click()])
    check((await saved(download)) === '2117x2646', 'killed again and answered Save smaller once the photo was back: a 2117x2646 file')
    check(errors.length + later.length === 0, `no page errors ${[...errors, ...later].join(' | ')}`)
    await ctx.close()
  }

  console.log('\n4. The stored photo deleted')
  {
    const ctx = await newContext()
    const { page } = await open(ctx)
    await choosePhoto(page, 1600, 1200)
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media.id)
    await page.evaluate(
      (id) =>
        new Promise((res) => {
          const r = indexedDB.open('printmachine')
          r.onsuccess = () => {
            const t = r.result.transaction('media', 'readwrite')
            t.objectStore('media').delete(id)
            t.oncomplete = res
          }
        }),
      id,
    )
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForTimeout(1500)
    // Every tool closed: Save itself has to say why.
    const closed = await page.evaluate(
      ([SAVE, LINE, CANCEL]) => ({
        line: document.querySelector(LINE)?.textContent ?? null,
        role: document.querySelector(LINE)?.getAttribute('role') ?? null,
        action: document.querySelector(CANCEL)?.textContent ?? null,
        label: document.querySelector(SAVE)?.getAttribute('aria-label') ?? null,
        panelOpen: !!document.querySelector('.app__panel--open'),
      }),
      [SAVE, LINE, CANCEL],
    )
    const why = 'This photo could not be loaded. Choose it again.'
    check(
      !closed.panelOpen && closed.line === why && closed.role === 'alert' && closed.action === 'Choose again' && closed.label === `Save: ${why}`,
      `tools closed, the status card: "${closed.line}" (${closed.role}, "${closed.action}"); Save's name: "${closed.label}"`,
    )
    await openTool(page, 'frame', 'photo')
    await page.waitForTimeout(300)
    const alerts = await page.getByRole('alert').allTextContents()
    let downloaded = false
    page.on('download', () => (downloaded = true))
    const disabled = (await page.locator(SAVE).getAttribute('aria-disabled')) === 'true'
    await page.locator(SAVE).click({ force: true })
    await page.waitForTimeout(2000)
    check(alerts.filter((a) => a === why).length === 2, `the card and the Frame tool's Photo tab: "${alerts.join(' | ')}"`)
    check(disabled && !downloaded, 'Save cannot be tapped, and no file appears (never the type on bare paper)')
    // More promises no size either: its first row says why, and the PNG row
    // (unavailable) has no size to show.
    await page.locator('.app__bar [aria-label="More"]').click()
    await page.waitForSelector('dialog[open]')
    const more = await page.evaluate(() => {
      const d = document.querySelector('dialog[open]')
      const png = [...d.querySelectorAll('.menu__item')].find((b) => b.textContent.includes('PNG'))
      return {
        row: d.querySelector('[data-export-size]')?.textContent ?? null,
        size: d.querySelector('[data-export-size]')?.getAttribute('data-export-size') ?? null,
        png: png?.textContent ?? null,
        pngOff: png?.getAttribute('aria-disabled') === 'true',
      }
    })
    check(
      more.row?.startsWith(why) && more.size === '' && !/\d×\d/.test(more.row + more.png) && more.pngOff,
      `More: "${more.row}"; "${more.png}" (${more.pngOff ? 'unavailable' : 'available'})`,
    )
    await ctx.close()
  }

  console.log('\n5. Cancel tapped while the file is written')
  {
    // The file's writing held 1.5 s after the last band, as a phone's can
    // take; the time it started is recorded.
    const slowEncoder = slowWrite(1500)
    const shareSheet = `window.__shared = 0; navigator.canShare = () => true; navigator.share = async () => { window.__shared++ }`
    for (const share of [false, true]) {
      const ctx = await newContext()
      const { page, errors } = await open(ctx, slowEncoder + (share ? shareSheet : ''))
      await page.waitForTimeout(600)
      const caption = await captionOf(page)
      let downloaded = 0
      page.on('download', () => downloaded++)
      await page.locator(SAVE).click()
      await page.waitForFunction(() => window.__encodeStarted !== null, null, { timeout: 120_000 })
      const during = { button: await page.locator(SAVE).textContent(), cancel: await page.locator(CANCEL).textContent() }
      await page.locator(CANCEL).click()
      await page.waitForTimeout(2500)
      const end = {
        button: await page.locator(SAVE).textContent(),
        card: await page.locator('.app__status').count(),
        caption: await captionOf(page),
        toast: (await page.locator('.app__toast').allTextContents()).join(''),
        shared: await page.evaluate(() => window.__shared ?? 0),
      }
      check(
        during.button === 'Saving' && during.cancel === 'Cancel' && end.button === 'Save' && end.card === 0 && end.caption === caption &&
          !/Saved|Downloaded/.test(end.toast) && downloaded === 0 && end.shared === 0,
        `${share ? 'with a share sheet' : 'no share sheet'}: "${during.cancel}" tapped while the file is written (Save "${during.button}") -> ` +
          `"${end.button}", ${end.card} card, "Saves ${end.caption}", toast "${end.toast}", ${downloaded} downloads, ${end.shared} shares`,
      )
      check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
      await ctx.close()
    }
  }

  console.log('\n6. Ctrl+Z while the print is pressed')
  {
    const ctx = await newContext()
    const { page, errors } = await open(ctx)
    const ratio = () => page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).getPropertyValue('--sheet-ratio').trim())
    // An edit to undo: the sheet from 4:5 to 1:1.
    await setAspect(page, '1:1')
    await closeTools(page)
    await page.waitForTimeout(600)
    const caption = `Saves ${await captionOf(page)}`
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      (async () => {
        await page.locator(SAVE).click()
        await pressing(page)
        await page.keyboard.press('Control+z')
        await page.keyboard.press('Meta+z')
      })(),
    ])
    const during = await ratio()
    const file = await saved(download)
    await page.waitForTimeout(300)
    check(caption === 'Saves 3600×3600' && during === '1' && file === '3600x3600', `Ctrl+Z during the press: "${caption}", the sheet ratio ${during} after it, the file ${file}`)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
    check((await ratio()) === '0.8', `Ctrl+Z after the press undoes the 1:1: ratio ${await ratio()}`)
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()
  }

  console.log('\n7. Focus while the print is pressed')
  {
    // A press long enough to look at: the file's writing held 1.5 s.
    const slow = slowWrite(1500)
    const ctx = await newContext()
    const { page, errors } = await open(ctx, slow)
    await page.waitForTimeout(600)
    const focused = () =>
      page.evaluate((CANCEL) => {
        const a = document.activeElement
        if (a && a === document.querySelector(CANCEL)) return 'Cancel'
        if (a && a.matches('.app__save')) return 'Save'
        return a ? a.tagName.toLowerCase() : 'none'
      }, CANCEL)
    const pressAndLook = async (start) => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        (async () => {
          await start()
          await pressing(page)
          await page.waitForTimeout(150)
          during.push(await focused())
        })(),
      ])
      await saved(download)
      await page.waitForTimeout(300)
      after.push(await focused())
    }
    const during = []
    const after = []
    await pressAndLook(() => page.locator(SAVE).click())
    await pressAndLook(async () => {
      await page.getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: /Save lossless PNG/ }).click()
    })
    check(
      during.join('|') === 'Cancel|Cancel' && after.join('|') === 'Save|Save',
      `focus while pressing: ${during.join(', ')} (from Save, from More's PNG); after: ${after.join(', ')}`,
    )
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()
  }

  console.log('\n8. The gesture hint across a save: the card hides, its words for a screen reader stay')
  {
    // A press long enough to look at: the file's writing held 1.5 s, as in
    // 7. The hint is looked at as soon as the status line says the print is
    // being pressed, in whichever phase (the photo, the bands, the file).
    const slow = slowWrite(1500)
    const ctx = await newContext()
    const { page, errors } = await open(ctx, slow)
    await choosePhoto(page, 1600, 1200)
    await page.waitForSelector('.app__hint')
    // Every change of the hint's live region (each one is announced).
    await page.evaluate(() => {
      const region = document.querySelector('.app__float > p.sr-only[role=status]')
      window.__said = [region.textContent]
      new MutationObserver(() => window.__said.push(region.textContent)).observe(region, { childList: true, characterData: true, subtree: true })
    })
    const cardDuring = []
    for (let i = 0; i < 2; i++) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        (async () => {
          await page.locator(SAVE).click()
          await page.waitForFunction((LINE) => document.querySelector(LINE)?.textContent?.startsWith('Pressing'), LINE, { timeout: 60_000 })
          cardDuring.push(await page.locator('.app__hint').count())
        })(),
      ])
      await saved(download)
      await page.waitForTimeout(400)
    }
    const cardAfter = await page.locator('.app__hint').count()
    const afterSaves = await page.evaluate(() => window.__said.slice())
    check(
      cardDuring.join('|') === '0|0' && cardAfter === 1,
      `the hint's card hides while each press runs (${cardDuring.join(', ')} cards) and is back after (${cardAfter})`,
    )
    check(
      afterSaves.length === 1 && /Tap type to pick it/.test(afterSaves[0]),
      `its live region says the type's gestures once and not again over two saves: ${afterSaves.map((t) => JSON.stringify(t)).join(' -> ')}`,
    )
    // Opening the Frame tool changes what the gestures move: said once more.
    await openTool(page, 'frame')
    await page.waitForTimeout(300)
    const afterTool = await page.evaluate(() => window.__said.slice(1))
    check(
      afterTool.length === 1 && /zoom the photo/.test(afterTool[0]),
      `and once when the tool changes: ${afterTool.map((t) => JSON.stringify(t)).join(' -> ')}`,
    )
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()
  }

  console.log('\n9. A 40 MP photo on Original')
  {
    const ctx = await newContext()
    const { page, errors } = await open(ctx)
    const t = Date.now()
    await choosePhoto(page, 7728, 5152, 'original')
    const size = (await captionOf(page)) ?? '?'
    const name = await page.locator(SAVE).getAttribute('aria-label')
    check(size === '9016×6440' && name === 'Save 9016×6440 JPEG', `before the tap: More says "Saves ${size}", Save is named "${name}"`)
    const files = []
    page.on('download', (d) => files.push(d))
    // A Save, cancelled once its percent has moved.
    await page.evaluate(() => (window.__labels.length = 0))
    const t0 = await page.evaluate((SAVE) => {
      const t = performance.now()
      document.querySelector(SAVE).click()
      return t
    }, SAVE)
    const mark = await page.evaluate((FLAG) => new Promise((res) => {
      const f = () => (localStorage.getItem(FLAG) ? res(localStorage.getItem(FLAG)) : setTimeout(f, 5))
      f()
    }), FLAG)
    await page.waitForFunction(
      (size) => new Set(window.__labels.map((x) => x.l).filter((l) => new RegExp(`^Pressing ${size}, \\d+%$`).test(l))).size >= 2,
      size,
      { timeout: 120_000 },
    )
    const moved = await page.evaluate(() => [...new Set(window.__labels.map((x) => x.l).filter((l) => /%$/.test(l)))])
    await page.locator(CANCEL).click()
    await page.waitForFunction((SAVE) => document.querySelector(SAVE)?.textContent === 'Save', SAVE, { timeout: 30_000 })
    await page.waitForTimeout(1500)
    const labels = await page.evaluate(() => window.__labels.slice())
    const first = labels.find((x) => x.b !== 'Save')
    const ms = first ? Math.round(first.t - t0) : Infinity
    check(first?.b === 'Saving' && first?.c === 'Cancel' && ms < 100, `Save read "${first?.b}" and the card offered "${first?.c}" ${ms} ms after the tap (< 100 ms)`)
    check(moved.length >= 2, `the percent moved: ${moved.join(' / ')}`)
    const markAfterCancel = await page.evaluate((F) => localStorage.getItem(F), FLAG)
    check(files.length === 0 && markAfterCancel === null, `Cancel at ${moved[moved.length - 1]}: no file, the in-flight mark ${markAfterCancel === null ? 'gone' : 'still set'}`)
    // Save again, to the file.
    const t1 = Date.now()
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240_000 }), page.locator(SAVE).click()])
    const frame = frameOf(readFileSync(await download.path()))
    const secs = ((Date.now() - t1) / 1000).toFixed(1)
    await page.waitForTimeout(300)
    check(
      frame.marker === 'SOF0' && frame.size === '9016x6440' && frame.sampling === '11 11 11',
      `Save again: the file is ${frame.marker} ${frame.size}, sampling ${frame.sampling} (4:4:4 is 11 11 11), ${(frame.bytes / 1e6).toFixed(1)} MB, ${secs} s from the tap`,
    )
    check(
      mark === JSON.stringify({ height: 6440, format: 'jpeg' }) && (await page.evaluate((F) => localStorage.getItem(F), FLAG)) === null,
      `in flight ${mark}, gone after`,
    )
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    console.log(`  (${((Date.now() - t) / 1000).toFixed(0)} s in all)`)
    await ctx.close()
  }

  console.log("\n10. The frame's inputs: held back, then made; and a photo they cannot be made from")
  {
    // The frame's source is the photo decoded at 1024 px on its long side
    // (features/media/frameSource.ts): the one decode of that size. Held
    // back until released, or failing, by a stand-in for createImageBitmap.
    // Every other decode is counted too (`__otherDecodes`: the preview's
    // copies, and Save's original).
    const stub = `
      window.__frameDecodes = 0
      window.__otherDecodes = 0
      const real = window.createImageBitmap
      window.createImageBitmap = function (src, ...rest) {
        const o = rest.length === 1 ? rest[0] : rest[4]
        if (o && Math.max(o.resizeWidth ?? 0, o.resizeHeight ?? 0) === 1024) {
          window.__frameDecodes++
          if (sessionStorage.getItem('frame-decode') === 'fail') return Promise.reject(new Error('injected: this decode fails'))
          const mode = sessionStorage.getItem('frame-decode')
          // 'hold-once': this decode held, the next ones not.
          if (mode === 'hold-once') sessionStorage.setItem('frame-decode', 'pass')
          if (mode === 'hold' || mode === 'hold-once') return new Promise((res, rej) => (window.__releaseFrame = () => real.call(window, src, ...rest).then(res, rej)))
        } else window.__otherDecodes++
        return real.call(window, src, ...rest)
      }
    `
    // A document given the frame a case starts from before the app reads
    // it, its palette left out (or kept, `keep`), on the next load.
    const frameNext = (page, frame, decode, keep = false) =>
      page.addInitScript(
        ([frame, decode, keep]) => {
          if (sessionStorage.getItem('framed') === JSON.stringify(frame)) return
          sessionStorage.setItem('framed', JSON.stringify(frame))
          sessionStorage.setItem('frame-decode', decode)
          const k = 'printmachine:settings:v1'
          const s = JSON.parse(localStorage.getItem(k))
          s.frame = { ...s.frame, ...frame }
          if (s.media && !keep) delete s.media.palette
          localStorage.setItem(k, JSON.stringify(s))
        },
        [frame, decode, keep],
      )
    // The sheet's top-left pixel, in the border, as the preview shows it.
    const corner = (page) =>
      page.evaluate(() => {
        const c = document.querySelector('.sheet canvas')
        return [...c.getContext('2d').getImageData(2, 2, 1, 1).data]
      })
    const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.palette ?? null)
    const mediaId = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.id ?? null)

    const ctx = await newContext()
    const { page, errors } = await open(ctx, stub)
    await choosePhoto(page, 1600, 1200)
    // Paper first: the border as bare paper looks.
    await frameNext(page, { width: 0.08, fill: 'paper' }, 'pass')
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForTimeout(1500)
    const paper = await corner(page)
    // The photo's colour, its source held back: Paper until it is made.
    await frameNext(page, { width: 0.08, fill: 'photo' }, 'hold')
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForFunction(() => window.__frameDecodes > 0 && typeof window.__releaseFrame === 'function', null, { timeout: 30_000 })
    await page.waitForTimeout(1500)
    const held = await corner(page)
    const heldSave = await page.locator(SAVE).getAttribute('aria-disabled')
    check(
      held.join() === paper.join() && (await stored(page)) === null && heldSave !== 'true',
      `held back: the border is Paper (${held.join(',')} = ${paper.join(',')}), no palette stored, Save still offered (it makes the inputs itself)`,
    )
    await page.evaluate(() => window.__releaseFrame())
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.palette, null, { timeout: 30_000 })
    await page.waitForTimeout(1500)
    const made = await corner(page)
    const palette = await stored(page)
    const decodes = await page.evaluate(() => window.__frameDecodes)
    check(
      made.join() !== paper.join() && /^#[0-9a-f]{6}$/.test(palette?.photo ?? '') && Object.keys(palette).join() === 'photo,deep,muted,comp' && decodes === 1,
      `released: the palette stored with the photo (${Object.values(palette ?? {}).join(' ')}), the border drawn in it (${made.join(',')}), one decode (${decodes})`,
    )
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()

    // Under Paper the page makes the palette too (the fill row shows the
    // four colours), from a decode that starts as the preview copy lands,
    // the moment Save can be tapped. Save waits for that decode to end
    // before it decodes the original, so the photo's two decodes never run
    // together; Paper takes nothing from it.
    {
      const ctx = await newContext()
      const { page, errors } = await open(ctx, stub)
      await choosePhoto(page, 1600, 1200)
      await frameNext(page, { width: 0.08, fill: 'paper' }, 'hold')
      await page.reload()
      await page.waitForSelector('.sheet canvas')
      await page.waitForFunction(() => typeof window.__releaseFrame === 'function', null, { timeout: 30_000 })
      await page.waitForTimeout(1500)
      let early = false
      page.on('download', () => (early = true))
      const before = await page.evaluate(() => window.__otherDecodes)
      await page.locator(SAVE).click()
      await page.waitForTimeout(2500)
      const held = await page.evaluate(() => window.__otherDecodes)
      check(
        held === before && !early,
        `Paper, the frame source held back: Save tapped, and while it is held the original is not decoded (${held - before} decodes) and no file is written`,
      )
      page.removeAllListeners('download')
      const download = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null)
      await page.evaluate(() => window.__releaseFrame())
      const file = await download
      const after = await page.evaluate(() => window.__otherDecodes)
      check(
        file !== null && after > before && Object.keys((await stored(page)) ?? {}).join() === 'photo,deep,muted,comp',
        `released: the original decoded (${after - before}) and the file written (${file?.suggestedFilename() ?? 'none'}), the palette stored`,
      )
      check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
      await ctx.close()
    }

    // A frame-source decode begun for another photo is waited for too: a
    // photo framed in Paper, its palette stored (it needs nothing made);
    // another photo chosen, its frame source held back; an Undo back to the
    // first. Save waits for the replaced photo's decode to end before it
    // decodes the original, so the two never run together.
    {
      const ctx = await newContext()
      const { page, errors } = await open(ctx, stub)
      await choosePhoto(page, 1600, 1200)
      await frameNext(page, { width: 0.08, fill: 'paper' }, 'pass')
      await page.reload()
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.palette, null, { timeout: 30_000 })
      await page.waitForTimeout(1500)
      const shown = await mediaId(page)
      await page.evaluate(() => {
        sessionStorage.setItem('frame-decode', 'hold-once')
        window.__releaseFrame = null
      })
      await choosePhoto(page, 1200, 1600)
      await page.waitForFunction(() => typeof window.__releaseFrame === 'function', null, { timeout: 30_000 })
      for (let i = 0; i < 3 && (await mediaId(page)) !== shown; i++) {
        await page.keyboard.press('Control+z')
        await page.waitForTimeout(300)
      }
      await page.waitForFunction(
        (SAVE) => document.querySelector(SAVE)?.textContent === 'Save' && !document.querySelector(SAVE)?.hasAttribute('aria-disabled'),
        SAVE,
        { timeout: 30_000 },
      )
      await page.waitForTimeout(1500)
      const back = (await mediaId(page)) === shown && (await stored(page)) !== null
      let early = false
      page.on('download', () => (early = true))
      const before = await page.evaluate(() => window.__otherDecodes)
      await page.locator(SAVE).click()
      await page.waitForTimeout(2500)
      const held = await page.evaluate(() => window.__otherDecodes)
      check(
        back && held === before && !early,
        `Paper, its palette stored, back by an Undo while the replaced photo's frame source is held: Save tapped, and while it is held the original is not decoded (${held - before} decodes) and no file is written`,
      )
      page.removeAllListeners('download')
      const download = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null)
      await page.evaluate(() => window.__releaseFrame())
      const file = await download
      const after = await page.evaluate(() => window.__otherDecodes)
      check(
        file !== null && after > before && (await mediaId(page)) === shown,
        `released: the original decoded (${after - before}) and the file written (${file?.suggestedFilename() ?? 'none'})`,
      )
      check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
      await ctx.close()
    }

    // Frosted shows on a photo with no palette: the palette is made too (the
    // fill row shows all four colours before one is chosen), from the one
    // decode Frosted needs anyway; the border is frosted.
    {
      const ctx = await newContext()
      const { page, errors } = await open(ctx, stub)
      await choosePhoto(page, 1600, 1200)
      await frameNext(page, { width: 0.08, fill: 'frosted' }, 'pass')
      await page.reload()
      await page.waitForSelector('.sheet canvas')
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.palette, null, { timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(1500)
      const frosted = await corner(page)
      const palette = await stored(page)
      const decodes = await page.evaluate(() => window.__frameDecodes)
      check(
        frosted.join() !== paper.join() && Object.keys(palette ?? {}).join() === 'photo,deep,muted,comp' && decodes === 1,
        `Frosted: the palette stored as well (${Object.values(palette ?? {}).join(' ')}), the border frosted (${frosted.join(',')}), one decode (${decodes})`,
      )
      check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
      await ctx.close()
    }

    // A photo whose frame source will not decode: one state, said as a photo
    // that cannot be loaded; Save refuses; the border stays Paper. For a
    // palette colour (its palette not stored: the palette's attempt reports
    // it) and for Frosted on a photo whose palette IS stored (made under
    // Paper first, as a reopened photo's is: Frosted's own attempt is the
    // only one made, and the only one to report it). Then another photo
    // whose source decodes, and an Undo back to the first: while it is
    // decoded again it reads as at first load (Paper, Save offered and
    // waiting, no card); decoded and working now, it is drawn and Save
    // offers it (what Save allows is what the preview draws).
    const why = 'This photo could not be loaded. Choose it again.'
    const saveState = (page) =>
      page.evaluate(
        ([SAVE, LINE, CANCEL]) => ({
          line: document.querySelector(LINE)?.textContent ?? null,
          role: document.querySelector(LINE)?.getAttribute('role') ?? null,
          action: document.querySelector(CANCEL)?.textContent ?? null,
          label: document.querySelector(SAVE)?.getAttribute('aria-label') ?? null,
          disabled: document.querySelector(SAVE)?.getAttribute('aria-disabled') === 'true',
        }),
        [SAVE, LINE, CANCEL],
      )
    for (const { fill, keep } of [
      { fill: 'photo', keep: false },
      { fill: 'frosted', keep: true },
    ]) {
      const ctx2 = await newContext()
      const second = await open(ctx2, stub)
      const p2 = second.page
      await choosePhoto(p2, 1600, 1200)
      let kept = null
      if (keep) {
        await frameNext(p2, { width: 0.08, fill: 'paper' }, 'pass')
        await p2.reload()
        await p2.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.palette, null, { timeout: 30_000 })
        kept = await stored(p2)
      }
      const decodesAtLoad = keep ? await p2.evaluate(() => window.__frameDecodes) : 0
      await frameNext(p2, { width: 0.08, fill }, 'fail', keep)
      await p2.reload()
      await p2.waitForSelector('.sheet canvas')
      await p2.waitForFunction(() => window.__frameDecodes > 0, null, { timeout: 30_000 })
      await p2.waitForTimeout(1500)
      const state = await saveState(p2)
      let downloaded = false
      p2.on('download', () => (downloaded = true))
      await p2.locator(SAVE).click({ force: true })
      await p2.waitForTimeout(2000)
      const failed = await corner(p2)
      const what = keep ? `${fill} (its palette stored, ${Object.values(kept ?? {}).join(' ')})` : fill
      check(
        state.line === why && state.role === 'alert' && state.action === 'Choose again' && state.label === `Save: ${why}` && state.disabled && !downloaded,
        `${what}, failing: the card says "${state.line}" (${state.role}, "${state.action}"), Save is "${state.label}", cannot be tapped, no file (${decodesAtLoad} decodes before)`,
      )
      check(
        failed.join() === paper.join() && JSON.stringify(await stored(p2)) === JSON.stringify(kept),
        `and the border stays Paper (${failed.join(',')}), ${keep ? 'the palette as it was' : 'nothing stored'}`,
      )

      // Another photo, its source decoding: drawn, and Save offers it.
      const first = await mediaId(p2)
      await p2.evaluate(() => sessionStorage.setItem('frame-decode', 'pass'))
      await choosePhoto(p2, 1200, 1600)
      await p2.waitForTimeout(1500)
      const other = await corner(p2)
      const otherState = await saveState(p2)
      check(
        other.join() !== paper.join() && !otherState.disabled && (await mediaId(p2)) !== first,
        `${fill}, another photo chosen: its border drawn (${other.join(',')}), Save "${otherState.label ?? 'Save'}" offered`,
      )
      // Undo back to the first photo, its new decode held back: it reads as
      // at first load, not as failed.
      await p2.evaluate(
        ([LINE, why]) => {
          sessionStorage.setItem('frame-decode', 'hold')
          window.__releaseFrame = null
          // Whether the card says so at any moment from here.
          window.__sawFailure = false
          const look = () => (window.__sawFailure ||= document.querySelector(LINE)?.textContent === why)
          new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true })
        },
        [LINE, why],
      )
      for (let i = 0; i < 3 && (await mediaId(p2)) !== first; i++) {
        await p2.keyboard.press('Control+z')
        await p2.waitForTimeout(300)
      }
      await p2.waitForFunction(() => typeof window.__releaseFrame === 'function', null, { timeout: 30_000 })
      await p2.waitForTimeout(1000)
      const waiting = await saveState(p2)
      const waitingCorner = await corner(p2)
      const alerted = await p2.evaluate(() => window.__sawFailure)
      check(
        (await mediaId(p2)) === first && waiting.line !== why && waiting.role !== 'alert' && !waiting.disabled && waiting.label !== `Save: ${why}` && !alerted && waitingCorner.join() === paper.join(),
        `${fill}, Undo to the first photo, decoded again and held: no card at any moment ("${waiting.line ?? ''}"), Save offered ("${waiting.label ?? 'Save'}"), the border Paper until it lands`,
      )
      // Released, and working now: drawn, and Save offers it.
      await p2.evaluate(() => sessionStorage.setItem('frame-decode', 'pass'))
      await p2.evaluate(() => window.__releaseFrame())
      await p2.waitForTimeout(1500)
      const back = await corner(p2)
      const backState = await saveState(p2)
      check(
        (await mediaId(p2)) === first && back.join() !== paper.join() && !backState.disabled && backState.label !== `Save: ${why}`,
        `${fill}, released: its border drawn (${back.join(',')}) and Save offered ("${backState.label ?? 'Save'}"), not refused`,
      )
      check(second.errors.length === 0, `no page errors ${second.errors.join(' | ')}`)
      await ctx2.close()
    }

    // A photo replaced while its frame source decodes, and the Replace
    // undone before that decode ends: the late decode is the replaced
    // photo's, and changes nothing of the photo shown. Its Frosted border
    // stays drawn, and is what Save presses.
    {
      const ctx = await newContext()
      const { page, errors } = await open(ctx, stub)
      await choosePhoto(page, 1600, 1200)
      await frameNext(page, { width: 0.08, fill: 'frosted' }, 'pass')
      await page.reload()
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1')).media?.palette, null, { timeout: 30_000 })
      await page.waitForTimeout(1500)
      const shown = await mediaId(page)
      const drawn = await corner(page)
      // Another photo chosen, its frame source held back; then Undo.
      await page.evaluate(() => {
        sessionStorage.setItem('frame-decode', 'hold-once')
        window.__releaseFrame = null
      })
      await choosePhoto(page, 1200, 1600)
      await page.waitForFunction(() => typeof window.__releaseFrame === 'function', null, { timeout: 30_000 })
      const decodes = await page.evaluate(() => window.__frameDecodes)
      for (let i = 0; i < 3 && (await mediaId(page)) !== shown; i++) {
        await page.keyboard.press('Control+z')
        await page.waitForTimeout(300)
      }
      await page.waitForFunction((d) => window.__frameDecodes > d, decodes, { timeout: 30_000 })
      await page.waitForTimeout(1500)
      const back = await corner(page)
      // The replaced photo's decode ends now.
      await page.evaluate(() => window.__releaseFrame())
      await page.waitForTimeout(1500)
      const after = await corner(page)
      check(
        (await mediaId(page)) === shown && back.join() !== paper.join() && after.join() === back.join(),
        `Frosted, a Replace undone while the replaced photo's source decodes: back on the first photo its border drawn (${back.join(',')}; ${drawn.join(',')} before), and after that decode ends still (${after.join(',')})`,
      )
      const download = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null)
      await page.locator(SAVE).click()
      const file = await download
      const printed = file
        ? await page.evaluate(async (b64) => {
            const img = new Image()
            img.src = `data:image/jpeg;base64,${b64}`
            await img.decode()
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const g = c.getContext('2d')
            g.drawImage(img, 0, 0)
            return [...g.getImageData(2, 2, 1, 1).data]
          }, readFileSync(await file.path()).toString('base64'))
        : null
      const near = printed !== null && printed.slice(0, 3).every((v, k) => Math.abs(v - after[k]) <= 12)
      check(near, `and Save presses what the preview draws: the file's corner ${printed?.join(',') ?? 'none'} against the preview's ${after.join(',')}`)
      check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await new Promise((r) => server.httpServer.close(r))
}

if (failures.length) {
  console.log(`\nFAILED:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nAll checks pass.')
