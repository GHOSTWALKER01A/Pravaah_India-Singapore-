import { randomBytes } from 'node:crypto'

import {
  KB_JWT_TYP,
  PASSPORT_ALG,
  SD_JWT_SEPARATOR,
} from '@pravaah/schema'

import {
  b64uDecode,
  b64uEncode,
  disclosureDigest,
  isB64u,
  sha256,
  type EcPublicJwk,
} from '@/modules/passport/crypto/jose.util'

/**
 * SD-JWT VC mechanics (IETF `dc+sd-jwt`): salted disclosures, the combined wire
 * format, and holder key binding.
 *
 * The whole scheme in three sentences:
 *
 *  - The issuer signs a JWT whose payload holds non-sensitive claims in the clear
 *    plus `_sd`, an array of salted SHA-256 DIGESTS of the sensitive ones.
 *  - Alongside it travel DISCLOSURES: the salted cleartext `[salt, name, value]`
 *    for each digest. The holder forwards only the ones they choose.
 *  - The verifier hashes each disclosure it receives and checks membership in
 *    `_sd`. Anything not disclosed is a digest of a random salt — un-invertible,
 *    and indistinguishable from any other undisclosed claim.
 *
 * Two properties are easy to lose and are defended explicitly here: the salt must
 * be per-claim and unguessable (or a verifier could brute-force `score_value`
 * across its 601 possible values), and the KB-JWT must commit to the exact
 * disclosure set (or disclosures could be swapped after the holder signed).
 */

/**
 * 128 bits of salt per claim.
 *
 * Sized against the real attack: a verifier who receives `score_band` but not
 * `score_value` knows there are only 601 possible scores, and would simply hash
 * all of them against the undisclosed digest. The salt is what makes that
 * 2^128 × 601 instead of 601.
 */
const SALT_BYTES = 16

/** Cap on a single disclosure, to bound parse work on hostile input. */
const MAX_DISCLOSURE_CHARS = 8192
/** Cap on disclosures in one presentation. Our credential mints ~20. */
const MAX_DISCLOSURES = 64

export interface Disclosure {
  /** The base64url string that travels on the wire and IS what gets hashed. */
  encoded: string
  /** Its digest, as it appears in `_sd`. */
  digest: string
  salt: string
  name: string
  value: unknown
}

/**
 * Build one selectively-disclosable claim.
 *
 * The JSON is serialised from a three-element array exactly as the spec defines,
 * and the digest is taken over the resulting base64url string — never over a
 * re-serialisation. That asymmetry is deliberate: the issuer's exact bytes are
 * the ones the verifier hashes, so two JSON serialisers disagreeing about spacing
 * can never break a credential.
 */
export function makeDisclosure(name: string, value: unknown): Disclosure {
  const salt = b64uEncode(randomBytes(SALT_BYTES))
  const encoded = b64uEncode(JSON.stringify([salt, name, value]))
  return { encoded, digest: disclosureDigest(encoded), salt, name, value }
}

export interface ParsedDisclosure {
  encoded: string
  digest: string
  salt: string
  name: string
  value: unknown
}

/**
 * Parse a disclosure received from a holder. Returns null for anything malformed
 * rather than throwing — a verifier processes a list, and one bad entry should
 * produce a precise rejection reason, not abort the whole verification.
 */
export function parseDisclosure(encoded: string): ParsedDisclosure | null {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MAX_DISCLOSURE_CHARS ||
    !isB64u(encoded)
  ) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(b64uDecode(encoded).toString('utf8'))
  } catch {
    return null
  }

  // Exactly three elements: object-property disclosures only. Array-element
  // disclosures (the two-element form) are a valid part of the spec we do not
  // mint, and accepting a shape we never issue only widens the parser.
  if (!Array.isArray(parsed) || parsed.length !== 3) return null
  const [salt, name, value] = parsed as [unknown, unknown, unknown]
  if (typeof salt !== 'string' || typeof name !== 'string') return null
  if (salt.length === 0 || name.length === 0) return null

  return { encoded, digest: disclosureDigest(encoded), salt, name, value }
}

// ── the combined wire format ────────────────────────────────────────────────
export interface SdJwtParts {
  /** The issuer-signed JWT. */
  jwt: string
  /** Encoded disclosure strings, in wire order. */
  disclosures: string[]
  /** The holder's Key Binding JWT, when one is present. */
  kbJwt?: string
}

/**
 * Serialise the issuance form: `<jwt>~<d1>~…~<dN>~`.
 *
 * The TRAILING separator is required even with no KB-JWT. It is what makes the
 * format unambiguous — a parser reads the segment after the last `~` as the
 * KB-JWT, and an empty one means "none". Dropping it turns the final disclosure
 * into a malformed KB-JWT.
 */
export function serializeIssuance(jwt: string, disclosures: string[]): string {
  return [jwt, ...disclosures, ''].join(SD_JWT_SEPARATOR)
}

/** Serialise the presentation form: `<jwt>~<selected…>~<kb-jwt>`. */
export function serializePresentation(
  jwt: string,
  disclosures: string[],
  kbJwt?: string,
): string {
  return [jwt, ...disclosures, kbJwt ?? ''].join(SD_JWT_SEPARATOR)
}

