import { createHash } from 'node:crypto'

import {
  b64uDecode,
  b64uEncode,
  disclosureDigest,
} from '@/modules/passport/crypto/jose.util'
import {
  buildSdJwtPayload,
  computeSdHash,
  makeDisclosure,
  parseCombined,
  parseDisclosure,
  resolveDisclosures,
  serializeIssuance,
  serializePresentation,
} from '@/modules/passport/crypto/sd-jwt.util'
import { generateEs256KeyPair } from '@/modules/passport/crypto/jose.util'

describe('sd-jwt.util', () => {
  describe('disclosures', () => {
    it('encodes [salt, name, value] and digests the encoded STRING', () => {
      const disclosure = makeDisclosure('score_band', 'VERY_GOOD')
      const decoded = JSON.parse(
        b64uDecode(disclosure.encoded).toString('utf8'),
      ) as [string, string, unknown]

      expect(decoded).toHaveLength(3)
      expect(decoded[1]).toBe('score_band')
      expect(decoded[2]).toBe('VERY_GOOD')

      // Hashed over the ASCII of the base64url string, NOT the bytes it decodes to.
      // This is what lets a verifier check membership without re-serialising the JSON
      // (and risking different bytes from the same object).
      expect(disclosure.digest).toBe(
        createHash('sha256')
          .update(Buffer.from(disclosure.encoded, 'ascii'))
          .digest('base64url'),
      )
    })

    it('salts every claim independently with 128 bits', () => {
      const a = makeDisclosure('score_value', 720)
      const b = makeDisclosure('score_value', 720)

      // Identical claim AND value must still produce different digests. Without this,
      // a verifier could tell that two credentials share a score, and could brute-force
      // score_value across its 601 possible values.
      expect(a.digest).not.toBe(b.digest)
      expect(b64uDecode(a.salt).length).toBe(16)
    })

    it('round-trips through the parser', () => {
      const made = makeDisclosure('data_rails', ['AA-IN', 'SGFinDex'])
      const parsed = parseDisclosure(made.encoded)

      expect(parsed).not.toBeNull()
      expect(parsed!.name).toBe('data_rails')
      expect(parsed!.value).toEqual(['AA-IN', 'SGFinDex'])
      expect(parsed!.digest).toBe(made.digest)
    })

    it('returns null for malformed input instead of throwing', () => {
      // A verifier processes a LIST; one bad entry must yield a precise rejection
      // reason, not abort the whole verification with an exception.
      expect(parseDisclosure('!!!not-base64!!!')).toBeNull()
      expect(parseDisclosure(b64uEncode('not json'))).toBeNull()
      expect(parseDisclosure(b64uEncode('{"a":1}'))).toBeNull()
      // Two-element (array-element) form: valid in the spec, but not a shape we mint.
      expect(parseDisclosure(b64uEncode('["salt","value"]'))).toBeNull()
      expect(parseDisclosure(b64uEncode('["salt",123,"v"]'))).toBeNull()
      expect(parseDisclosure(b64uEncode('["","name","v"]'))).toBeNull()
      expect(parseDisclosure('')).toBeNull()
    })
  })

  describe('resolveDisclosures', () => {
    it('resolves disclosures whose digests are in _sd', () => {
      const band = makeDisclosure('score_band', 'GOOD')
      const name = makeDisclosure('given_name', 'Asha')
      const { claims, errors } = resolveDisclosures(
        [band.digest, name.digest],
        [band.encoded, name.encoded],
      )

      expect(errors).toEqual([])
      expect(claims).toEqual({ score_band: 'GOOD', given_name: 'Asha' })
    })

    it('reveals nothing about undisclosed claims', () => {
      const shown = makeDisclosure('score_at_least_good', true)
      const hidden = makeDisclosure('score_value', 812)
      const { claims } = resolveDisclosures(
        [shown.digest, hidden.digest],
        [shown.encoded],
      )

      // The exact score is a salted digest and nothing more. This is the property the
      // whole module exists to provide.
      expect(claims).toEqual({ score_at_least_good: true })
      expect(Object.keys(claims)).not.toContain('score_value')
    })

    it('rejects a claim lifted from a different credential', () => {
      const mine = makeDisclosure('score_band', 'FAIR')
      const foreign = makeDisclosure('score_band', 'EXCELLENT')
      const { claims, errors } = resolveDisclosures(
        [mine.digest],
        [foreign.encoded],
      )

      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/not part of this credential/)
      expect(claims).toEqual({})
    })

    it('rejects a duplicated disclosure', () => {
      const one = makeDisclosure('nationality', 'IN')
      const { errors } = resolveDisclosures(
        [one.digest],
        [one.encoded, one.encoded],
      )
      expect(errors[0]).toMatch(/sent twice/)
    })

    it('refuses a disclosure that would overwrite a signed claim', () => {
      // Without this, a holder could disclose `exp` or `cnf` and rewrite their own
      // expiry or key binding — claims the ISSUER signed in the clear.
      for (const reserved of ['exp', 'cnf', 'iss', '_sd', 'status']) {
        const evil = makeDisclosure(reserved, 'forged')
        const { errors, claims } = resolveDisclosures(
          [evil.digest],
          [evil.encoded],
        )
        expect(errors[0]).toMatch(/reserved claim name/)
        expect(claims[reserved]).toBeUndefined()
      }
    })
  })

  describe('wire format', () => {
    it('serialises issuance with a trailing separator', () => {
      // The trailing `~` is required even with no KB-JWT: a parser reads the segment
      // after the last `~` as the KB-JWT, so dropping it turns the final disclosure
      // into a malformed proof.
      const combined = serializeIssuance('JWT', ['D1', 'D2'])
      expect(combined).toBe('JWT~D1~D2~')

      const parts = parseCombined(combined)
      expect(parts.jwt).toBe('JWT')
      expect(parts.disclosures).toEqual(['D1', 'D2'])
      expect(parts.kbJwt).toBeUndefined()
    })

    it('serialises and parses a presentation with a KB-JWT', () => {
      const parts = parseCombined(serializePresentation('JWT', ['D1'], 'KB'))
      expect(parts.jwt).toBe('JWT')
      expect(parts.disclosures).toEqual(['D1'])
      expect(parts.kbJwt).toBe('KB')
    })

    it('handles a presentation with no disclosures at all', () => {
      // Presenting zero claims still proves "PRAVAAH issued a live passport to the
      // holder of this device" — a real assertion, and the most private one available.
      const parts = parseCombined(serializePresentation('JWT', [], 'KB'))
      expect(parts.disclosures).toEqual([])
      expect(parts.kbJwt).toBe('KB')
    })

    it('rejects a structurally impossible string', () => {
      expect(() => parseCombined('JWT')).toThrow(/trailing separator/)
    })
  })

  describe('computeSdHash — the disclosure-substitution defence', () => {
    it('changes when the disclosure set changes', () => {
      // THE check people forget. Without sd_hash, a KB-JWT proves only "the holder
      // signed this nonce for this audience", and an interceptor could keep the signed
      // proof while swapping the disclosures — turning a credential that revealed a
      // boolean into one that revealed an exact score, with the holder's own signature
      // still attached.
      const base = computeSdHash('JWT', ['D1'])
      expect(computeSdHash('JWT', ['D1', 'D2'])).not.toBe(base)
      expect(computeSdHash('JWT', [])).not.toBe(base)
      expect(computeSdHash('JWT', ['D2'])).not.toBe(base)
    })

    it('is order-sensitive, so a reordered set is a different commitment', () => {
      expect(computeSdHash('JWT', ['D1', 'D2'])).not.toBe(
        computeSdHash('JWT', ['D2', 'D1']),
      )
    })

    it('covers the presentation up to and including the final separator', () => {
      const expected = b64uEncode(
        createHash('sha256').update(Buffer.from('JWT~D1~', 'ascii')).digest(),
      )
      expect(computeSdHash('JWT', ['D1'])).toBe(expected)
    })

    it('excludes the KB-JWT itself', () => {
      // A hash that included the KB-JWT could never be computed before signing it.
      const hash = computeSdHash('JWT', ['D1'])
      const presentation = serializePresentation('JWT', ['D1'], 'KB')
      expect(presentation.endsWith('~KB')).toBe(true)
      expect(hash).toBe(computeSdHash('JWT', ['D1']))
    })
  })

  describe('buildSdJwtPayload', () => {
    const { publicJwk } = generateEs256KeyPair()

    const payload = buildSdJwtPayload({
      issuer: 'did:web:pravaah.app',
      vct: 'https://pravaah.app/credentials/financial-reputation-passport/v1',
      subjectDid: 'did:key:zDnaeX',
      holderPublicJwk: publicJwk,
      issuedAt: 1_700_000_000,
      expiresAt: 1_710_000_000,
      statusList: { uri: 'https://pravaah.app/api/v1/status/1', index: 42 },
      visibleClaims: { document_type: 'FINANCIAL_REPUTATION_PASSPORT' },
      sdDigests: ['zzz', 'aaa', 'mmm'],
    })

    it('pins the holder key in cnf', () => {
      expect(payload.cnf).toEqual({ jwk: publicJwk })
    })

    it('carries the status reference a verifier needs for revocation', () => {
      expect(payload.status).toEqual({
        status_list: { idx: 42, uri: 'https://pravaah.app/api/v1/status/1' },
      })
    })

    it('sorts _sd so digest position cannot leak which claim it is', () => {
      // Our claim ordering is PUBLIC — it is in the shared schema package. If `_sd`
      // preserved insertion order, the index of a digest would identify the claim, and
      // selective disclosure would collapse for anyone who read the package.
      expect(payload._sd).toEqual(['aaa', 'mmm', 'zzz'])
      expect(payload._sd_alg).toBe('sha-256')
    })

    it('keeps always-visible claims in the clear', () => {
      expect(payload.document_type).toBe('FINANCIAL_REPUTATION_PASSPORT')
    })

    it('never emits a disclosure digest that is not in _sd', () => {
      const digests = new Set(payload._sd as string[])
      expect(digests.size).toBe(3)
      expect(disclosureDigest('anything-else')).not.toBe('aaa')
    })
  })
})
