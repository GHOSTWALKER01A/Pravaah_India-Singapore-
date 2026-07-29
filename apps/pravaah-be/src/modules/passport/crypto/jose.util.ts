import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto'

/**
 * JOSE primitives (JWS · JWK · did:key) for the M3 passport, built directly on
 * `node:crypto`.
 *
 * Why not a library: the obvious candidate, `jose`, is ESM-only from v5 and this
 * is a CommonJS NestJS build, so it cannot be `require`d without a dynamic-import
 * shim in the hot path of every signature. Node's own crypto already implements
 * everything ES256 needs — the only real work is the two JOSE-specific details
 * that a naive implementation gets wrong, both handled explicitly below:
 *
 *  1. SIGNATURE ENCODING. Node emits ASN.1/DER ECDSA signatures by default; JWS
 *     mandates the fixed-width IEEE P-1363 form (r ‖ s, 32 bytes each). Getting
 *     this wrong produces signatures that verify locally and are rejected by
 *     every standards-compliant wallet — the worst kind of bug, because our own
 *     tests would pass. `dsaEncoding: 'ieee-p1363'` pins it on both paths.
 *
 *  2. CANONICAL JWK THUMBPRINTS. RFC 7638 hashes a JSON object with EXACTLY the
 *     required members, in lexicographic order, with no whitespace. Hashing the
 *     JWK as received would make the same key produce different thumbprints
 *     depending on how a wallet ordered its JSON.
 */

// ── base64url ───────────────────────────────────────────────────────────────
export function b64uEncode(input: Buffer | Uint8Array | string): string {
  const buf =
    typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  return buf.toString('base64url')
}

export function b64uDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url')
}

export function b64uToString(input: string): string {
  return b64uDecode(input).toString('utf8')
}

/**
 * base64url is not self-validating — `Buffer.from` silently drops any character
 * it does not recognise, so `"!!!"` decodes to an empty buffer instead of
 * failing. Every value that arrives from the network is checked against the
 * alphabet first, so malformed input is a 400 rather than a mysterious empty
 * claim.
 */
const B64U = /^[A-Za-z0-9_-]+$/
export function isB64u(input: string): boolean {
  return typeof input === 'string' && input.length > 0 && B64U.test(input)
}

// ── hashing ─────────────────────────────────────────────────────────────────
export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest()
}

/**
 * The SD-JWT digest of a disclosure.
 *
 * Hashed over the ASCII of the base64url disclosure STRING, not over the bytes it
 * decodes to. That is what the spec says, and it matters: it means a verifier
 * never has to re-encode a disclosure (and risk producing a different byte string
 * from the same JSON) before checking membership in `_sd`.
 */
export function disclosureDigest(disclosureB64u: string): string {
  return b64uEncode(sha256(Buffer.from(disclosureB64u, 'ascii')))
}

// ── JWK types ───────────────────────────────────────────────────────────────
/**
 * Type aliases rather than interfaces, and not by accident: only aliases get
 * TypeScript's implicit index signature, which is what lets a JWK be written straight
 * into a Prisma `Json` column (`InputJsonValue`) without a cast. The same reason M2's
 * `DriftWindow` is an alias.
 */
export type EcPublicJwk = {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  kid?: string
  alg?: string
  use?: string
}

export type EcPrivateJwk = EcPublicJwk & { d: string }

/** Structural check for a P-256 public JWK. Cheap gate before any key import. */
export function isEcPublicJwk(value: unknown): value is EcPublicJwk {
  const jwk = value as Partial<EcPublicJwk> | null
  return (
    !!jwk &&
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    typeof jwk.y === 'string' &&
    isB64u(jwk.x) &&
    isB64u(jwk.y) &&
    b64uDecode(jwk.x).length === 32 &&
    b64uDecode(jwk.y).length === 32
  )
}

/** Strip every private/optional member, leaving the canonical public key. */
export function toPublicJwk(jwk: EcPublicJwk | EcPrivateJwk): EcPublicJwk {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

// ── key handling ────────────────────────────────────────────────────────────
export interface GeneratedKeyPair {
  publicJwk: EcPublicJwk
  privateJwk: EcPrivateJwk
}

/** Fresh P-256 (prime256v1) keypair, exported as JWKs. */
export function generateEs256KeyPair(): GeneratedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  return {
    publicJwk: toPublicJwk(publicKey.export({ format: 'jwk' }) as EcPublicJwk),
    privateJwk: privateKey.export({ format: 'jwk' }) as EcPrivateJwk,
  }
}

export function importPrivateKey(jwk: EcPrivateJwk): KeyObject {
  return createPrivateKey({ key: jwk as JsonWebKey, format: 'jwk' })
}

/**
 * Import a public JWK.
 *
 * Node rejects a point that is not on the P-256 curve, so an attacker cannot
 * supply a crafted `cnf` key to mount an invalid-curve attack. That check is the
 * reason this goes through `createPublicKey` rather than reconstructing the point
 * by hand — and the reason the throw is left to propagate.
 */
