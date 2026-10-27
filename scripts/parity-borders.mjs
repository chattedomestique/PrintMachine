/**
 * The frame against Border Studio's own: Print Machine's engine renders the
 * frozen parity cases (scripts/parity-borders/: Border Studio 597ce7a's
 * frame, captured once) and is compared with them under stated bounds.
 * Exits 1 if any is broken. CI runs it in the verify job, after
 * check-bands (deploy.yml).
 *
 *   node scripts/parity-borders.mjs     (npm run check:parity-borders)
 *
 * Each case is rendered in Chromium through the render harness's page
 * (scripts/harness, `H.parityBorders`) by the EXPORT entry (renderPrintAsync,
 * what Save presses): the block photo Border Studio framed (photos.mjs, the
 * same pixels), the document carrying the hex Border Studio keyed from it as
 * its palette (so this tests the frame's geometry and compositing; the
 * palette's port is tested on the recorded sample), the case's frame (its
 * width as recorded), the paper veil off and one plate with no text, so the
 * sheet is the ground alone, at the reference's height.
 *
 * All six cases: (1) free + Photo, (2) free + corners 100 + Deep, (3) free +
 * Frosted at Blur 60, (4) free + Frosted at Blur 240, (5) Fit 4:5 + Muted,
 * (6) Fit 9:16 + corners 50 + Comp. Free is Print Machine's Original sheet;
 * Fit a fixed sheet in Fit. Frosted's field is made as the app makes it:
 * the block photo's bytes (a PNG) through the app's frame source (decoded at
 * its fixed size, read back), then the field at the save's size.
 *
 * What is compared, with the reference's own rectangle for the photo
 * (`shown`) and its corner radius:
 *  - the sheet: the engine's is the reference's size, within 1 px a side;
 *  - the border and, in Fit, the matte (every pixel outside the photo): the
 *    mean absolute error per channel and the largest; and the engine's matte
 *    is the fill's hex exactly. Frosted's border: the mean and the 99th
 *    percentile of every channel's difference (the field is twice as fine as
 *    Border Studio's 240 px one and kept in float where Border Studio rounds
 *    every pass, so the two frosts differ by a level or two);
 *  - the photo inside the frame, away from the corners: in the free cases,
 *    where both apps draw it at its own pixels, every byte equal; in Fit,
 *    where each app resamples it its own way (Border Studio's canvas at 'low'
 *    smoothing, the engine at 'high'), only the flat squares at the photo's
 *    corners are compared (every byte), the rest is masked;
 *  - each corner's patch (ceil(radius) square): the mean absolute error, and
 *    how many pixels' coverage (read back from the colour, between the
 *    photo's flat corner and the fill) differs by more than a quarter: the
 *    reference is a canvas's antialiased clip, the engine's the exact area.
 *
 * The bounds (BOUNDS below) are the measured numbers x 1.25, each lower than
 * the plan's first figure; the script prints what it measures.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { CORNER, PHOTOS, blockPhoto } from './parity-borders/photos.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const refsDir = join(here, 'parity-borders')
const refs = JSON.parse(readFileSync(join(refsDir, 'refs.json'), 'utf8'))
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

/** The cases this gate renders (refs.json ids). */
const CASES = ['free-photo', 'free-corners-deep', 'free-frosted-60', 'free-frosted-240', 'fit-4x5-muted', 'fit-9x16-corners-comp']

/**
 * The bounds, in levels of 0..255 unless said. The plan's first figures
 * were: the sheet within 1 px; border and matte mean <= 1.5 and max <= 6;
 * a corner patch's mean <= 4, and its coverage off by more than a quarter
 * in under 1% of its pixels. Each is pinned at what was measured x 1.25,
 * which is lower in every case (Chromium 141, the frame's first commit):
 *  - the sheet: the reference's size exactly in all four cases;
 *  - border and matte: every byte equal in all four (mean 0, max 0);
 *  - corners: mean 0.24 to 0.27 (case 2, radius 150) and 0.62 to 0.81
 *    (case 6, radius 29.7), so <= 1.02; coverage off by more than a quarter
 *    at 0 to 12 pixels of a patch, 0.222% at most, so < 0.28%.
 * The engine's own pixels here are exact arithmetic on flat colour (the
 * resampled interior of Fit is masked), so they do not move with the
 * browser; the references are frozen.
 * Frosted (cases 3 and 4) was first put at a mean of 4 and a 99th
 * percentile of 12; it measured a mean of 0.48 and 0.49, a 99th percentile
 * of 3 and 2 (largest 5 and 3), so it is held to <= 0.62 and <= 3.75. A
 * radius not scaled with the field, the grade's brightness left out, the
 * 2% overscan left out or the box passes clamped at the edges instead of
 * shrunk each fail it (mean 2.6 to 19).
 */
