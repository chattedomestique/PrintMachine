/**
 * A streaming PNG encoder: rows in, a lossless PNG out in chunks, never a
 * sheet-sized buffer. The lossless choice beside the JPEG: every pixel of the
 * print exactly, at the price of its size.
 *
 * RGB, 8 bits a channel (colour type 2), no alpha (the print is opaque), an
 * sRGB chunk (the canvas's pixels are sRGB). Each row is filtered with the
 * one of None, Sub, Up and Paeth whose bytes, read as signed, sum to the
 * least (libpng's heuristic), batched 64 rows at a time, and compressed by
 * the browser's own `CompressionStream('deflate')` (zlib, which is what IDAT
 * holds). Where there is none (Safari before 16.4) the image data is stored
 * uncompressed in deflate's stored blocks, unfiltered: a valid PNG of about 3
 * bytes a pixel (`storedSize`).
 *
 * What it allocates, so a 40 MP save makes no garbage the size of its pixels
 * (JavaScriptCore keeps short-lived buffers that V8 frees): the batches are a
 * pool, made at construction for the band height it is told (`bandRows`) and
 * each handed back to the pool when the compressor has taken it, never made
 * per batch; a compressed chunk is handed on as it came, between its IDAT
 * length-and-type and its CRC (no copy); a stored block is written once, in
 * place, into the IDAT chunk that is handed on. So once it is made, the only
 * arrays it makes are pieces of the file.
 *
 * "Taken" is the Compression Streams standard's: a CompressionStream is a
 * TransformStream whose transform compresses the chunk it is given, and a
 * write's promise resolves once that transform has run, so a batch whose
 * write has resolved has been read and may be filled again. Every browser's
 * is built so (Chromium's is checked by scripts/check-encode.mjs). Node's is
 * not: it can resolve a write before it has read the chunk. So the encoder
 * also checks what the compressor read: the zlib stream ends with the
 * Adler-32 of the bytes it compressed, and `finish` compares it with the
 * Adler-32 of the batches as they were handed over. On a compressor that
 * read a batch after it was filled again the file is refused (`finish`
 * throws), never written wrong.
 *
 * Written from ISO/IEC 15948 (PNG), RFC 1950 (zlib) and RFC 1951 (deflate's
 * stored blocks); no code is taken from anywhere else.
 *
 * The contract a band loop drives it by: `push` takes the rows before it
 * returns (the caller's buffer is free at once), `settled()` resolves once
 * the batches handed to the compressor are taken (await it between bands:
 * at most a band of rows is ever queued), `finish()` ends the file, `abort()`
 * stops it and leaves nothing pending.
 */

import { adler32, crc32 } from './crc32.ts'

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
/** Rows filtered into one batch for the compressor. */
const BATCH_ROWS = 64
/** The most a stored deflate block holds (RFC 1951 3.2.4). */
const STORED_BLOCK = 65535
/** The most one stored block's IDAT chunk takes: length and type, the zlib
 *  header (first block only), the block's header, its data, the Adler-32
 *  (last block only), the CRC. */
const STORED_CHUNK = 8 + 2 + 5 + STORED_BLOCK + 4 + 4
/** The largest width or height a PNG header can carry (2^31 - 1). */
export const PNG_MAX_EDGE = 0x7fffffff

/** Whether this engine compresses (`CompressionStream`); without it a PNG is
 *  stored, about 3 bytes a pixel. */
export const pngCompresses = (): boolean => typeof CompressionStream === 'function'

/** The exact size of a stored (uncompressed) PNG of w x h. */
export function storedSize(w: number, h: number): number {
  const raw = h * (1 + 3 * w)
  const blocks = Math.ceil(raw / STORED_BLOCK)
  const zlib = 2 + 5 * blocks + raw + 4
  return SIGNATURE.length + (12 + 13) + (12 + 1) + 12 * blocks + zlib + 12
}

