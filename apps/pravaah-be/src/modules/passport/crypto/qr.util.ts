/**
 * A minimal QR Code encoder (ISO/IEC 18004), byte mode, error-correction level M.
 *
 * Written rather than installed for the same reason as the JOSE layer: the QR has
 * three consumers — the RN wallet's "show QR" screen, the admin console's card
 * artwork, and the print-ready card PDF — and none of them share a runtime. A
 * server-rendered SVG serves all three from one implementation, and neither the
 * Expo app nor the Next.js console needs a QR dependency of its own.
 *
 * Scope is deliberately narrow: byte mode only, level M only, versions 1–10. Our
 * payload is a ~70-character verify URL, which fits in version 4; the range to 10
 * (213 bytes at level M) is headroom, not ambition. Level M recovers ~15% of the
 * symbol, which is the right trade for a card that will be scanned off scuffed PVC.
 */

const ECC_LEVEL_M = 0b00

/**
 * Block structure per version at level M:
 * `[ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]`.
 *
 * Straight from the standard's tables. There is no formula — the values are chosen
 * per version by the spec, so they are transcribed and pinned by test rather than
 * derived.
 */
const VERSION_TABLE_M: Record<
  number,
  [number, number, number, number, number]
> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
}

const MAX_VERSION = 10

/** Total data codewords available at a version, level M. */
function dataCodewords(version: number): number {
  const [, g1, d1, g2, d2] = VERSION_TABLE_M[version]!
  return g1 * d1 + g2 * d2
}

/** Character-count field width: 8 bits below version 10, 16 bits from 10 up. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16
}

/** Smallest version that fits `byteLength` in byte mode at level M. */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacity =
      Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8)
    if (byteLength <= capacity) return version
  }
  throw new Error(
    `Payload of ${byteLength} bytes exceeds the largest supported QR version`,
  )
}

// ── GF(256) arithmetic for Reed–Solomon ─────────────────────────────────────
/**
 * QR uses GF(2^8) with the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
 * (0x11d). Log/antilog tables make multiplication a pair of lookups and an add,
 * which is what keeps the encoder fast enough to run per request.
 */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  // Duplicated upper half so an exponent sum up to 508 needs no modulo.
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!
}

/** The RS generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = Uint8Array.from([1])
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j]! ^ gfMul(poly[j]!, GF_EXP[i]!)) & 0xff
      next[j + 1] = (next[j + 1]! ^ poly[j]!) & 0xff
    }
    poly = next
  }
  return poly
}

/** Polynomial long division in GF(256); the remainder IS the EC codewords. */
function reedSolomon(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = generatorPoly(ecCount)
  const remainder = new Uint8Array(ecCount)
  for (const byte of data) {
    const factor = (byte ^ remainder[0]!) & 0xff
    remainder.copyWithin(0, 1)
    remainder[ecCount - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i += 1) {
        remainder[i] = (remainder[i]! ^ gfMul(generator[i + 1]!, factor)) & 0xff
      }
    }
  }
  return remainder
}

// ── bit stream ──────────────────────────────────────────────────────────────
class BitBuffer {
  private readonly bits: number[] = []

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1)
    }
  }

  get length(): number {
    return this.bits.length
  }

  /** Pad to a byte boundary, then alternate 0xEC/0x11 as the standard requires. */
  toCodewords(target: number): Uint8Array {
    const bits = [...this.bits]
    // Up to four terminator zeros, but never past the capacity.
    const terminator = Math.min(4, target * 8 - bits.length)
    for (let i = 0; i < terminator; i += 1) bits.push(0)
    while (bits.length % 8 !== 0) bits.push(0)

    const codewords: number[] = []
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!
      codewords.push(byte)
    }
    const padBytes = [0xec, 0x11]
    let padIndex = 0
    while (codewords.length < target) {
      codewords.push(padBytes[padIndex % 2]!)
      padIndex += 1
    }
    return Uint8Array.from(codewords)
  }
}