const FROST_MEAN = 0.62
const FROST_P99 = 3.75
const BOUNDS = {
  sheetPx: 0,
  borderMean: 0,
  borderMax: 0,
  cornerMean: 1.02,
  cornerOff: 0.0028,
  frostMean: FROST_MEAN,
  frostP99: FROST_P99,
}

const failures = []
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const b64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))

/**
 * The pixels of [x0, x1) x [y0, y1) that `keep(x, y)` takes, the engine's
 * against the reference's: the mean absolute error per channel, the largest,
 * how many differ at all, and, given a colour, how many of the engine's are
 * not it.
 */
function compare(pm, ref, pmW, refW, [x0, y0, x1, y1], keep = () => true, colour = null) {
  let sum = 0
  let max = 0
  let n = 0
  let differ = 0
  let notColour = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!keep(x, y)) continue
      const p = (y * pmW + x) * 4
      const r = (y * refW + x) * 4
      let d = 0
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(pm[p + c] - ref[r + c])
        sum += e
        d = Math.max(d, e)
      }
      if (colour && (pm[p] !== colour[0] || pm[p + 1] !== colour[1] || pm[p + 2] !== colour[2])) notColour++
      if (d) differ++
      max = Math.max(max, d)
      n++
    }
  }
  return { mean: n ? sum / (3 * n) : 0, max, differ, n, notColour }
}

