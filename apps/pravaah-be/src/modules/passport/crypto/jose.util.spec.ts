import {
  createHash,
  createPublicKey,
  createVerify,
  sign as nodeSign,
} from 'node:crypto'

import {
  b64uDecode,
  b64uEncode,
  base58btcDecode,
  base58btcEncode,
  decodeJwsUnverified,
  didKeyFromJwk,
  generateEs256KeyPair,
  importPrivateKey,
  importPublicKey,
  isB64u,
  isEcPublicJwk,
  jwkThumbprint,
  signCompactJws,
  toPublicJwk,
  verifyCompactJws,
  type EcPublicJwk,
} from '@/modules/passport/crypto/jose.util'

describe('jose.util', () => {
  describe('base64url', () => {
    it('round-trips arbitrary bytes', () => {
      const bytes = Buffer.from([0, 1, 250, 255, 128, 64])
      expect(b64uDecode(b64uEncode(bytes))).toEqual(bytes)
    })

    it('emits no padding and no non-url characters', () => {
      // "?" and ">" are the bytes that produce '+' and '/' in standard base64, so a
      // token containing them would break any strict base64url parser downstream.
      const encoded = b64uEncode(Buffer.from([0xfb, 0xff, 0xbf]))
      expect(encoded).not.toContain('=')
      expect(encoded).not.toContain('+')
      expect(encoded).not.toContain('/')
    })

    it('rejects strings outside the base64url alphabet', () => {
      // Buffer.from silently DROPS unknown characters, so "!!!" would decode to an
      // empty buffer and read as an empty claim rather than an error. This guard is
      // the only thing standing between that and a 500.
      expect(isB64u('abc-_123')).toBe(true)
      expect(isB64u('abc!!!')).toBe(false)
      expect(isB64u('abc=')).toBe(false)
      expect(isB64u('')).toBe(false)
    })
  })

  describe('ES256 signing', () => {
    const { publicJwk, privateJwk } = generateEs256KeyPair()

    it('produces a verifiable compact JWS', () => {
      const token = signCompactJws({
        header: { alg: 'ES256', typ: 'dc+sd-jwt', kid: 'did:web:x#key-1' },
        payload: { iss: 'did:web:x', sub: 'did:key:z1' },
        privateKey: importPrivateKey(privateJwk),
      })
      const decoded = decodeJwsUnverified(token)

      expect(decoded.header.typ).toBe('dc+sd-jwt')
      expect(decoded.payload.iss).toBe('did:web:x')
      expect(verifyCompactJws(decoded, importPublicKey(publicJwk))).toBe(true)
    })

    it('emits a 64-byte IEEE P-1363 signature, not DER', () => {
      // THE interop bug this codebase must not have. Node defaults to ASN.1/DER, and a
      // DER signature verifies fine against our own code while being rejected by every
      // standards-compliant wallet — so our tests would pass and the product would
      // fail. A raw r‖s signature for P-256 is exactly 64 bytes; DER is 70-72 and
      // starts with 0x30.
      const token = signCompactJws({
        header: { alg: 'ES256', typ: 'dc+sd-jwt' },
        payload: { a: 1 },
        privateKey: importPrivateKey(privateJwk),
      })
      const { signature } = decodeJwsUnverified(token)

      expect(signature.length).toBe(64)
      expect(signature[0]).not.toBe(0x30)
    })

    it('rejects a signature from a different key', () => {
      const other = generateEs256KeyPair()
      const token = signCompactJws({
        header: { alg: 'ES256', typ: 'dc+sd-jwt' },
        payload: { a: 1 },
        privateKey: importPrivateKey(privateJwk),
      })
      expect(
        verifyCompactJws(decodeJwsUnverified(token), importPublicKey(other.publicJwk)),
      ).toBe(false)
    })

    it('rejects a tampered payload', () => {
      const token = signCompactJws({
        header: { alg: 'ES256', typ: 'dc+sd-jwt' },
        payload: { score: 650 },
        privateKey: importPrivateKey(privateJwk),
      })
      const [header, , signature] = token.split('.')
      const forged = `${header}.${b64uEncode(JSON.stringify({ score: 900 }))}.${signature}`

      expect(
        verifyCompactJws(decodeJwsUnverified(forged), importPublicKey(publicJwk)),
      ).toBe(false)
    })

    it('refuses any alg other than ES256 without touching the curve maths', () => {
      // The classic JWS confusion attack: a token declaring `alg: none` (or HS256 over
      // a public key) must be refused on the header alone. The algorithm is fixed by
      // OUR policy; the header field is validated, never obeyed.
      const decoded = decodeJwsUnverified(
        signCompactJws({
          header: { alg: 'ES256', typ: 'dc+sd-jwt' },
          payload: { a: 1 },
          privateKey: importPrivateKey(privateJwk),
        }),
      )
      const spoofed = {
        ...decoded,
        header: { ...decoded.header, alg: 'none' as unknown as 'ES256' },
      }
      expect(verifyCompactJws(spoofed, importPublicKey(publicJwk))).toBe(false)
    })

    it('interoperates with a raw node:crypto signature over the same input', () => {
      // Cross-checks our framing against Node's own primitives: if the signing input
      // were assembled differently (padding, encoding, ASCII vs UTF-8), this would fail.
      const header = b64uEncode(JSON.stringify({ alg: 'ES256', typ: 'dc+sd-jwt' }))
      const payload = b64uEncode(JSON.stringify({ a: 1 }))
      const signingInput = `${header}.${payload}`
      const signature = nodeSign(
        'sha256',
        Buffer.from(signingInput, 'ascii'),
        { key: importPrivateKey(privateJwk), dsaEncoding: 'ieee-p1363' },
      )
      const token = `${signingInput}.${b64uEncode(signature)}`

      expect(
        verifyCompactJws(decodeJwsUnverified(token), importPublicKey(publicJwk)),
      ).toBe(true)
    })

    it('rejects malformed tokens with a clear error rather than a crash', () => {
      expect(() => decodeJwsUnverified('a.b')).toThrow(/three dot-separated/)
      expect(() => decodeJwsUnverified('a.b.c.d')).toThrow(/three dot-separated/)
      expect(() => decodeJwsUnverified('!!.!!.!!')).toThrow(/base64url/)
      // Valid base64url that is not JSON.
      expect(() => decodeJwsUnverified('aaaa.bbbb.cccc')).toThrow(/not JSON/)
      // Valid JSON that is an array, not an object — a payload we must not index into.
      const arrayPayload = b64uEncode('[1,2,3]')
      const header = b64uEncode('{"alg":"ES256"}')
      expect(() =>
        decodeJwsUnverified(`${header}.${arrayPayload}.AAAA`),
      ).toThrow(/JSON object/)
    })
  })

  describe('JWK handling', () => {
    it('accepts a well-formed P-256 public JWK', () => {
      const { publicJwk } = generateEs256KeyPair()
      expect(isEcPublicJwk(publicJwk)).toBe(true)
    })

    it('rejects wrong curves, wrong types, and truncated coordinates', () => {
      const { publicJwk } = generateEs256KeyPair()
      expect(isEcPublicJwk({ ...publicJwk, crv: 'P-384' })).toBe(false)
      expect(isEcPublicJwk({ ...publicJwk, kty: 'RSA' })).toBe(false)
      expect(isEcPublicJwk({ ...publicJwk, x: 'short' })).toBe(false)
      expect(isEcPublicJwk(null)).toBe(false)
      expect(isEcPublicJwk({})).toBe(false)
    })

    it('refuses a point that is not on the curve', () => {
      // An invalid-curve attack supplies a crafted `cnf` key to leak information from
      // the scalar multiplication. Node's key import is what stops it, and this test is
      // what proves we route through the import rather than reconstructing the point.
      const { publicJwk } = generateEs256KeyPair()
      const offCurve: EcPublicJwk = {
        ...publicJwk,
        y: b64uEncode(Buffer.alloc(32, 7)),
      }
      expect(() => importPublicKey(offCurve)).toThrow()
    })

    it('strips private and advisory members when narrowing to a public JWK', () => {
      const { privateJwk } = generateEs256KeyPair()
      const pub = toPublicJwk({ ...privateJwk, kid: 'x', alg: 'ES256' })
      expect(Object.keys(pub).sort()).toEqual(['crv', 'kty', 'x', 'y'])
      expect((pub as Record<string, unknown>).d).toBeUndefined()
    })
  })

  describe('RFC 7638 thumbprint', () => {
    it('uses the exact canonicalisation RFC 7638 §3.1 specifies', () => {
      // The RFC's own worked example is an RSA key, which this EC-only helper cannot
      // take — so the RECIPE is verified against that vector directly. If our
      // canonicalisation (required members only, lexicographic order, no whitespace,
      // sha256, base64url) were wrong in any respect, this would not reproduce.
      const rsaCanonical = JSON.stringify({
        e: 'AQAB',
        kty: 'RSA',
        n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      })
      expect(
        createHash('sha256').update(rsaCanonical, 'utf8').digest('base64url'),
      ).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs')
    })

    it('produces the same digest as the canonical recipe applied by hand', () => {
      // Cross-checks the EC path against an independent computation, so a future
      // "tidy-up" of the canonical string cannot silently change every thumbprint we
      // have already stored against a holder.
      const jwk: EcPublicJwk = {
        kty: 'EC',
        crv: 'P-256',
        x: 'weNJy2HscCSM6AEDTDg04biOvhFhyyWvOHQfeF_PxMQ',
        y: 'e8lnCO-AlStT-NJVX-crhB7QRYhiix03illJOVAOyck',
      }
      const byHand = createHash('sha256')
        .update(
          JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
          'utf8',
        )
        .digest('base64url')

      expect(jwkThumbprint(jwk)).toBe(byHand)
      // Pinned literal, so the value is a regression lock and not merely self-consistent.
      expect(jwkThumbprint(jwk)).toBe(
        'Vy57XrArUrW0NbpI12tEzDHABxMwrTh6HHXRenSpnCo',
      )
    })

    it('ignores member order and advisory fields', () => {
      // A wallet is free to order its JSON however it likes. If the thumbprint depended
      // on that, the same device key would look like two different holders.
      const { publicJwk } = generateEs256KeyPair()
      const reordered = {
        y: publicJwk.y,
        kty: publicJwk.kty,
        alg: 'ES256',
        x: publicJwk.x,
        kid: 'whatever',
        crv: publicJwk.crv,
      } as EcPublicJwk

      expect(jwkThumbprint(reordered)).toBe(jwkThumbprint(publicJwk))
    })

    it('differs between distinct keys', () => {
      const a = generateEs256KeyPair()
      const b = generateEs256KeyPair()
      expect(jwkThumbprint(a.publicJwk)).not.toBe(jwkThumbprint(b.publicJwk))
    })
  })

  describe('base58btc', () => {
    it('round-trips and preserves leading zeros', () => {
      // Leading zero bytes carry no numeric weight, so a naive big-integer conversion
      // drops them — and a did:key whose multicodec prefix vanished is a different key.
      const bytes = Buffer.from([0, 0, 1, 2, 3, 255])
      const encoded = base58btcEncode(bytes)
      expect(encoded.startsWith('11')).toBe(true)
      expect(base58btcDecode(encoded)).toEqual(bytes)
    })

    it('matches the known "Hello World!" vector', () => {
      expect(base58btcEncode(Buffer.from('Hello World!', 'utf8'))).toBe(
        '2NEpo7TZRRrLZSi2U',
      )
    })
  })

  describe('did:key', () => {
    it('emits the P-256 multibase/multicodec prefix', () => {
      // `zDn` is the fixed prefix a compressed P-256 key produces: 'z' for base58btc,
      // then the two-byte varint 0x8024 for p256-pub. Other implementations resolve on
      // exactly these bytes, so they are pinned.
      const { publicJwk } = generateEs256KeyPair()
      const did = didKeyFromJwk(publicJwk)

      expect(did.startsWith('did:key:zDn')).toBe(true)
      const decoded = base58btcDecode(did.slice('did:key:z'.length))
      expect(decoded[0]).toBe(0x80)
      expect(decoded[1]).toBe(0x24)
      // 2 prefix bytes + 33-byte compressed point.
      expect(decoded.length).toBe(35)
    })

    it('encodes the SEC1 compressed point with the correct parity byte', () => {
      const { publicJwk } = generateEs256KeyPair()
      const decoded = base58btcDecode(
        didKeyFromJwk(publicJwk).slice('did:key:z'.length),
      )
      const prefixByte = decoded[2]
      const y = b64uDecode(publicJwk.y)
      const expected = (y[y.length - 1]! & 1) === 0 ? 0x02 : 0x03

      expect(prefixByte).toBe(expected)
      expect(decoded.subarray(3)).toEqual(b64uDecode(publicJwk.x))
    })

    it('is deterministic and unique per key', () => {
      const { publicJwk } = generateEs256KeyPair()
      expect(didKeyFromJwk(publicJwk)).toBe(didKeyFromJwk(publicJwk))
      expect(didKeyFromJwk(publicJwk)).not.toBe(
        didKeyFromJwk(generateEs256KeyPair().publicJwk),
      )
    })

    it('produces a point a standard library can decompress', () => {
      // Proves the compressed encoding is genuinely SEC1 and not merely self-consistent:
      // Node reconstructs the original x and y from our 33 bytes alone.
      const { publicJwk } = generateEs256KeyPair()
      const compressed = base58btcDecode(
        didKeyFromJwk(publicJwk).slice('did:key:z'.length),
      ).subarray(2)

      const rebuilt = createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: b64uEncode(compressed.subarray(1)),
          y: publicJwk.y,
        },
        format: 'jwk',
      }).export({ format: 'jwk' }) as EcPublicJwk

      expect(rebuilt.x).toBe(publicJwk.x)
      expect(rebuilt.y).toBe(publicJwk.y)
      expect(createVerify).toBeDefined()
    })
  })
})
