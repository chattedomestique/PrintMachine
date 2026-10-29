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
 *    sheet whose width binds); a 40 MP 7728x5152 one on its own sheet, on 4:5
 *    and (with FULL=1) on 1:1 (7728x5152, 4122x5152, 5152x5152) and a 61 MP
 *    9504x6336 one on 4:5 (5069x6336), each saved again as Save's JPEG, which
 *    must be a baseline frame (SOF0) of the plan's size with every component
 *    sampled 1x1 (4:4:4). Two controls prove the gate can fail: the same
 *    photo drawn half a pixel off its grid, and from a 2048 px copy (the old
 *    import), must both fall below it.
 *  - framed (the photo's pixels inside a frame): the 40 MP 7728x5152 zone
 *    plate on its own sheet with the first photo's frame, round, in the
 *    photo's colour (9016x6440, also as Save's JPEG: SOF0, 4:4:4); a 3000x2000
 *    one in Fit on 4:5, round (the matte above and below); and that one's
 *    smaller copy at 60%, decoded at its contained rectangle. Inside the
 *    photo's rectangle, outside the corners, every byte is the photo Save
 *    drew (the original, or the copy), Laplacian 1.0000; every pixel of the
 *    frame and the matte is the fill; each corner pixel is the photo over the
 *    fill at the corner's exact coverage, rounded once; Fit's contained
 *    rectangle is the photo's shape to under a pixel. And case 16: a 40 MP
 *    one fading out over a smooth colour gradient, in Frosted at Blur 240
 *    (its field made as Save makes it, from the stored file): the field is
 *    float (under 1% of its values on a whole level: a field rounded to
 *    bytes before it is stretched fails); every pixel of the frame is the
 *    field sampled there exactly, in float64 by the harness's own code, and
 *    rounded once (a sampler that rounds before it has mixed fails); along
 *    the middle row of the left border no run of one value is longer than
 *    the field's own, rounded once, plus one (printed: at 58 MP the field
 *    moves under a level across the 644 px border, so this run cannot tell
 *    a rounded field from a float one; the two checks before it can); and
 *    it presses in at most 1.25x the time of the same photo in a palette
 *    colour, pressed just before it.
 *  - a JPEG whose EXIF says rotate 90 saves upright; a PNG's transparent hole
 *    prints as paper, never black; a document whose stored photo is gone is
 *    refused, never printed on bare paper.
 *  - the same print at every size: the default document (and its type at 20%
 *    and 40%) at h and 2h, corr(box2(render(2h)), render(h)) >= SCALE[doc]
 *    from the 1800 px reference height up (scripts/harness/harness.ts).
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places. The
 * page holds a 61 MP photo, its output and the reference at once (about
 * 1.2 GB of typed arrays at the 61 MP row), so Chromium's heap is raised.
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
/** Case 16, Frosted at Blur 240 on the 40 MP photo: its press may take at
 *  most this many times the same photo's print in a palette colour, pressed
 *  just before it. One sample each, so a few percent of the machine's drift
 *  is in the ratio (interleaved, the two measured 1.00x); the bound is there
 *  for a sampler gone wrong, not to time the frame. */
const FROSTED_TIME = 1.25
/** And at most this share of its field's values on a whole level: a field
 *  kept in float has next to none (measured 4e-6), one rounded to bytes
 *  before it is stretched, all of them. */
