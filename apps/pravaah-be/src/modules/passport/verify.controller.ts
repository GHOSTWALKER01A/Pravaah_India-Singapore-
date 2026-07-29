import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CreateVerifierRequestSchema,
  PASSPORT_DOCUMENT_TYPE,
  PASSPORT_ISSUING_AUTHORITY,
  PASSPORT_ALG,
  PRESENTATION_TEMPLATES,
  SD_JWT_VC_TYP,
  VerifyPresentationSchema,
  describeClaims,
  DISCLOSABLE_CLAIMS,
  ALWAYS_VISIBLE_CLAIMS,
  PresentationTemplateIdSchema,
  type CreateVerifierRequestDto,
  type VerifyPresentationDto,
} from '@pravaah/schema'

import { PartnerApiKeyGuard } from '@/common/guards/partner-api-key.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ResponseBuilder } from '@/utils/response-builder'

import type { VerifierPartner } from 'generated/prisma/client'

import { PassportConfig } from '@/modules/passport/passport.config'
import { VERIFY_ROUTES } from '@/modules/passport/passport.route'
import { VerificationService } from '@/modules/passport/services/verification.service'
import { VerifierSessionService } from '@/modules/passport/services/verifier-session.service'

/**
 * The partner-facing verification surface.
 *
 * This is where the "only in market" claim actually cashes out: a lender in Singapore
 * who has never spoken to us can verify an Indian user's reputation with one POST, or
 * with no call at all if they cached our JWKS and status list. No bilateral agreement,
 * no onboarding, no data-sharing arrangement — just a signature they can check.
 *
 * Authenticated with a partner API key rather than left open, for one specific reason:
 * the KB-JWT `aud`. A key binding proof is made out to ONE verifier, and that is what
 * stops a presentation captured at one lender being replayed at another. An anonymous
 * caller could name any audience it liked, which would turn the strongest replay
 * defence in the credential into a self-declared field.
 */
@Controller(VERIFY_ROUTES.BASE)
export class VerifyController {
  private readonly logger: AppLogger

