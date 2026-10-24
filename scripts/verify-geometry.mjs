/**
 * The dock's geometry, measured in the built app. Exits 1 if any check fails.
 *
 *   npm run build && node scripts/verify-geometry.mjs [--shots <dir>] [--width 320]
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
 *  - the Size slider's travel on the real track: pixels per 1% step, and what
 *    one pixel of drag changes at the smallest size (the touchiness bound of
 *    WP2's Size slider, measured where a thumb meets it).
 *
 * The DOM contract it reads (src/features/shell/AppShell.tsx and the panels):
 * tool buttons `[data-tool]` with `aria-pressed`, the open panel
 * `.controls__section[data-tool]` with its `[role=tab][data-tab]`, the content
 * area `.controls__panel[data-sub]`, the scroller `.app__panel-inner`, the
 * sheet `.sheet`. `--shots <dir>` writes a screenshot of every state.
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

/** Two painted frames: layout has settled, the overlay height is published. */
const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))))

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

async function closeTools(page) {
  const open = page.locator('[data-tool][aria-pressed="true"]')
  if (await open.count()) await open.first().click()
}

try {
  for (const [vw, vh] of VIEWPORTS) {
    for (const [pw, ph] of PHOTOS) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, serviceWorkers: 'block' })
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(APP)
      await page.waitForSelector('.sheet canvas')
      await openTool(page, 'photo')
      await choosePhoto(page, pw, ph)

      const where = `${vw}x${vh}, a ${pw}x${ph} photo`
      const states = []
      const record = async (name) => {
        await settle(page)
        const m = await measure(page)
        states.push({ name, ...m })
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${vw}-${pw}x${ph}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) })
      }

      for (const tool of ['type', 'ink', 'photo', 'press']) {
        await openTool(page, tool)
        const tabs = await page.locator(`.controls__section[data-tool="${tool}"] [role=tab]`).evaluateAll((els) => els.map((e) => e.dataset.tab))
        for (const tab of tabs) {
          await page.locator(`.controls__section[data-tool="${tool}"] [role=tab][data-tab="${tab}"]`).click()
          await page.waitForSelector(`.controls__panel[data-sub="${tab}"]`)
          if (tool === 'ink' && tab === 'over') {
            // Every state of Over photo: the strip comes and goes with them.
            const over = page.locator('.controls__panel[data-sub="over"]')
            for (const mode of ['off', 'second', 'backing']) {
              await over.locator(`input[type=radio][value="${mode}"]`).check({ force: true })
              await record(`${tool}-${tab}-${mode}`)
              if (mode === 'second') {
                // Keep this ink: no Switch point (O-4), the strip gives way to a row.
                await over.locator('[data-ink-button]').first().click()
                await page.locator('dialog[open] input[type=radio][value="keep"]').check({ force: true })
                await page.locator('dialog[open] .dialog__actions .btn').click()
                await page.waitForSelector('dialog[open]', { state: 'detached' })
                await record(`${tool}-${tab}-keep`)
              }
            }
            await over.locator('input[type=radio][value="second"]').check({ force: true })
            continue
          }
          await record(`${tool}-${tab}`)
          if (tool === 'type' && tab === 'size' && vw === 320) {
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
        }
      }
      await closeTools(page)

      const first = states[0]
      for (const s of states) {
        const same = s.sheet && first.sheet && s.sheet.every((v, i) => Math.abs(v - first.sheet[i]) <= 1)
        check(same, `${where}: the sheet moved in ${s.name}: ${JSON.stringify(s.sheet)} against ${JSON.stringify(first.sheet)} in ${first.name}`)
        check(s.overflow <= 0.5, `${where}: the panel overflows by ${s.overflow} px in ${s.name}`)
        check(s.sideways <= 0, `${where}: the page scrolls sideways by ${s.sideways} px in ${s.name}`)
      }
      check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
      console.log(`${where}: ${states.length} states, sheet ${JSON.stringify(first.sheet)}${failures.length ? '' : ', all the same'}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await new Promise((r) => server.httpServer.close(r))
}

if (failures.length) {
  console.error(`\n${failures.length} geometry check(s) failed.`)
  process.exit(1)
}
console.log('\nGeometry: the sheet holds still across every tool and tab, and no panel overflows.')