export function importPublicKey(jwk: EcPublicJwk): KeyObject {
  return createPublicKey({
    key: { ...toPublicJwk(jwk) } as JsonWebKey,
    format: 'jwk',
  })
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the canonical JSON of exactly the
 * required members, lexicographically ordered, no whitespace. For an EC key that
 * is `{"crv":...,"kty":...,"x":...,"y":...}` — and nothing else, which is why
 * `kid`/`alg`/`use` are dropped rather than passed through.
 */
export function jwkThumbprint(jwk: EcPublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64uEncode(sha256(Buffer.from(canonical, 'utf8')))
}

// ── did:key (P-256) ─────────────────────────────────────────────────────────
/**
 * Multicodec prefix for `p256-pub` (0x1200), unsigned-varint encoded as
 * `0x80 0x24`. Two bytes, and they are the difference between a DID other
 * implementations resolve and one only we understand.
 */
const P256_MULTICODEC_PREFIX = Buffer.from([0x80, 0x24])

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** base58btc, as `did:key` requires (multibase prefix `z` added by the caller). */
export function base58btcEncode(bytes: Buffer): string {
  if (bytes.length === 0) return ''
  // Leading zero bytes carry no numeric weight, so they must be re-emitted as
  // explicit '1's after the big-integer conversion, or they vanish.
  let leadingZeros = 0
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++

  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)

  let out = ''
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out
    value /= 58n
  }
  return '1'.repeat(leadingZeros) + out
}

export function base58btcDecode(input: string): Buffer {
  let leadingOnes = 0
  while (leadingOnes < input.length && input[leadingOnes] === '1') leadingOnes++

  let value = 0n
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index < 0) throw new Error(`Invalid base58 character: ${char}`)
    value = value * 58n + BigInt(index)
  }

  const bytes: number[] = []
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn))
    value >>= 8n
  }
  return Buffer.from([...new Array<number>(leadingOnes).fill(0), ...bytes])
}

/**
 * SEC1 point compression: `0x02`/`0x03` (by the parity of y) followed by x.
 * did:key encodes the compressed form, which halves the DID's length and is what
 * every other did:key implementation expects.
 */
function compressP256Point(jwk: EcPublicJwk): Buffer {
  const x = b64uDecode(jwk.x)
  const y = b64uDecode(jwk.y)
  const prefix = (y[y.length - 1]! & 1) === 0 ? 0x02 : 0x03
  return Buffer.concat([Buffer.from([prefix]), x])
}

/** `did:key:z…` for a P-256 public key — the credential's `sub`. */
export function didKeyFromJwk(jwk: EcPublicJwk): string {
  const multicodec = Buffer.concat([
    P256_MULTICODEC_PREFIX,
    compressP256Point(jwk),
  ])
  return `did:key:z${base58btcEncode(multicodec)}`
}

// ── compact JWS (ES256) ─────────────────────────────────────────────────────
export interface JwsHeader {
  alg: 'ES256'
  typ: string
  kid?: string
  [key: string]: unknown
}

/**
 * Sign a compact JWS.
 *
 * `dsaEncoding: 'ieee-p1363'` is load-bearing: without it Node produces a DER
 * signature and the token is rejected by every spec-compliant verifier.
 */
export function signCompactJws(args: {
  header: JwsHeader
  payload: Record<string, unknown>
  privateKey: KeyObject
}): string {
  const header = b64uEncode(JSON.stringify(args.header))
  const payload = b64uEncode(JSON.stringify(args.payload))
  const signingInput = `${header}.${payload}`
  const signature = nodeSign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: args.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${b64uEncode(signature)}`
}

export interface DecodedJws {
  header: JwsHeader
  payload: Record<string, unknown>
  signingInput: string
  signature: Buffer
}

/**
 * Split and JSON-decode a compact JWS WITHOUT verifying it.
 *
 * Named `decode…Unverified` on purpose. Reading the header's `kid` is a genuine
 * prerequisite to choosing a verification key, but everything it returns is
 * attacker-controlled until {@link verifyCompactJws} has run — so the name makes
 * a caller that forgets that read wrong.
 */
export function decodeJwsUnverified(token: string): DecodedJws {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Malformed JWS: expected three dot-separated segments')
  }
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ]
  if (!isB64u(headerB64) || !isB64u(payloadB64) || !isB64u(signatureB64)) {
    throw new Error('Malformed JWS: segments are not base64url')
  }

  let header: JwsHeader
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(b64uToString(headerB64)) as JwsHeader
    payload = JSON.parse(b64uToString(payloadB64)) as Record<string, unknown>
  } catch {
    throw new Error('Malformed JWS: header or payload is not JSON')
  }
  if (!header || typeof header !== 'object') {
    throw new Error('Malformed JWS: header is not an object')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Malformed JWS: payload is not a JSON object')
  }

  return {
    header,
    payload,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: b64uDecode(signatureB64),
  }
}

/**
 * Verify a compact JWS against a public key.
 *
 * The `alg` is checked against ES256 BEFORE the signature, and taken from our own
 * expectation rather than from the token. Trusting the token's own `alg` is the
 * classic JWS confusion attack (`alg: none`, or an RSA key coerced into HMAC);
 * here the algorithm is fixed by policy and the header field is only ever
 * validated, never obeyed.
 *
 * Returns `false` rather than throwing on a bad signature: for a verifier, an
 * invalid signature is an ordinary answer, not an exceptional one.
 */
export function verifyCompactJws(
  decoded: DecodedJws,
  publicKey: KeyObject,
): boolean {
  if (decoded.header.alg !== 'ES256') return false
  // A P-1363 P-256 signature is exactly 64 bytes. Node tolerates other lengths
  // by failing the verify, but rejecting early keeps a malformed token from
  // reaching the curve maths at all.
  if (decoded.signature.length !== 64) return false
  try {
    return nodeVerify(
      'sha256',
      Buffer.from(decoded.signingInput, 'ascii'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      decoded.signature,
    )
  } catch {
    return false
  }
}

/** Seconds since the epoch — the unit every JWT time claim is expressed in. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Clock skew tolerated on `exp` / `iat` / `nbf`.
 *
 * Without it, a phone whose clock is thirty seconds fast produces a KB-JWT the
 * server reads as issued in the future and rejects — a failure the user
 * experiences as "the passport is broken" and can do nothing about.
 */
export const CLOCK_SKEW_SECONDS = 120
