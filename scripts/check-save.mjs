/**
 * The save flow in the BUILT app, tapped like a person would. Exits 1 if any
 * check fails.
 *
 *   npm run build && node scripts/check-save.mjs
 *
 * Serves dist/ (vite preview, at whatever base the build was made for) and,
 * in Chromium at phone size:
 *
 *  1. A 12 MP photo on 4:5, Save: within 100 ms of the tap Save reads Saving
 *     and the status card above the dock offers Cancel, the card counts the
 *     press in pixels and plates, the file is the size the More sheet and
 *     Save's name promised, and the in-flight mark is set while it presses
 *     and gone after.
 *  2. Canvases that read back blank above 5 MP (what an iOS canvas over its
 *     limit does): Save asks, in numbers, for a smaller copy before pressing
 *     anything (focus on Save smaller), and Save smaller saves a file that
 *     size. Blank above 0.3 MP: it says this device cannot save the print.
 *  3. The tab closed mid-press: the next launch says the last save did not
 *     finish, with Try again (focused) and a smaller copy; Escape dismisses
 *     it, the launch after says nothing. Killed again, and the photo's
 *     preview decode held back: the question waits for the photo (its
 *     choices aria-disabled, focus still on Try again, a tap on it starting
 *     nothing, "Loading the photo…"), then the smaller copy saves.
 *  4. The stored photo deleted: with every tool closed, the status card says
 *     so (an alert, with Choose again) and so does Save's name; the Photo
 *     tool's File tab says so; Save cannot be tapped, and no file appears;
 *     the More sheet promises no size (its first row says why, the PNG row
 *     is unavailable and shows no size).
 *  5. Cancel tapped while the file is encoded (an encoder slowed to 1.5 s,
 *     as a phone's is): no file, no "Saved" toast, Save again and no card,
 *     with a share sheet and without one.
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

/** What Save makes now ("2419×3024"), from the More sheet. */
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

/** A w x h JPEG made in the page, chosen through the real file input, the
 *  sheet set to 4:5. */
async function choosePhoto(page, w, h) {
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
  await openTool(page, 'photo')
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.media, null, { timeout: 30_000 })
  await openTool(page, 'photo', 'sheet')
  await page.locator('.controls__section[data-tool="photo"] select').selectOption('4:5')
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
const pressing = (page) => page.waitForFunction((LINE) => document.querySelector(LINE)?.textContent?.includes('plate'), LINE, { timeout: 60_000 })

/** Detached canvases (the press's, not the on-screen preview) over `mp`
 *  megapixels read back blank. */
