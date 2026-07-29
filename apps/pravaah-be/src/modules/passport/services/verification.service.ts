import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { KB_JWT_TYP, SD_JWT_VC_TYP } from '@pravaah/schema'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { PassportConfig } from '@/modules/passport/passport.config'
import {
  CLOCK_SKEW_SECONDS,
  decodeJwsUnverified,
  importPublicKey,
  isEcPublicJwk,
  nowSeconds,
  verifyCompactJws,
  type EcPublicJwk,
} from '@/modules/passport/crypto/jose.util'
import {
  computeSdHash,
  parseCombined,
  resolveDisclosures,
} from '@/modules/passport/crypto/sd-jwt.util'
import { unsatisfiedClaims } from '@/modules/passport/passport.state'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'

export interface VerifyInput {
  /** Combined wire format, or the pre-split parts. */
  presentation?: string
  sdJwt?: string
  disclosures?: string[]
  kbJwt?: string
  expectedNonce?: string
  audience?: string
  requiredClaims?: string[]
}

/**
 * Machine-readable failure codes.
 *
 * Distinct per cause because they mean genuinely different things to a verifier:
 * `REVOKED` is a decision about this holder, `UNKNOWN_ISSUER_KEY` is a problem with
 * the token, and `EXPIRED` is a prompt to ask the holder to refresh. Collapsing them
 * into "invalid" would leave a partner unable to write a sensible error screen.
 */
export const VERIFY_FAILURE = {
  MALFORMED: 'MALFORMED',
  WRONG_TYPE: 'WRONG_TYPE',
  UNKNOWN_ISSUER_KEY: 'UNKNOWN_ISSUER_KEY',
  BAD_ISSUER_SIGNATURE: 'BAD_ISSUER_SIGNATURE',
  WRONG_ISSUER: 'WRONG_ISSUER',
  NOT_YET_VALID: 'NOT_YET_VALID',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  TAMPERED_DISCLOSURE: 'TAMPERED_DISCLOSURE',
  KEY_BINDING_MISSING: 'KEY_BINDING_MISSING',
  KEY_BINDING_FAILED: 'KEY_BINDING_FAILED',
  REPLAY_SUSPECTED: 'REPLAY_SUSPECTED',
} as const

export type VerifyFailureCode =
  (typeof VERIFY_FAILURE)[keyof typeof VERIFY_FAILURE]

export interface VerifyResult {
  valid: boolean
  code?: VerifyFailureCode
  reason?: string

  issuer?: string
  documentType?: string
  credentialNumber?: string
  issuedAt?: string
  expiresAt?: string

  /** True only when a KB-JWT verified against the credential's `cnf` key. */
  holderVerified: boolean
  /** True only when a nonce AND audience were both supplied and matched. */
  replayProtected: boolean
  /** Claims the holder chose to reveal. Nothing else is knowable. */
  claims?: Record<string, unknown>
  /** Requested claims the holder declined. Absent ≠ false. */
  unsatisfied?: string[]
  /** Internal correlation id, echoed so a partner can quote it in support. */
  credentialId?: string
}

/**
 * The `/verify` brain.
 *
 * Runs the full SD-JWT VC check in the order that fails cheapest-first, and returns
 * a verdict rather than throwing — for a verifier, "this credential is invalid" is
 * an ordinary answer, and a 500 would be indistinguishable from our being down.
 *
 * Six checks, each closing a specific attack:
 *
 *  1. issuer signature      forgery, and tampering with any signed claim
 *  2. type (`typ`)          a plain JWT smuggled in as a credential
 *  3. validity window       a stale credential presented as current
 *  4. revocation            a credential the issuer or holder has since killed
 *  5. disclosure digests    an invented or cross-credential claim
 *  6. holder key binding    a STOLEN credential replayed by someone else
 *
 * Only (4) needs our database; (1)–(3), (5) and (6) are pure cryptography, which is
 * what makes offline verification real rather than aspirational.
 */