/**
 * Interleave data and EC codewords across blocks.
 *
 * Interleaving is what makes level M's ~15% recovery useful against a physical
 * scratch: a contiguous smudge damages one codeword in each block rather than
 * destroying one block entirely, and per-block recovery then has enough intact
 * symbols to work with.
 */
function buildCodewords(version: number, data: Uint8Array): Uint8Array {
  const [ecPerBlock, g1, d1, g2, d2] = VERSION_TABLE_M[version]!
  const blocks: Array<{ data: Uint8Array; ec: Uint8Array }> = []

  let offset = 0
  for (let i = 0; i < g1; i += 1) {
    const slice = data.subarray(offset, offset + d1)
    blocks.push({ data: slice, ec: reedSolomon(slice, ecPerBlock) })
    offset += d1
  }
  for (let i = 0; i < g2; i += 1) {
    const slice = data.subarray(offset, offset + d2)
    blocks.push({ data: slice, ec: reedSolomon(slice, ecPerBlock) })
    offset += d2
  }

  const out: number[] = []
  const maxData = Math.max(d1, d2)
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]!)
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i]!)
  }
  return Uint8Array.from(out)
}

// ── BCH error correction for the format and version fields ──────────────────
function bch(value: number, dataBits: number, generator: number): number {
  let remainder = value << (Math.floor(Math.log2(generator)) )
  const genBits = Math.floor(Math.log2(generator))
  for (let i = dataBits - 1; i >= 0; i -= 1) {
    if ((remainder >>> (i + genBits)) & 1) {
      remainder ^= generator << i
    }
  }
  return remainder & ((1 << genBits) - 1)
}

function formatBits(mask: number): number {
  const data = (ECC_LEVEL_M << 3) | mask
  const ec = bch(data, 5, 0b10100110111)
  // The XOR mask stops an all-zero format field, which would be
  // indistinguishable from blank media.
  return ((data << 10) | ec) ^ 0b101010000010010
}

function versionBits(version: number): number {
  return (version << 12) | bch(version, 6, 0b1111100100101)
}

// ── module placement ────────────────────────────────────────────────────────
type Grid = Int8Array[]

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

/**
 * Lay down the function patterns.
 *
 * `-1` marks a reserved module, distinct from `0` (light) and `1` (dark), so the
 * data-placement walk can skip function areas without a second bookkeeping
 * structure — and so a bug that writes data over a finder pattern is impossible
 * rather than merely unlikely.
 */
function buildFunctionPatterns(version: number): {
  grid: Grid
  size: number
} {
  const size = version * 4 + 17
  const grid: Grid = Array.from({ length: size }, () =>
    new Int8Array(size).fill(-1),
  )

  const setFinder = (row: number, col: number): void => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const y = row + dy
        const x = col + dx
        if (y < 0 || y >= size || x < 0 || x >= size) continue
        const ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3))
        grid[y]![x] = ring === 2 || ring > 3 ? 0 : 1
      }
    }
  }
  setFinder(0, 0)
  setFinder(0, size - 7)
  setFinder(size - 7, 0)

  // Timing patterns: alternating row/column 6, giving a scanner its module pitch.
  for (let i = 0; i < size; i += 1) {
    if (grid[6]![i] === -1) grid[6]![i] = i % 2 === 0 ? 1 : 0
    if (grid[i]![6] === -1) grid[i]![6] = i % 2 === 0 ? 1 : 0
  }

  for (const row of alignmentPositions(version)) {
    for (const col of alignmentPositions(version)) {
      // Skip the three corners already occupied by finder patterns.
      if (grid[row]![col] !== -1) continue
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const ring = Math.max(Math.abs(dy), Math.abs(dx))
          grid[row + dy]![col + dx] = ring === 1 ? 0 : 1
        }
      }
    }
  }

  // The dark module — a single fixed-value module the standard mandates.
  grid[size - 8]![8] = 1

  return { grid, size }
}

