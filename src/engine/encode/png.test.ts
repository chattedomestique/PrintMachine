/**
 * The streaming PNG encoder, read back: every chunk's CRC, the zlib stream
 * inflated and unfiltered gives the pixels back exactly, through deflate
 * (`CompressionStream`) and through the stored fallback, however the rows
 * arrive. That a browser decodes it the same is checked in Chromium:
 * scripts/check-encode.mjs.
 *
 * The encoder fills a batch again once its write has resolved, which the
 * Compression Streams standard (and every browser) makes safe: the chunk is
 * read by the transform before the write resolves. Node's CompressionStream
 * may resolve first and read later, so these tests run on `StandardDeflate`:
 * node's deflate behind a TransformStream that reads each chunk when its
 * write is processed, as the standard's does, and a little late, so a batch
 * filled again too early would show.
 */

import { inflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adler32, crc32 } from './crc32.ts'
import { PngEncoder, storedSize } from './png.ts'
import { mulberry32 } from '../rng.ts'

const NodeCompressionStream = globalThis.CompressionStream

const later = () => new Promise((r) => setTimeout(r, 1))

/** A deflate that takes its chunk as the standard's does: read (here,
 *  copied) when its write is processed, and only then resolved. */
class StandardDeflate {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<BufferSource>
  constructor(format: CompressionFormat) {
    const real = new NodeCompressionStream(format)
    const w = real.writable.getWriter()
    this.readable = real.readable
    this.writable = new WritableStream<BufferSource>({
      async write(chunk) {
        await later()
        const v = chunk as Uint8Array
        await w.write(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice())
      },
      close: () => w.close(),
      abort: (reason) => w.abort(reason),
    })
  }
}

/** One that does not: its write resolves at once, and it reads the chunk a
 *  moment later. */
class LateDeflate {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<BufferSource>
  constructor(format: CompressionFormat) {
    const real = new NodeCompressionStream(format)
    const w = real.writable.getWriter()
    let reads = Promise.resolve()
    this.readable = real.readable
    this.writable = new WritableStream<BufferSource>({
      write(chunk) {
        const v = chunk as Uint8Array
        reads = reads.then(later).then(() => w.write(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()))
      },
      close: () => reads.then(() => w.close()),
      abort: (reason) => w.abort(reason),
    })
  }
}

const join = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/** Encode, pushing the rows in groups of the sizes given, in turn, and
 *  waiting for the encoder between groups as a band loop does. */
async function encode(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  compression: 'deflate' | 'stored',
  groups: number[] = [h],
  bandRows?: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const png = new PngEncoder(w, h, (c) => chunks.push(c), { compression, bandRows })
  let y = 0
  for (let k = 0; y < h; k++) {
    const n = Math.min(groups[k % groups.length], h - y)
    png.push(rgba.subarray(y * w * 4, (y + n) * w * 4), n)
    await png.settled()
    y += n
  }
  await png.finish()
  return join(chunks)
}

interface Chunk {
  type: string
  data: Uint8Array
  crc: number
}

function chunksOf(bytes: Uint8Array): Chunk[] {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Chunk[] = []
  for (let i = 8; i < bytes.length; ) {
    const len = view.getUint32(i)
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8))
    out.push({ type, data: bytes.subarray(i + 8, i + 8 + len), crc: view.getUint32(i + 8 + len) })
    i += 12 + len
  }
  return out
}

/** The pixels back, as RGB rows, and the filter type of each row. */
function decode(bytes: Uint8Array): { w: number; h: number; rgb: Uint8Array; filters: number[] } {
  const chunks = chunksOf(bytes)
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13)
  const w = ihdr.getUint32(0)
  const h = ihdr.getUint32(4)
  const raw = inflateSync(join(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = 3 * w
  expect(raw.length).toBe(h * (1 + stride))
  const rgb = new Uint8Array(h * stride)
  const filters: number[] = []
  for (let y = 0; y < h; y++) {
    const type = raw[y * (1 + stride)]
    filters.push(type)
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (1 + stride) + 1 + i]
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0
      const b = y > 0 ? rgb[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0
      let pred = 0
      if (type === 1) pred = a
      else if (type === 2) pred = b
      else if (type === 3) pred = (a + b) >> 1
      else if (type === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else expect(type).toBe(0)
      rgb[y * stride + i] = (v + pred) & 0xff
    }
  }
  return { w, h, rgb, filters }
}

const rgbOf = (rgba: Uint8ClampedArray) => {
  const out = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) out.set(rgba.subarray(i, i + 3), o)
  return out
}