@Injectable()
export class VerificationService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyManagementService,
    private readonly revocation: RevocationService,
    private readonly config: PassportConfig,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: VerificationService.name })
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    // ── parse ────────────────────────────────────────────────────────────────
    let jwt: string
    let encodedDisclosures: string[]
    let kbJwt: string | undefined
    try {
      if (input.presentation) {
        const parts = parseCombined(input.presentation)
        jwt = parts.jwt
        encodedDisclosures = parts.disclosures
        kbJwt = parts.kbJwt
      } else {
        jwt = input.sdJwt ?? ''
        encodedDisclosures = input.disclosures ?? []
        kbJwt = input.kbJwt
      }
      if (!jwt) throw new Error('No credential present')
    } catch (error) {
      return this.fail(
        VERIFY_FAILURE.MALFORMED,
        (error as Error).message ?? 'Could not parse the presentation',
      )
    }

    let decoded: ReturnType<typeof decodeJwsUnverified>
    try {
      decoded = decodeJwsUnverified(jwt)
    } catch (error) {
      return this.fail(VERIFY_FAILURE.MALFORMED, (error as Error).message)
    }

    // ── 1. type ──────────────────────────────────────────────────────────────
    // Checked before the signature because it is free, and because a token typed as
    // something else was never meant to be read as a credential — accepting a
    // correctly-signed but wrongly-typed JWT is a cross-protocol confusion attack.
    if (decoded.header.typ !== SD_JWT_VC_TYP) {
      return this.fail(
        VERIFY_FAILURE.WRONG_TYPE,
        `Not an SD-JWT VC (expected typ "${SD_JWT_VC_TYP}")`,
      )
    }

    // ── 2. issuer signature ──────────────────────────────────────────────────
    const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : null
    if (!kid) {
      return this.fail(
        VERIFY_FAILURE.UNKNOWN_ISSUER_KEY,
        'The credential does not name the key that signed it',
      )
    }
    const issuerKey = await this.keys.publicKeyForKid(kid)
    if (!issuerKey) {
      return this.fail(
        VERIFY_FAILURE.UNKNOWN_ISSUER_KEY,
        'This credential was not signed by a key PRAVAAH publishes',
      )
    }
    if (!verifyCompactJws(decoded, issuerKey)) {
      return this.fail(
        VERIFY_FAILURE.BAD_ISSUER_SIGNATURE,
        'The issuer signature does not verify — the credential has been altered',
      )
    }

    const payload = decoded.payload
    // The kid is resolved from our own key table, so a matching signature already
    // proves we signed it. `iss` is still checked: a mismatch would mean our key
    // signed a credential claiming a different issuer, which is a bug worth
    // surfacing rather than tolerating.
    if (payload.iss !== this.config.did()) {
      return this.fail(
        VERIFY_FAILURE.WRONG_ISSUER,
        'The credential names an issuer that is not PRAVAAH',
      )
    }

    // ── 3. validity window ───────────────────────────────────────────────────
    const now = nowSeconds()
    const exp = typeof payload.exp === 'number' ? payload.exp : null
    const iat = typeof payload.iat === 'number' ? payload.iat : null
    const nbf = typeof payload.nbf === 'number' ? payload.nbf : null

    if (nbf !== null && now + CLOCK_SKEW_SECONDS < nbf) {
      return this.fail(VERIFY_FAILURE.NOT_YET_VALID, 'This credential is not yet valid')
    }
    if (exp !== null && now - CLOCK_SKEW_SECONDS >= exp) {
      return this.fail(
        VERIFY_FAILURE.EXPIRED,
        'This credential has expired — ask the holder to refresh it',
      )
    }

    const credentialNumber =
      typeof payload.credential_number === 'string'
        ? payload.credential_number
        : undefined

    // ── 4. revocation ────────────────────────────────────────────────────────
    const statusRef = this.readStatusRef(payload)
    if (statusRef) {
      const revoked = await this.revocation.isRevoked(
        statusRef.uri,
        statusRef.index,
      )
      if (revoked) {
        return this.fail(
          VERIFY_FAILURE.REVOKED,
          'This credential has been revoked or suspended',
          { credentialNumber },
        )
      }
    } else {
      // A credential we minted always carries a status reference. Its absence means
      // the token predates the status list or was hand-built, and either way we
      // cannot show it is live.
      return this.fail(
        VERIFY_FAILURE.MALFORMED,
        'The credential carries no revocation reference',
        { credentialNumber },
      )
    }

    // ── 5. disclosures ───────────────────────────────────────────────────────
    const sdDigests = Array.isArray(payload._sd)
      ? (payload._sd as unknown[]).filter(
          (d): d is string => typeof d === 'string',
        )
      : []
    if (payload._sd_alg !== undefined && payload._sd_alg !== 'sha-256') {
      return this.fail(
        VERIFY_FAILURE.MALFORMED,
        `Unsupported digest algorithm "${String(payload._sd_alg)}"`,
      )
    }

    const { claims, errors } = resolveDisclosures(sdDigests, encodedDisclosures)
    if (errors.length) {
      // ANY bad disclosure fails the WHOLE presentation. Accepting the good ones
      // and ignoring the rest would let an attacker append a forged claim and rely
      // on the verifier reading only the claims it cared about.
      return this.fail(VERIFY_FAILURE.TAMPERED_DISCLOSURE, errors.join('; '), {
        credentialNumber,
      })
    }

    // ── 6. holder key binding ────────────────────────────────────────────────
    const cnfJwk = this.readCnfJwk(payload)
    let holderVerified = false
    let replayProtected = false

    if (kbJwt) {
      if (!cnfJwk) {
        return this.fail(
          VERIFY_FAILURE.KEY_BINDING_FAILED,
          'The credential has no holder key to check the binding against',
          { credentialNumber },
        )
      }
      const kb = this.verifyKeyBinding({
        kbJwt,
        cnfJwk,
        jwt,
        disclosures: encodedDisclosures,
        expectedNonce: input.expectedNonce,
        audience: input.audience,
      })
      if (!kb.ok) {
        return this.fail(kb.code, kb.reason, { credentialNumber })
      }
      holderVerified = true
      replayProtected = kb.replayProtected
    }

    // A presentation with no key binding proves the CREDENTIAL is genuine but says
    // nothing about who is presenting it. Rejected outright once the verifier has
    // asked for replay protection: a verifier that issued a nonce is expecting proof
    // of possession, and returning `valid: true` with `holderVerified: false` invites
    // them to miss the distinction.
    if (!holderVerified && (input.expectedNonce || input.audience)) {
      return this.fail(
        VERIFY_FAILURE.KEY_BINDING_MISSING,
        'The holder did not prove possession of this credential — a key binding proof is required',
        { credentialNumber },
      )
    }

    // ── correlate (best-effort) ──────────────────────────────────────────────
    // Purely so a partner can quote an id in a support ticket. A verification does
    // NOT depend on finding the row: the cryptography already decided, and requiring
    // a database hit here would break offline-issued or archived credentials.
    const known = credentialNumber
      ? await this.prisma.credential.findUnique({
          where: { credentialNumber },
          select: { id: true },
        })
      : null

    const required = input.requiredClaims ?? []
    return {
      valid: true,
      issuer: String(payload.iss),
      documentType:
        typeof payload.document_type === 'string'
          ? payload.document_type
          : undefined,
      credentialNumber,
      issuedAt: iat ? new Date(iat * 1000).toISOString() : undefined,
      expiresAt: exp ? new Date(exp * 1000).toISOString() : undefined,
      holderVerified,
      replayProtected,
      // Only what the holder chose. Everything else is a salted digest.
      claims: {
        // The score scale travels in the clear so a disclosed band is
        // interpretable. Merged in explicitly rather than spread from the payload,
        // which would also leak `_sd`, `cnf` and the raw status reference.
        ...(payload.score_scale ? { score_scale: payload.score_scale } : {}),
        ...claims,
      },
      unsatisfied: required.length
        ? unsatisfiedClaims(required, claims)
        : undefined,
      credentialId: known?.id,
    }
  }

  /**
   * Verify the holder's Key Binding JWT.
   *
   * Four things must hold, and each one closes a distinct attack:
   *
   *  - the signature verifies under the credential's OWN `cnf` key → the presenter
   *    holds the device the credential was issued to (defeats a stolen credential),
   *  - `sd_hash` matches the exact bytes presented → nobody swapped the disclosure
   *    set after the holder signed (defeats a disclosure-substitution attack),
   *  - `aud` is this verifier → a presentation captured by one lender cannot be
   *    replayed at another,
   *  - `nonce` is the challenge this verifier issued → the same presentation cannot
   *    be replayed at the SAME verifier twice.
   */
  private verifyKeyBinding(args: {
    kbJwt: string
    cnfJwk: EcPublicJwk
    jwt: string
    disclosures: string[]
    expectedNonce?: string
    audience?: string
  }):
    | { ok: true; replayProtected: boolean }
    | { ok: false; code: VerifyFailureCode; reason: string } {
    let decoded: ReturnType<typeof decodeJwsUnverified>
    try {
      decoded = decodeJwsUnverified(args.kbJwt)
    } catch (error) {
      return {
        ok: false,
        code: VERIFY_FAILURE.KEY_BINDING_FAILED,
        reason: `Malformed key binding proof: ${(error as Error).message}`,
      }
    }

    if (decoded.header.typ !== KB_JWT_TYP) {
      return {
        ok: false,
        code: VERIFY_FAILURE.KEY_BINDING_FAILED,
        reason: `Key binding proof has the wrong type (expected "${KB_JWT_TYP}")`,
      }
    }

    let holderKey: ReturnType<typeof importPublicKey>
    try {
      holderKey = importPublicKey(args.cnfJwk)
    } catch {
      return {
        ok: false,
        code: VERIFY_FAILURE.KEY_BINDING_FAILED,
        reason: 'The credential’s holder key is not a valid P-256 key',
      }
    }
    if (!verifyCompactJws(decoded, holderKey)) {
      return {
        ok: false,
        code: VERIFY_FAILURE.KEY_BINDING_FAILED,
        reason:
          'The key binding proof was not signed by the device this credential belongs to',
      }
    }

    const kb = decoded.payload
    const expectedSdHash = computeSdHash(args.jwt, args.disclosures)
    if (kb.sd_hash !== expectedSdHash) {
      return {
        ok: false,
        code: VERIFY_FAILURE.TAMPERED_DISCLOSURE,
        reason:
          'The disclosures do not match what the holder signed — they were altered in transit',
      }
    }

    // A KB-JWT is minted per presentation, so a far-future or long-past `iat` means
    // it was not minted for this exchange.
    const now = nowSeconds()
    const iat = typeof kb.iat === 'number' ? kb.iat : null
    if (iat === null) {
      return {
        ok: false,
        code: VERIFY_FAILURE.KEY_BINDING_FAILED,
        reason: 'The key binding proof carries no issue time',
      }
    }
    if (iat > now + CLOCK_SKEW_SECONDS) {
      return {
        ok: false,
        code: VERIFY_FAILURE.KEY_BINDING_FAILED,
        reason: 'The key binding proof is dated in the future',
      }
    }
    if (now - iat > KB_JWT_MAX_AGE_SECONDS) {
      return {
        ok: false,
        code: VERIFY_FAILURE.REPLAY_SUSPECTED,
        reason: 'The key binding proof is too old to be for this exchange',
      }
    }

    let replayProtected = false
    if (args.audience !== undefined) {
      if (kb.aud !== args.audience) {
        return {
          ok: false,
          code: VERIFY_FAILURE.REPLAY_SUSPECTED,
          reason:
            'This presentation was made out to a different verifier — it may be a replay',
        }
      }
    }
    if (args.expectedNonce !== undefined) {
      if (kb.nonce !== args.expectedNonce) {
        return {
          ok: false,
          code: VERIFY_FAILURE.REPLAY_SUSPECTED,
          reason:
            'The challenge does not match the one this verifier issued — it may be a replay',
        }
      }
    }
    // Only both together are a real defence. A matching nonce with no audience
    // check can be relayed to a different verifier, and an audience with no nonce
    // can be replayed at the same one.
    replayProtected =
      args.audience !== undefined && args.expectedNonce !== undefined

    return { ok: true, replayProtected }
  }

  private readStatusRef(
    payload: Record<string, unknown>,
  ): { uri: string; index: number } | null {
    const status = payload.status as
      | { status_list?: { uri?: unknown; idx?: unknown } }
      | undefined
    const uri = status?.status_list?.uri
    const idx = status?.status_list?.idx
    if (typeof uri !== 'string' || typeof idx !== 'number') return null
    if (!Number.isInteger(idx) || idx < 0) return null
    return { uri, index: idx }
  }

  private readCnfJwk(payload: Record<string, unknown>): EcPublicJwk | null {
    const cnf = payload.cnf as { jwk?: unknown } | undefined
    return isEcPublicJwk(cnf?.jwk) ? cnf.jwk : null
  }

  private fail(
    code: VerifyFailureCode,
    reason: string,
    extra: Partial<VerifyResult> = {},
  ): VerifyResult {
    this.logger.info(`[verify] Presentation rejected: ${code}`, { reason })
    return {
      valid: false,
      code,
      reason,
      holderVerified: false,
      replayProtected: false,
      ...extra,
    }
  }
}

/**
 * How old a key binding proof may be.
 *
 * Five minutes is the whole window an honest tap-and-approve needs, including a
 * user reading the consent screen. Anything older is either a stale retry or a
 * captured proof being replayed, and both should be refused.
 */
const KB_JWT_MAX_AGE_SECONDS = 300