const FROSTED_WHOLE = 0.01
const FROSTED = '40 MP Original, round, Frosted 240'
const FROSTED_BASE = '40 MP Original, round, Photo, sky'
const CORRELATION = 0.999
// Per document. Type at 20% has a halftone lattice under 4 px at 1800, so a
// point-sampled raster aliases it and the two heights can only agree so far;
// how far depends on the glyphs. Every document here is set in Poster, the
// bundled Tanklager Kompakt, so the glyphs are the same on every machine: it
// measured 0.9712 (in each machine's fallback face, before the face was
// bundled, 0.9706 here and 0.9644 on the CI runner's Chrome). 0.95 is kept
// with room for the browser's own text rasteriser, and still fails the defect
// this gate exists for: a quantity held in pixels, which put the same
// document at 0.7735 before 2.5.
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
  const rows = [
    [4032, 3024, 'original', '4032x3024'],
    [4032, 3024, '4:5', '2419x3024'],
    [6000, 4500, '4:5', '3600x4500'],
    [5712, 4284, '4:5', '3427x4284'],
    [5712, 4284, 'original', '5712x4284'],
    // A tall photo cropped by zooming on its own sheet: the width binds, and
    // the native height lands over 1:1 by more than 1.5 px over the height.
    [2268, 4032, 'original', '2008x3569', 1.13],
    // 40 and 61 MP, each saved twice: as a PNG, compared pixel for pixel,
    // and as Save's JPEG, its size and sampling read from its header. The
    // 1:1 crop runs with FULL=1 (the CI budget).
    [7728, 5152, 'original', '7728x5152', 1, true],
    [7728, 5152, '4:5', '4122x5152', 1, true],
    ...(process.env.FULL === '1' ? [[7728, 5152, '1:1', '5152x5152', 1, true]] : []),
    [9504, 6336, '4:5', '5069x6336', 1, true],
  ]
  for (const [w, h, aspect, plan, zoom = 1, jpeg = false] of rows) {
    const t = Date.now()
    const r = await p.evaluate(([w, h, a, z, j]) => window.F.zone(w, h, a, 'png', z, j), [w, h, aspect, zoom, jpeg])
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
    if (jpeg) {
      const j = r.jpeg
      console.log(
        `  ${''.padEnd(30)}    and as a JPEG: ${j.marker} ${j.file}, sampling ${j.sampling} ` +
          `${gate(j.marker === 'SOF0' && j.file === size && j.sampling === '11 11 11', `${name}: the JPEG is ${j.marker} ${j.file} sampling ${j.sampling}, not SOF0 ${size} 11 11 11`)} ` +
          `(${(j.bytes / 1e6).toFixed(1)} MB in ${(j.ms / 1000).toFixed(1)} s; the row ${((Date.now() - t) / 1000).toFixed(0)} s in all)`,
      )
    }
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

  console.log('\nFramed: the photo inside its frame at its own pixels, every byte; the frame its fill; the corners on the photo')
  {
    const round = { width: 1 / 14, corners: 1 }
    const rows = [
      // The 40 MP photo on its own sheet with the first photo's frame, the
      // photo's own colour, round: the default a photo is framed with.
      ['40 MP Original, round, Photo', 7728, 5152, 'original', { ...round, fill: 'photo' }, { jpeg: true }, '9016x6440', 'native'],
      // Fit of a landscape photo on 4:5, round: the matte above and below,
      // the corners on the photo, not on the frame.
      ['Fit 4:5, round, Muted', 3000, 2000, '4:5', { ...round, fill: 'muted', mode: 'fit' }, {}, '3652x4565', 'native'],
      // Its smaller copy (60% of the height): decoded at its contained
      // rectangle and drawn 1:1, never stretched.
      ['Fit 4:5, a smaller copy at 60%', 3000, 2000, '4:5', { ...round, fill: 'muted', mode: 'fit' }, { smaller: 0.6 }, '2191x2739', 'smaller'],
      // Case 16: a 40 MP photo in Frosted at its heaviest blur, the veil
      // off: 18 MP of border sampled from the field. The zone plate fades
      // out over a smooth colour gradient (a grey zone plate frosts to one
      // flat grey, where no stair could show). Pressed just after the same
      // photo in a palette colour, the base of its time.
      [FROSTED_BASE, 7728, 5152, 'original', { ...round, fill: 'photo' }, { sky: true }, '9016x6440', 'native'],
      [FROSTED, 7728, 5152, 'original', { ...round, fill: 'frosted', blur: 240 }, { sky: true }, '9016x6440', 'native'],
    ]
    const timed = {}
    for (const [name, w, h, aspect, frame, opts, size, limit] of rows) {
      const t = Date.now()
      const r = await p.evaluate(([w, h, a, f, o]) => window.F.framed(w, h, a, f, o), [w, h, aspect, frame, opts])
      const planned = `${r.plan.width}x${r.plan.height}`
      console.log(
        `  ${name.padEnd(32)} ${r.photo} -> ${planned} ${r.plan.limit} (${r.plan.border} px frame), file ${r.file}; the photo ${r.drawn}, shown ${r.shown}, radius ${r.radius.toFixed(2)}`,
      )
      gate(planned === size && r.plan.limit === limit, `${name}: planned ${planned} ${r.plan.limit}, not ${size} ${limit}`)
      gate(r.dimsMatch, `${name}: the file is ${r.file}, not the plan's ${planned}`)
      console.log(
        `  ${''.padEnd(32)} drawn at its own pixels ${gate(r.aligned, `${name}: the photo is not drawn at its own pixels`)}; ` +
          `the photo's rectangle outside the corners: ${r.photoRect.pixels} px, ${r.photoRect.differ} differ, largest difference ${r.photoRect.maxDiff}/255 ` +
          `${gate(r.photoRect.pixels > 0 && r.photoRect.differ === 0, `${name}: ${r.photoRect.differ} pixels of the photo differ (largest ${r.photoRect.maxDiff})`)}, ` +
          `Laplacian ${f4(r.lapRatio)} ${gate(r.lapRatio >= LAPLACIAN, `${name}: Laplacian ${r.lapRatio}`)}`,
      )
      console.log(
        `  ${''.padEnd(32)} the frame${frame.mode === 'fit' ? ' and the matte' : ''}: ${r.border.pixels} px, ${r.border.notFill} not the fill ` +
          `${gate(r.border.pixels > 0 && r.border.notFill === 0, `${name}: ${r.border.notFill} pixels of the frame are not the fill`)}; ` +
          `the corners on the photo: ${r.corners.pixels} px within ${r.corners.maxDev.toFixed(3)} of the exact coverage ` +
          `${gate(r.corners.pixels > 0 && r.corners.maxDev <= 0.5 + 1e-6, `${name}: a corner pixel is ${r.corners.maxDev} off its exact coverage`)}` +
          (frame.mode === 'fit' ? `; the photo's shape held to ${r.aspectError.toFixed(3)} px ${gate(r.aspectError < 1, `${name}: the photo's shape is off by ${r.aspectError} px`)}` : '') +
          `; ${(r.ms / 1000).toFixed(1)} s`,
      )
      timed[name] = r.ms
      if (r.banding) {
        const b = r.banding
        const ok = b.print.every((run, c) => run <= b.field[c] + 1)
        console.log(
          `  ${''.padEnd(32)} the field Save pressed: ${(b.whole * 100).toPrecision(2)}% of its values on a whole level ` +
            `${gate(b.whole < FROSTED_WHOLE, `${name}: ${(b.whole * 100).toFixed(1)}% of the field is on whole levels: it was rounded before it was stretched`)} (bound ${FROSTED_WHOLE * 100}%); ` +
            `banding along row ${b.row}, the left border's ${b.pixels} px: longest run of one value ${b.print.join(' / ')} (R / G / B), ` +
            `the field's own, rounded once, ${b.field.join(' / ')} ${gate(ok, `${name}: a run of ${b.print.join('/')} where the field gives ${b.field.join('/')}: the frost is stepped`)}`,
        )
        const base = timed[FROSTED_BASE]
        const ratio = r.ms / base
        console.log(
          `  ${''.padEnd(32)} pressed in ${(r.ms / 1000).toFixed(1)} s against ${(base / 1000).toFixed(1)} s for the same photo in a palette colour: ${ratio.toFixed(3)}x ` +
            `${gate(ratio <= FROSTED_TIME, `${name}: ${ratio.toFixed(3)}x the time of the same photo in a palette colour (bound ${FROSTED_TIME})`)} (bound ${FROSTED_TIME}); its field made in ${(r.inputsMs / 1000).toFixed(2)} s`,
        )
      }
      if (r.jpeg) {
        const j = r.jpeg
        console.log(
          `  ${''.padEnd(32)} and as a JPEG: ${j.marker} ${j.file}, sampling ${j.sampling} ` +
            `${gate(j.marker === 'SOF0' && j.file === planned && j.sampling === '11 11 11', `${name}: the JPEG is ${j.marker} ${j.file} sampling ${j.sampling}, not SOF0 ${planned} 11 11 11`)} ` +
            `(${(j.bytes / 1e6).toFixed(1)} MB in ${(j.ms / 1000).toFixed(1)} s; the row ${((Date.now() - t) / 1000).toFixed(0)} s in all)`,
        )
      }
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
