/**
 * MD5 over raw bytes, used only to identify one opened file.
 *
 * The page is served over plain HTTP on a LAN address, so `crypto.subtle` is
 * unavailable (it requires a secure context). This digest never protects
 * anything; it only tells the host "this is the same file as before".
 */

/** Per-round left-rotation amounts. */
const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** Round constants: floor(abs(sin(i + 1)) * 2^32). */
const K = new Uint32Array(64)
for (let index = 0; index < 64; index += 1) {
  K[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32)
}

/**
 * @param {Uint8Array} bytes - file contents.
 * @returns {string} 32 lowercase hex characters.
 */
export function md5(bytes) {
  const length = bytes.length
  const padded = (((length + 8) >>> 6) + 1) << 6
  const buffer = new Uint8Array(padded)
  buffer.set(bytes)
  buffer[length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(padded - 8, (length * 8) >>> 0, true)
  view.setUint32(padded - 4, Math.floor(length / 2 ** 29), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const block = new Uint32Array(16)

  for (let offset = 0; offset < padded; offset += 64) {
    for (let index = 0; index < 16; index += 1) block[index] = view.getUint32(offset + index * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let round = 0; round < 64; round += 1) {
      let f
      let slot
      if (round < 16) {
        f = (b & c) | (~b & d)
        slot = round
      } else if (round < 32) {
        f = (d & b) | (~d & c)
        slot = (5 * round + 1) & 15
      } else if (round < 48) {
        f = b ^ c ^ d
        slot = (3 * round + 5) & 15
      } else {
        f = c ^ (b | ~d)
        slot = (7 * round) & 15
      }
      const previous = d
      d = c
      c = b
      const sum = (a + f + K[round] + block[slot]) | 0
      b = (b + ((sum << SHIFT[round]) | (sum >>> (32 - SHIFT[round])))) | 0
      a = previous
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  let hex = ''
  for (const word of [a0, b0, c0, d0]) {
    for (let index = 0; index < 4; index += 1) {
      hex += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, '0')
    }
  }
  return hex
}