  constructor(
    private readonly verification: VerificationService,
    private readonly sessions: VerifierSessionService,
    private readonly config: PassportConfig,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: VerifyController.name })
  }

  /**
   * Verify a presentation handed over directly.
   *
   * The `audience` is forced to the AUTHENTICATED partner's, never taken from the body.
   * A verifier that could nominate its own audience could accept a presentation made
   * out to somebody else, which is precisely the replay the KB-JWT exists to prevent.
   *
   * Rate-limited because this endpoint runs elliptic-curve verification per call, and
   * an unbounded one is a cheap way to spend our CPU.
   */
  @Post(VERIFY_ROUTES.PRESENTATION)
  // 200, not Nest's default 201: this endpoint CREATES nothing, it answers a question.
  // A `201 Created` would tell an integrator a resource now exists, and some clients
  // branch on it. `/verify/request` below genuinely creates one and keeps its 201.
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard, PartnerApiKeyGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async verifyPresentation(
    @Body(new ZodValidationPipe(VerifyPresentationSchema))
    dto: VerifyPresentationDto,
    @Req() req: { partner: VerifierPartner },
  ) {
    const result = await this.verification.verify({
      presentation: dto.presentation,
      sdJwt: dto.sdJwt,
      disclosures: dto.disclosures,
      kbJwt: dto.kbJwt,
      expectedNonce: dto.expectedNonce,
      audience: req.partner.audience,
      requiredClaims: dto.requiredClaims,
    })

    this.logger.info(`[${this.verifyPresentation.name}] Presentation verified`, {
      partner: req.partner.name,
      valid: result.valid,
      code: result.code,
      holderVerified: result.holderVerified,
    })

    // A rejection is a 200 with `valid: false`, not an HTTP error. "This credential is
    // revoked" is a successful answer to a verification question, and a 4xx would be
    // indistinguishable from the partner's own request being malformed.
    return ResponseBuilder.success(
      {
        ...result,
        issuingAuthority: PASSPORT_ISSUING_AUTHORITY,
        // Told plainly: a verifier that ignores this flag has no replay defence, and
        // it is not obvious from `valid: true` alone.
        replayProtectionNote: result.replayProtected
          ? undefined
          : 'Send both `expectedNonce` and a nonce you generated to make this presentation replay-proof.',
      },
      result.valid ? 'Credential verified' : 'Credential rejected',
    )
  }

  /**
   * Open a request the holder will approve in their wallet.
   *
   * The device-engagement handshake. Returns a single-use nonce bound to this partner's
   * audience plus a deep link that hands the request to the wallet.
   */
  @Post(VERIFY_ROUTES.REQUEST)
  @UseGuards(ThrottlerGuard, PartnerApiKeyGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async createRequest(
    @Body(new ZodValidationPipe(CreateVerifierRequestSchema))
    dto: CreateVerifierRequestDto,
    @Req() req: { partner: VerifierPartner },
  ) {
    const data = await this.sessions.createRequest(dto, req.partner)
    return ResponseBuilder.success(
      data,
      'Request opened — waiting for the holder to approve',
    )
  }

  /**
   * A scanned card resolves to a request here.
   *
   * `GET` because this is the URL physically encoded on the card, and an NFC tap or a
   * QR scan produces a GET. Nothing about the holder is returned — only a request id,
   * which is exactly as much as a piece of plastic should ever be able to prove.
   */
  @Get(VERIFY_ROUTES.CARD)
  @UseGuards(ThrottlerGuard, PartnerApiKeyGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async fromCard(
    @Param('cardRef') cardRef: string,
    @Req() req: { partner: VerifierPartner },
    @Query('template') template?: string,
  ) {
    const parsed = PresentationTemplateIdSchema.safeParse(template)
    const data = await this.sessions.requestFromCard(
      cardRef,
      req.partner,
      parsed.success ? parsed.data : undefined,
    )
    return ResponseBuilder.success(
      data,
      'Card recognised — the holder has been asked to approve',
    )
  }

  /** Poll for the holder's answer. Idempotent: the verdict is cached at approval. */
  @Get(VERIFY_ROUTES.REQUEST_RESULT)
  @UseGuards(ThrottlerGuard, PartnerApiKeyGuard)
  async requestResult(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Req() req: { partner: VerifierPartner },
  ) {
    const data = await this.sessions.result(requestId, req.partner)
    return ResponseBuilder.success(data, 'Request status')
  }

  /**
   * What this issuer is, and how to verify it without us.
   *
   * Unauthenticated on purpose. A verifier deciding whether to trust Pravaah at all
   * needs to read this BEFORE they have a key, and everything in it is public by
   * construction — it is the discovery document that makes the trust model self-service
   * rather than a conversation.
   */
  @Get(VERIFY_ROUTES.METADATA)
  metadata() {
    const publicUrl = this.config.publicUrl()
    return ResponseBuilder.success(
      {
        issuer: this.config.did(),
        issuingAuthority: PASSPORT_ISSUING_AUTHORITY,
        documentType: PASSPORT_DOCUMENT_TYPE,
        credentialFormat: SD_JWT_VC_TYP,
        vct: this.config.vct(),
        signingAlgorithms: [PASSPORT_ALG],
        didDocument: `${publicUrl}/.well-known/did.json`,
        jwks: `${publicUrl}/.well-known/jwks.json`,
        statusListFormat: 'BitstringStatusList',
        holderBinding: {
          required: true,
          proof: 'kb+jwt',
          note: 'Every presentation carries a holder-signed proof over the verifier’s nonce, audience, and the exact disclosure set. A stolen credential cannot be presented.',
        },
        claims: {
          alwaysVisible: ALWAYS_VISIBLE_CLAIMS,
          selectivelyDisclosable: DISCLOSABLE_CLAIMS,
        },
        // Stated explicitly because it is the thing a data-protection reviewer asks
        // first, and because it is a design guarantee rather than a policy promise.
        dataMinimisation:
          'This credential carries a derived reputation score and its provenance. It never contains transactions, balances, or account identifiers.',
        verificationSteps: [
          'Resolve the issuer DID (or fetch the JWKS) and check the SD-JWT signature.',
          'Confirm the JWS `typ` is dc+sd-jwt and `iss` is this issuer.',
          'Check `exp` (and `nbf`, if present).',
          'Fetch the status list named in `status.status_list.uri` and read the bit at `idx`. Treat an unreadable list as revoked.',
          'Hash each disclosure and confirm membership in `_sd`. Reject the whole presentation if any disclosure fails.',
          'Verify the KB-JWT against the `cnf` key, and check `sd_hash`, `aud`, and `nonce`.',
        ],
      },
      'Issuer metadata',
    )
  }

  /** Request templates, so a partner can ask by name and get a purpose sentence. */
  @Get(VERIFY_ROUTES.TEMPLATES)
  templates() {
    return ResponseBuilder.success(
      Object.values(PRESENTATION_TEMPLATES).map((template) => ({
        id: template.id,
        label: template.label,
        purpose: template.purpose,
        claims: describeClaims(template.claims),
      })),
      'Presentation templates',
    )
  }
}