/** Split a combined SD-JWT VC string. Throws only on a structurally impossible input. */
export function parseCombined(input: string): SdJwtParts {
  const segments = input.trim().split(SD_JWT_SEPARATOR)
  if (segments.length < 2) {
    throw new Error(
      'Malformed SD-JWT: expected at least a JWT and a trailing separator',
    )
  }
  const jwt = segments[0]!
  const kbSegment = segments[segments.length - 1]!
  const disclosures = segments.slice(1, -1).filter((s) => s.length > 0)

  if (disclosures.length > MAX_DISCLOSURES) {
    throw new Error('Malformed SD-JWT: too many disclosures')
  }
  return {
    jwt,
    disclosures,
    kbJwt: kbSegment.length > 0 ? kbSegment : undefined,
  }
}

// ── key binding ─────────────────────────────────────────────────────────────
/**
 * The `sd_hash` a KB-JWT must commit to: SHA-256 over the presentation string up
 * to and INCLUDING the separator that precedes the KB-JWT.
 *
 * This is the defence people forget. Without it a KB-JWT proves only "the holder
 * signed this nonce for this audience", and an interceptor could keep the signed
 * proof while swapping in a different set of disclosures — turning a credential
 * that revealed `score_at_least_good` into one that revealed `score_value`,
 * with the holder's own signature still attached. Committing to the exact bytes
 * makes the disclosure set unforgeable after the fact.
 */
export function computeSdHash(jwt: string, disclosures: string[]): string {
  const bound = [jwt, ...disclosures, ''].join(SD_JWT_SEPARATOR)
  return b64uEncode(sha256(Buffer.from(bound, 'ascii')))
}

export interface KbJwtPayload {
  iat: number
  aud: string
  nonce: string
  sd_hash: string
}

/** The protected header every KB-JWT must carry. */
export const KB_JWT_HEADER = { alg: PASSPORT_ALG, typ: KB_JWT_TYP } as const

// ── SD-JWT payload assembly ─────────────────────────────────────────────────
export interface SdJwtPayloadInput {
  issuer: string
  vct: string
  subjectDid: string
  holderPublicJwk: EcPublicJwk
  issuedAt: number
  expiresAt: number
  statusList: { uri: string; index: number }
  /** Claims that travel in the clear. */
  visibleClaims: Record<string, unknown>
  /** Digests of the selectively-disclosable claims. */
  sdDigests: string[]
}

/**
 * Assemble the issuer-signed payload.
 *
 * `_sd` is SORTED. The spec requires the digest order to be decorrelated from the
 * claim order, and sorting is the simplest way to guarantee it: without it, the
 * position of a digest would leak which claim it belongs to, and the entire
 * selective-disclosure property would collapse for anyone who knows our claim
 * ordering — which is public, because it is in the shared schema package.
 */
export function buildSdJwtPayload(
  input: SdJwtPayloadInput,
): Record<string, unknown> {
  return {
    iss: input.issuer,
    vct: input.vct,
    sub: input.subjectDid,
    iat: input.issuedAt,
    exp: input.expiresAt,
    // Holder key binding: the public half of the key that must sign every
    // presentation. This one claim is what makes a stolen credential inert.
    cnf: { jwk: input.holderPublicJwk },
    status: {
      status_list: { idx: input.statusList.index, uri: input.statusList.uri },
    },
    ...input.visibleClaims,
    _sd: [...input.sdDigests].sort(),
    _sd_alg: 'sha-256',
  }
}

/**
 * Resolve disclosed claims against the credential's `_sd` array.
 *
 * Every rejection reason is distinct because they mean different things to a
 * verifier: a duplicate digest is a (harmless but suspicious) replayed
 * disclosure, whereas a digest absent from `_sd` is a forged or foreign claim and
 * must fail the whole presentation.
 */
export function resolveDisclosures(
  sdDigests: readonly string[],
  encodedDisclosures: readonly string[],
): {
  claims: Record<string, unknown>
  errors: string[]
} {
  const known = new Set(sdDigests)
  const seen = new Set<string>()
  const claims: Record<string, unknown> = {}
  const errors: string[] = []

  for (const encoded of encodedDisclosures) {
    const parsed = parseDisclosure(encoded)
    if (!parsed) {
      errors.push('A disclosure was malformed')
      continue
    }
    if (!known.has(parsed.digest)) {
      // Either invented, or lifted from a different credential. Both are forgery.
      errors.push(`Disclosure "${parsed.name}" is not part of this credential`)
      continue
    }
    if (seen.has(parsed.digest)) {
      errors.push(`Disclosure "${parsed.name}" was sent twice`)
      continue
    }
    // A claim name that collides with a plaintext payload claim would let a
    // disclosure overwrite something the issuer signed in the clear.
    if (parsed.name.startsWith('_') || RESERVED_CLAIMS.has(parsed.name)) {
      errors.push(`Disclosure "${parsed.name}" uses a reserved claim name`)
      continue
    }
    seen.add(parsed.digest)
    claims[parsed.name] = parsed.value
  }

  return { claims, errors }
}

/**
 * Claim names a disclosure may never carry. These are either JWT registered
 * claims or the SD-JWT control fields; letting a disclosure set one would let a
 * holder rewrite their own expiry, issuer, or key binding.
 */
const RESERVED_CLAIMS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'cnf',
  'vct',
  'status',
  '_sd',
  '_sd_alg',
])
