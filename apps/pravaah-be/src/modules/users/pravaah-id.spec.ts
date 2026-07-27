import { randomBytes } from 'node:crypto'

import {
  buildPravaahId,
  isPravaahId,
  normalizePravaahId,
  PRAVAAH_ID_ENTROPY_SYMBOLS,
  PRAVAAH_ID_LENGTH,
  PRAVAAH_ID_PATTERN,
  PravaahIdSchema,
} from '@pravaah/schema'

/**
 * The Pravaah ID is the identity a user reads out and a partner types in, so
 * every property the format claims is asserted here: shape, the excluded
 * letters, checksum coverage of the mistakes people actually make, and the
 * transcription rules that make a mistyped ID recoverable rather than rejected.
 */
describe('Pravaah ID', () => {
  const entropy = (...bytes: number[]) => Uint8Array.from(bytes)
  const eleven = (fill: number) =>
    Uint8Array.from(new Array(PRAVAAH_ID_ENTROPY_SYMBOLS).fill(fill))

  describe('buildPravaahId', () => {
    it('renders the canonical PVH-XXXX-XXXX-XXXX shape', () => {
      const id = buildPravaahId(eleven(0))
      expect(id).toMatch(PRAVAAH_ID_PATTERN)
      expect(id).toHaveLength(PRAVAAH_ID_LENGTH)
      expect(id.startsWith('PVH-')).toBe(true)
    })

    it('is deterministic for the same entropy', () => {
      expect(buildPravaahId(eleven(7))).toBe(buildPravaahId(eleven(7)))
    })

    it('rejects the wrong number of entropy bytes', () => {
      expect(() => buildPravaahId(entropy(1, 2, 3))).toThrow(/exactly 11/)
      expect(() => buildPravaahId(eleven(0).slice(0, 10))).toThrow(/exactly 11/)
    })

    it('never emits I, L, O or U — the ambiguous letters', () => {
      // Every byte value maps through the alphabet, so 256 IDs cover it fully.
      for (let byte = 0; byte < 256; byte += 1) {
        const body = buildPravaahId(eleven(byte)).replace(/^PVH-/, '')
        expect(body).not.toMatch(/[ILOU]/)
      }
    })

    it('maps entropy bytes uniformly (256 is a multiple of the 32-symbol base)', () => {
      const seen = new Map<string, number>()
      for (let byte = 0; byte < 256; byte += 1) {
        const symbol = buildPravaahId(eleven(byte))[4]
        seen.set(symbol, (seen.get(symbol) ?? 0) + 1)
      }
      expect(seen.size).toBe(32)
      // Exactly 8 of the 256 byte values per symbol — no modulo bias.
      expect([...seen.values()].every((count) => count === 8)).toBe(true)
    })

    it('produces valid IDs from real entropy', () => {
      for (let i = 0; i < 500; i += 1) {
        expect(isPravaahId(buildPravaahId(randomBytes(11)))).toBe(true)
      }
    })
  })

  describe('checksum', () => {
    const id = buildPravaahId(randomBytes(11))
    const symbols = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'

    it('catches every single-symbol substitution', () => {
      const body = id.replace(/-/g, '').slice(3) // drop prefix + dashes
      for (let i = 0; i < body.length; i += 1) {
        for (const replacement of symbols) {
          if (replacement === body[i]) continue
          const typo = body.slice(0, i) + replacement + body.slice(i + 1)
          expect(normalizePravaahId(typo)).toBeNull()
        }
      }
    })

    /**
     * Luhn mod 32 has exactly one blind spot, and it is worth pinning rather
     * than glossing: an adjacent 0/Z swap is undetectable. Asserting the precise
     * set — instead of "most transpositions" — means any future change to the
     * alphabet or the checksum has to come back here and restate its coverage.
     */
    it('catches every adjacent transposition except the 0/Z pair', () => {
      const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
      const missed = new Set<string>()

      for (let a = 0; a < 32; a += 1) {
        for (let b = 0; b < 32; b += 1) {
          if (a === b) continue // swapping equal symbols is a no-op
          const bytes = Uint8Array.from([a, b, 5, 6, 7, 8, 9, 10, 11, 12, 13])
          const body = buildPravaahId(bytes).replace(/-/g, '').slice(3)
          const swapped = body[1] + body[0] + body.slice(2)
          if (normalizePravaahId(swapped) !== null) {
            missed.add([ALPHABET[a], ALPHABET[b]].sort().join(''))
          }
        }
      }

      expect([...missed]).toEqual(['0Z'])
    })

    it('has the same transposition coverage at every position (parity-independent)', () => {
      const body = id.replace(/-/g, '').slice(3)
      for (let i = 0; i < body.length - 1; i += 1) {
        const pair = [body[i], body[i + 1]].sort().join('')
        if (body[i] === body[i + 1] || pair === '0Z') continue
        const swapped =
          body.slice(0, i) + body[i + 1] + body[i] + body.slice(i + 2)
        expect(normalizePravaahId(swapped)).toBeNull()
      }
    })
  })

  describe('normalizePravaahId', () => {
    const id = buildPravaahId(eleven(3))

    it('accepts the canonical form unchanged', () => {
      expect(normalizePravaahId(id)).toBe(id)
    })

    it('accepts lower case, spaces and missing dashes', () => {
      expect(normalizePravaahId(id.toLowerCase())).toBe(id)
      expect(normalizePravaahId(id.replace(/-/g, ''))).toBe(id)
      expect(normalizePravaahId(id.replace(/-/g, ' '))).toBe(id)
      expect(normalizePravaahId(`  ${id}  `)).toBe(id)
    })

    it('accepts the ID without its PVH prefix', () => {
      expect(normalizePravaahId(id.slice(4))).toBe(id)
    })

    it('does not mistake a body starting with PVH for a prefix', () => {
      // 'PVH' is three valid Base32 symbols, so length — not the match — must
      // decide whether a leading PVH is the prefix.
      const body = 'PVHJKMNPQRS'
      const bare = buildPravaahId(
        Uint8Array.from(
          [...body].map((s) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(s)),
        ),
      )
      expect(normalizePravaahId(bare.slice(4))).toBe(bare)
      expect(normalizePravaahId(bare)).toBe(bare)
    })

    it('applies the Crockford transcription rules (I/L→1, O→0)', () => {
      const canonical = buildPravaahId(entropy(1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1))
      const dictated = canonical.slice(4).replace(/1/g, 'I').replace(/0/g, 'O')
      expect(normalizePravaahId(dictated)).toBe(canonical)
      expect(normalizePravaahId(canonical.slice(4).replace(/1/g, 'l'))).toBe(
        canonical,
      )
    })

    it('rejects wrong lengths, junk, and the excluded letter U', () => {
      expect(normalizePravaahId('')).toBeNull()
      expect(normalizePravaahId('PVH-1234')).toBeNull()
      expect(normalizePravaahId(`${id}X`)).toBeNull()
      expect(normalizePravaahId('PVH-UUUU-UUUU-UUUU')).toBeNull()
      expect(normalizePravaahId('not an id at all')).toBeNull()
      // A 15-symbol string with a wrong prefix is not silently accepted.
      expect(
        normalizePravaahId(`ABC${id.slice(4).replace(/-/g, '')}`),
      ).toBeNull()
    })

    it('rejects a raw UUID — the thing it exists to replace', () => {
      expect(
        normalizePravaahId('6fa10462-eaed-4d37-ad08-fb8c1b9d58b0'),
      ).toBeNull()
    })
  })

  describe('PravaahIdSchema', () => {
    const id = buildPravaahId(eleven(9))

    it('normalizes valid input on parse', () => {
      expect(PravaahIdSchema.parse(id.toLowerCase().replace(/-/g, ''))).toBe(id)
    })

    it('fails a checksum-invalid ID', () => {
      expect(PravaahIdSchema.safeParse('PVH-0000-0000-0001').success).toBe(
        false,
      )
    })
  })
})
