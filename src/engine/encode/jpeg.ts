/**
 * A streaming baseline JPEG encoder: rows in, 4:4:4 JPEG chunks out, never a
 * sheet-sized buffer.
 *
 * Why it exists: a browser canvas encodes JPEG only from a whole canvas, and
 * below quality 1.0 Chromium stores the colour at half resolution each way
 * (4:2:0), which smears a saturated halftone's dots. This keeps every
 * pixel's colour (three components, every sampling factor 1x1) and takes the
 * print a band of rows at a time, so a 40 MP save never needs a 40 MP canvas.
 *
 * Baseline (SOF0), 8 bits, a JFIF APP0 segment, the standard quantisation
 * and Huffman tables of ITU-T T.81 Annex K scaled by quality, no restart
 * intervals, no EXIF (the pixels are upright) and no ICC profile (untagged is
 * read as sRGB, which is what the canvas held).
 *
 * Provenance. Written from ITU-T T.81; the Annex K tables below are the
 * standard's data. `fdct8` is the Independent JPEG Group's jfdctflt.c
 * `jpeg_fdct_float` (libjpeg 9f) translated to TypeScript: the same
 * statements, in float64; the scale table `AAN` is jcdctmgr.c's
 * `aanscalefactor`; the quality scaling is jcparam.c's
 * `jpeg_quality_scaling`. Changed from the originals: the samples are fed as
 * floats already level-shifted (the colour conversion keeps its fractions
 * where libjpeg rounds to 8-bit samples first), so the DC term's
 * `- 8 * CENTERJSAMPLE` of jfdctflt.c is the conversion's `- 128`; the
 * reciprocal table folds the AAN scale and the 8 of jcdctmgr.c's
 * `forward_DCT_float` exactly as it does. This software is based in part on
 * the work of the Independent JPEG Group (its README, with its copyright and
 * no-warranty notice unaltered, is IJG-README.txt beside this file). The
 * DCT's algorithm is Arai, Agui and Nakajima's (Trans. IEICE E-71(11):1095),
 * as in Pennebaker and Mitchell's JPEG book, figure 4-8.
 */

/** The largest width or height a JPEG frame header can carry. */
export const JPEG_MAX_EDGE = 65535

/** Zig-zag order: the n-th coefficient sent is ZIGZAG[n] in natural order. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42,
  49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

/** T.81 Table K.1: luminance quantisation, natural order. */
export const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18,
  22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]

/** T.81 Table K.2: chrominance quantisation, natural order. */
export const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
]

/** T.81 Tables K.3 to K.6: the standard Huffman tables, as BITS (codes of
 *  each length 1..16) and HUFFVAL. */
export const HUFFMAN = {
  dcLuma: {
    bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
  dcChroma: {
    bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
  acLuma: {
    bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    vals: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91,
      0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a,
      0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53,
      0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
      0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
      0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
      0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2,
      0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    ],
  },
  acChroma: {
    bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    vals: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14,
      0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17,
      0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
      0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
      0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
      0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
      0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2,
      0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    ],
  },
} as const

/** jcdctmgr.c's aanscalefactor: cos(k pi / 16) x sqrt(2), and 1 for k = 0. */
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379]

/** jcparam.c's jpeg_quality_scaling: the percentage a base table is scaled
 *  by for a quality of 1..100 (5000 / q below 50, integer division; 200 - 2q
 *  from 50). */
export function qualityScaling(quality: number): number {
  const q = Math.max(1, Math.min(100, Math.round(quality)))
  return q < 50 ? Math.floor(5000 / q) : 200 - 2 * q
}

/** A base table at a quality, as jpeg_add_quant_table makes it with
 *  force_baseline: (v x scale + 50) / 100, integer division, in 1..255. */
export function quantTable(base: readonly number[], quality: number): number[] {
  const scale = qualityScaling(quality)
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))))
}

interface Huffman {
  code: Uint16Array
  size: Uint8Array
}

/** The code and its length for every symbol of a BITS/HUFFVAL table (T.81
 *  Annex C). */
function huffman(t: { bits: readonly number[]; vals: readonly number[] }): Huffman {
  const code = new Uint16Array(256)
  const size = new Uint8Array(256)
  let c = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < t.bits[len - 1]; i++) {
      code[t.vals[k]] = c
      size[t.vals[k]] = len
      c++
      k++
    }
    c <<= 1
  }
  return { code, size }
}

