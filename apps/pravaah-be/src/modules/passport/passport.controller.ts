import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  ApproveRequestSchema,
  ChallengeSchema,
  DeclineRequestSchema,
  IssueCredentialSchema,
  PeerScanSchema,
  PresentSchema,
  RevokeCredentialSchema,
  describeClaims,
  DISCLOSABLE_CLAIMS,
  PRESENTATION_TEMPLATES,
  type ApproveRequestDto,
  type ChallengeDto,
  type DeclineRequestDto,
  type IssueCredentialDto,
  type PeerScanDto,
  type PresentDto,
  type RevokeCredentialDto,
} from '@pravaah/schema'

import { User, type AuthenticatedUser } from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { ActorType } from 'generated/prisma/client'

import { PASSPORT_ROUTES } from '@/modules/passport/passport.route'
import { CardService } from '@/modules/passport/services/card.service'
import { IssuerService } from '@/modules/passport/services/issuer.service'
import { PeerVerifyService } from '@/modules/passport/services/peer-verify.service'
import { PresentationService } from '@/modules/passport/services/presentation.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'
import { VerifierSessionService } from '@/modules/passport/services/verifier-session.service'

/**
 * M3 holder-facing API — the wallet.
 *
 * Every route is JWT-guarded and scoped to the authenticated `user.id`. A credential
 * is never addressable by id alone: the ownership predicate is inside each service's
 * WHERE clause, so someone else's credential id is a 404 rather than a 403 that
 * confirms it exists.
 *
 * What this controller deliberately does NOT do: sign. The holder's private key lives
 * in the device keystore and never reaches us, so every route that needs a key binding
 * proof takes one as input. That is the whole reason a stolen credential — or a stolen
 * copy of our database — cannot be presented by anyone but the holder.
 */
@Controller(PASSPORT_ROUTES.BASE)
@UseGuards(AuthGuard)
export class PassportController {
  private readonly logger: AppLogger

