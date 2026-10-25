/**
 * The streaming JPEG encoder, read back byte by byte: a baseline 4:4:4 file
 * with the standard tables, the same bytes however its rows arrive, and a DCT
 * that is the textbook transform (scaled as the quantisation expects). That
 * it decodes, and how close, is measured in a browser: scripts/check-encode.mjs.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { CHROMA_QUANT, HUFFMAN, JPEG_MAX_EDGE, JpegEncoder, LUMA_QUANT, fdct8, qualityScaling, quantTable } from './jpeg.ts'
import { mulberry32 } from '../rng.ts'

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42,
  49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

/** Encode, pushing the rows in groups of the sizes given, in turn. */
function encode(rgba: Uint8ClampedArray, w: number, h: number, quality = 95, groups: number[] = [h], chunkSize?: number): Uint8Array {
  const chunks: Uint8Array[] = []
  const jpeg = new JpegEncoder(w, h, quality, (c) => chunks.push(c), chunkSize)
  let y = 0
  for (let k = 0; y < h; k++) {
    const n = Math.min(groups[k % groups.length], h - y)
    jpeg.push(rgba.subarray(y * w * 4, (y + n) * w * 4), n)
    y += n
  }
  jpeg.finish()
  const out = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/** The marker segments before the scan, and where the scan's data is. */
function parse(b: Uint8Array) {
  expect([b[0], b[1]]).toEqual([0xff, 0xd8])
  const segments: { marker: number; data: Uint8Array }[] = []
  let i = 2
  for (;;) {
    expect(b[i]).toBe(0xff)
    const marker = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    segments.push({ marker, data: b.subarray(i + 4, i + 2 + len) })
    i += 2 + len
    if (marker === 0xda) break
  }
  return { segments, scan: b.subarray(i, b.length - 2), end: [b[b.length - 2], b[b.length - 1]] }
}

const image = {
  gradient(w: number, h: number) {
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([(x * 255) / Math.max(1, w - 1), (y * 255) / Math.max(1, h - 1), 128, 255], (y * w + x) * 4)
    return d
  },
  noise(w: number, h: number, seed = 1) {
    const r = mulberry32(seed)
    const d = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(r() * 256)
    return d
  },
  /** A saturated halftone: pink dots on paper, the case 4:2:0 smears. */
  halftone(w: number, h: number) {
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x * 0.7071 + y * 0.7071) / 9
        const v = (x * 0.7071 - y * 0.7071) / 9
        const dot = Math.hypot(u - Math.round(u), v - Math.round(v)) < 0.35
        d.set(dot ? [255, 72, 176, 255] : [242, 239, 230, 255], (y * w + x) * 4)
      }
    }
    return d
  },
}