const DC_LUMA = huffman(HUFFMAN.dcLuma)
const AC_LUMA = huffman(HUFFMAN.acLuma)
const DC_CHROMA = huffman(HUFFMAN.dcChroma)
const AC_CHROMA = huffman(HUFFMAN.acChroma)

/**
 * One 1-D pass of jfdctflt.c's jpeg_fdct_float over 8 values of `d`, from
 * offset `o`, `s` apart: the AAN forward DCT, its outputs scaled (the scale
 * is folded into the quantisation).
 */
function fdct1(d: Float64Array, o: number, s: number): void {
  const tmp0 = d[o] + d[o + 7 * s]
  const tmp7 = d[o] - d[o + 7 * s]
  const tmp1 = d[o + s] + d[o + 6 * s]
  const tmp6 = d[o + s] - d[o + 6 * s]
  const tmp2 = d[o + 2 * s] + d[o + 5 * s]
  const tmp5 = d[o + 2 * s] - d[o + 5 * s]
  const tmp3 = d[o + 3 * s] + d[o + 4 * s]
  const tmp4 = d[o + 3 * s] - d[o + 4 * s]

  // Even part.
  let tmp10 = tmp0 + tmp3
  const tmp13 = tmp0 - tmp3
  let tmp11 = tmp1 + tmp2
  let tmp12 = tmp1 - tmp2
  d[o] = tmp10 + tmp11
  d[o + 4 * s] = tmp10 - tmp11
  const z1 = (tmp12 + tmp13) * 0.707106781 // c4
  d[o + 2 * s] = tmp13 + z1
  d[o + 6 * s] = tmp13 - z1

  // Odd part.
  tmp10 = tmp4 + tmp5
  tmp11 = tmp5 + tmp6
  tmp12 = tmp6 + tmp7
  // The rotator is modified from fig 4-8 to avoid extra negations.
  const z5 = (tmp10 - tmp12) * 0.382683433 // c6
  const z2 = 0.5411961 * tmp10 + z5 // c2-c6
  const z4 = 1.306562965 * tmp12 + z5 // c2+c6
  const z3 = tmp11 * 0.707106781 // c4
  const z11 = tmp7 + z3
  const z13 = tmp7 - z3
  d[o + 5 * s] = z13 + z2
  d[o + 3 * s] = z13 - z2
  d[o + s] = z11 + z4
  d[o + 7 * s] = z11 - z4
}

/** The 8x8 forward DCT of `d` in place: rows, then columns. */
export function fdct8(d: Float64Array): void {
  for (let i = 0; i < 8; i++) fdct1(d, i * 8, 1)
  for (let i = 0; i < 8; i++) fdct1(d, i, 8)
}

/**
 * Rows of RGBA in, a baseline 4:4:4 JPEG out in chunks.
 *
 *   const chunks: Uint8Array[] = []
 *   const jpeg = new JpegEncoder(w, h, 95, (c) => chunks.push(c))
 *   jpeg.push(band, rows) // as often as needed, top to bottom
 *   jpeg.finish()
 *   new Blob(chunks, { type: 'image/jpeg' })
 *
 * It holds one strip of 8 rows (three planes of floats, the width rounded up
 * to 8) and one chunk of output. Rows may come in any groups: the bytes are
 * the same however they are pushed.
 */
export class JpegEncoder {
  private readonly w: number
  private readonly h: number
  private readonly onChunk: (chunk: Uint8Array) => void
  private readonly chunkSize: number
  private readonly mcuCols: number
  /** Y, Cb, Cr of the strip being filled, level-shifted, mcuCols x 8 wide. */
  private readonly strip: [Float32Array, Float32Array, Float32Array]
  private stripRows = 0
  private rows = 0
  /** 1 / (quantiser x the AAN scale x 8), natural order, luma and chroma. */
  private readonly recipLuma = new Float64Array(64)
  private readonly recipChroma = new Float64Array(64)
  private readonly qLuma: number[]
  private readonly qChroma: number[]
  private readonly block = new Float64Array(64)
  private readonly coef = new Int32Array(64)
  private readonly pred = [0, 0, 0]
  private out: Uint8Array
  private n = 0
  private bits = 0
  private nbits = 0
  private done = false

