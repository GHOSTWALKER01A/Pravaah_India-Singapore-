import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CLAIM_CATALOGUE,
  isPeerAudience,
  type DisclosableClaim,
} from '@pravaah/schema'

import { decryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CredentialStatus,
  PresentationChannel,
  type Credential,
} from 'generated/prisma/client'

import { computeSdHash, serializePresentation } from '@/modules/passport/crypto/sd-jwt.util'
import {
  describeCredentialClaims,
  isPresentable,
  selectableClaims,
} from '@/modules/passport/passport.state'
import {
  VerificationService,
  type VerifyResult,
} from '@/modules/passport/services/verification.service'

export interface BuiltPresentation {
  presentation: string
  sdJwt: string
  disclosures: string[]
  disclosedClaims: string[]
  /** Claims the holder asked to reveal that this credential does not carry. */
  skippedClaims: string[]
  presentationId: string
  verification: VerifyResult
}

/**
 * The holder's side of a presentation.
 *
 * Assembles the credential plus ONLY the chosen disclosures, attaches the KB-JWT
 * the device signed, and logs what was shared so the user can see it later.
 *
 * The service never signs the key binding proof. That is not a convenience
 * boundary, it is the security model: a server-signed proof of possession would
 * prove only that our server was reachable, and the whole point of `cnf` is that
 * possession is proven by a key we do not have.
 */