const blankAbove = (mp) => `
  const real = CanvasRenderingContext2D.prototype.getImageData
  CanvasRenderingContext2D.prototype.getImageData = function (...a) {
    const d = real.apply(this, a)
    if (!this.canvas.isConnected && this.canvas.width * this.canvas.height > ${mp} * 1e6) d.data.fill(0)
    return d
  }
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
    check(size === '2419×3024' && name === 'Save 2419×3024 JPEG', `before the tap: More says "Saves ${size}", Save is named "${name}"`)
    check(first?.b === 'Saving' && first?.c === 'Cancel' && ms < 100, `Save read "${first?.b}" and the card offered "${first?.c}" ${ms} ms after the tap (< 100 ms)`)
    check(lines.some((l) => l.includes(`${size}, plate 1 of`)) && lines.some((l) => l.endsWith('printing the sheet')), `the line counted the press: ${lines.join(' / ')}`)
    check(file === pixels(size), `the file is ${file}, the caption's ${size}`)
    check(mark === JSON.stringify({ height: 3024, format: 'jpeg' }) && (await page.evaluate((F) => localStorage.getItem(F), FLAG)) === null, `in flight ${mark}, gone after`)
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()
  }

  console.log('\n2. A device whose canvases come back blank above 5 MP')
  {
    const ctx = await newContext()
    const { page, errors } = await open(ctx, blankAbove(5))
    await choosePhoto(page, 4032, 3024)
    const files = []
    page.on('download', (d) => files.push(d))
    await page.locator(SAVE).click()
    await waitForQuestion(page)
    const q = await question(page)
    const pressed = await page.evaluate(() => window.__labels.some((x) => x.l.includes('plate') || x.l.includes('printing')))
    check(
      q.text === "This device couldn't press 2419×3024 (a canvas that size came back blank). Save a smaller 1814×2268 copy instead?",
      `asked: "${q.text}"`,
    )
    check(q.buttons.join('|') === 'Cancel|Save smaller' && q.focus === 'Save smaller', `choices: ${q.buttons.join(', ')}; focus on "${q.focus}"`)
    check(!pressed && files.length === 0, 'nothing pressed, no file, before the answer')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByRole('button', { name: 'Save smaller' }).click()])
    const file = await saved(download)
    await page.waitForTimeout(300)
    const toast = await page.locator('.app__toast').allTextContents()
    check(file === '1814x2268' && toast.includes('Downloaded 1814×2268, a smaller copy'), `Save smaller: a ${file} file, "${toast.join('')}"`)
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()

    const ctx2 = await newContext()
    const { page: p2 } = await open(ctx2, blankAbove(0.3))
    await choosePhoto(p2, 4032, 3024)
    await p2.locator(SAVE).click()
    await waitForQuestion(p2)
    const none = await question(p2)
    check(
      none.text === "This device couldn't press 2419×3024 (a canvas that size came back blank), nor a copy smaller than it: it cannot save this print." &&
        none.buttons.join('|') === 'OK',
      `blank above 0.3 MP: "${none.text}" [${none.buttons.join(', ')}]`,
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
    check(q.text === 'The last save, 2419×3024, did not finish.', `the next launch: "${q.text}"`)
    check(
      q.buttons.join('|') === 'Cancel|Try again|Save smaller (1814×2268)' && q.focus === 'Try again',
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
      early.disabled.join('|') === 'Try again|Save smaller (1814×2268)' && early.note === 'Loading the photo…',
      `asked before the photo is back: disabled ${early.disabled.join(', ') || 'none'}; note "${early.note ?? ''}"`,
    )
    // The first save has focus even while it waits (aria-disabled, as Save
    // is), and a tap on it then does nothing.
    const smaller = fourth.getByRole('button', { name: 'Save smaller (1814×2268)' })
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
    check((await saved(download)) === '1814x2268', 'killed again and answered Save smaller once the photo was back: a 1814x2268 file')
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
    await openTool(page, 'photo', 'file')
    await page.waitForTimeout(300)
    const alerts = await page.getByRole('alert').allTextContents()
    let downloaded = false
    page.on('download', () => (downloaded = true))
    const disabled = (await page.locator(SAVE).getAttribute('aria-disabled')) === 'true'
    await page.locator(SAVE).click({ force: true })
    await page.waitForTimeout(2000)
    check(alerts.filter((a) => a === why).length === 2, `the card and the Photo tool's File tab: "${alerts.join(' | ')}"`)
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

  console.log('\n5. Cancel tapped while the file is encoded')
  {
    // The press's encoder (a detached canvas over 1 MP) answers 1.5 s late,
    // as a phone's does; the time it started is recorded.
    const slowEncoder = `
      window.__encodeStarted = null
      const real = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        if (!this.isConnected && this.width * this.height > 1e6) window.__encodeStarted = performance.now()
        return real.call(this, (b) => setTimeout(() => cb(b), 1500), ...rest)
      }
    `
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
        `${share ? 'with a share sheet' : 'no share sheet'}: "${during.cancel}" tapped during the encode (Save "${during.button}") -> ` +
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
    await openTool(page, 'photo', 'sheet')
    await page.locator('.controls__section[data-tool="photo"] select').selectOption('1:1')
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
    // A press long enough to look at: the encoder answers 1.5 s late.
    const slow = `
      const real = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        return real.call(this, (b) => setTimeout(() => cb(b), 1500), ...rest)
      }
    `
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
    // A press long enough to look at: the encoder answers 800 ms late.
    const slow = `
      const real = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        return real.call(this, (b) => setTimeout(() => cb(b), 800), ...rest)
      }
    `
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
          await pressing(page)
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
    // Opening the Photo tool changes what the gestures move: said once more.
    await openTool(page, 'photo')
    await page.waitForTimeout(300)
    const afterTool = await page.evaluate(() => window.__said.slice(1))
    check(
      afterTool.length === 1 && /zoom the photo/.test(afterTool[0]),
      `and once when the tool changes: ${afterTool.map((t) => JSON.stringify(t)).join(' -> ')}`,
    )
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
    await ctx.close()
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
