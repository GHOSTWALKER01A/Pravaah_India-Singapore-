import { randomBytes } from 'node:crypto'

import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CLAIM_CATALOGUE,
  describeClaims,
  normalizePravaahId,
  type ApproveRequestDto,
  type CreateVerifierRequestDto,
  type DisclosableClaim,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CardStatus,
  CredentialStatus,
  Prisma,
  VerifierRequestStatus,
  type VerifierPartner,
} from 'generated/prisma/client'

import { PassportConfig } from '@/modules/passport/passport.config'
import {
  isRequestOpen,
  partitionRequestedClaims,
  resolveTemplate,
} from '@/modules/passport/passport.state'
import { PeerVerifyService } from '@/modules/passport/services/peer-verify.service'
import { PresentationService } from '@/modules/passport/services/presentation.service'

/** 256 bits of challenge. A guessable nonce is not a replay defence. */
const NONCE_BYTES = 32

/**
 * The verifier↔holder handshake.
 *
 * This is what makes the physical card safe. The card carries only an opaque
 * reference, so tapping or photographing it reveals NOTHING: it opens a request
 * that the holder's own device must approve and sign. A stolen card, or a QR
 * photographed over someone's shoulder, is inert — the same "device engagement"
 * property ISO mDL relies on, and the reason we can print a card at all without
 * turning it into a bearer token for the holder's reputation.
 *
 * The flow, and what each step buys:
 *
 *   1. verifier opens a request     → a single-use nonce bound to one audience
 *   2. holder's wallet reads it     → the consent screen, in the holder's words
 *   3. holder approves + signs      → proof of possession over the exact claims
 *   4. verifier collects the result → idempotent, and the nonce is burnt
 */
