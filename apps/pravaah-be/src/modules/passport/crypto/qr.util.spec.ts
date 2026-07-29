import { encodeQr, qrToSvg, textToQrSvg } from '@/modules/passport/crypto/qr.util'

/**
 * Block structure per version at level M, mirrored from the encoder's table so the
 * de-interleaver below can reverse what the encoder did. Duplicated on purpose: a test
 * that imported the encoder's own table would agree with a transcription error.
 */
const BLOCKS_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
}

/**
 * Reverse the mask, the module walk, and the interleaving to recover the payload.
 *
 * Written rather than asserting on module counts because a QR that is structurally
 * plausible and semantically wrong is exactly the failure a printed card cannot afford:
 * nobody discovers it until a scanner in a branch office refuses the card. Recovering
 * the original string proves placement, masking, and interleaving are all right at once.
 */
function decodeOwnQr(text: string): string {
  const qr = encodeQr(text)
  const size = qr.size
  const version = qr.version
  const [ecPerBlock, g1, d1, g2, d2] = BLOCKS_M[version]!

  // Recover which modules are function patterns by re-deriving the reserved map the same
  // way a decoder would: from the version alone, never from the encoder's internals.
  const reserved = buildReservedMap(version, size)

  // The format field tells us which of the eight masks was chosen.
  const mask = readMask(qr.modules, size)
  expect(mask).toBeGreaterThanOrEqual(0)
  expect(mask).toBeLessThan(8)

  const grid = qr.modules.map((row, y) =>
    row.map((dark, x) =>
      reserved[y]![x] ? dark : dark !== maskAt(mask, y, x),
    ),
  )

  // Walk the data region in the same two-module serpentine the encoder used.
  const bits: number[] = []
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right <= 6 ? right - 1 : right
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let offset = 0; offset < 2; offset += 1) {
        const x = col - offset
        if (x === 6 || reserved[row]![x]) continue
        bits.push(grid[row]![x] ? 1 : 0)
      }
    }
    upward = !upward
  }

  const codewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!
    codewords.push(byte)
  }

  // De-interleave: the encoder emitted data codewords column-wise across blocks.
  const blockSizes = [
    ...new Array<number>(g1).fill(d1),
    ...new Array<number>(g2).fill(d2),
  ]
  const blocks: number[][] = blockSizes.map(() => [])
  const maxData = Math.max(d1, d2 || 0)
  let cursor = 0
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < blockSizes[b]!) blocks[b]!.push(codewords[cursor++]!)
    }
  }
  const data = blocks.flat()
  expect(ecPerBlock).toBeGreaterThan(0)

  // Byte mode: 4-bit mode indicator, then the length, then the bytes.
  const stream: number[] = []
  for (const byte of data) {
    for (let i = 7; i >= 0; i -= 1) stream.push((byte >>> i) & 1)
  }
  const take = (count: number): number => {
    let value = 0
    for (let i = 0; i < count; i += 1) value = (value << 1) | stream.shift()!
    return value
  }
  expect(take(4)).toBe(0b0100)
  const length = take(version < 10 ? 8 : 16)
  const bytes = Buffer.from(
    Array.from({ length }, () => take(8)),
  )
  return bytes.toString('utf8')
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** Read the mask index out of the format field, undoing its XOR mask. */
function readMask(modules: boolean[][], size: number): number {
  let format = 0
  for (let i = 0; i <= 5; i += 1) format |= (modules[8]![i] ? 1 : 0) << i
  format |= (modules[8]![7] ? 1 : 0) << 6
  format |= (modules[8]![8] ? 1 : 0) << 7
  format |= (modules[7]![8] ? 1 : 0) << 8
  for (let i = 9; i < 15; i += 1) {
    format |= (modules[14 - i]![8] ? 1 : 0) << i
  }
  expect(size).toBeGreaterThan(20)
  const unmasked = format ^ 0b101010000010010
  // Top 5 bits are the data: 2 for the EC level, 3 for the mask.
  const data = unmasked >>> 10
  // Level M is 0b00.
  expect(data >>> 3).toBe(0b00)
  return data & 0b111
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2
  const result = [6]
  let pos = version * 4 + 10
  while (result.length < count) {
    result.splice(1, 0, pos)
    pos -= step
  }
  return result
}

function buildReservedMap(version: number, size: number): boolean[][] {
  const reserved = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  )
  const markFinder = (row: number, col: number): void => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const y = row + dy
        const x = col + dx
        if (y < 0 || y >= size || x < 0 || x >= size) continue
        reserved[y]![x] = true
      }
    }
  }
  markFinder(0, 0)
  markFinder(0, size - 7)
  markFinder(size - 7, 0)

  for (let i = 0; i < size; i += 1) {
    reserved[6]![i] = true
    reserved[i]![6] = true
  }

  const positions = alignmentPositions(version)
  for (const row of positions) {
    for (const col of positions) {
      // Alignment patterns are skipped where a finder already sits.
      if (reserved[row]![col]) continue
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) reserved[row + dy]![col + dx] = true
      }
    }
  }

  reserved[size - 8]![8] = true
  for (let i = 0; i < 9; i += 1) {
    reserved[8]![i] = true
    reserved[i]![8] = true
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8]![size - 1 - i] = true
    reserved[size - 1 - i]![8] = true
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3)
      const b = (i % 3) + size - 11
      reserved[a]![b] = true
      reserved[b]![a] = true
    }
  }
  return reserved
}