const IMAGES: [string, number, number, (x: number, y: number, r: () => number) => [number, number, number, number]][] = [
  ['random', 64, 48, (_x, _y, r) => [r() * 256, r() * 256, r() * 256, r() * 256]],
  ['gradient', 100, 80, (x, y) => [x * 2.5, y * 3, 128, 255]],
  ['flat', 50, 50, () => [200, 100, 50, 255]],
  ['1x1', 1, 1, () => [1, 2, 3, 4]],
  ['3x5', 3, 5, (x, y) => [x * 80, y * 60, 7, 255]],
  ['257x65', 257, 65, (x, y, r) => [(x * y) & 255, x & 255, r() < 0.1 ? 255 : 0, 255]],
]

const make = (w: number, h: number, f: (typeof IMAGES)[number][3]) => {
  const r = mulberry32(w * 31 + h)
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y, r), (y * w + x) * 4)
  return d
}

describe('the PNG encoder', { timeout: 60_000 }, () => {
  beforeEach(() => vi.stubGlobal('CompressionStream', StandardDeflate))
  afterEach(() => vi.unstubAllGlobals())

  it('writes the chunks in order, each with its CRC: IHDR (8-bit RGB), sRGB, IDAT..., IEND', async () => {
    for (const compression of ['deflate', 'stored'] as const) {
      const bytes = await encode(make(40, 30, IMAGES[1][3]), 40, 30, compression)
      const chunks = chunksOf(bytes)
      for (const c of chunks) expect(c.crc).toBe(crc32(c.data, crc32(new TextEncoder().encode(c.type))))
      expect(chunks[0].type).toBe('IHDR')
      expect(Array.from(chunks[0].data)).toEqual([0, 0, 0, 40, 0, 0, 0, 30, 8, 2, 0, 0, 0])
      expect(chunks[1].type).toBe('sRGB')
      expect(chunks.at(-1)!.type).toBe('IEND')
      expect(chunks.slice(2, -1).every((c) => c.type === 'IDAT')).toBe(true)
    }
  })

  for (const [name, w, h, f] of IMAGES) {
    it(`${name} (${w}x${h}): inflated and unfiltered it is the input exactly, deflated or stored, rows in groups of 1, 7, 64 or all`, async () => {
      const rgba = make(w, h, f)
      for (const compression of ['deflate', 'stored'] as const) {
        for (const groups of [[1], [7], [64], [h]]) {
          const out = decode(await encode(rgba, w, h, compression, groups))
          expect([out.w, out.h]).toEqual([w, h])
          expect(out.rgb).toEqual(rgbOf(rgba))
        }
      }
    })
  }

  it('a band loop: bands of 150 rows, told or not, its batches filled again once taken, give the input exactly', async () => {
    const [, w, h, f] = IMAGES[5]
    const rgba = make(w, 700, f)
    for (const bandRows of [undefined, 150]) {
      const out = decode(await encode(rgba, w, 700, 'deflate', [150], bandRows))
      expect(out.rgb).toEqual(rgbOf(rgba))
    }
    expect(h).toBe(65)
  })

  it("on a compressor that reads a batch after its write resolved, the file is refused, never written wrong", async () => {
    vi.stubGlobal('CompressionStream', LateDeflate)
    const [, w, , f] = IMAGES[5]
    const rgba = make(w, 300, f)
    await expect(encode(rgba, w, 300, 'deflate', [64])).rejects.toThrow(/compressor read rows after they were handed over/)
  })

  it('deflated, each row takes the filter whose bytes weigh least: a gradient is not stored as None', async () => {
    const { filters } = decode(await encode(make(100, 80, IMAGES[1][3]), 100, 80, 'deflate'))
    expect(filters.every((t) => [0, 1, 2, 4].includes(t))).toBe(true)
    expect(filters.filter((t) => t !== 0).length).toBeGreaterThan(70)
  })

  it('stored: every row unfiltered, the size storedSize says, the zlib stream valid (Adler-32)', async () => {
    for (const [w, h] of [
      [1, 1],
      [300, 200],
      [21845, 1], // a row of exactly 65,536 bytes: two blocks
    ]) {
      const rgba = make(w, h, IMAGES[0][3])
      const bytes = await encode(rgba, w, h, 'stored', [7])
      expect(bytes.length).toBe(storedSize(w, h))
      const out = decode(bytes)
      expect(out.filters.every((t) => t === 0)).toBe(true)
      const z = join(chunksOf(bytes).filter((c) => c.type === 'IDAT').map((c) => c.data))
      expect(new DataView(z.buffer, z.byteOffset + z.length - 4).getUint32(0)).toBe(adler32(new Uint8Array(inflateSync(z))))
    }
  })

  it('without CompressionStream (Safari before 16.4), it stores', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const rgba = make(30, 20, IMAGES[1][3])
    const chunks: Uint8Array[] = []
    const png = new PngEncoder(30, 20, (c) => chunks.push(c))
    png.push(rgba, 20)
    await png.finish()
    expect(join(chunks).length).toBe(storedSize(30, 20))
  })

  it('settled() resolves only once the batches handed over have been taken', async () => {
    const log: string[] = []
    const Real = CompressionStream
    // A deflate whose every write takes 20 ms, and says when it is done.
    class Slow {
      readonly readable: ReadableStream<Uint8Array>
      readonly writable: WritableStream<BufferSource>
      constructor(format: CompressionFormat) {
        const real = new Real(format)
        const w = real.writable.getWriter()
        this.readable = real.readable
        this.writable = new WritableStream<BufferSource>({
          async write(chunk) {
            await new Promise((r) => setTimeout(r, 20))
            await w.write(chunk)
            log.push('written')
          },
          close: () => w.close(),
          abort: (reason) => w.abort(reason),
        })
      }
    }
    vi.stubGlobal('CompressionStream', Slow)
    const w = 50
    const h = 130
    const rgba = make(w, h, IMAGES[2][3])
    const chunks: Uint8Array[] = []
    const png = new PngEncoder(w, h, (c) => chunks.push(c))
    png.push(rgba.subarray(0, 64 * w * 4), 64) // one whole batch, handed over
    log.push('pushed')
    await png.settled()
    log.push('settled')
    expect(log).toEqual(['pushed', 'written', 'settled'])
    png.push(rgba.subarray(64 * w * 4), h - 64)
    await png.finish()
    expect(decode(join(chunks)).rgb).toEqual(rgbOf(rgba))
  })

  it('abort() stops it: nothing more is handed on, nothing is left pending, and it cannot be finished', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const w = 64
      const h = 200
      const rgba = make(w, h, IMAGES[0][3])
      const chunks: Uint8Array[] = []
      const png = new PngEncoder(w, h, (c) => chunks.push(c))
      png.push(rgba.subarray(0, 130 * w * 4), 130)
      png.abort()
      const after = chunks.length
      await new Promise((r) => setTimeout(r, 50))
      expect(chunks.length).toBe(after)
      await expect(png.finish()).rejects.toThrow(/abandoned/)
      expect(() => png.push(rgba, 1)).toThrow()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('says so when the rows do not add up, or the size cannot be a PNG', async () => {
    const png = new PngEncoder(4, 4, () => {})
    png.push(new Uint8ClampedArray(4 * 4 * 2), 2)
    await expect(png.finish()).rejects.toThrow(/2 rows pushed for a height of 4/)
    expect(() => png.push(new Uint8ClampedArray(4 * 4 * 3), 3)).toThrow(/5 rows/)
    png.abort()
    for (const [w, h] of [
      [0, 1],
      [1, 0],
      [2.5, 1],
    ]) {
      // A plain Error, never a RangeError: Save reads that as memory.
      expect(() => new PngEncoder(w, h, () => {})).toThrow(/is not a size a PNG can hold/)
      expect(() => new PngEncoder(w, h, () => {})).not.toThrow(RangeError)
    }
  })
})

describe('the checks', () => {
  it('crc32 and adler32 give the published values', () => {
    const text = new TextEncoder().encode('123456789')
    expect(crc32(text)).toBe(0xcbf43926)
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398)
    // Adler-32 over more than its 5,552-byte reduction window.
    const big = new Uint8Array(100_000).fill(255)
    let a = 1
    let b = 0
    for (const v of big) {
      a = (a + v) % 65521
      b = (b + a) % 65521
    }
    expect(adler32(big)).toBe(((b << 16) | a) >>> 0)
  })
})
