/**
 * Reading a canvas's pixels back, in pieces.
 *
 * `getImageData` hands back a new array every call: the one allocation a
 * band cannot avoid. So every read-back is done in pieces of at most
 * READ_PIXELS (2^18 pixels, 1 MB of RGBA), never a whole canvas at once, and
 * the pieces are copied straight into a buffer that was made once: what a
 * read leaves behind is a megabyte of garbage at a time, not a canvas's worth.
 */

/** Pixels read from a canvas at a time. */
export const READ_PIXELS = 1 << 18

/**
 * The alpha channel of the canvas's top-left `cw` x `ch` pixels, into `into`:
 * canvas row y goes to `into[(y) * stride + x0 ...]`, one byte a pixel.
 */
export function readAlpha(ctx: CanvasRenderingContext2D, cw: number, ch: number, into: Uint8Array, stride: number, x0 = 0): void {
  const band = Math.max(1, Math.floor(READ_PIXELS / cw))
  for (let y = 0; y < ch; y += band) {
    const rows = Math.min(band, ch - y)
    const { data } = ctx.getImageData(0, y, cw, rows)
    for (let r = 0; r < rows; r++) {
      let p = r * cw * 4 + 3
      for (let i = (y + r) * stride + x0, end = i + cw; i < end; i++, p += 4) into[i] = data[p]
    }
  }
}

/**
 * The canvas's top-left `cw` x `ch` pixels, RGBA, into `into`: canvas row y
 * goes to `into[(y * stride + x0) * 4 ...]`, `stride` pixels a row.
 */
export function readRgba(ctx: CanvasRenderingContext2D, cw: number, ch: number, into: Uint8ClampedArray, stride: number, x0 = 0): void {
  const band = Math.max(1, Math.floor(READ_PIXELS / cw))
  for (let y = 0; y < ch; y += band) {
    const rows = Math.min(band, ch - y)
    const { data } = ctx.getImageData(0, y, cw, rows)
    if (cw === stride && x0 === 0) {
      into.set(data.subarray(0, rows * cw * 4), y * stride * 4)
      continue
    }
    for (let r = 0; r < rows; r++) into.set(data.subarray(r * cw * 4, (r + 1) * cw * 4), ((y + r) * stride + x0) * 4)
  }
}
