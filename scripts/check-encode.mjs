/**
 * The save's own encoders, decoded by a browser. Exits 1 if any bound fails;
 * prints every number either way, so a drift is visible before it fails.
 *
 *   node scripts/check-encode.mjs
 *
 * In Chromium, through the render harness's page (scripts/harness), the JPEG
 * encoder (src/engine/encode/jpeg.ts) at quality 95, its file decoded with
 * createImageBitmap and compared with the pixels it was given:
 *
 *  (a) a smooth gradient: RMSE <= 1.0;
 *  (b) a 1023x771 saturated halftone (pink dots on paper, not a multiple of
 *      8 either way): RMSE <= 4.2 and the largest error <= 32; against
 *      Chromium's own JPEG at 0.95 on the same pixels (it stores the colour
 *      at half resolution, 4:2:0, and smears the dots' edges): an RMSE at
 *      most a third of its, and a largest error at most half of its;
 *  (c) a real print, the harness's photo-second-ink at 1000 px: RMSE <= 2.6
 *      and the largest error <= 45;
 *  and every file's frame header says three components at 1x1 (4:4:4).
 *
 * And the PNG encoder (src/engine/encode/png.ts) on the halftone and the
 * real print, compressed and stored, its rows pushed in bands of 150 as a band
 * loop pushes them (each band fills several batches, filled again once
 * Chromium's CompressionStream has taken them): decoded, the input exactly
 * (the gate);
 * its size beside Chromium's own PNG of the same pixels is printed, never
 * gated (looked into only above 1.5 times).
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
  cacheDir: join(tmpdir(), `printmachine-encode-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`),
  server: { port: 0, strictPort: false },
})
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/harness.html`
const browser = await chromium.launch({ executablePath })
const t0 = Date.now()
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url)
  await page.waitForFunction(() => window.H !== undefined, null, { timeout: 30_000 })

  const fmt = (r) => `RMSE ${r.rmse.toFixed(2)}, largest error ${r.max}`
  const run = (kind) => page.evaluate((k) => window.H.encodeCheck(k), kind)

  console.log('JPEG, quality 95')
  const gradient = await run('gradient')
  console.log(`  gradient ${gradient.w}x${gradient.h}: ${fmt(gradient)}, ${gradient.bytes} bytes, ${gradient.msPerMP} ms/MP`)
  check(gradient.rmse <= 1.0, `(a) a smooth gradient: ${fmt(gradient)} (RMSE <= 1.0)`)

  const halftone = await run('halftone')
  console.log(`  halftone ${halftone.w}x${halftone.h}: ${fmt(halftone)}, ${halftone.bytes} bytes; Chromium's own at 0.95 (sampling ${halftone.chromium.sampling}): ${fmt(halftone.chromium)}, ${halftone.chromium.bytes} bytes`)
  check(halftone.rmse <= 4.2 && halftone.max <= 32, `(b) the saturated halftone: ${fmt(halftone)} (RMSE <= 4.2, largest <= 32)`)
  check(
    halftone.rmse * 3 <= halftone.chromium.rmse && halftone.max * 2 <= halftone.chromium.max,
    `(b) against Chromium's 4:2:0: RMSE ${halftone.rmse.toFixed(2)} x 3 <= ${halftone.chromium.rmse.toFixed(2)}, largest ${halftone.max} x 2 <= ${halftone.chromium.max}`,
  )

  const print = await run('print')
  console.log(`  print ${print.w}x${print.h}: ${fmt(print)}, ${print.bytes} bytes; Chromium's own at 0.95: ${fmt(print.chromium)}, ${print.chromium.bytes} bytes`)
  check(print.rmse <= 2.6 && print.max <= 45, `(c) a real print: ${fmt(print)} (RMSE <= 2.6, largest <= 45)`)

  for (const r of [gradient, halftone, print]) check(r.sampling === '11 11 11', `${r.kind}: SOF0 sampling ${r.sampling} (4:4:4)`)

  console.log('PNG')
  for (const kind of ['halftone', 'print']) {
    const r = await page.evaluate((k) => window.H.pngCheck(k), kind)
    const ratio = r.deflate.bytes / r.chromiumBytes
    console.log(
      `  ${kind} ${r.w}x${r.h}: ${r.deflate.bytes} bytes in ${r.deflate.ms} ms (Chromium's own PNG ${r.chromiumBytes}: x${ratio.toFixed(2)}${ratio > 1.5 ? ', over 1.5: look into the filter choice' : ''}); stored ${r.stored.bytes} bytes`,
    )
    check(r.deflate.max === 0, `${kind}: the PNG decodes to the input exactly (largest error ${r.deflate.max})`)
    check(r.stored.max === 0, `${kind}: the stored PNG (no CompressionStream) decodes to the input exactly (largest error ${r.stored.max})`)
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  await server.close()
}

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : 'all checks passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
process.exit(failures.length ? 1 : 0)