/** Reserve the format/version areas so the data walk skips them. */
function reserveFormatAreas(grid: Grid, size: number, version: number): void {
  for (let i = 0; i < 9; i += 1) {
    if (grid[8]![i] === -1) grid[8]![i] = 0
    if (grid[i]![8] === -1) grid[i]![8] = 0
  }
  for (let i = 0; i < 8; i += 1) {
    if (grid[8]![size - 1 - i] === -1) grid[8]![size - 1 - i] = 0
    if (grid[size - 1 - i]![8] === -1) grid[size - 1 - i]![8] = 0
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3)
      const b = (i % 3) + size - 11
      if (grid[a]![b] === -1) grid[a]![b] = 0
      if (grid[b]![a] === -1) grid[b]![a] = 0
    }
  }
}

/**
 * Walk the data codewords into the symbol: two-module columns, right to left,
 * alternating upward and downward, skipping column 6 (the timing pattern).
 */
function placeData(
  grid: Grid,
  size: number,
  codewords: Uint8Array,
  reserved: boolean[][],
): void {
  let bitIndex = 0
  const readBit = (): number => {
    const byte = codewords[bitIndex >>> 3] ?? 0
    const bit = (byte >>> (7 - (bitIndex & 7))) & 1
    bitIndex += 1
    return bit
  }

  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right <= 6 ? right - 1 : right
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let offset = 0; offset < 2; offset += 1) {
        const x = col - offset
        if (x === 6) continue
        if (reserved[row]![x]) continue
        grid[row]![x] = bitIndex < codewords.length * 8 ? readBit() : 0
      }
    }
    upward = !upward
  }
}

/** The eight standard data-mask patterns. */
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

/**
 * The four penalty rules. The mask with the lowest total wins.
 *
 * Masking exists so a payload cannot accidentally produce large blank areas or a
 * pattern that mimics a finder — either of which makes a real scanner fail on a
 * symbol that is mathematically perfect. Evaluating all eight is cheap at these
 * versions and removes an entire class of "works on my phone" failure.
 */
function penalty(grid: Grid, size: number): number {
  let score = 0

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const horizontal of [true, false]) {
      let run = 1
      for (let j = 1; j < size; j += 1) {
        const prev = horizontal ? grid[i]![j - 1]! : grid[j - 1]![i]!
        const cur = horizontal ? grid[i]![j]! : grid[j]![i]!
        if (cur === prev) {
          run += 1
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else {
          run = 1
        }
      }
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const v = grid[row]![col]!
      if (
        v === grid[row]![col + 1] &&
        v === grid[row + 1]![col] &&
        v === grid[row + 1]![col + 1]
      ) {
        score += 3
      }
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-lookalike, with four light modules either side.
  const finder = [1, 0, 1, 1, 1, 0, 1]
  const matches = (get: (k: number) => number, start: number): boolean =>
    finder.every((want, k) => get(start + k) === want)
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= size - 7; j += 1) {
      for (const horizontal of [true, false]) {
        const get = (k: number): number =>
          k < 0 || k >= size ? 0 : horizontal ? grid[i]![k]! : grid[k]![i]!
        if (!matches(get, j)) continue
        const before = Array.from({ length: 4 }, (_, k) => get(j - 1 - k))
        const after = Array.from({ length: 4 }, (_, k) => get(j + 7 + k))
        if (
          before.every((v) => v === 0) ||
          after.every((v) => v === 0)
        ) {
          score += 40
        }
      }
    }
  }

  // Rule 4: deviation from a 50/50 light/dark balance.
  let dark = 0
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (grid[row]![col] === 1) dark += 1
  }
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

