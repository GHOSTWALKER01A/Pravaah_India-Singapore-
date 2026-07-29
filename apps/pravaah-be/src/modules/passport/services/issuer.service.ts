import { randomInt } from 'node:crypto'

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  PASSPORT_ALG,
  PASSPORT_DOCUMENT_TYPE,
  PASSPORT_ISSUING_AUTHORITY,
  SD_JWT_VC_TYP,
  type IssueCredentialDto,
} from '@pravaah/schema'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { ENV } from '@/constants/environment.constants'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CheckStatus,
  CheckType,
  CredentialStatus,
  DocType,
  KycStatus,
  Prisma,
  ScoreStatus,
  type Consent,
  type Score,
} from 'generated/prisma/client'

import { canFetch } from '@/modules/consent/consent.state'
import { parseBands } from '@/modules/scoring/scoring.state'
import { PassportConfig } from '@/modules/passport/passport.config'
import {
  didKeyFromJwk,
  jwkThumbprint,
  nowSeconds,
  signCompactJws,
  toPublicJwk,
  type EcPublicJwk,
} from '@/modules/passport/crypto/jose.util'
import {
  buildSdJwtPayload,
  makeDisclosure,
  serializeIssuance,
} from '@/modules/passport/crypto/sd-jwt.util'
import { buildCredentialNumber, alpha2 } from '@/modules/passport/icao.util'
import {
  dataRailsFor,
  kycLevel,
  splitVerifiedName,
  thresholdClaims,
} from '@/modules/passport/passport.state'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'

/** Fallback ceiling on credential validity when none is configured. */
const DEFAULT_MAX_VALIDITY_DAYS = 180

/** Retries when a random credential number collides with an existing one. */
const CREDENTIAL_NUMBER_ATTEMPTS = 5

export interface IssuedCredential {
  credentialId: string
  credentialNumber: string
  /** The combined issuance string the wallet stores: `<jwt>~<d1>~…~`. */
  credential: string
  /** Split form, for a wallet that prefers to hold the parts separately. */
  sdJwt: string
  disclosures: Record<string, string>
  subjectDid: string
  issuedAt: Date
  expiresAt: Date
  passportBound: boolean
  dataRails: string[]
  /** Populated when something the caller asked for could not be honoured. */
  notes: string[]
}

/**
 * Mints the Financial Reputation Passport.
 *
 * This is the module's centre of gravity: an M2 score that lives in our database
 * becomes a credential the USER owns — signed by us, bound to their device, and
 * verifiable by a stranger with no call back to us.
 *
 * The two rules that shape every decision here:
 *
 *  1. NO RAW FINANCIAL DATA. Only the derived score and its provenance ever enter
 *     a credential. This is simultaneously the privacy keystone and the answer to
 *     data residency: raw bank data stays in India under M1, and the minimal,
 *     user-owned score is the only thing that crosses a border.
 *
 *  2. NO UNBACKED ASSERTION. A credential is only ever minted from a live consent,
 *     a VERIFIED identity, and a fresh COMPUTED score. Every guard that can refuse
 *     runs before a single byte is signed.
 */