describe('the JPEG encoder: what the file says', () => {
  it('is a baseline JFIF with three components, every sampling factor 1x1 (4:4:4), its size in SOF0, ending in EOI', () => {
    const w = 123
    const h = 77
    const { segments, end } = parse(encode(image.noise(w, h), w, h))
    expect(segments.map((s) => s.marker)).toEqual([0xe0, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xda])
    expect(String.fromCharCode(...segments[0].data.subarray(0, 4))).toBe('JFIF')
    const sof = segments[3].data
    expect(sof[0]).toBe(8)
    expect((sof[1] << 8) | sof[2]).toBe(h)
    expect((sof[3] << 8) | sof[4]).toBe(w)
    expect(sof[5]).toBe(3)
    // Component id, sampling factors (H << 4 | V), quantisation table.
    expect(Array.from(sof.subarray(6, 15))).toEqual([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
    const sos = segments[8].data
    expect(Array.from(sos)).toEqual([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])
    expect(end).toEqual([0xff, 0xd9])
  })

  it('its quantisation tables are the Annex K tables scaled as libjpeg scales them, at 50, 90 and 95', () => {
    expect(quantTable(LUMA_QUANT, 50)).toEqual(LUMA_QUANT)
    expect(quantTable(CHROMA_QUANT, 50)).toEqual(CHROMA_QUANT)
    // libjpeg's quality 95 luma table starts 2, 1, 1, 2, 2, 4, 5, 6.
    expect(quantTable(LUMA_QUANT, 95).slice(0, 8)).toEqual([2, 1, 1, 2, 2, 4, 5, 6])
    expect(qualityScaling(95)).toBe(10)
    expect(qualityScaling(30)).toBe(166) // 5000 / 30, integer division
    expect(qualityScaling(100)).toBe(0)
    expect(quantTable(LUMA_QUANT, 100).every((v) => v === 1)).toBe(true)
    for (const q of [50, 90, 95]) {
      const { segments } = parse(encode(image.gradient(16, 16), 16, 16, q))
      const [dq0, dq1] = [segments[1].data, segments[2].data]
      expect(dq0[0]).toBe(0)
      expect(dq1[0]).toBe(1)
      expect(Array.from(dq0.subarray(1))).toEqual(ZIGZAG.map((k) => quantTable(LUMA_QUANT, q)[k]))
      expect(Array.from(dq1.subarray(1))).toEqual(ZIGZAG.map((k) => quantTable(CHROMA_QUANT, q)[k]))
    }
  })

  it('its Huffman tables are the standard ones (Annex K.3)', () => {
    const { segments } = parse(encode(image.gradient(16, 16), 16, 16))
    const dht = segments.filter((s) => s.marker === 0xc4).map((s) => s.data)
    const want = [
      [0x00, HUFFMAN.dcLuma],
      [0x10, HUFFMAN.acLuma],
      [0x01, HUFFMAN.dcChroma],
      [0x11, HUFFMAN.acChroma],
    ] as const
    dht.forEach((d, k) => {
      expect(d[0]).toBe(want[k][0])
      expect(Array.from(d.subarray(1, 17))).toEqual([...want[k][1].bits])
      expect(Array.from(d.subarray(17))).toEqual([...want[k][1].vals])
      // Every code length is accounted for.
      expect(want[k][1].bits.reduce((a: number, b: number) => a + b, 0)).toBe(want[k][1].vals.length)
    })
  })

  it('in the scan every 0xFF is stuffed (followed by 0x00): no marker inside the data', () => {
    for (const [w, h] of [
      [97, 61],
      [256, 64],
    ]) {
      const { scan } = parse(encode(image.noise(w, h, w), w, h, 100))
      for (let i = 0; i < scan.length; i++) if (scan[i] === 0xff) expect(scan[i + 1], `byte ${i}`).toBe(0)
    }
  })
})

describe('the JPEG encoder: streaming', () => {
  it('rows in groups of 1, 7, 8, 13 or 100 give the bytes of one push, and small chunks join to the same file', () => {
    const w = 123
    const h = 211
    const rgba = image.noise(w, h, 7)
    const whole = encode(rgba, w, h)
    for (const groups of [[1], [7], [8], [13], [100], [3, 11, 1, 29]]) expect(encode(rgba, w, h, 95, groups)).toEqual(whole)
    expect(encode(rgba, w, h, 95, [h], 64)).toEqual(whole)
  })

  it('any size from 1x1 to 1023 wide and 771 tall: the size it says, a whole file', () => {
    for (const w of [1, 7, 8, 9, 15, 17, 1023]) {
      for (const h of [1, 8, 9, 771]) {
        const bytes = encode(image.gradient(w, h), w, h)
        const { segments, end } = parse(bytes)
        const sof = segments[3].data
        expect([(sof[3] << 8) | sof[4], (sof[1] << 8) | sof[2]]).toEqual([w, h])
        expect(end).toEqual([0xff, 0xd9])
      }
    }
  })

  it('says so when the rows do not add up, or a JPEG cannot hold the size', () => {
    const j = new JpegEncoder(4, 4, 95, () => {})
    j.push(new Uint8ClampedArray(4 * 4 * 2), 2)
    expect(() => j.finish()).toThrow(/2 rows pushed for a height of 4/)
    expect(() => j.push(new Uint8ClampedArray(4 * 4 * 3), 3)).toThrow(/5 rows/)
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [JPEG_MAX_EDGE + 1, 1],
      [1, JPEG_MAX_EDGE + 1],
      [1.5, 2],
    ]) {
      expect(() => new JpegEncoder(w, h, 95, () => {})).toThrow(RangeError)
    }
  })

  it('the same bytes every run: three small images, pinned', () => {
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
    expect(sha(encode(image.gradient(16, 16), 16, 16))).toBe(GOLDEN.gradient)
    expect(sha(encode(image.noise(33, 17), 33, 17))).toBe(GOLDEN.noise)
    expect(sha(encode(image.halftone(64, 48), 64, 48))).toBe(GOLDEN.halftone)
  })
})

describe('the DCT', () => {
  it('is the textbook 8x8 DCT, each output scaled by 8 x the AAN factors of its row and column', () => {
    const r = mulberry32(3)
    const aan = (k: number) => (k === 0 ? 1 : Math.cos((k * Math.PI) / 16) * Math.SQRT2)
    for (let t = 0; t < 20; t++) {
      const f = Float64Array.from({ length: 64 }, () => r() * 255 - 128)
      const d = f.slice()
      fdct8(d)
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          let sum = 0
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += f[y * 8 + x] * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16)
          const F = 0.25 * (u === 0 ? Math.SQRT1_2 : 1) * (v === 0 ? Math.SQRT1_2 : 1) * sum
          expect(d[v * 8 + u]).toBeCloseTo(F * 8 * aan(u) * aan(v), 5)
        }
      }
    }
  })
})

/** Recorded when the encoder was written, once its files were shown to
 *  decode in Chromium within check-encode's bounds. A change here is a
 *  change to every saved JPEG. */
const GOLDEN = {
  gradient: '43c131b7d4a05f788ceeae320c4145b88e35c09d88a352f55f3e76d7d5a22dc0',
  noise: 'a14f3c2d47c9244a6cf87d85d4ecb52ef50d87eaddd770f181e6cff910470adb',
  halftone: 'bd286a35766172a2f095e402ecdf42aff800c936ec351fbe72c50cb6e206084a',
}
