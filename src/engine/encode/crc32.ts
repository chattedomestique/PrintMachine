/**
 * CRC-32 (ISO 3309, the polynomial PNG's chunks are checked with, ISO/IEC
 * 15948 Annex D) and Adler-32 (RFC 1950, the zlib stream's check), for the
 * PNG encoder.
 */

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** The running CRC of `bytes`, continuing `crc` (start from 0). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/** The running Adler-32 of `bytes`, continuing `adler` (start from 1). */
export function adler32(bytes: Uint8Array, adler = 1): number {
  let a = adler & 0xffff
  let b = (adler >>> 16) & 0xffff
  // 5552 is the most bytes the sums can take before they must be reduced
  // (zlib's NMAX).
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552)
    for (; i < end; i++) {
      a += bytes[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}