@Injectable()
export class IssuerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyManagementService,
    private readonly revocation: RevocationService,
    private readonly config: PassportConfig,
    private readonly env: ConfigService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: IssuerService.name })
  }

  async issue(
    userId: string,
    dto: IssueCredentialDto,
  ): Promise<IssuedCredential> {
    const notes: string[] = []

    // ── GUARD 1: identity ────────────────────────────────────────────────────
    // A reputation passport asserts something about a VERIFIED person. Issuing one
    // to an unverified account would make the credential exactly the unfalsifiable
    // claim it exists to replace.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        kycProfile: { include: { checks: true } },
        documents: true,
      },
    })
    if (!user) throw new NotFoundException('User not found')
    if (user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException(
        'Complete identity verification before issuing your passport',
      )
    }
    if (user.isSuspended) throw new ForbiddenException('Account suspended')

    // ── GUARD 2: a fresh, servable score ─────────────────────────────────────
    const score = await this.prisma.score.findFirst({
      where: {
        userId,
        status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN] },
        value: { not: null },
        band: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { computedAt: 'desc' },
      include: { modelVersion: true },
    })
    if (!score || score.value === null || score.band === null) {
      throw new ForbiddenException(
        'No current reputation score to certify — compute your score first',
      )
    }

    // ── GUARD 3: the consent behind the score is still live ──────────────────
    // The score row could be fresh while its consent was revoked a minute ago.
    // Re-checked against M1's own predicate rather than trusting the status column,
    // because a credential issued on a dead consent is a live credit assertion with
    // no lawful basis behind it — the single worst failure mode in M3.
    const consent = await this.prisma.consent.findUnique({
      where: { id: score.consentId },
    })
    if (!consent || !canFetch(consent.status, consent.expiresAt)) {
      throw new ForbiddenException(
        'The data-sharing consent behind your score is no longer active — re-share your data to refresh it',
      )
    }

    const holderJwk = toPublicJwk(dto.holderPublicJwk as EcPublicJwk)
    const thumbprint = jwkThumbprint(holderJwk)
    const subjectDid = didKeyFromJwk(holderJwk)

    // ── supersede the prior passport ─────────────────────────────────────────
    // Exactly one live credential per user. Two would let a holder present a
    // stale-but-flattering score after their real one dropped, and a verifier has
    // no way to know a better-looking credential was superseded.
    const prior = await this.prisma.credential.findFirst({
      where: {
        userId,
        status: { in: [CredentialStatus.ISSUED, CredentialStatus.SUSPENDED] },
      },
      orderBy: { issuedAt: 'desc' },
    })
    if (prior) {
      await this.revocation.revoke(prior.id, 'superseded_by_reissue', {
        type: ActorType.USER,
        id: userId,
      })
      notes.push(
        'Your previous passport was replaced. Anything you shared it with will now see it as revoked.',
      )
    }

    // ── assemble the claims ──────────────────────────────────────────────────
    const kycProfile = user.kycProfile
    const { givenName, familyName } = splitVerifiedName(
      kycProfile?.verifiedName,
    )
    const bands = parseBands(score.modelVersion.bands)

    const passportDoc = user.documents.find(
      (doc) => doc.docType === DocType.PASSPORT,
    )
    let passportNumber: string | null = null
    if (dto.bindPassportNumber) {
      if (passportDoc?.maskedNumber) {
        passportNumber = passportDoc.maskedNumber
      } else {
        // Asked for but unavailable. Told plainly rather than silently dropped: the
        // user opted into the international tier and needs to know they did not get
        // it, so they can go and verify a passport in M0.
        notes.push(
          'We could not include a passport binding — no verified passport is on file. Verify your passport to enable cross-border use.',
        )
      }
    }

    const expiresAt = this.resolveExpiry(score, consent)
    const issuedAtSeconds = nowSeconds()

    /**
     * Selectively-disclosable claims.
     *
     * `score_value` is the exact number and `score_band` the coarse one, and both
     * are minted so the holder can choose the granularity at presentation time
     * rather than at issuance. The four `score_at_least_*` assertions come from
     * {@link thresholdClaims}, which returns all four (true AND false) so the
     * digest count cannot leak the band.
     */
    const disclosableClaims: Record<string, unknown> = {
      given_name: givenName || null,
      family_name: familyName || null,
      nationality: alpha2(user.primaryCountry),
      pravaah_id: user.pravaahId,
      passport_number: passportNumber,

      score_value: score.value,
      score_band: score.band,
      ...thresholdClaims(score.band),
      confidence: score.confidence,
      coverage: score.coverageScore,
      score_as_of: score.computedAt?.toISOString() ?? null,

      model_version: score.modelVersion.version,
      data_rails: dataRailsFor(user.primaryCountry),
      consent_ref: consent.providerConsentId ?? consent.id,
      kyc_level: kycLevel({
        governmentDocument: this.passed(kycProfile?.checks, [
          CheckType.AADHAAR_OKYC,
          CheckType.PAN,
          CheckType.SINGPASS_MYINFO,
        ]),
        liveness: this.passed(kycProfile?.checks, [CheckType.LIVENESS]),
        faceMatch: this.passed(kycProfile?.checks, [CheckType.FACE_MATCH]),
        bankAccount: this.passed(kycProfile?.checks, [
          CheckType.BANK_PENNY_DROP,
        ]),
        sanctionsScreened: this.passed(kycProfile?.checks, [
          CheckType.SANCTIONS_PEP,
        ]),
      }),
    }

    // `birth_date` and `sex` are minted only when M0 actually extracted them.
    // Minting a null would create a disclosure whose only content is "we do not
    // know this", which is worse than its absence: a verifier would read the
    // disclosed null as a claim about the holder.

    const disclosures: Record<string, string> = {}
    const digests: string[] = []
    for (const [name, value] of Object.entries(disclosableClaims)) {
      if (value === null || value === undefined) continue
      const disclosure = makeDisclosure(name, value)
      disclosures[name] = disclosure.encoded
      digests.push(disclosure.digest)
    }

    const credentialNumber = await this.mintCredentialNumber(user.primaryCountry)
    const allocation = await this.revocation.allocate()
    const { kid, keyId, privateKey } = await this.keys.activeSigningKey()

    /**
     * Always-visible claims.
     *
     * `score_scale` is the one that earns its place: "GOOD" is a meaningless token
     * to a lender in Singapore without the cutoffs that define it. It describes the
     * MODEL, never the holder, so it costs no privacy to publish in the clear — and
     * withholding it would make the disclosed band uninterpretable.
     */
    const visibleClaims = {
      document_type: PASSPORT_DOCUMENT_TYPE,
      issuing_authority: PASSPORT_ISSUING_AUTHORITY,
      credential_number: credentialNumber,
      score_scale: {
        min: 300,
        max: 900,
        model: score.modelVersion.name,
        bands: bands.map((band) => ({
          band: band.band,
          min: band.min,
          max: band.max,
        })),
      },
    }

    const payload = buildSdJwtPayload({
      issuer: this.config.did(),
      vct: this.config.vct(),
      subjectDid,
      holderPublicJwk: holderJwk,
      issuedAt: issuedAtSeconds,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
      statusList: { uri: allocation.uri, index: allocation.index },
      visibleClaims,
      sdDigests: digests,
    })

    const sdJwt = signCompactJws({
      header: { alg: PASSPORT_ALG, typ: SD_JWT_VC_TYP, kid },
      payload,
      privateKey,
    })

    /**
     * `supersedesId` is UNIQUE — a credential can be superseded by at most one successor —
     * which makes a concurrent double-issue a constraint violation rather than a silent
     * fork. Both callers find the same `prior`, both revoke it idempotently, and the second
     * insert loses. Translated to a 409 rather than surfacing as a 500: the first issuance
     * genuinely succeeded, and "you already have a new passport" is the truth.
     */
    const credential = await this.prisma.credential
      .create({
        data: {
          userId,
          scoreId: score.id,
          issuerKeyId: keyId,
          vct: this.config.vct(),
          credentialNumber,
          subjectDid,
          holderJwkThumbprint: thumbprint,
          holderPublicJwk: holderJwk,
          deviceLabel: dto.deviceLabel ?? null,
          sdJwtEnc: encryptField(sdJwt),
          disclosuresEnc: encryptField(JSON.stringify(disclosures)),
          claimKeys: Object.keys(disclosures),
          status: CredentialStatus.ISSUED,
          statusListId: allocation.listId,
          statusListIndex: allocation.index,
          dataRails: disclosableClaims.data_rails as string[],
          passportBound: !!passportNumber,
          scoreBand: score.band,
          supersedesId: prior?.id ?? null,
          expiresAt,
        },
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          this.logger.warn(
            `[${this.issue.name}] Concurrent issuance lost the race`,
            { userId, target: error.meta?.target },
          )
          throw new ConflictException(
            'A passport was just issued for this account. Reload to see it.',
          )
        }
        throw error
      })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'passport.issued',
      entity: 'Credential',
      entityId: credential.id,
      metadata: {
        credentialNumber,
        scoreId: score.id,
        modelVersion: score.modelVersion.version,
        // The BAND, never the value: an audit row is read by admins who have no
        // business seeing a precise score they were not shown in the console.
        scoreBand: score.band,
        issuerKid: kid,
        statusListIndex: allocation.index,
        passportBound: !!passportNumber,
        dataRails: disclosableClaims.data_rails as string[],
        supersedes: prior?.id ?? null,
        claimCount: digests.length,
        expiresAt: expiresAt.toISOString(),
      },
    })
    this.logger.info(`[${this.issue.name}] Passport issued`, {
      userId,
      credentialId: credential.id,
      credentialNumber,
      claimCount: digests.length,
      expiresAt,
    })

    return {
      credentialId: credential.id,
      credentialNumber,
      credential: serializeIssuance(sdJwt, Object.values(disclosures)),
      sdJwt,
      disclosures,
      subjectDid,
      issuedAt: credential.issuedAt,
      expiresAt,
      passportBound: !!passportNumber,
      dataRails: credential.dataRails,
      notes,
    }
  }

  /**
   * When the credential expires.
   *
   * The MINIMUM of three limits, because each answers a different question and the
   * shortest is the only defensible one:
   *
   *  - the consent's data life — a credential may not outlive the permission that
   *    produced the number inside it,
   *  - the score's own expiry — a stale score is not a current assertion,
   *  - a policy ceiling — even a five-year consent should not produce a five-year
   *    credential, because reputation moves and an old one flatters or maligns.
   */
  private resolveExpiry(score: Score, consent: Consent): Date {
    const ceilingDays =
      Number(this.env.get<string>(ENV.PASSPORT.MAX_VALIDITY_DAYS)) ||
      DEFAULT_MAX_VALIDITY_DAYS
    const candidates = [
      new Date(Date.now() + ceilingDays * 24 * 60 * 60_000),
      score.expiresAt,
      consent.expiresAt,
    ].filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))

    return new Date(Math.min(...candidates.map((d) => d.getTime())))
  }

  /**
   * A unique credential number.
   *
   * The sequence is cryptographically random, not incremental: a running counter
   * would publish how many passports Pravaah has ever issued and let anyone
   * enumerate valid credential numbers. `randomInt` is used over `Math.random`
   * because this value ends up on a physical card and in an audit trail.
   *
   * A collision is a retried insert, not a defect — but retrying forever would
   * hide a genuinely exhausted namespace, so the loop is bounded and the failure is
   * loud.
   */
  private async mintCredentialNumber(
    country: Parameters<typeof buildCredentialNumber>[0],
  ): Promise<string> {
    for (let attempt = 0; attempt < CREDENTIAL_NUMBER_ATTEMPTS; attempt += 1) {
      const candidate = buildCredentialNumber(
        country,
        String(randomInt(0, 10_000_000)),
      )
      const clash = await this.prisma.credential.findUnique({
        where: { credentialNumber: candidate },
        select: { id: true },
      })
      if (!clash) return candidate
      this.logger.warn(
        `[${this.mintCredentialNumber.name}] Credential number collision — retrying`,
        { attempt: attempt + 1 },
      )
    }
    throw new Error(
      'Could not mint a unique credential number after several attempts',
    )
  }

  /** Whether any of `types` passed. A single PASSED check proves the capability. */
  private passed(
    checks: Array<{ checkType: CheckType; status: CheckStatus }> | undefined,
    types: CheckType[],
  ): boolean {
    if (!checks?.length) return false
    return checks.some(
      (check) =>
        types.includes(check.checkType) &&
        check.status === CheckStatus.PASSED,
    )
  }
}