  constructor(width: number, height: number, quality: number, onChunk: (chunk: Uint8Array) => void, chunkSize = 1 << 18) {
    if (!(width >= 1 && height >= 1 && width <= JPEG_MAX_EDGE && height <= JPEG_MAX_EDGE) || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new RangeError(`JPEG: ${width}x${height} is not a size a JPEG can hold (1 to ${JPEG_MAX_EDGE} a side)`)
    }
    this.w = width
    this.h = height
    this.onChunk = onChunk
    this.chunkSize = Math.max(64, chunkSize)
    this.out = new Uint8Array(this.chunkSize)
    this.mcuCols = Math.ceil(width / 8)
    const stripLength = this.mcuCols * 64
    this.strip = [new Float32Array(stripLength), new Float32Array(stripLength), new Float32Array(stripLength)]
    this.qLuma = quantTable(LUMA_QUANT, quality)
    this.qChroma = quantTable(CHROMA_QUANT, quality)
    for (let v = 0; v < 8; v++) {
      for (let u = 0; u < 8; u++) {
        const i = v * 8 + u
        const scale = AAN[v] * AAN[u] * 8
        this.recipLuma[i] = 1 / (this.qLuma[i] * scale)
        this.recipChroma[i] = 1 / (this.qChroma[i] * scale)
      }
    }
    this.header()
  }

  /** `count` rows of RGBA (alpha ignored), row after row from the top, at
   *  rgba[0]. They are consumed before this returns: the buffer may be
   *  reused at once. */
  push(rgba: Uint8Array | Uint8ClampedArray, count: number): void {
    if (this.done) throw new Error('JPEG: rows pushed after finish')
    if (this.rows + count > this.h) throw new Error(`JPEG: ${this.rows + count} rows pushed for a height of ${this.h}`)
    const w = this.w
    const stride = this.mcuCols * 8
    const [Y, Cb, Cr] = this.strip
    for (let r = 0; r < count; r++) {
      const src = r * w * 4
      const d = this.stripRows * stride
      for (let x = 0; x < w; x++) {
        const o = src + x * 4
        const R = rgba[o]
        const G = rgba[o + 1]
        const B = rgba[o + 2]
        // libjpeg's full-range YCbCr (jccolor.c), level-shifted for the DCT.
        Y[d + x] = 0.299 * R + 0.587 * G + 0.114 * B - 128
        Cb[d + x] = -0.168736 * R - 0.331264 * G + 0.5 * B
        Cr[d + x] = 0.5 * R - 0.418688 * G - 0.081312 * B
      }
      // The last block column's missing pixels repeat the row's last pixel.
      for (let x = w; x < stride; x++) {
        Y[d + x] = Y[d + w - 1]
        Cb[d + x] = Cb[d + w - 1]
        Cr[d + x] = Cr[d + w - 1]
      }
      this.stripRows++
      this.rows++
      if (this.stripRows === 8) this.encodeStrip()
    }
  }

  /** Writes the end: a short last strip (its missing rows repeat its last
   *  row), the last byte's padding (1-bits) and EOI. Throws unless exactly
   *  `height` rows were pushed. */
  finish(): void {
    if (this.done) return
    if (this.rows !== this.h) throw new Error(`JPEG: ${this.rows} rows pushed for a height of ${this.h}`)
    if (this.stripRows > 0) this.encodeStrip()
    if (this.nbits > 0) this.put((1 << (8 - this.nbits)) - 1, 8 - this.nbits)
    this.marker(0xd9)
    this.flush()
    this.done = true
  }

  private encodeStrip(): void {
    const stride = this.mcuCols * 8
    if (this.stripRows < 8) {
      for (const plane of this.strip) {
        for (let r = this.stripRows; r < 8; r++) plane.copyWithin(r * stride, (this.stripRows - 1) * stride, this.stripRows * stride)
      }
    }
    // Interleaved, one MCU a block of each component (every factor 1x1).
    for (let m = 0; m < this.mcuCols; m++) {
      this.encodeBlock(this.strip[0], m * 8, stride, 0)
      this.encodeBlock(this.strip[1], m * 8, stride, 1)
      this.encodeBlock(this.strip[2], m * 8, stride, 2)
    }
    this.stripRows = 0
  }

