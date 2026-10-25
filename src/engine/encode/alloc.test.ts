/**
 * The encoders allocate once. A save of 40 MP pushes its whole image through
 * them a band at a time; a buffer made per batch or a copy per chunk would be
 * garbage the size of the image, which JavaScriptCore is slow to give back.
 * So, on a sheet as wide as a 40 MP photo (7728 px) pushed in the bands the
 * print would push (271 rows), once the encoder is made: nothing of 512 KiB or
 * more is made, and every array it makes is a piece of the file it hands on.
 *
 * The PNG runs on node's own CompressionStream here (a test compressor would
 * make arrays of its own and blur the count). Node's reads a chunk before it
 * resolves the write when the chunk is larger than its stream's high-water
 * mark (64 KiB), which a batch of these widths is (1.5 MB and 384 KB); and if
 * it ever did not, the encoder's own check would refuse the file and the test
 * would fail, not pass on a wrong file.
 */

import { describe, expect, it } from 'vitest'

import { allocationsAsync, type Allocation } from '../__tests__/alloc.ts'
import { JpegEncoder } from './jpeg.ts'
import { PngEncoder } from './png.ts'

const BIG = 512 * 1024
const W = 7728
const B = 271

/** A band of noise (it barely compresses: the most the compressor hands back). */
function band(w: number, rows: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * rows * 4)
  let s = 0x9e3779b9
  for (let i = 0; i < out.length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = s >>> 24
  }
  return out
}

interface Run {
  log: Allocation[]
  chunks: Uint8Array[]
}

/** Push `bands` bands of `rows` (the last may be short) into a PNG, awaiting
 *  `settled()` after each as the band loop does. */
async function png(w: number, h: number, rows: number, opts: { compression: 'deflate' | 'stored'; bandRows?: number }): Promise<Run> {
  const data = band(w, rows)
  const chunks: Uint8Array[] = []
  const log = await allocationsAsync(async (phase) => {
    const e = new PngEncoder(w, h, (c) => chunks.push(c), opts)
    phase.now = 'push'
    for (let y = 0; y < h; y += rows) {
      e.push(data, Math.min(rows, h - y))
      await e.settled()
    }
    await e.finish()
  })
  return { log, chunks }
}

/** What was made after construction that is not a piece of the file. */
const kept = (r: Run) => {
  const handedOn = new Set(r.chunks.map((c) => c.buffer))
  return r.log.filter((a) => a.phase === 'push' && !handedOn.has(a.buffer))
}

describe('the encoders allocate once', { timeout: 120_000 }, () => {
  it('JPEG: once made, it makes nothing but the chunks it hands on (256 KiB each)', async () => {
    const h = 4 * B
    const data = band(W, B)
    const chunks: Uint8Array[] = []
    const log = await allocationsAsync(async (phase) => {
      const e = new JpegEncoder(W, h, 95, (c) => chunks.push(c))
      phase.now = 'push'
      for (let y = 0; y < h; y += B) e.push(data, Math.min(B, h - y))
      e.finish()
    })
    const r = { log, chunks }
    const after = log.filter((a) => a.phase === 'push')
    expect(after.length).toBeGreaterThan(10)
    expect(kept(r)).toEqual([])
    expect(after.every((a) => a.bytes === 1 << 18)).toBe(true)
    // Its strip, made with it: three planes of 8 rows of floats.
    expect(log.filter((a) => a.phase === 'setup' && a.bytes >= BIG).map((a) => a.bytes)).toEqual([])
    expect(log.filter((a) => a.phase === 'setup' && a.bytes === Math.ceil(W / 8) * 64 * 4).length).toBe(3)
  })

  it('PNG, deflated: told the band height, it makes its batches up front and none after; a compressed chunk is never copied', async () => {
    const r = await png(W, 4 * B, B, { compression: 'deflate', bandRows: B })
    const batch = 64 * (1 + 3 * W)
    // ceil((271 + 63) / 64) batches: a band may begin in a batch part-filled.
    expect(r.log.filter((a) => a.phase === 'setup' && a.bytes === batch).length).toBe(Math.ceil((B + 63) / 64))
    expect(r.log.filter((a) => a.phase === 'push' && a.bytes >= BIG)).toEqual([])
    expect(kept(r)).toEqual([])
    // Each IDAT is its 8 bytes of length and type, the compressor's bytes as
    // they came, and its 4 of CRC: the only arrays made are those two pieces,
    // and the 12 bytes of IEND.
    const sizes = r.log.filter((a) => a.phase === 'push').map((a) => a.bytes)
    expect(sizes.filter((n) => n === 12)).toEqual([12])
    expect(sizes.every((n) => n === 8 || n === 4 || n === 12)).toBe(true)
    // Signature, IHDR, sRGB, three pieces an IDAT, IEND.
    const idats = (r.chunks.length - 4) / 3
    expect(sizes.filter((n) => n === 8).length).toBe(idats)
    expect(sizes.filter((n) => n === 4).length).toBe(idats)
  })

  it('PNG, deflated, not told: the batches it makes never outnumber the most a band can touch, however many bands', async () => {
    const w = 2000
    const batch = 64 * (1 + 3 * w)
    const made = async (bands: number) => (await png(w, bands * B, B, { compression: 'deflate' })).log.filter((a) => a.bytes === batch).length
    // A band of 271 rows that begins with r rows already in a batch touches
    // ceil((r + 271) / 64) batches: 5 for the first (r = 0), 6 for the fifth
    // (r = 4 x 271 mod 64 = 60), and never more.
    expect(await made(2)).toBe(5)
    expect(await made(7)).toBe(Math.ceil((B + 63) / 64))
    expect(await made(20)).toBe(Math.ceil((B + 63) / 64))
  })

  it('PNG, stored: each block is written once, into the chunk it hands on', async () => {
    const r = await png(W, 4 * B, B, { compression: 'stored', bandRows: B })
    expect(r.log.filter((a) => a.bytes >= BIG)).toEqual([])
    expect(kept(r)).toEqual([])
    const made = r.log.filter((a) => a.phase === 'push').reduce((t, a) => t + a.bytes, 0)
    const file = r.chunks.reduce((t, c) => t + c.length, 0)
    // What it made is the file, but the few bytes a block's chunk keeps spare.
    expect(made).toBeGreaterThanOrEqual(file - 65_558)
    expect(made).toBeLessThan(file * 1.001)
  })
})