@Injectable()
export class PresentationService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PresentationService.name })
  }

  /**
   * Build a presentation and verify it before handing it over.
   *
   * We verify our OWN output on purpose. The KB-JWT arrives from the device, and a
   * wallet bug — a wrong `sd_hash`, a stale nonce, a clock-skewed `iat` — would
   * otherwise surface as a rejection at the verifier, where the user gets an
   * unexplained failure at the counter and we have no visibility. Catching it here
   * turns that into an actionable error in the app.
   */
  async present(args: {
    userId: string
    credentialId: string
    revealClaims: string[]
    verifier: string
    nonce: string
    channel: PresentationChannel
    kbJwt: string
    /** Set when this presentation answers a verifier request. */
    partnerId?: string | null
  }): Promise<BuiltPresentation> {
    const credential = await this.requirePresentable(
      args.userId,
      args.credentialId,
    )

    const sdJwt = decryptField(credential.sdJwtEnc)
    const allDisclosures = JSON.parse(
      decryptField(credential.disclosuresEnc),
    ) as Record<string, string>

    const { selected, missing } = selectableClaims(
      args.revealClaims,
      Object.keys(allDisclosures),
    )
    // Sorted, so the disclosure order is a function of the claim set alone. The
    // KB-JWT commits to the exact bytes via `sd_hash`, and an order that depended on
    // how the wallet happened to enumerate its ticks would make a correctly-signed
    // proof fail to reproduce.
    selected.sort()
    const disclosures = selected.map((claim) => allDisclosures[claim]!)

    const presentation = serializePresentation(sdJwt, disclosures, args.kbJwt)

    const verification = await this.verification.verify({
      presentation,
      expectedNonce: args.nonce,
      audience: args.verifier,
      requiredClaims: args.revealClaims,
    })

    const logged = await this.prisma.presentation.create({
      data: {
        credentialId: credential.id,
        partnerId: args.partnerId ?? null,
        verifierAudience: args.verifier,
        disclosedClaims: selected,
        channel: args.channel,
        nonce: args.nonce,
        kbVerified: verification.holderVerified,
        valid: verification.valid,
        failureReason: verification.valid
          ? null
          : `${verification.code}: ${verification.reason}`,
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: args.userId,
      action: verification.valid
        ? 'passport.presented'
        : 'passport.presentation_failed',
      entity: 'Presentation',
      entityId: logged.id,
      metadata: {
        credentialId: credential.id,
        credentialNumber: credential.credentialNumber,
        verifier: args.verifier,
        channel: args.channel,
        // The claim NAMES, never their values. An audit trail that recorded the
        // disclosed score would recreate, in plaintext and forever, exactly the
        // data selective disclosure exists to keep out of our hands.
        disclosedClaims: selected,
        kbVerified: verification.holderVerified,
        valid: verification.valid,
        failure: verification.code ?? null,
      },
    })

    if (!verification.valid) {
      this.logger.warn(
        `[${this.present.name}] Our own presentation failed verification`,
        {
          credentialId: credential.id,
          code: verification.code,
          reason: verification.reason,
        },
      )
    } else {
      this.logger.info(`[${this.present.name}] Presentation built`, {
        credentialId: credential.id,
        verifier: args.verifier,
        claimCount: selected.length,
      })
    }

    return {
      presentation,
      sdJwt,
      disclosures,
      disclosedClaims: selected,
      skippedClaims: missing,
      presentationId: logged.id,
      verification,
    }
  }

  /**
   * The exact bytes a wallet must hash into `sd_hash` before signing.
   *
   * Exposed because the alternative is worse. `sd_hash` covers the credential plus
   * the disclosures in the order they will actually be sent, and a wallet computing
   * that independently has to reproduce our claim ordering, our separator handling,
   * and our ASCII encoding — three chances to produce a proof that fails at the
   * verifier for reasons the user cannot act on. Handing over the digest to sign
   * keeps the private key on the device (which is what matters) while removing the
   * ways a client can get the framing wrong.
   */
  async signingMaterial(args: {
    userId: string
    credentialId: string
    revealClaims: string[]
    audience: string
    nonce: string
  }): Promise<{
    sdHash: string
    disclosedClaims: string[]
    skippedClaims: string[]
    audience: string
    nonce: string
  }> {
    const credential = await this.requirePresentable(
      args.userId,
      args.credentialId,
    )
    const sdJwt = decryptField(credential.sdJwtEnc)
    const allDisclosures = JSON.parse(
      decryptField(credential.disclosuresEnc),
    ) as Record<string, string>

    const { selected, missing } = selectableClaims(
      args.revealClaims,
      Object.keys(allDisclosures),
    )
    selected.sort()

    return {
      sdHash: computeSdHash(
        sdJwt,
        selected.map((claim) => allDisclosures[claim]!),
      ),
      disclosedClaims: selected,
      skippedClaims: missing,
      audience: args.audience,
      nonce: args.nonce,
    }
  }

  /**
   * The wallet's view of its own passport.
   *
   * Includes the raw credential so a reinstalled app can restore its wallet, and
   * the per-claim descriptors so the disclosure picker reads as sentences rather
   * than snake_case keys. Deliberately does NOT include the claim VALUES: the
   * wallet already holds the disclosures and can read them itself, and sending
   * decrypted values through a second channel widens the surface for no gain.
   */
  async wallet(userId: string): Promise<Record<string, unknown>> {
    const credential = await this.prisma.credential.findFirst({
      where: {
        userId,
        status: {
          in: [CredentialStatus.ISSUED, CredentialStatus.SUSPENDED],
        },
      },
      orderBy: { issuedAt: 'desc' },
      include: {
        score: {
          select: { band: true, computedAt: true, confidence: true },
        },
        issuerKey: { select: { kid: true } },
        cards: {
          select: {
            cardSerial: true,
            status: true,
            nfcWritten: true,
            verifyUrl: true,
          },
        },
        _count: { select: { presentations: true } },
      },
    })

    if (!credential) {
      // Distinguish "never issued" from "no longer valid": they are different user
      // actions. One is a first-time issue, the other is a re-issue after an
      // expiry or a revocation, and the app routes them differently.
      const lapsed = await this.prisma.credential.findFirst({
        where: { userId },
        orderBy: { issuedAt: 'desc' },
        select: {
          id: true,
          status: true,
          credentialNumber: true,
          expiresAt: true,
          revokedAt: true,
          revokeReason: true,
        },
      })
      return lapsed
        ? {
            state: 'NEEDS_REISSUE' as const,
            previous: lapsed,
            message:
              lapsed.status === CredentialStatus.EXPIRED
                ? 'Your passport has expired. Refresh your score to issue a new one.'
                : 'Your passport was revoked. Issue a new one when you are ready.',
          }
        : {
            state: 'NOT_ISSUED' as const,
            message:
              'Your reputation is ready to become a passport you own. Issue it to start sharing it on your terms.',
          }
    }

    const expired = credential.expiresAt <= new Date()
    return {
      state: expired ? ('NEEDS_REISSUE' as const) : ('ACTIVE' as const),
      id: credential.id,
      credentialNumber: credential.credentialNumber,
      status: credential.status,
      subjectDid: credential.subjectDid,
      deviceLabel: credential.deviceLabel,
      scoreBand: credential.scoreBand,
      dataRails: credential.dataRails,
      passportBound: credential.passportBound,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      /** Days remaining, so the wallet can nudge before it lapses at a counter. */
      daysRemaining: Math.max(
        0,
        Math.ceil(
          (credential.expiresAt.getTime() - Date.now()) / (24 * 60 * 60_000),
        ),
      ),
      issuerKid: credential.issuerKey.kid,
      // The wallet's restore path. Encrypted at rest here; the holder's PRIVATE
      // key is never in this table, so restoring a credential onto a new device
      // still requires a re-issue against that device's key.
      credential: serializePresentation(
        decryptField(credential.sdJwtEnc),
        Object.values(
          JSON.parse(decryptField(credential.disclosuresEnc)) as Record<
            string,
            string
          >,
        ),
        undefined,
      ),
      claims: describeCredentialClaims(credential.claimKeys),
      card: credential.cards[0] ?? null,
      presentationCount: credential._count.presentations,
      score: credential.score,
    }
  }

  /**
   * Share history — who saw what, and when.
   *
   * The transparency half of selective disclosure. Choosing what to share is only
   * meaningful if the user can later see what they shared, so claim names are
   * resolved to their human labels here rather than left for the client to guess.
   */
  async history(
    userId: string,
    limit = 50,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.presentation.findMany({
      where: { credential: { userId } },
      orderBy: { presentedAt: 'desc' },
      take: limit,
      include: {
        partner: { select: { name: true, country: true } },
        credential: { select: { credentialNumber: true } },
        // The peer who asked, when the verifier was a PERSON. Joined here rather than
        // resolved per row: a history of fifty shares must not become fifty round trips.
        request: {
          select: {
            requestedBy: {
              select: {
                primaryCountry: true,
                kycProfile: { select: { verifiedName: true } },
              },
            },
          },
        },
      },
    })

    /**
     * Resolve a peer audience back to the person it names.
     *
     * Without this, every person-to-person share renders in the holder's own history as
     * `pravaah:peer:PVH-4K7Q-…`. "Who has seen my score" is half of what makes selective
     * disclosure meaningful, and an answer the holder cannot read is not an answer — it is
     * the raw scheme string leaking out of a layer that was supposed to hide it.
     *
     * The Pravaah ID is deliberately NOT shown as a fallback when the peer has no verified
     * name. It would be the one place in the product where scanning somebody discloses your
     * own identifier to them permanently, and "a Pravaah user" plus the timestamp is enough
     * for the holder to recall the encounter.
     */
    const peerName = (row: (typeof rows)[number]): string | null => {
      if (!isPeerAudience(row.verifierAudience)) return null
      return row.request?.requestedBy?.kycProfile?.verifiedName ?? 'A Pravaah user'
    }

    return rows.map((row) => ({
      id: row.id,
      // A registered partner's display name when we know it, then the person who scanned,
      // and only then the raw audience — which by that point is a genuine partner string
      // rather than an internal scheme.
      verifier: row.partner?.name ?? peerName(row) ?? row.verifierAudience,
      /** True when a person did the checking. The wallet marks these differently. */
      isPeer: isPeerAudience(row.verifierAudience),
      verifierCountry:
        row.partner?.country ??
        row.request?.requestedBy?.primaryCountry ??
        null,
      credentialNumber: row.credential.credentialNumber,
      channel: row.channel,
      presentedAt: row.presentedAt,
      valid: row.valid,
      holderVerified: row.kbVerified,
      failureReason: row.failureReason,
      disclosedClaims: row.disclosedClaims.map((claim) => ({
        claim,
        label:
          CLAIM_CATALOGUE[claim as DisclosableClaim]?.label ?? claim,
      })),
    }))
  }

  /**
   * Fetch a credential the user owns and may present.
   *
   * Scoped by `userId` in the WHERE clause, not checked afterwards, so a credential
   * id belonging to someone else is a 404 and reveals nothing about whether it
   * exists.
   */
  private async requirePresentable(
    userId: string,
    credentialId: string,
  ): Promise<Credential> {
    const credential = await this.prisma.credential.findFirst({
      where: { id: credentialId, userId },
    })
    if (!credential) throw new NotFoundException('Passport not found')

    if (!isPresentable(credential.status, credential.expiresAt)) {
      // Reasons are separated because the fix differs: an expired passport needs a
      // re-issue, a suspended one needs support, and a revoked one is final.
      const message =
        credential.status === CredentialStatus.SUSPENDED
          ? 'Your passport is on hold and cannot be shared right now.'
          : credential.status === CredentialStatus.REVOKED
            ? 'This passport has been revoked and can no longer be shared.'
            : 'Your passport has expired. Refresh your score to issue a new one.'
      throw new ForbiddenException(message)
    }
    return credential
  }
}