describe('qr.util', () => {
  describe('structure', () => {
    it('sizes the symbol as 4v+17', () => {
      const qr = encodeQr('https://pravaah.app/api/v1/verify/card/abc')
      expect(qr.size).toBe(qr.version * 4 + 17)
      expect(qr.modules).toHaveLength(qr.size)
      expect(qr.modules[0]).toHaveLength(qr.size)
    })

    it('picks the smallest version that fits', () => {
      // Level M byte capacities: v1 = 14, v2 = 26, v3 = 42.
      expect(encodeQr('a'.repeat(14)).version).toBe(1)
      expect(encodeQr('a'.repeat(15)).version).toBe(2)
      expect(encodeQr('a'.repeat(26)).version).toBe(2)
      expect(encodeQr('a'.repeat(27)).version).toBe(3)
    })

    it('places the three finder patterns', () => {
      const qr = encodeQr('x')
      const size = qr.size
      for (const [row, col] of [
        [0, 0],
        [0, size - 7],
        [size - 7, 0],
      ] as const) {
        // Dark 3x3 core, light ring at radius 2, dark ring at radius 3.
        expect(qr.modules[row + 3]![col + 3]).toBe(true)
        expect(qr.modules[row + 1]![col + 3]).toBe(false)
        expect(qr.modules[row]![col + 3]).toBe(true)
      }
    })

    it('alternates the timing patterns', () => {
      const qr = encodeQr('x')
      for (let i = 8; i < qr.size - 8; i += 1) {
        expect(qr.modules[6]![i]).toBe(i % 2 === 0)
        expect(qr.modules[i]![6]).toBe(i % 2 === 0)
      }
    })

    it('sets the mandatory dark module', () => {
      const qr = encodeQr('x')
      expect(qr.modules[qr.size - 8]![8]).toBe(true)
    })

    it('encodes error-correction level M in the format field', () => {
      // readMask asserts the level bits are 0b00 (level M) as a side effect.
      expect(readMask(encodeQr('x').modules, encodeQr('x').size)).toBeLessThan(8)
    })

    it('is deterministic for the same input', () => {
      const a = encodeQr('https://pravaah.app/api/v1/verify/card/ref')
      const b = encodeQr('https://pravaah.app/api/v1/verify/card/ref')
      expect(a.modules).toEqual(b.modules)
    })

    it('refuses a payload larger than the supported range', () => {
      expect(() => encodeQr('x'.repeat(400))).toThrow(/exceeds the largest/)
    })
  })

  describe('round-trip', () => {
    it('recovers a version-1 payload', () => {
      expect(decodeOwnQr('PVH-4K7Q-M2XB')).toBe('PVH-4K7Q-M2XB')
    })

    it('recovers a real card verify URL', () => {
      // The actual payload shape: a ~60-character verify URL, which lands on version 4
      // — the first MULTI-BLOCK version at level M, so this also proves interleaving.
      const url =
        'https://pravaah.app/api/v1/verify/card/Zm9vYmFyYmF6cXV4MTIz'
      const qr = encodeQr(url)
      expect(qr.version).toBeGreaterThanOrEqual(4)
      expect(decodeOwnQr(url)).toBe(url)
    })

    it('recovers payloads across every supported single- and multi-block version', () => {
      for (const length of [5, 14, 20, 30, 40, 50, 60, 80]) {
        const payload = 'A'.repeat(length)
        if (encodeQr(payload).version > 5) continue
        expect(decodeOwnQr(payload)).toBe(payload)
      }
    })

    it('recovers a payload that exactly fills a version', () => {
      // Boundary case: with the capacity exactly consumed there is no room for the
      // four-bit terminator, and a naive encoder overruns the data region here.
      expect(decodeOwnQr('a'.repeat(14))).toBe('a'.repeat(14))
      expect(decodeOwnQr('a'.repeat(26))).toBe('a'.repeat(26))
    })
  })

  describe('svg rendering', () => {
    it('includes the mandatory quiet zone', () => {
      // Part of the SPEC, not decoration: a symbol printed flush to an edge fails to scan.
      const qr = encodeQr('x')
      const svg = qrToSvg(qr, { moduleSize: 4, quietZone: 4 })
      const expected = (qr.size + 8) * 4
      expect(svg).toContain(`width="${expected}"`)
      expect(svg).toContain(`viewBox="0 0 ${expected} ${expected}"`)
    })

    it('draws all modules in one path rather than thousands of rects', () => {
      // A version-4 symbol is 1,089 modules; a thousand SVG elements is a real cost in a
      // React Native tree.
      const svg = textToQrSvg('https://pravaah.app/api/v1/verify/card/abc')
      expect(svg.match(/<path/g)).toHaveLength(1)
      expect(svg).not.toContain('<rect x=')
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
    })

    it('honours the palette', () => {
      const svg = textToQrSvg('x', { dark: '#0B1F3A', light: '#FFFFFF' })
      expect(svg).toContain('fill="#0B1F3A"')
      expect(svg).toContain('fill="#FFFFFF"')
    })
  })
})