const server = await createServer({
  configFile: join(here, 'harness/vite.harness.config.ts'),
  cacheDir: join(tmpdir(), `printmachine-parity-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`),
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
  await page.waitForFunction(() => window.H !== undefined, null, { timeout: 60_000 })
  console.log(`Border Studio ${refs.borders_sha.slice(0, 7)}'s frame against the engine's (bounds: ${JSON.stringify(BOUNDS)})`)

  for (const id of CASES) {
    const k = refs.cases.find((c) => c.id === id)
    const photo = refs.photos.find((p) => p.id === k.photo)
    const gen = PHOTOS.find((p) => p.id === k.photo)
    const { px, corner } = blockPhoto(gen.width, gen.height, gen.blocks)
    if (corner !== photo.corner) throw new Error(`${id}: the generated photo is not the one captured (corner ${corner}, not ${photo.corner})`)
    const r = await page.evaluate((c) => window.H.parityBorders(c), {
      aspect: k.print_machine.aspect,
      frame: k.print_machine.frame,
      photo: { width: gen.width, height: gen.height, rgba: b64(px), palette: photo.hex },
      height: k.sheet.height,
      ref: readFileSync(join(refsDir, k.png)).toString('base64'),
    })
    const pm = unb64(r.pm)
    const ref = unb64(r.ref)
    console.log(`\n${id}: engine ${r.w}x${r.h}, reference ${r.refW}x${r.refH} (${k.width_fraction} border, ${k.print_machine.frame.fill}${k.radius ? `, radius ${k.radius}` : ''})`)
    if (r.refW !== k.sheet.width || r.refH !== k.sheet.height) throw new Error(`${id}: the reference decodes to ${r.refW}x${r.refH}, not the recorded ${k.sheet.width}x${k.sheet.height}`)
    check(Math.abs(r.w - r.refW) <= BOUNDS.sheetPx && Math.abs(r.h - r.refH) <= BOUNDS.sheetPx, `sheet ${r.w}x${r.h} against ${r.refW}x${r.refH} (within ${BOUNDS.sheetPx} px)`)
    // Compared over the sheet both have.
    const w = Math.min(r.w, r.refW)
    const h = Math.min(r.h, r.refH)
    const s = k.shown
    const inShown = (x, y) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
    const patch = Math.ceil(k.radius)
    const inPatch = (x, y) => patch > 0 && inShown(x, y) && (x < s.x + patch || x >= s.x + s.w - patch) && (y < s.y + patch || y >= s.y + s.h - patch)
    const frosted = k.print_machine.frame.fill === 'frosted'
    const fill = frosted ? null : hexRgb(photo.hex[k.print_machine.frame.fill])

    // The border, and in Fit the matte.
    const fit = k.print_machine.frame.mode === 'fit'
    if (frosted) {
      // Frosted: the photo blurred and graded, from a field twice as fine
      // as Border Studio's, in float where it rounds every pass: the mean
      // and the 99th percentile of every channel's difference.
      const diffs = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (inShown(x, y)) continue
          const p = (y * r.w + x) * 4
          const q = (y * r.refW + x) * 4
          for (let c = 0; c < 3; c++) diffs.push(Math.abs(pm[p + c] - ref[q + c]))
        }
      }
      diffs.sort((a, b) => a - b)
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
      const p99 = diffs[Math.floor(0.99 * (diffs.length - 1))]
      check(mean <= BOUNDS.frostMean && p99 <= BOUNDS.frostP99, `Frosted border: ${diffs.length / 3} px, mean ${mean.toFixed(4)} (<= ${BOUNDS.frostMean}), 99th percentile ${p99} (<= ${BOUNDS.frostP99}), max ${diffs[diffs.length - 1]}`)
    } else {
      const border = compare(pm, ref, r.w, r.refW, [0, 0, w, h], (x, y) => !inShown(x, y), fill)
      check(border.mean <= BOUNDS.borderMean && border.max <= BOUNDS.borderMax, `border${fit ? ' and matte' : ''}: ${border.n} px, mean ${border.mean.toFixed(4)} (<= ${BOUNDS.borderMean}), max ${border.max} (<= ${BOUNDS.borderMax}), ${border.differ} differ`)
      check(border.notColour === 0, `the engine's ${fit ? 'border and matte are' : 'border is'} the fill ${photo.hex[k.print_machine.frame.fill]} exactly (${border.notColour} pixels are not)`)
    }

    // The photo, away from the corners.
    if (!fit) {
      const c = compare(pm, ref, r.w, r.refW, [s.x, s.y, s.x + s.w, s.y + s.h], (x, y) => !inPatch(x, y))
      check(c.differ === 0, `the photo at its own pixels, outside the corners: ${c.n} px, ${c.differ} differ (max ${c.max}): every byte equal`)
    } else {
      // Only the flat squares at the photo's corners: the rest is resampled
      // by each app its own way. Two pixels in from where the square ends,
      // so a resampled edge is never in it.
      const side = Math.floor((photo.corner * s.w) / gen.width) - 2
      const parts = [[s.x, s.y], [s.x + s.w - side, s.y], [s.x, s.y + s.h - side], [s.x + s.w - side, s.y + s.h - side]].map(([x0, y0]) =>
        compare(pm, ref, r.w, r.refW, [x0, y0, x0 + side, y0 + side], (x, y) => !inPatch(x, y)),
      )
      const c = { n: parts.reduce((a, q) => a + q.n, 0), differ: parts.reduce((a, q) => a + q.differ, 0), max: Math.max(...parts.map((q) => q.max)) }
      check(c.differ === 0, `the photo's flat corner squares (${side} px a side, outside the corner patches; the resampled rest masked): ${c.n} px, ${c.differ} differ (max ${c.max}): every byte equal`)
    }

    // The corners.
    if (patch > 0) {
      const P = CORNER
      const ch = [0, 1, 2].reduce((a, b) => (Math.abs(P[b] - fill[b]) > Math.abs(P[a] - fill[a]) ? b : a), 0)
      const coverage = (v) => (v - fill[ch]) / (P[ch] - fill[ch])
      for (const [name, x0, y0] of [['top left', s.x, s.y], ['top right', s.x + s.w - patch, s.y], ['bottom left', s.x, s.y + s.h - patch], ['bottom right', s.x + s.w - patch, s.y + s.h - patch]]) {
        const c = compare(pm, ref, r.w, r.refW, [x0, y0, x0 + patch, y0 + patch])
        let off = 0
        let partial = 0
        for (let y = y0; y < y0 + patch; y++) {
          for (let x = x0; x < x0 + patch; x++) {
            const a = coverage(pm[(y * r.w + x) * 4 + ch])
            const b = coverage(ref[(y * r.refW + x) * 4 + ch])
            if (a > 0.02 && a < 0.98) partial++
            if (Math.abs(a - b) > 0.25) off++
          }
        }
        check(
          c.mean <= BOUNDS.cornerMean && off / c.n < BOUNDS.cornerOff,
          `corner ${name} (${patch} px square, ${partial} pixels partly covered): mean ${c.mean.toFixed(4)} (<= ${BOUNDS.cornerMean}), max ${c.max}; coverage off by more than 25% at ${off} px, ${((100 * off) / c.n).toFixed(3)}% (< ${(100 * BOUNDS.cornerOff).toFixed(2)}%)`,
        )
      }
    }
  }
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
} finally {
  await browser.close()
  await server.close()
}

console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s`)
if (failures.length) {
  console.log(`\nFAILED:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('All checks pass.')
