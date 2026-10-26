/**
 * The streaming JPEG encoder, read back byte by byte: a baseline 4:4:4 file
 * with the standard tables, the same bytes however its rows arrive, and a DCT
 * that is the textbook transform (scaled as the quantisation expects). That
 * it decodes, and how close, is measured in a browser: scripts/check-encode.mjs.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { CHROMA_QUANT, JPEG_MAX_EDGE, JpegEncoder, LUMA_QUANT, fdct8, qualityScaling, quantTable } from './jpeg.ts'
import { mulberry32 } from '../rng.ts'

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42,
  49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

/**
 * ITU-T T.81 Annex K, typed here from the standard rather than imported from
 * the encoder, so that a slip in the encoder's tables (or here) shows.
 * Tables K.1 (luminance) and K.2 (chrominance) quantisation, natural order.
 */
const T81_K1 = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]
const T81_K2 = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array<number>(32).fill(99),
]
const hex = (s: string) => s.trim().split(/\s+/).map((v) => parseInt(v, 16))
/** Tables K.3 to K.6: BITS (how many codes of each length 1..16), then
 *  HUFFVAL, as the DHT segment carries them (class and id first). */
const T81_K3_K6: [number, number[], number[]][] = [
  [0x00, hex('00 01 05 01 01 01 01 01 01 00 00 00 00 00 00 00'), hex('00 01 02 03 04 05 06 07 08 09 0a 0b')],
  [
    0x10,
    hex('00 02 01 03 03 02 04 03 05 05 04 04 00 00 01 7d'),
    hex(`
      01 02 03 00 04 11 05 12 21 31 41 06 13 51 61 07 22 71 14 32 81 91 a1 08
      23 42 b1 c1 15 52 d1 f0 24 33 62 72 82 09 0a 16 17 18 19 1a 25 26 27 28
      29 2a 34 35 36 37 38 39 3a 43 44 45 46 47 48 49 4a 53 54 55 56 57 58 59
      5a 63 64 65 66 67 68 69 6a 73 74 75 76 77 78 79 7a 83 84 85 86 87 88 89
      8a 92 93 94 95 96 97 98 99 9a a2 a3 a4 a5 a6 a7 a8 a9 aa b2 b3 b4 b5 b6
      b7 b8 b9 ba c2 c3 c4 c5 c6 c7 c8 c9 ca d2 d3 d4 d5 d6 d7 d8 d9 da e1 e2
      e3 e4 e5 e6 e7 e8 e9 ea f1 f2 f3 f4 f5 f6 f7 f8 f9 fa`),
  ],
  [0x01, hex('00 03 01 01 01 01 01 01 01 01 01 00 00 00 00 00'), hex('00 01 02 03 04 05 06 07 08 09 0a 0b')],
  [
    0x11,
    hex('00 02 01 02 04 04 03 04 07 05 04 04 00 01 02 77'),
    hex(`
      00 01 02 03 11 04 05 21 31 06 12 41 51 07 61 71 13 22 32 81 08 14 42 91
      a1 b1 c1 09 23 33 52 f0 15 62 72 d1 0a 16 24 34 e1 25 f1 17 18 19 1a 26
      27 28 29 2a 35 36 37 38 39 3a 43 44 45 46 47 48 49 4a 53 54 55 56 57 58
      59 5a 63 64 65 66 67 68 69 6a 73 74 75 76 77 78 79 7a 82 83 84 85 86 87
      88 89 8a 92 93 94 95 96 97 98 99 9a a2 a3 a4 a5 a6 a7 a8 a9 aa b2 b3 b4
      b5 b6 b7 b8 b9 ba c2 c3 c4 c5 c6 c7 c8 c9 ca d2 d3 d4 d5 d6 d7 d8 d9 da
      e2 e3 e4 e5 e6 e7 e8 e9 ea f2 f3 f4 f5 f6 f7 f8 f9 fa`),
  ],
]

/** libjpeg's scaling of a base table at a quality (jcparam.c
 *  jpeg_quality_scaling and jpeg_add_quant_table, force_baseline), written
 *  out again here. */
const scaled = (base: number[], q: number) => {
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))
}

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
    expect(LUMA_QUANT).toEqual(T81_K1)
    expect(CHROMA_QUANT).toEqual(T81_K2)
    // libjpeg's quality 95 luma table starts 2, 1, 1, 2, 2, 4, 5, 6.
    expect(quantTable(LUMA_QUANT, 95).slice(0, 8)).toEqual([2, 1, 1, 2, 2, 4, 5, 6])
    expect(qualityScaling(95)).toBe(10)
    expect(qualityScaling(30)).toBe(166) // 5000 / 30, integer division
    expect(qualityScaling(100)).toBe(0)
    expect(quantTable(LUMA_QUANT, 100).every((v) => v === 1)).toBe(true)
    for (const q of [10, 30, 50, 90, 95]) {
      const { segments } = parse(encode(image.gradient(16, 16), 16, 16, q))
      const [dq0, dq1] = [segments[1].data, segments[2].data]
      expect(dq0[0]).toBe(0)
      expect(dq1[0]).toBe(1)
      expect(Array.from(dq0.subarray(1))).toEqual(ZIGZAG.map((k) => scaled(T81_K1, q)[k]))
      expect(Array.from(dq1.subarray(1))).toEqual(ZIGZAG.map((k) => scaled(T81_K2, q)[k]))
    }
  })

  it('its Huffman tables are the standard ones (Annex K.3 to K.6)', () => {
    const { segments } = parse(encode(image.gradient(16, 16), 16, 16))
    const dht = segments.filter((s) => s.marker === 0xc4).map((s) => s.data)
    expect(dht.length).toBe(4)
    dht.forEach((d, k) => {
      const [id, bits, vals] = T81_K3_K6[k]
      expect(d[0]).toBe(id)
      expect(Array.from(d.subarray(1, 17))).toEqual(bits)
      expect(Array.from(d.subarray(17))).toEqual(vals)
      // Every code length is accounted for.
      expect(bits.reduce((a, b) => a + b, 0)).toBe(vals.length)
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
      // A plain Error, never a RangeError: Save reads that as memory.
      expect(() => new JpegEncoder(w, h, 95, () => {})).toThrow(/is not a size a JPEG can hold/)
      expect(() => new JpegEncoder(w, h, 95, () => {})).not.toThrow(RangeError)
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

describe('the licence that travels with the encoder', () => {
  it('the site ships the acknowledgement and the IJG README unaltered (public/licences.txt)', async () => {
    const { readFileSync } = await import('node:fs')
    const readme = readFileSync(new URL('./IJG-README.txt', import.meta.url), 'utf8')
    const shipped = readFileSync(new URL('../../../public/licences.txt', import.meta.url), 'utf8')
    expect(shipped).toContain('This software is based in part on the work of the Independent JPEG Group.')
    expect(shipped.endsWith(readme)).toBe(true)
  })
})
