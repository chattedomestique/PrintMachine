// Generates the PWA icon set. The mark is two overprinting halftone circles —
// Fluorescent Pink over Blue, multiplying to purple where they cross — which is
// literally what this app does, drawn with the same subtractive math as
// src/engine/composite.ts. Run: node scripts/gen-icons.mjs
//
// Hand-rolled PNG encoder so the build has no image dependency (playbook §14:
// don't add heavy dependencies for what ~30 lines of code covers).

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/* ── minimal PNG encoder ──────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** @param {Uint8Array} rgba packed RGBA, length w*h*4 */
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10,11,12 = compression, filter, interlace = 0

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    const src = y * w * 4
    const dst = y * (w * 4 + 1)
    raw[dst] = 0
    rgba.subarray ? raw.set(rgba.subarray(src, src + w * 4), dst + 1) : null
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ── the mark ─────────────────────────────────────────────────────────── */

const PAPER = [242, 239, 230]
const PINK = [255, 72, 176] // RISO FLUORESCENTPINK
const BLUE = [0, 120, 191] // RISO BLUE

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Smooth 0→1 ramp across `edge` units either side of 0. */
const smooth = (d, edge) => {
  const t = clamp01(0.5 - d / (2 * edge))
  return t * t * (3 - 2 * t)
}

/**
 * Angled dot screen. Returns 0..1 ink coverage for a requested tone at (x,y).
 * Same idea as engine/screen.ts: rotate into screen space, measure distance to
 * the nearest cell centre, and grow the dot with the tone.
 */
function screen(x, y, tone, angleDeg, pitch) {
  if (tone <= 0) return 0
  const a = (angleDeg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const rx = x * cos - y * sin
  const ry = x * sin + y * cos
  const cx = Math.round(rx / pitch) * pitch
  const cy = Math.round(ry / pitch) * pitch
  const d = Math.hypot(rx - cx, ry - cy)
  // Dot radius grows with sqrt(tone) so area is linear in tone.
  const r = Math.sqrt(tone) * pitch * 0.72
  return smooth(d - r, pitch * 0.14)
}

/** Signed distance to a circle, negative inside. */
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

function renderIcon(size, { maskable }) {
  const rgba = new Uint8Array(size * size * 4)

  // `any` fills its box; `maskable` keeps the mark inside the 80% safe circle.
  const inset = maskable ? size * 0.19 : size * 0.11
  const box = size - inset * 2
  const pitch = Math.max(2.2, box * 0.052)

  // Two overlapping circles, offset like a mis-registered two-colour print.
  const r = box * 0.3
  const pinkC = [inset + box * 0.385, inset + box * 0.4]
  const blueC = [inset + box * 0.615, inset + box * 0.6]

  // Rounded-square paper card. Maskable bleeds to the edge instead.
  const cardR = size * 0.22
  const cardInset = maskable ? 0 : size * 0.02

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5

      // Paper alpha (rounded rect SDF).
      let paperA = 1
      if (!maskable) {
        const qx = Math.abs(px - size / 2) - (size / 2 - cardInset - cardR)
        const qy = Math.abs(py - size / 2) - (size / 2 - cardInset - cardR)
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cardR
        paperA = smooth(d, 1.2)
      }

      // Ink coverage per layer: solid inside the circle, screened at the edge
      // so the dots read at small sizes.
      const pinkTone = smooth(sdCircle(px, py, pinkC[0], pinkC[1], r), box * 0.16)
      const blueTone = smooth(sdCircle(px, py, blueC[0], blueC[1], r), box * 0.16)

      const pinkCov = screen(px, py, pinkTone * 0.94, 15, pitch)
      const blueCov = screen(px, py, blueTone * 0.94, 75, pitch)

      // Subtractive overprint — the same model as engine/composite.ts.
      let cr = PAPER[0] / 255
      let cg = PAPER[1] / 255
      let cb = PAPER[2] / 255
      for (const [cov, ink] of [
        [blueCov, BLUE],
        [pinkCov, PINK],
      ]) {
        cr *= 1 - cov * (1 - ink[0] / 255)
        cg *= 1 - cov * (1 - ink[1] / 255)
        cb *= 1 - cov * (1 - ink[2] / 255)
      }

      const i = (y * size + x) * 4
      rgba[i] = Math.round(cr * 255)
      rgba[i + 1] = Math.round(cg * 255)
      rgba[i + 2] = Math.round(cb * 255)
      rgba[i + 3] = Math.round(paperA * 255)
    }
  }

  return encodePNG(rgba, size, size)
}

/* ── write ────────────────────────────────────────────────────────────── */

mkdirSync(OUT, { recursive: true })

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-192.png', 192, true],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false], // PNG, not SVG — iOS ignores SVG (§3.3)
]

for (const [name, size, maskable] of targets) {
  const png = renderIcon(size, { maskable })
  writeFileSync(join(OUT, name), png)
  console.log(`${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`)
}

// favicon.svg — a flat two-colour reduction of the same mark for the browser tab.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#F2EFE6"/>
  <g style="mix-blend-mode:multiply">
    <circle cx="40" cy="42" r="26" fill="#0078BF"/>
    <circle cx="60" cy="58" r="26" fill="#FF48B0"/>
  </g>
</svg>
`
writeFileSync(join(OUT, 'favicon.svg'), favicon)
console.log('favicon.svg')
