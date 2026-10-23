/**
 * How long an export takes, and how much the browser holds while it runs —
 * in desktop Chromium, so INFORMATIONAL: V8 frees short-lived buffers far
 * more eagerly than an iPhone's JavaScriptCore, which is why the hard gate is
 * measure-alloc.mjs's deterministic count and, on a phone, DEVICE-CHECKLIST.
 *
 *   node scripts/measure-export.mjs           (cases 1-5 of export-cases.mjs)
 *   node scripts/measure-export.mjs 1 3
 *
 * Each case runs the real Save path (savePrint, JPEG) in a fresh browser, the
 * document and its photo prepared first; resident memory is summed over the
 * browser's process tree every 50 ms, and the peak over the press is reported
 * as a delta over the moment before it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { exportCases } from './export-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

const server = await createServer({ configFile: join(here, 'harness/vite.harness.config.ts'), server: { port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/harness.html`
const load = (p) => server.ssrLoadModule(resolve(root, p))
const { defaultSettings, makeLayer, makeMedia } = await load('src/state/defaults.ts')
const { contrastPartner } = await load('src/engine/inks.ts')
const CASES = exportCases({ defaultSettings, makeLayer, makeMedia, contrastPartner })

/** Resident memory of a process and all its descendants, in MB. */
function treeRss(pid) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const kids = new Map()
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p])
  const rss = new Map(rows.map(([p, , r]) => [p, r]))
  let total = 0
  const stack = [pid]
  while (stack.length) {
    const p = stack.pop()
    total += rss.get(p) ?? 0
    stack.push(...(kids.get(p) ?? []))
  }
  return total / 1024
}

const only = process.argv.slice(2).map(Number).filter(Boolean)
try {
  for (const c of CASES.filter((k) => only.length === 0 || only.includes(k.id))) {
    const browserServer = await chromium.launchServer({ executablePath, args: ['--js-flags=--max-old-space-size=8000'] })
    const pid = browserServer.process().pid
    const browser = await chromium.connect(browserServer.wsEndpoint())
    try {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      await page.goto(url)
      await page.waitForFunction(() => window.H !== undefined, null, { timeout: 30_000 })
      await page.evaluate((doc) => window.H.prepare(doc), c.doc())
      await new Promise((r) => setTimeout(r, 500))
      const before = treeRss(pid)
      let peak = before
      const poll = setInterval(() => (peak = Math.max(peak, treeRss(pid))), 50)
      const r = await page.evaluate(() => window.H.press('jpeg'))
      clearInterval(poll)
      if (errors.length) throw new Error(errors.join(' | '))
      const mp = (r.w * r.h) / 1e6
      console.log(
        `case ${c.id}: ${c.name}\n  ${r.w}x${r.h} (${mp.toFixed(1)} MP): ${(r.ms / 1000).toFixed(1)} s (${(r.ms / mp).toFixed(0)} ms/MP), ` +
          `peak RSS +${(peak - before).toFixed(0)} MB (${((peak - before) / mp).toFixed(0)} B/px), file ${(r.bytes / 1e6).toFixed(2)} MB`,
      )
    } finally {
      await browser.close()
      await browserServer.close()
    }
  }
} finally {
  await server.close()
}