const typeBytes = (t: string) => new Uint8Array([t.charCodeAt(0), t.charCodeAt(1), t.charCodeAt(2), t.charCodeAt(3)])
const IHDR = typeBytes('IHDR')
const SRGB = typeBytes('sRGB')
const IDAT = typeBytes('IDAT')
const IEND = typeBytes('IEND')
const IDAT_CRC = crc32(IDAT)
const NO_DATA = new Uint8Array(0)

/** A chunk: length, type, data, and the CRC-32 of type and data. */
function chunk(type: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(type, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(data, crc32(type)))
  return out
}

/** Paeth's predictor (ISO/IEC 15948 9.4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = p > a ? p - a : a - p
  const pb = p > b ? p - b : b - p
  const pc = p > c ? p - c : c - p
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A filtered byte's weight in libpng's heuristic: its value read as signed. */
const weight = (v: number) => (v < 128 ? v : 256 - v)

export class PngEncoder {
  private readonly w: number
  private readonly h: number
  private readonly onChunk: (chunk: Uint8Array) => void
  /** Bytes a filtered row takes: its filter type, then 3 a pixel. */
  private readonly rowBytes: number
  /** The previous row and this one, as RGB. */
  private prev: Uint8Array
  private cur: Uint8Array
  private rows = 0
  private done = false
  private aborted = false
  private failure: unknown = null

  // CompressionStream: the batch being filled, the batches free to fill, the
  // writer, the reader's pump.
  private readonly writer: WritableStreamDefaultWriter<BufferSource> | null = null
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readonly pump: Promise<void> = Promise.resolve()
  private pending: Promise<void> = Promise.resolve()
  private batch: Uint8Array<ArrayBuffer> | null = null
  private batchRows = 0
  private readonly free: Uint8Array<ArrayBuffer>[] = []
  /** The Adler-32 of the batches handed to the compressor, as they were
   *  handed; and the last four bytes it gave back (its stream's Adler-32,
   *  once it has ended). */
  private adlerIn = 1
  private tail = 0

  // Stored: the IDAT chunk being filled (its block's data from `blockAt`),
  // and the running Adler-32.
  private readonly stored: boolean
  private block: Uint8Array | null = null
  private blockAt = 0
  private blockN = 0
  private adler = 1
  private firstBlock = true