function applyFormatAndVersion(
  grid: Grid,
  size: number,
  version: number,
  mask: number,
): void {
  const format = formatBits(mask)
  const bit = (n: number): number => (format >>> n) & 1

  // Format info, written twice so the symbol survives losing one copy.
  for (let i = 0; i <= 5; i += 1) grid[8]![i] = bit(i)
  grid[8]![7] = bit(6)
  grid[8]![8] = bit(7)
  grid[7]![8] = bit(8)
  for (let i = 9; i < 15; i += 1) grid[14 - i]![8] = bit(i)

  for (let i = 0; i < 8; i += 1) grid[size - 1 - i]![8] = bit(i)
  for (let i = 8; i < 15; i += 1) grid[8]![size - 15 + i] = bit(i)

  // The dark module is written LAST, because the vertical run above passes straight
  // through its position: format bit 7 lands on (size-8, 8) and would otherwise
  // overwrite it. A missing dark module is not caught by a round-trip decode — the
  // decoder skips it as a function module — but a real scanner reads it, so the symbol
  // fails in the field and nowhere else.
  grid[size - 8]![8] = 1

  if (version >= 7) {
    const info = versionBits(version)
    for (let i = 0; i < 18; i += 1) {
      const value = (info >>> i) & 1
      const a = Math.floor(i / 3)
      const b = (i % 3) + size - 11
      grid[a]![b] = value
      grid[b]![a] = value
    }
  }
}

export interface QrCode {
  size: number
  version: number
  /** Row-major modules; true is dark. */
  modules: boolean[][]
}

/** Encode a UTF-8 string as a QR symbol. */
export function encodeQr(text: string): QrCode {
  const bytes = Buffer.from(text, 'utf8')
  const version = pickVersion(bytes.length)

  const buffer = new BitBuffer()
  buffer.push(0b0100, 4) // byte mode
  buffer.push(bytes.length, countBits(version))
  for (const byte of bytes) buffer.push(byte, 8)

  const codewords = buildCodewords(
    version,
    buffer.toCodewords(dataCodewords(version)),
  )

  const { grid: functionGrid, size } = buildFunctionPatterns(version)
  reserveFormatAreas(functionGrid, size, version)
  // Snapshot which modules are function patterns BEFORE any data lands, so mask
  // application can leave them untouched — masking a finder pattern makes the
  // symbol unscannable.
  const reserved = functionGrid.map((row) => Array.from(row, (v) => v !== -1))

  let best: { grid: Grid; score: number; mask: number } | null = null
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = functionGrid.map((row) => Int8Array.from(row))
    placeData(grid, size, codewords, reserved)
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (reserved[row]![col]) continue
        if (maskAt(mask, row, col)) grid[row]![col] = grid[row]![col]! ^ 1
      }
    }
    applyFormatAndVersion(grid, size, version, mask)
    const score = penalty(grid, size)
    if (!best || score < best.score) best = { grid, score, mask }
  }

  const chosen = best!.grid
  return {
    size,
    version,
    modules: chosen.map((row) => Array.from(row, (v) => v === 1)),
  }
}

/**
 * Render a QR as an SVG string.
 *
 * A single `<path>` of rectangles rather than one `<rect>` per module: a version-4
 * symbol is 1,089 modules, and a thousand elements is a real cost in a React Native
 * SVG tree. The quiet zone is included because it is part of the SPEC, not
 * decoration — a symbol printed flush to an edge fails to scan.
 */
export function qrToSvg(
  qr: QrCode,
  opts: { moduleSize?: number; quietZone?: number; dark?: string; light?: string } = {},
): string {
  const moduleSize = opts.moduleSize ?? 4
  const quiet = opts.quietZone ?? 4
  const dimension = (qr.size + quiet * 2) * moduleSize

  let path = ''
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (!qr.modules[row]![col]) continue
      const x = (col + quiet) * moduleSize
      const y = (row + quiet) * moduleSize
      path += `M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}"`,
    ` viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`,
    `<rect width="${dimension}" height="${dimension}" fill="${opts.light ?? '#FFFFFF'}"/>`,
    `<path d="${path}" fill="${opts.dark ?? '#0B1F3A'}"/>`,
    '</svg>',
  ].join('')
}

/** Convenience: text straight to SVG. */
export function textToQrSvg(
  text: string,
  opts?: Parameters<typeof qrToSvg>[1],
): string {
  return qrToSvg(encodeQr(text), opts)
}
