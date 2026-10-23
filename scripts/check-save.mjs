/**
 * The save flow in the BUILT app, tapped like a person would. Exits 1 if any
 * check fails.
 *
 *   npm run build && node scripts/check-save.mjs
 *
 * Serves dist/ (vite preview, at whatever base the build was made for) and,
 * in Chromium at phone size:
 *
 *  1. A 12 MP photo on 4:5, Save: the button reads Cancel within 100 ms of the
 *     tap, the line counts the press in pixels and plates, the file is the
 *     size the caption promised, and the in-flight mark is set while it
 *     presses and gone after.
 *  2. Canvases that read back blank above 5 MP (what an iOS canvas over its
 *     limit does): Save asks, in numbers, for a smaller copy before pressing
 *     anything, and Save smaller saves a file that size. Blank above 0.3 MP:
 *     it says this device cannot save the print.
 *  3. The tab closed mid-press: the next launch says the last save did not
 *     finish, with Try again and a smaller copy; Escape dismisses it, the
 *     launch after says nothing, and the smaller copy saves.
 *  4. The stored photo deleted: with the Photo tab closed, the line above
 *     Save says so (an alert, in place of the size) and so does Save's
 *     label; the Photo panel says so; Save cannot be tapped, and no file
 *     appears.
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

const SAVE = '.toolbar .icon-button[data-variant=primary]'
const LINE = '.app__overlay > .control-group .field-label'
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
    ([SAVE, LINE]) => {
      window.__labels = []
      const rec = () => {
        const b = document.querySelector(SAVE)?.textContent ?? ''
        const l = document.querySelector(LINE)?.textContent ?? ''
        const last = window.__labels[window.__labels.length - 1]
        if (!last || last.b !== b || last.l !== l) window.__labels.push({ t: performance.now(), b, l })
      }
      new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true })
      rec()
    },
    [SAVE, LINE],
  )
  return { page, errors }
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
  await page.getByRole('tab', { name: 'Photo' }).click()
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.media, null, { timeout: 30_000 })
  await page.getByRole('radio', { name: '4:5' }).click()
  await page.getByRole('tab', { name: 'Photo' }).click()
  await page.waitForFunction((SAVE) => document.querySelector(SAVE)?.textContent === 'Save', SAVE, { timeout: 30_000 })
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
  page.evaluate(() => {
    const d = document.querySelector('dialog')
    return { open: !!d?.open, text: d?.querySelector('p')?.textContent ?? null, buttons: [...(d?.querySelectorAll('button') ?? [])].map((b) => b.textContent) }
  })
const waitForQuestion = (page) => page.waitForFunction(() => document.querySelector('dialog')?.open, null, { timeout: 60_000 })
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
    const caption = await page.locator(LINE).textContent()
    const size = /Saves (\d+×\d+)/.exec(caption)?.[1] ?? '?'
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
    check(caption === 'Saves 2419×3024', `the caption before the tap: "${caption}"`)
    check(first?.b === 'Cancel' && ms < 100, `the button read "${first?.b}" ${ms} ms after the tap (< 100 ms)`)
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
    check(q.buttons.join('|') === 'Save smaller|Cancel', `choices: ${q.buttons.join(', ')}`)
    check(!pressed && files.length === 0, 'nothing pressed, no file, before the answer')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByRole('button', { name: 'Save smaller' }).click()])
    const file = await saved(download)
    await page.waitForTimeout(300)
    const toast = await page.locator('.toast').allTextContents()
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
    check(q.buttons.join('|') === 'Try again|Save smaller (1814×2268)|Cancel', `choices: ${q.buttons.join(', ')}`)
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
    const { page: fourth } = await open(ctx)
    await waitForQuestion(fourth)
    // Asked at launch, before the photo is back: its saves wait for it.
    const early = await fourth.evaluate(() => ({
      disabled: [...document.querySelectorAll('dialog button')].filter((b) => b.disabled).map((b) => b.textContent),
      note: document.querySelector('dialog .panel-note')?.textContent ?? null,
    }))
    const [download] = await Promise.all([
      fourth.waitForEvent('download', { timeout: 120_000 }),
      fourth.getByRole('button', { name: 'Save smaller (1814×2268)' }).click(),
    ])
    check((await saved(download)) === '1814x2268', 'killed again and answered Save smaller: a 1814x2268 file')
    console.log(`       (at launch: disabled ${early.disabled.join(', ') || 'none'}; note "${early.note ?? ''}")`)
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
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
      ([SAVE, LINE]) => ({
        line: document.querySelector(LINE)?.textContent ?? null,
        role: document.querySelector(LINE)?.getAttribute('role') ?? null,
        label: document.querySelector(SAVE)?.getAttribute('aria-label') ?? null,
        panelOpen: !!document.querySelector('.drawer[data-open=true]'),
      }),
      [SAVE, LINE],
    )
    const why = 'This photo could not be loaded. Choose it again.'
    check(
      !closed.panelOpen && closed.line === why && closed.role === 'alert' && closed.label === `Save: ${why}`,
      `tools closed, the line above Save: "${closed.line}" (${closed.role}); Save's label: "${closed.label}"`,
    )
    await page.getByRole('tab', { name: 'Photo' }).click()
    await page.waitForTimeout(300)
    const alerts = await page.getByRole('alert').allTextContents()
    let downloaded = false
    page.on('download', () => (downloaded = true))
    const disabled = await page.locator(SAVE).isDisabled()
    await page.locator(SAVE).click({ force: true })
    await page.waitForTimeout(2000)
    check(alerts.includes('This photo could not be loaded. Choose it again.'), `the Photo panel: "${alerts.join(' | ')}"`)
    check(disabled && !downloaded, 'Save cannot be tapped, and no file appears (never the type on bare paper)')
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