  constructor(
    private readonly issuer: IssuerService,
    private readonly presentations: PresentationService,
    private readonly sessions: VerifierSessionService,
    private readonly peers: PeerVerifyService,
    private readonly revocation: RevocationService,
    private readonly cards: CardService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PassportController.name })
  }

  // ── wallet ────────────────────────────────────────────────────────────────
  /** The passport, or the state explaining its absence. */
  @Get(PASSPORT_ROUTES.CURRENT)
  async current(@User() user: AuthenticatedUser) {
    const data = await this.presentations.wallet(user.id)
    return ResponseBuilder.success(data, 'Your passport')
  }

  /**
   * Mint the credential.
   *
   * The device generates its keypair first and sends only the public half, so this
   * is the one moment holder key binding is established — and the reason issuance
   * takes a body at all.
   */
  @Post(PASSPORT_ROUTES.ISSUE)
  async issue(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(IssueCredentialSchema)) dto: IssueCredentialDto,
  ) {
    this.logger.info(`[${this.issue.name}] Issuing passport`, {
      userId: user.id,
      bindPassportNumber: dto.bindPassportNumber,
    })
    const data = await this.issuer.issue(user.id, dto)
    return ResponseBuilder.success(data, 'Your passport has been issued')
  }

  /**
   * The claim catalogue and the request templates.
   *
   * Served from the backend rather than bundled into the app so a wallet that has not
   * been updated still renders a claim a newer credential carries — an unlabelled
   * snake_case key on a consent screen is a consent nobody can meaningfully give.
   */
  @Get(PASSPORT_ROUTES.CLAIMS)
  claims() {
    return ResponseBuilder.success(
      {
        claims: describeClaims(DISCLOSABLE_CLAIMS),
        templates: Object.values(PRESENTATION_TEMPLATES).map((template) => ({
          id: template.id,
          label: template.label,
          purpose: template.purpose,
          claims: template.claims,
        })),
      },
      'Claim catalogue',
    )
  }

  // ── presenting ────────────────────────────────────────────────────────────
  /**
   * The bytes the device must sign, for a self-initiated presentation.
   *
   * Returns the `sd_hash` rather than asking the wallet to compute it. The hash covers
   * the credential plus the disclosures in the exact order they will be sent, and a
   * wallet deriving that independently has three ways to get the framing wrong — each
   * producing a proof that fails at the verifier, in front of the user, for a reason
   * they cannot act on. The private key still never leaves the device, which is the
   * part that matters.
   */
  @Post(PASSPORT_ROUTES.CHALLENGE)
  // 200: this returns a digest to sign. Nothing is created or stored.
  @HttpCode(HttpStatus.OK)
  async challenge(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ChallengeSchema)) dto: ChallengeDto,
  ) {
    const data = await this.presentations.signingMaterial({
      userId: user.id,
      credentialId: dto.credentialId,
      revealClaims: dto.revealClaims,
      // The VERIFIER's audience and nonce, passed through. This endpoint deliberately does
      // not invent a nonce: one is only a replay defence if the party CHECKING it chose it,
      // so a server-minted value here would be theatre — and generating it with
      // `Math.random()`, as an earlier draft of this did, would be worse than theatre.
      audience: dto.audience,
      nonce: dto.nonce,
    })
    return ResponseBuilder.success(data, 'Signing material')
  }

  /** A direct presentation, when the holder already holds the verifier's nonce. */
  @Post(PASSPORT_ROUTES.PRESENT)
  async present(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PresentSchema)) dto: PresentDto,
  ) {
    this.logger.info(`[${this.present.name}] Building a presentation`, {
      userId: user.id,
      verifier: dto.verifier,
      claimCount: dto.revealClaims.length,
    })
    const built = await this.presentations.present({
      userId: user.id,
      credentialId: dto.credentialId,
      revealClaims: dto.revealClaims,
      verifier: dto.verifier,
      nonce: dto.nonce,
      channel: dto.channel,
      kbJwt: dto.kbJwt,
    })
    return ResponseBuilder.success(
      {
        presentation: built.presentation,
        disclosedClaims: built.disclosedClaims,
        skippedClaims: built.skippedClaims,
        // Our own verification of what we just built, so a wallet bug surfaces here
        // rather than as an unexplained rejection at a counter.
        verification: {
          valid: built.verification.valid,
          code: built.verification.code,
          reason: built.verification.reason,
          holderVerified: built.verification.holderVerified,
          replayProtected: built.verification.replayProtected,
        },
      },
      built.verification.valid
        ? 'Presentation ready'
        : 'Presentation built but failed verification',
    )
  }

  // ── verifier requests (card tap / QR scan) ────────────────────────────────
  /** Requests waiting for this holder. Drives the wallet's inbox. */
  @Get(PASSPORT_ROUTES.REQUESTS)
  async pendingRequests(@User() user: AuthenticatedUser) {
    const data = await this.sessions.pendingForHolder(user.id)
    return ResponseBuilder.success(data, 'Pending verification requests')
  }

  /** The consent-to-disclose screen's data: who is asking, for what, and why. */
  @Get(PASSPORT_ROUTES.REQUEST_DETAIL)
  async requestDetail(
    @User() user: AuthenticatedUser,
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
  ) {
    const data = await this.sessions.requestForHolder(user.id, requestId)
    return ResponseBuilder.success(data, 'Verification request')
  }

  /** Approve — with the claims the holder ticked and the proof their device signed. */
  @Post(PASSPORT_ROUTES.REQUEST_APPROVE)
  async approveRequest(
    @User() user: AuthenticatedUser,
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Body(new ZodValidationPipe(ApproveRequestSchema)) dto: ApproveRequestDto,
  ) {
    this.logger.info(`[${this.approveRequest.name}] Holder approving a request`, {
      userId: user.id,
      requestId,
      claimCount: dto.revealClaims.length,
    })
    const data = await this.sessions.approve(user.id, requestId, dto)
    return ResponseBuilder.success(data, 'Shared with the verifier')
  }

  @Post(PASSPORT_ROUTES.REQUEST_DECLINE)
  async declineRequest(
    @User() user: AuthenticatedUser,
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Body(new ZodValidationPipe(DeclineRequestSchema)) dto: DeclineRequestDto,
  ) {
    const data = await this.sessions.decline(user.id, requestId, dto.reason)
    return ResponseBuilder.success(data, 'Request declined')
  }

  // ── peer verification (one holder scanning another) ───────────────────────
  /**
   * Resolve a scanned code and, if it is a Pravaah passport, ask its holder.
   *
   * The response deliberately carries NOTHING about the holder — not a name, not a
   * confirmation that the code belonged to anyone in particular. Only a request id and
   * what was asked for. Everything the scanner eventually learns arrives through
   * {@link scanResult}, after the holder has approved it, and never before.
   *
   * 200 rather than 201 even though a request row is created, because the interesting
   * answer is "what kind of code was that" — including `NOT_PASSPORT`, which creates
   * nothing at all and which the payments scanner branches on.
   */
  @Post(PASSPORT_ROUTES.SCAN)
  @HttpCode(HttpStatus.OK)
  async scan(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PeerScanSchema)) dto: PeerScanDto,
  ) {
    const data = await this.peers.scan(user.id, dto)
    return ResponseBuilder.success(
      data,
      data.kind === 'PASSPORT'
        ? 'Asked the holder to approve'
        : 'Not a Pravaah passport code',
    )
  }

  /** Poll for the holder's answer. Scoped to the scanner; idempotent once approved. */
  @Get(PASSPORT_ROUTES.SCAN_RESULT)
  async scanResult(
    @User() user: AuthenticatedUser,
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
  ) {
    const data = await this.peers.result(user.id, requestId)
    return ResponseBuilder.success(data, 'Check status')
  }

  /** Withdraw a request the scanner no longer needs, so the holder stops being asked. */
  @Delete(PASSPORT_ROUTES.SCAN_RESULT)
  async cancelScan(
    @User() user: AuthenticatedUser,
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
  ) {
    const data = await this.peers.cancel(user.id, requestId)
    return ResponseBuilder.success(data, 'Check withdrawn')
  }

  // ── transparency ──────────────────────────────────────────────────────────
  /**
   * Share history.
   *
   * The other half of selective disclosure. Choosing what to share only means
   * something if the user can later see what they shared, and with whom.
   */
  @Get(PASSPORT_ROUTES.HISTORY)
  async history(
    @User() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit)
    const take =
      Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50
    const data = await this.presentations.history(user.id, take)
    return ResponseBuilder.success(data, 'Share history')
  }

  // ── card ──────────────────────────────────────────────────────────────────
  @Get(PASSPORT_ROUTES.CARD)
  async card(@User() user: AuthenticatedUser) {
    const data = await this.cards.forHolder(user.id)
    return ResponseBuilder.success(data, data ? 'Your card' : 'No card issued yet')
  }

  /** Issue or re-point the physical card. Idempotent. */
  @Post(PASSPORT_ROUTES.CARD)
  async issueCard(@User() user: AuthenticatedUser) {
    const data = await this.cards.ensureCard(user.id)
    return ResponseBuilder.success(data, 'Card ready')
  }

  @Post(PASSPORT_ROUTES.CARD_NFC_WRITTEN)
  async cardNfcWritten(@User() user: AuthenticatedUser) {
    const data = await this.cards.markNfcWritten(user.id)
    return ResponseBuilder.success(data, 'Card tag written')
  }

  /**
   * Report the card lost.
   *
   * Disables the card AND revokes the credential — a lost card usually means a lost
   * wallet, and the phone may have gone with it. Conservative on purpose: a re-issue
   * costs one tap, and the alternative risks leaving a live credential with an
   * unknown holder.
   */
  @Post(PASSPORT_ROUTES.CARD_LOST)
  async cardLost(@User() user: AuthenticatedUser) {
    this.logger.warn(`[${this.cardLost.name}] Card reported lost`, {
      userId: user.id,
    })
    const data = await this.cards.reportLost(user.id)
    return ResponseBuilder.success(data, 'Card disabled')
  }

  // ── revocation ────────────────────────────────────────────────────────────
  /**
   * The holder kills their own passport.
   *
   * A `DELETE` on an explicit `credentials/:id/revoke` path rather than a bare `:id`,
   * so it can never be matched by accident — and because "revoke" is what actually
   * happens: the row is kept forever for the audit trail, and only the status-list bit
   * moves.
   */
  @Delete(PASSPORT_ROUTES.REVOKE)
  async revoke(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(RevokeCredentialSchema))
    dto: RevokeCredentialDto,
  ) {
    this.logger.warn(`[${this.revoke.name}] Holder revoking their passport`, {
      userId: user.id,
      credentialId: id,
    })
    const data = await this.revocation.revokeOwned(
      user.id,
      id,
      dto.reason ?? 'user_revoked',
      { type: ActorType.USER, id: user.id },
    )
    return ResponseBuilder.success(
      data,
      'Your passport has been revoked. Anyone you shared it with will now see it as invalid.',
    )
  }
}