@Injectable()
export class VerifierSessionService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly presentations: PresentationService,
    private readonly peers: PeerVerifyService,
    private readonly config: PassportConfig,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: VerifierSessionService.name })
  }

  // ── 1. the verifier asks ──────────────────────────────────────────────────
  async createRequest(
    dto: CreateVerifierRequestDto,
    partner: VerifierPartner,
  ): Promise<Record<string, unknown>> {
    const resolved = dto.template
      ? resolveTemplate(dto.template)
      : {
          claims: [],
          purpose: dto.purpose ?? '',
          label: 'Custom request',
        }

    const { known, unknown } = partitionRequestedClaims(
      dto.template ? resolved.claims : (dto.requestedClaims ?? []),
    )
    if (!known.length) {
      throw new BadRequestException(
        `None of the requested claims exist on this credential type: ${unknown.join(', ')}`,
      )
    }

    // Resolve WHO is being asked before minting a nonce, so a request can never
    // sit pending against a holder who does not exist.
    const target = await this.resolveTarget(dto)

    const request = await this.prisma.verifierRequest.create({
      data: {
        partnerId: partner.id,
        audience: partner.audience,
        purpose: dto.template ? resolved.purpose : (dto.purpose ?? ''),
        template: dto.template ?? null,
        requestedClaims: known,
        nonce: randomBytes(NONCE_BYTES).toString('base64url'),
        channel: dto.channel,
        status: VerifierRequestStatus.PENDING,
        userId: target.userId,
        credentialId: target.credentialId,
        cardRef: dto.cardRef ?? null,
        expiresAt: new Date(Date.now() + dto.ttlSeconds * 1000),
      },
    })

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'passport.verify_requested',
      entity: 'VerifierRequest',
      entityId: request.id,
      metadata: {
        partner: partner.name,
        audience: partner.audience,
        template: dto.template ?? 'custom',
        requestedClaims: known,
        channel: dto.channel,
        viaCard: !!dto.cardRef,
      },
    })
    this.logger.info(`[${this.createRequest.name}] Verifier request opened`, {
      requestId: request.id,
      partner: partner.name,
      claimCount: known.length,
    })

    return {
      requestId: request.id,
      nonce: request.nonce,
      audience: request.audience,
      purpose: request.purpose,
      requestedClaims: known,
      // Told, rather than silently dropped: a partner integrating against a stale
      // claim list needs to know their request was narrowed.
      unknownClaims: unknown.length ? unknown : undefined,
      expiresAt: request.expiresAt,
      /** Deep link / QR payload that hands the request to the holder's wallet. */
      holderLink: this.config.walletRequestLink(request.id),
      status: request.status,
    }
  }

  /**
   * A scanned card resolves to a request here.
   *
   * The card's reference is looked up, but nothing about the holder is returned —
   * only a request id. A scanner learns that the card is a Pravaah card and that a
   * request has been opened, which is exactly as much as the physical object should
   * ever be able to prove on its own.
   */
  async requestFromCard(
    cardRef: string,
    partner: VerifierPartner,
    template: CreateVerifierRequestDto['template'],
  ): Promise<Record<string, unknown>> {
    const card = await this.prisma.passportCard.findUnique({
      where: { qrPayloadRef: cardRef },
      include: { credential: { select: { id: true, status: true } } },
    })
    if (!card) throw new NotFoundException('Unrecognised card')
    if (card.status !== CardStatus.ACTIVE) {
      // A lost card is reported by its owner and must stop working immediately,
      // whatever the state of the credential behind it.
      throw new ForbiddenException(
        'This card has been reported lost and can no longer be used',
      )
    }

    // Defaults to the most private template there is. A scan with no stated intent
    // gets the minimum — one boolean — rather than the maximum; a verifier that
    // genuinely needs more can name a template and say why.
    return this.createRequest(
      {
        template: template ?? 'DOMESTIC_MICRO_LOAN',
        cardRef,
        channel: 'QR',
        ttlSeconds: 300,
      },
      partner,
    )
  }

  // ── 2. the holder reads it ────────────────────────────────────────────────
  /**
   * The consent-to-disclose screen's data.
   *
   * Every claim comes back with its label, its plain-language consequence, and why a
   * legitimate verifier would ask — because "needs `passport_number`" is not a
   * decision a person can make, and "a landlord abroad wants to tie your reputation
   * to the passport they already trust" is.
   */
  async requestForHolder(
    userId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
      include: { partner: { select: { name: true, country: true } } },
    })
    if (!request) throw new NotFoundException('Request not found')

    // A request raised from a card is already bound to its owner. One raised from a
    // link is unbound until someone opens it, and the first authenticated holder to
    // do so claims it — so a bound request belonging to somebody else is a 404,
    // never a "this is not yours" that confirms it exists.
    if (request.userId && request.userId !== userId) {
      throw new NotFoundException('Request not found')
    }

    const open = isRequestOpen(request.status, request.expiresAt)
    const credential = await this.prisma.credential.findFirst({
      where: {
        userId,
        status: CredentialStatus.ISSUED,
        expiresAt: { gt: new Date() },
      },
      orderBy: { issuedAt: 'desc' },
      select: { id: true, credentialNumber: true, claimKeys: true },
    })

    const requested = request.requestedClaims as DisclosableClaim[]
    const held = new Set(credential?.claimKeys ?? [])

    /**
     * Who is actually asking, when the asker is a PERSON.
     *
     * A peer request has no partner row, so `partner?.name ?? audience` would render
     * `pravaah:peer:PVH-4K7Q-…` as the verifier — a string that tells the holder nothing
     * and looks like a bug. The requester block below is what the consent screen shows
     * instead, and it comes from the scanner's VERIFIED name rather than anything they
     * typed: a self-declared display name here would be a free impersonation primitive.
     */
    const requester = await this.peers.describeRequester(
      request.requestedByUserId,
    )

    return {
      requestId: request.id,
      status: open ? request.status : this.staleStatus(request.status),
      open,
      verifier: request.partner?.name ?? requester?.name ?? 'A Pravaah user',
      verifierCountry:
        request.partner?.country ?? (requester?.country as string | null) ?? null,
      /**
       * Present only on a peer check. Its presence is ALSO the wallet's signal that this
       * is a person rather than an institution, which is a materially different decision:
       * an institution is accountable and auditable, and the person in front of you is
       * whoever they appear to be.
       */
      requester,
      purpose: request.purpose,
      template: request.template,
      channel: request.channel,
      expiresAt: request.expiresAt,
      // Nonce and audience travel to the wallet because the device must sign over
      // both. They are useless to anyone else: without the holder's private key a
      // nonce cannot be turned into a presentation.
      nonce: request.nonce,
      audience: request.audience,
      credentialId: credential?.id ?? null,
      credentialNumber: credential?.credentialNumber ?? null,
      claims: describeClaims(requested).map((descriptor) => ({
        ...descriptor,
        // Requested but not carried — greyed out with a reason, rather than
        // silently absent from a list the verifier said they needed.
        held: held.has(descriptor.claim),
      })),
      /** A holder may always send less than was asked. */
      allDeclinable: true,
    }
  }

  /** Requests waiting for this holder. Drives the wallet's inbox badge. */
  async pendingForHolder(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.verifierRequest.findMany({
      where: {
        userId,
        status: VerifierRequestStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        partner: { select: { name: true } },
        // The scanner's verified name, so an inbox row for a peer check reads as a
        // person. Joined rather than resolved per row: an inbox of twenty requests
        // must not become twenty round trips.
        requestedBy: {
          select: {
            kycStatus: true,
            primaryCountry: true,
            kycProfile: { select: { verifiedName: true } },
          },
        },
      },
    })
    return rows.map((row) => ({
      requestId: row.id,
      verifier:
        row.partner?.name ??
        row.requestedBy?.kycProfile?.verifiedName ??
        'A Pravaah user',
      /** True when the asker is a person. The wallet marks these differently. */
      isPeer: row.requestedByUserId !== null,
      peerVerified: row.requestedBy?.kycStatus === 'VERIFIED',
      peerCountry: row.requestedBy?.primaryCountry ?? null,
      purpose: row.purpose,
      claimCount: row.requestedClaims.length,
      channel: row.channel,
      expiresAt: row.expiresAt,
    }))
  }

  // ── 3. the holder approves ────────────────────────────────────────────────
  async approve(
    userId: string,
    requestId: string,
    dto: ApproveRequestDto,
  ): Promise<Record<string, unknown>> {
    const request = await this.claimRequest(userId, requestId)

    // Every failure from here on must hand the lock back, or a wallet-side error strands
    // the request until it expires — with the verifier still waiting at the counter and the
    // holder unable to retry.
    let built: Awaited<ReturnType<PresentationService['present']>>
    try {
      // A holder may reveal LESS than was asked but never more: a verifier that asked for a
      // band must not receive an exact score because the wallet had a bug, and
      // over-disclosure is not something the holder can undo afterwards.
      const allowed = new Set(request.requestedClaims)
      const overreach = dto.revealClaims.filter((claim) => !allowed.has(claim))
      if (overreach.length) {
        throw new BadRequestException(
          `This verifier did not ask for: ${overreach.join(', ')}`,
        )
      }

      built = await this.presentations.present({
        userId,
        credentialId: dto.credentialId,
        revealClaims: dto.revealClaims,
        verifier: request.audience,
        nonce: request.nonce,
        channel: request.channel,
        kbJwt: dto.kbJwt,
        partnerId: request.partnerId,
      })

      if (!built.verification.valid) {
        // Released back to PENDING rather than consumed. The wallet can fix the proof and
        // retry inside the SAME request — burning the challenge on a client-side error
        // would force the verifier to start over.
        this.logger.warn(
          `[${this.approve.name}] Holder approval produced an invalid presentation`,
          {
            requestId,
            code: built.verification.code,
            reason: built.verification.reason,
          },
        )
        throw new BadRequestException(
          built.verification.reason ??
            'The proof from your device could not be verified. Please try again.',
        )
      }
    } catch (error) {
      await this.releaseRequest(requestId)
      throw error
    }

    const result = this.verifierFacingResult(built.verification, {
      requestedClaims: request.requestedClaims,
      disclosedClaims: built.disclosedClaims,
    })

    await this.prisma.verifierRequest.update({
      where: { id: request.id },
      data: {
        status: VerifierRequestStatus.APPROVED,
        presentationId: built.presentationId,
        credentialId: dto.credentialId,
        respondedAt: new Date(),
        // Cached so the verifier's poll is a read, and so collecting the result
        // twice cannot produce two different verdicts.
        resultJson: result as Prisma.InputJsonValue,
      },
    })

    this.logger.info(`[${this.approve.name}] Holder approved a request`, {
      requestId,
      disclosedCount: built.disclosedClaims.length,
      requestedCount: request.requestedClaims.length,
    })

    return {
      requestId: request.id,
      status: VerifierRequestStatus.APPROVED,
      disclosedClaims: built.disclosedClaims,
      /** Claims the verifier asked for and the holder chose not to send. */
      withheldClaims: request.requestedClaims.filter(
        (claim) => !built.disclosedClaims.includes(claim),
      ),
      skippedClaims: built.skippedClaims,
      verifier: request.audience,
    }
  }

  /** An explicit refusal. Distinct from a timeout, and told to the verifier as such. */
  async decline(
    userId: string,
    requestId: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const request = await this.claimRequest(userId, requestId)

    await this.prisma.verifierRequest.update({
      where: { id: request.id },
      data: {
        status: VerifierRequestStatus.DECLINED,
        // Kept for OUR product insight only, and never surfaced to the verifier —
        // a holder's reason for saying no is not the asker's business.
        declineReason: reason ?? null,
        respondedAt: new Date(),
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'passport.verify_declined',
      entity: 'VerifierRequest',
      entityId: request.id,
      metadata: { audience: request.audience, hasReason: !!reason },
    })
    return { requestId: request.id, status: VerifierRequestStatus.DECLINED }
  }

  // ── 4. the verifier collects ──────────────────────────────────────────────
  /**
   * The verifier's poll.
   *
   * Idempotent by design: the verdict was computed once at approval time and is
   * returned from cache, so a verifier retrying after a dropped connection gets the
   * same answer rather than a second, differently-timed verification.
   */
  async result(
    requestId: string,
    partner: VerifierPartner,
  ): Promise<Record<string, unknown>> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
    })
    if (!request) throw new NotFoundException('Request not found')
    // Scoped to the asking partner: a request id must never be a way for one
    // verifier to read another's result.
    if (request.partnerId !== partner.id) {
      throw new NotFoundException('Request not found')
    }

    if (
      request.status === VerifierRequestStatus.PENDING &&
      request.expiresAt <= new Date()
    ) {
      await this.prisma.verifierRequest.update({
        where: { id: request.id },
        data: { status: VerifierRequestStatus.EXPIRED },
      })
      return {
        requestId: request.id,
        status: VerifierRequestStatus.EXPIRED,
        message: 'The holder did not respond in time.',
      }
    }

    if (
      request.status === VerifierRequestStatus.APPROVED ||
      request.status === VerifierRequestStatus.CONSUMED
    ) {
      if (request.status === VerifierRequestStatus.APPROVED) {
        await this.prisma.verifierRequest.update({
          where: { id: request.id },
          data: {
            status: VerifierRequestStatus.CONSUMED,
            consumedAt: new Date(),
          },
        })
        await this.prisma.presentation
          .findUnique({
            where: { id: request.presentationId ?? '' },
            select: { credentialId: true },
          })
          .then((row) =>
            row
              ? this.prisma.passportCard.updateMany({
                  where: { credentialId: row.credentialId },
                  data: { lastVerifiedAt: new Date() },
                })
              : null,
          )
          .catch(() => null)
      }
      return {
        requestId: request.id,
        status: VerifierRequestStatus.CONSUMED,
        result: request.resultJson,
      }
    }

    return {
      requestId: request.id,
      status: request.status,
      message:
        request.status === VerifierRequestStatus.DECLINED
          ? 'The holder declined to share.'
          : 'Waiting for the holder to approve.',
    }
  }

  /** Sweep expired requests. Called by the lifecycle scheduler. */
  async expireStale(): Promise<number> {
    const result = await this.prisma.verifierRequest.updateMany({
      where: {
        status: VerifierRequestStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      data: { status: VerifierRequestStatus.EXPIRED },
    })
    return result.count
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  /**
   * Load an open request and take an EXCLUSIVE lock on it.
   *
   * `respondedAt` doubles as the lock, and the `updateMany` is a genuine compare-and-swap:
   * `respondedAt: null` in the WHERE clause means only one caller can transition it away
   * from null, and the loser sees `count === 0`.
   *
   * Worth being explicit about why the obvious version does NOT work, because it looks like
   * it does: writing only `userId` leaves `status` at PENDING, so two simultaneous approvals
   * both pass the open-status read AND both satisfy the conditional write — producing two
   * presentations against one single-use nonce. A CAS has to be on a field the update
   * itself changes.
   *
   * The caller MUST {@link releaseRequest} if it fails after this point, or a wallet-side
   * error would strand the request until it expires.
   */
  private async claimRequest(
    userId: string,
    requestId: string,
  ): Promise<{
    id: string
    audience: string
    nonce: string
    channel: Parameters<PresentationService['present']>[0]['channel']
    requestedClaims: string[]
    partnerId: string | null
  }> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
    })
    if (!request) throw new NotFoundException('Request not found')
    if (request.userId && request.userId !== userId) {
      throw new NotFoundException('Request not found')
    }
    if (!isRequestOpen(request.status, request.expiresAt)) {
      throw new GoneException(
        request.status === VerifierRequestStatus.PENDING
          ? 'This request has expired. Ask the verifier to try again.'
          : 'This request has already been answered.',
      )
    }

    const claimed = await this.prisma.verifierRequest.updateMany({
      where: {
        id: requestId,
        status: VerifierRequestStatus.PENDING,
        respondedAt: null,
        // Re-checked inside the CAS, so a request that expired between the read above and
        // this write cannot still be claimed.
        expiresAt: { gt: new Date() },
      },
      data: { userId, respondedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new GoneException(
        'This request is already being answered, or has expired.',
      )
    }

    return {
      id: request.id,
      audience: request.audience,
      nonce: request.nonce,
      channel: request.channel,
      requestedClaims: request.requestedClaims,
      partnerId: request.partnerId,
    }
  }

  /**
   * Hand the lock back after a failed approval.
   *
   * Scoped to requests still PENDING, so a release can never resurrect one that has since
   * been legitimately answered. Swallows its own errors: this runs on an error path, and a
   * failure to unlock must not replace the real error the caller is about to report.
   */
  private async releaseRequest(requestId: string): Promise<void> {
    try {
      await this.prisma.verifierRequest.updateMany({
        where: { id: requestId, status: VerifierRequestStatus.PENDING },
        data: { respondedAt: null },
      })
    } catch (error) {
      this.logger.warn(
        `[${this.releaseRequest.name}] Could not release the request lock`,
        { requestId, err: error },
      )
    }
  }

  /** Resolve which holder a request is for, from a card ref or a Pravaah ID. */
  private async resolveTarget(dto: CreateVerifierRequestDto): Promise<{
    userId: string | null
    credentialId: string | null
  }> {
    if (dto.cardRef) {
      const card = await this.prisma.passportCard.findUnique({
        where: { qrPayloadRef: dto.cardRef },
        select: { userId: true, credentialId: true, status: true },
      })
      if (!card) throw new NotFoundException('Unrecognised card')
      if (card.status !== CardStatus.ACTIVE) {
        throw new ForbiddenException(
          'This card has been reported lost and can no longer be used',
        )
      }
      return { userId: card.userId, credentialId: card.credentialId }
    }

    if (dto.pravaahId) {
      // Normalised through the shared checksum helper, so a mistyped ID is refused
      // here rather than becoming a request aimed at nobody — or, worse, at the
      // wrong person.
      const canonical = normalizePravaahId(dto.pravaahId)
      if (!canonical) {
        throw new BadRequestException(
          'That is not a valid Pravaah ID (expected PVH-XXXX-XXXX-XXXX)',
        )
      }
      const user = await this.prisma.user.findUnique({
        where: { pravaahId: canonical },
        select: { id: true },
      })
      if (!user) throw new NotFoundException('No holder with that Pravaah ID')
      return { userId: user.id, credentialId: null }
    }

    return { userId: null, credentialId: null }
  }

  /**
   * The verifier's view of a verified presentation.
   *
   * Built from the verification result rather than passed through, so a claim the
   * verifier did not request can never reach them even if a wallet sent it. This is
   * the last enforcement point for data minimisation, and the cheapest place to be
   * strict.
   */
  private verifierFacingResult(
    verification: {
      valid: boolean
      claims?: Record<string, unknown>
      holderVerified: boolean
      replayProtected: boolean
      credentialNumber?: string
      expiresAt?: string
      issuer?: string
    },
    context: { requestedClaims: string[]; disclosedClaims: string[] },
  ): Record<string, unknown> {
    const allowed = new Set(context.requestedClaims)
    const claims: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(verification.claims ?? {})) {
      // `score_scale` is always-visible metadata about the model, not a claim about
      // the holder — a disclosed band is uninterpretable without it.
      if (name === 'score_scale' || allowed.has(name)) claims[name] = value
    }

    return {
      valid: verification.valid,
      issuer: verification.issuer,
      issuingAuthority: 'PRAVAAH',
      credentialNumber: verification.credentialNumber,
      expiresAt: verification.expiresAt,
      holderVerified: verification.holderVerified,
      replayProtected: verification.replayProtected,
      claims,
      withheldClaims: context.requestedClaims.filter(
        (claim) => !context.disclosedClaims.includes(claim),
      ),
      // Labels so a partner console renders "Good or better" rather than a raw key.
      claimLabels: Object.fromEntries(
        Object.keys(claims)
          .filter((claim) => claim in CLAIM_CATALOGUE)
          .map((claim) => [
            claim,
            CLAIM_CATALOGUE[claim as DisclosableClaim].label,
          ]),
      ),
      verifiedAt: new Date().toISOString(),
    }
  }

  /** What a no-longer-open PENDING request should report. */
  private staleStatus(status: VerifierRequestStatus): VerifierRequestStatus {
    return status === VerifierRequestStatus.PENDING
      ? VerifierRequestStatus.EXPIRED
      : status
  }
}