  private encodeBlock(src: Float32Array, x0: number, stride: number, component: number): void {
    const b = this.block
    for (let y = 0; y < 8; y++) {
      const row = y * stride + x0
      for (let x = 0; x < 8; x++) b[y * 8 + x] = src[row + x]
    }
    fdct8(b)
    const recip = component === 0 ? this.recipLuma : this.recipChroma
    const q = this.coef
    for (let i = 0; i < 64; i++) q[i] = Math.round(b[i] * recip[i])
    const dc = component === 0 ? DC_LUMA : DC_CHROMA
    const ac = component === 0 ? AC_LUMA : AC_CHROMA
    const diff = q[0] - this.pred[component]
    this.pred[component] = q[0]
    this.symbol(dc, 0, diff)
    let run = 0
    for (let k = 1; k < 64; k++) {
      const v = q[ZIGZAG[k]]
      if (v === 0) {
        run++
        continue
      }
      // ZRL: sixteen zeros at a time.
      while (run > 15) {
        this.put(ac.code[0xf0], ac.size[0xf0])
        run -= 16
      }
      this.symbol(ac, run, v)
      run = 0
    }
    // EOB.
    if (run > 0) this.put(ac.code[0x00], ac.size[0x00])
  }

  /** A value's Huffman symbol (its run of zeros before it, and its size
   *  category) and then its bits (T.81 F.1.2). */
  private symbol(t: Huffman, run: number, v: number): void {
    let a = v < 0 ? -v : v
    let size = 0
    while (a) {
      size++
      a >>= 1
    }
    const sym = (run << 4) | size
    this.put(t.code[sym], t.size[sym])
    if (size) this.put(v < 0 ? v + (1 << size) - 1 : v, size)
  }

  /** Bits, most significant first, with 0xFF stuffed as FF 00. */
  private put(code: number, size: number): void {
    this.bits = (this.bits << size) | code
    this.nbits += size
    while (this.nbits >= 8) {
      const byte = (this.bits >> (this.nbits - 8)) & 0xff
      this.byte(byte)
      if (byte === 0xff) this.byte(0)
      this.nbits -= 8
    }
    this.bits &= (1 << this.nbits) - 1
  }

  private byte(b: number): void {
    if (this.n === this.out.length) {
      this.onChunk(this.out)
      this.out = new Uint8Array(this.chunkSize)
      this.n = 0
    }
    this.out[this.n++] = b
  }

  private flush(): void {
    if (this.n > 0) this.onChunk(this.out.slice(0, this.n))
    this.n = 0
  }

  private u16(v: number): void {
    this.byte(v >> 8)
    this.byte(v & 0xff)
  }

  private marker(m: number): void {
    this.byte(0xff)
    this.byte(m)
  }

  private header(): void {
    this.marker(0xd8) // SOI
    // APP0 JFIF 1.01, no density units, 1:1, no thumbnail.
    this.marker(0xe0)
    this.u16(16)
    for (const b of [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]) this.byte(b)
    // DQT: tables 0 (luma) and 1 (chroma), 8-bit, in zig-zag order.
    for (const [id, table] of [
      [0, this.qLuma],
      [1, this.qChroma],
    ] as const) {
      this.marker(0xdb)
      this.u16(67)
      this.byte(id)
      for (let k = 0; k < 64; k++) this.byte(table[ZIGZAG[k]])
    }
    // SOF0: 8-bit, the size, three components, each 1x1 (4:4:4); Y on
    // table 0, Cb and Cr on table 1.
    this.marker(0xc0)
    this.u16(17)
    this.byte(8)
    this.u16(this.h)
    this.u16(this.w)
    this.byte(3)
    for (let c = 0; c < 3; c++) {
      this.byte(c + 1)
      this.byte(0x11)
      this.byte(c === 0 ? 0 : 1)
    }
    // DHT: DC and AC, luma (0) and chroma (1).
    for (const [tc, th, t] of [
      [0, 0, HUFFMAN.dcLuma],
      [1, 0, HUFFMAN.acLuma],
      [0, 1, HUFFMAN.dcChroma],
      [1, 1, HUFFMAN.acChroma],
    ] as const) {
      this.marker(0xc4)
      this.u16(19 + t.vals.length)
      this.byte((tc << 4) | th)
      for (const b of t.bits) this.byte(b)
      for (const v of t.vals) this.byte(v)
    }
    // SOS: three components, Y with tables 0/0, Cb and Cr with 1/1; the
    // whole spectrum, no successive approximation.
    this.marker(0xda)
    this.u16(12)
    this.byte(3)
    for (let c = 0; c < 3; c++) {
      this.byte(c + 1)
      this.byte(c === 0 ? 0x00 : 0x11)
    }
    this.byte(0)
    this.byte(63)
    this.byte(0)
  }
}