  /**
   * `opts.bandRows`: the most rows pushed between two `settled()` calls (the
   * band height a band loop pushes). The batches those rows can fill, with
   * the one a band may begin part-way through, are made here; pushing then
   * makes none. Without it one batch is made here, and more only if more rows
   * than that are pushed before `settled()`; every batch is kept and reused.
   */
  constructor(
    width: number,
    height: number,
    onChunk: (chunk: Uint8Array) => void,
    opts: { compression?: 'deflate' | 'stored'; bandRows?: number } = {},
  ) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= PNG_MAX_EDGE && height <= PNG_MAX_EDGE)) {
      throw new RangeError(`PNG: ${width}x${height} is not a size a PNG can hold`)
    }
    this.w = width
    this.h = height
    this.onChunk = onChunk
    this.rowBytes = 1 + 3 * width
    this.prev = new Uint8Array(3 * width)
    this.cur = new Uint8Array(3 * width)
    this.stored = opts.compression === 'stored' || !pngCompresses()

    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    ihdr.set([8, 2, 0, 0, 0], 8) // 8 bits, RGB, deflate, adaptive filtering, no interlace
    onChunk(SIGNATURE.slice())
    onChunk(chunk(IHDR, ihdr))
    onChunk(chunk(SRGB, new Uint8Array([0]))) // rendering intent: perceptual

    if (this.stored) {
      this.openBlock()
      return
    }
    // A band of B rows that begins with up to 63 rows already in the batch
    // being filled touches at most ceil((B + 63) / 64) batches.
    const rows = Math.max(1, Math.min(height, Math.floor(opts.bandRows ?? 1)))
    for (let i = Math.ceil((rows + BATCH_ROWS - 1) / BATCH_ROWS); i > 0; i--) this.free.push(new Uint8Array(BATCH_ROWS * this.rowBytes))
    const cs = new CompressionStream('deflate')
    this.writer = cs.writable.getWriter()
    this.reader = cs.readable.getReader()
    const reader = this.reader
    this.pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (let i = Math.max(0, value.length - 4); i < value.length; i++) this.tail = ((this.tail << 8) | value[i]) >>> 0
        if (!this.aborted && value.length > 0) this.emitIdat(value)
      }
    })()
    this.pump.catch((err) => {
      this.failure ??= err
    })
  }

  /** `count` rows of RGBA (alpha ignored), from the top, at rgba[0]: taken
   *  before this returns. */
  push(rgba: Uint8Array | Uint8ClampedArray, count: number): void {
    if (this.done || this.aborted) throw new Error('PNG: rows pushed after the file ended')
    if (this.rows + count > this.h) throw new Error(`PNG: ${this.rows + count} rows pushed for a height of ${this.h}`)
    const w3 = 3 * this.w
    for (let r = 0; r < count; r++) {
      const cur = this.cur
      const src = r * this.w * 4
      for (let x = 0, o = src, k = 0; x < this.w; x++, o += 4, k += 3) {
        cur[k] = rgba[o]
        cur[k + 1] = rgba[o + 1]
        cur[k + 2] = rgba[o + 2]
      }
      if (this.stored) {
        // Unfiltered: type 0 and the row as it is.
        this.storeByte(0)
        this.storeBytes(cur)
      } else {
        if (!this.batch) {
          this.batch = this.free.pop() ?? new Uint8Array(BATCH_ROWS * this.rowBytes)
          this.batchRows = 0
        }
        this.filterInto(this.batch, this.batchRows * this.rowBytes, w3)
        this.batchRows++
        if (this.batchRows === BATCH_ROWS) this.submit()
      }
      // The row just made is the previous one now; the old previous row's
      // buffer takes the next.
      this.cur = this.prev
      this.prev = cur
      this.rows++
    }
  }

  /** Resolves once every batch handed to the compressor has been taken. */
  async settled(): Promise<void> {
    if (this.writer) {
      await this.writer.ready
      await this.pending
    }
    if (this.failure) throw this.failure
  }

  /** Ends the file (IEND). Throws unless exactly `height` rows were pushed. */
  async finish(): Promise<void> {
    if (this.done) return
    if (this.aborted) throw new Error('PNG: the file was abandoned')
    if (this.rows !== this.h) throw new Error(`PNG: ${this.rows} rows pushed for a height of ${this.h}`)
    if (this.stored) {
      this.emitBlock(true)
    } else {
      if (this.batch) this.submit()
      await this.pending
      await this.writer!.close()
      await this.pump
      if (this.failure) throw this.failure
      if (this.tail !== this.adlerIn) {
        throw new Error("PNG: the compressor read rows after they were handed over (this engine's CompressionStream is not the standard's)")
      }
    }
    this.onChunk(chunk(IEND, NO_DATA))
    this.done = true
  }

  /** Stops: the compressor is cancelled, nothing more is handed on, and no
   *  promise is left pending. */
  abort(): void {
    if (this.done || this.aborted) return
    this.aborted = true
    this.batch = null
    this.free.length = 0
    this.block = null
    if (this.writer) {
      this.writer.abort().catch(() => {})
      this.reader!.cancel().catch(() => {})
    }
  }

  /** The current row, filtered as libpng would choose, into `out` at `at`. */
  private filterInto(out: Uint8Array, at: number, w3: number): void {
    const x = this.cur
    const up = this.rows === 0 ? null : this.prev
    // The four candidates' weights, in one pass.
    let none = 0
    let sub = 0
    let upw = 0
    let pae = 0
    for (let i = 0; i < w3; i++) {
      const a = i >= 3 ? x[i - 3] : 0
      const b = up ? up[i] : 0
      const c = up && i >= 3 ? up[i - 3] : 0
      const v = x[i]
      none += weight(v)
      sub += weight((v - a) & 0xff)
      upw += weight((v - b) & 0xff)
      pae += weight((v - paeth(a, b, c)) & 0xff)
    }
    let type = 0
    let best = none
    if (sub < best) {
      type = 1
      best = sub
    }
    if (upw < best) {
      type = 2
      best = upw
    }
    if (pae < best) type = 4
    out[at] = type
    const o = at + 1
    for (let i = 0; i < w3; i++) {
      const a = i >= 3 ? x[i - 3] : 0
      const b = up ? up[i] : 0
      const c = up && i >= 3 ? up[i - 3] : 0
      const v = x[i]
      out[o + i] = type === 0 ? v : type === 1 ? v - a : type === 2 ? v - b : v - paeth(a, b, c)
    }
  }

  /** Hands the batch to the compressor, without waiting for it; the batch
   *  goes back to the pool once the compressor has taken it. */
  private submit(): void {
    const batch = this.batch!
    const data = batch.subarray(0, this.batchRows * this.rowBytes)
    this.adlerIn = adler32(data, this.adlerIn)
    this.batch = null
    this.batchRows = 0
    this.pending = this.writer!.write(data).then(
      () => {
        if (!this.aborted) this.free.push(batch)
      },
      (err) => {
        this.failure ??= err
      },
    )
  }

  /** A compressed chunk as an IDAT, in three pieces: length and type, the
   *  bytes as the compressor gave them, the CRC. */
  private emitIdat(data: Uint8Array): void {
    const head = new Uint8Array(8)
    new DataView(head.buffer).setUint32(0, data.length)
    head.set(IDAT, 4)
    const crc = new Uint8Array(4)
    new DataView(crc.buffer).setUint32(0, crc32(data, IDAT_CRC))
    this.onChunk(head)
    this.onChunk(data)
    this.onChunk(crc)
  }

  /** A new IDAT chunk for the next stored block: its data starts after the
   *  length, the type, the zlib header (first block only) and the block's
   *  own header, which `emitBlock` writes. */
  private openBlock(): void {
    this.block = new Uint8Array(STORED_CHUNK)
    this.blockAt = 8 + (this.firstBlock ? 2 : 0) + 5
    this.blockN = 0
  }

  private storeByte(b: number): void {
    if (this.blockN === STORED_BLOCK) {
      this.emitBlock(false)
      this.openBlock()
    }
    this.block![this.blockAt + this.blockN++] = b
  }

  private storeBytes(bytes: Uint8Array): void {
    let i = 0
    while (i < bytes.length) {
      if (this.blockN === STORED_BLOCK) {
        this.emitBlock(false)
        this.openBlock()
      }
      const n = Math.min(bytes.length - i, STORED_BLOCK - this.blockN)
      this.block!.set(bytes.subarray(i, i + n), this.blockAt + this.blockN)
      this.blockN += n
      i += n
    }
  }

  /** The stored block, finished in place and handed on as one IDAT: the zlib
   *  header before the first block's, the Adler-32 after the last's. */
  private emitBlock(final: boolean): void {
    const out = this.block!
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    const n = this.blockN
    this.adler = adler32(out.subarray(this.blockAt, this.blockAt + n), this.adler)
    let o = 8
    if (this.firstBlock) {
      // CMF 0x78: deflate, 32 KB window; FLG 0x01: no dictionary, fastest,
      // and (CMF x 256 + FLG) a multiple of 31.
      out[o++] = 0x78
      out[o++] = 0x01
    }
    out[o++] = final ? 1 : 0 // BFINAL, BTYPE 00 (stored)
    out[o++] = n & 0xff
    out[o++] = n >>> 8
    out[o++] = ~n & 0xff
    out[o++] = (~n >>> 8) & 0xff
    o += n
    if (final) {
      view.setUint32(o, this.adler)
      o += 4
    }
    view.setUint32(0, o - 8)
    out.set(IDAT, 4)
    view.setUint32(o, crc32(out.subarray(4, o)))
    this.onChunk(out.subarray(0, o + 4))
    this.block = null
    this.firstBlock = false
  }
}
