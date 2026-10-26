/**
 * Does Save keep every pixel of the photo? Exits 1 if any gate fails.
 *
 *   node scripts/measure-fidelity.mjs
 *
 * In Chromium, through the REAL import (`importMedia`, IndexedDB), the REAL
 * decode for Save and the REAL `savePrint` (scripts/harness/fidelity.ts), with
 * the type off and the paper veil off so the print IS the photo. Each print
 * is compared with the part of the original the sheet shows, drawn at its own
 * pixels (an integer offset at scale 1):
 *
 *  - native prints: the file is the plan's size, the Laplacian energy (the
 *    finest detail, which any resampling takes down) is >= 0.98 of the
 *    original's, the luminance correlation >= 0.999, and the stored photo is
 *    the picked file byte for byte, and Save's caption gives no reason. A
 *    12 MP zone plate on its own sheet and on 4:5; a 6000x4500 one on 4:5
 *    (above the old 4096 cap: native, 3600x4500); a 24 MP iPhone-sized
 *    5712x4284 one on 4:5 (native, 3427x4284) and on its own sheet (native,
 *    5712x4284: no ceiling); a
 *    2268x4032 one zoomed to 113% on its own sheet (native, 2008x3569, a tall
 *    sheet whose width binds). Two controls prove the gate can fail: the same
 *    photo drawn half a pixel off its grid, and from a 2048 px copy (the old
 *    import), must both fall below it.
 *  - a JPEG whose EXIF says rotate 90 saves upright; a PNG's transparent hole
 *    prints as paper, never black; a document whose stored photo is gone is
 *    refused, never printed on bare paper.
 *  - the same print at every size: the default document (and its type at 20%
 *    and 40%) at h and 2h, corr(box2(render(2h)), render(h)) >= SCALE[doc]
 *    from the 1800 px reference height up (scripts/harness/harness.ts).
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

const LAPLACIAN = 0.98
const CORRELATION = 0.999
// Per document. Type at 20% has a halftone lattice under 4 px at 1800, so a
// point-sampled raster aliases it and the two heights can only agree so far;
// how far depends on the glyphs, i.e. on the machine's installed fonts. It
// measured 0.9706 here and 0.9644 on the CI runner's Chrome. 0.95 still fails
// the defect this gate exists for: a quantity held in pixels, which put the
// same document at 0.7735 before 2.5.
const SCALE = { default: 0.97, 'small-2': 0.95, 'small-4': 0.97 }

const server = await createServer({ configFile: join(here, 'harness/vite.harness.config.ts'), server: { port: 0 } })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ executablePath, args: ['--js-flags=--max-old-space-size=8000'] })

const failures = []
const gate = (ok, what) => {
  if (!ok) failures.push(what)
  return ok ? 'ok' : 'FAIL'
}
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v))

async function page(path, global) {
  const p = await browser.newPage()
  p.on('pageerror', (e) => failures.push(`page error: ${e.message}`))
  await p.goto(`${base}/${path}`)
  await p.waitForFunction((g) => window[g] !== undefined, global, { timeout: 60_000 })
  return p
}

try {
  const p = await page('fidelity.html', 'F')

  console.log('Native prints: the photo pixel for pixel (Laplacian ratio >= 0.98, correlation >= 0.999)')
  for (const [w, h, aspect, plan, zoom = 1] of [
    [4032, 3024, 'original', '4032x3024'],
    [4032, 3024, '4:5', '2419x3024'],
    [6000, 4500, '4:5', '3600x4500'],
    [5712, 4284, '4:5', '3427x4284'],
    [5712, 4284, 'original', '5712x4284'],
    // A tall photo cropped by zooming on its own sheet: the width binds, and
    // the native height lands over 1:1 by more than 1.5 px over the height.
    [2268, 4032, 'original', '2008x3569', 1.13],
  ]) {
    const r = await p.evaluate(([w, h, a, z]) => window.F.zone(w, h, a, 'png', z), [w, h, aspect, zoom])
    const name = `${r.photo} on ${aspect}${zoom !== 1 ? ` at ${Math.round(zoom * 100)}%` : ''}`
    const size = `${r.plan.width}x${r.plan.height}`
    console.log(
      `  ${name.padEnd(30)} -> ${size} ${r.plan.limit}, file ${r.file}: Laplacian ${f4(r.lapRatio)} ${gate(r.lapRatio >= LAPLACIAN, `${name}: Laplacian ${r.lapRatio}`)}, ` +
        `corr ${f4(r.corr)} ${gate(r.corr >= CORRELATION, `${name}: correlation ${r.corr}`)}, largest difference ${r.maxDiff}/255; ` +
        `stored byte for byte ${gate(r.stored.byteForByte, `${name}: not stored byte for byte`)} (${(r.stored.fileBytes / 1e6).toFixed(1)} MB, ${r.stored.layer}); ${(r.ms / 1000).toFixed(1)} s`,
    )
    gate(size === plan && r.plan.limit === 'native', `${name}: planned ${size} ${r.plan.limit}, not ${plan} native`)
    gate(r.dimsMatch, `${name}: the file is ${r.file}, not the plan's ${size}`)
    gate(r.aligned, `${name}: the photo is not drawn at its own pixels`)
    gate(r.caption.reason === null, `${name}: the caption gives a reason (${r.caption.reason}) for a native print`)
  }

  {
    const c = await p.evaluate(() => window.F.controls())
    for (const [name, r] of [
      ['half a pixel off (control)', c.halfPixel],
      ['from a 2048 copy (control)', c.oldImport],
    ]) {
      const fails = r.lapRatio < LAPLACIAN || r.corr < CORRELATION
      console.log(`  ${name.padEnd(28)} Laplacian ${f4(r.lapRatio)}, corr ${f4(r.corr)}: below the gate ${gate(fails, `${name} passes the gate: it cannot fail`)}`)
    }
  }

  console.log('\nOrientation, transparency, a missing photo')
  {
    const o = await p.evaluate(() => window.F.orientation())
    const upright = o.topQuarter.r > 150 && o.topQuarter.b < 80 && o.bottomQuarter.b > 150 && o.bottomQuarter.r < 80
    console.log(
      `  EXIF orientation 6, stored 2400x1800 -> layer ${o.stored.layer}, file ${o.file}: top quarter rgb(${o.topQuarter.r},_,${o.topQuarter.b}), ` +
        `bottom rgb(${o.bottomQuarter.r},_,${o.bottomQuarter.b}): upright ${gate(upright && o.stored.layer === '1800x2400' && o.file === '1800x2400', 'orientation: not upright')}` +
        `; byte for byte ${gate(o.stored.byteForByte, 'orientation: not stored byte for byte')}`,
    )
    const a = await p.evaluate(() => window.F.pngAlpha())
    const paper = a.hole.minLuma > 150
    console.log(
      `  PNG with a transparent hole, ${a.stored.layer} -> ${a.file}: hole mean luma ${a.hole.meanLuma}, min ${a.hole.minLuma} over ${a.hole.pixels} px: ` +
        `paper ${gate(paper, `PNG alpha: the hole prints dark (min luma ${a.hole.minLuma})`)}; the rest: corr ${f4(a.corrOpaque)} ` +
        `${gate(a.corrOpaque >= CORRELATION, `PNG alpha: correlation ${a.corrOpaque}`)}; byte for byte ${gate(a.stored.byteForByte, 'PNG: not stored byte for byte')}`,
    )
    const m = await p.evaluate(() => window.F.missingPhoto())
    console.log(
      `  stored photo deleted: Save's decode refuses ${gate(m.decodeRefused, 'missing photo: decode did not refuse')}, savePrint refuses ` +
        `${gate(m.saveRefused && !m.canvasTouched, 'missing photo: savePrint pressed something')} ("${m.message}"), nothing pressed`,
    )
  }
  await p.close()

  console.log('\nThe same print at every size: corr(box2(render(2h)), render(h)) >= the floor per document')
  {
    const h = await page('harness.html', 'H')
    for (const doc of ['default', 'small-2', 'small-4']) {
      const r = await h.evaluate((d) => window.H.scaleCorrelation(d, 1800), doc)
      console.log(`  ${doc.padEnd(8)} at 1800 against 3600: corr ${f4(r.corr)} (floor ${SCALE[doc]}) ${gate(r.corr >= SCALE[doc], `${doc}: scale correlation ${r.corr}`)}`)
    }
    await h.close()
  }
} finally {
  await browser.close()
  await server.close()
}

if (failures.length) {
  console.log(`\nFAILED:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nAll gates pass.')
