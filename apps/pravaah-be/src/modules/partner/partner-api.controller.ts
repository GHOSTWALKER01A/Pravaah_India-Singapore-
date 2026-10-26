import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import {
  CancelPartnerVerificationSchema,
  CreatePartnerVerificationSchema,
  PartnerDecisionSchema,
  PartnerDirectVerifySchema,
  PartnerUsageQuerySchema,
  PartnerVerificationListQuerySchema,
  type CancelPartnerVerificationDto,
  type CreatePartnerVerificationDto,
  type PartnerDecisionDto,
  type PartnerDirectVerifyDto,
  type PartnerUsageQueryDto,
  type PartnerVerificationListQueryDto,
} from '@pravaah/schema'

import {
  PartnerApiKeyGuard,
  type PartnerAuthContext,
} from '@/common/guards/partner-api-key.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { OptionalIdempotencyKey } from '@/modules/partner/decorators/optional-idempotency-key.decorator'
import { billingPeriod } from '@/modules/partner/partner.state'
import { PARTNER_API_ROUTES } from '@/modules/partner/partner.route'
import { PartnerRegistryService } from '@/modules/partner/services/partner-registry.service'
import { PartnerTemplateService } from '@/modules/partner/services/partner-template.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import {
  PartnerVerificationService,
  type PartnerActor,
} from '@/modules/partner/services/partner-verification.service'

/**
 * The server-to-server partner API — verification-as-a-service.
 *
 * Authenticated by a partner API key on every route (`PartnerApiKeyGuard` at the
 * class level, so no route can be added without it). The key's effective scope —
 * its own scopes intersected with the partner's CURRENT approval — travels with the
 * request, which is how a narrow integration key stays narrow.
 *
 * Rate limiting is per key, in the guard, from the key's own `rateLimitPerMin`.
 *
 * Zod pipes are applied PARAMETER-scoped (`@Body(new ZodValidationPipe(...))`),
 * never method-level `@UsePipes` — the latter validates `@Req()` and `@Param()`
 * against the body schema too, the bug that once broke every guarded KYC POST.
 */
@Controller(PARTNER_API_ROUTES.BASE)
@UseGuards(PartnerApiKeyGuard)
export class PartnerApiController {
  constructor(
    private readonly verifications: PartnerVerificationService,
    private readonly registry: PartnerRegistryService,
    private readonly templates: PartnerTemplateService,
    private readonly usage: PartnerUsageService,
  ) {}

  /** Who this key authenticates as, and what it may ask for. */
  @Get(PARTNER_API_ROUTES.ME)
  async me(@Req() req: PartnerAuthContext) {
    const profile = await this.registry.profile(req.partner.id)
    return ResponseBuilder.success(
      {
        partner: profile,
        key: req.partnerApiKey
          ? {
              id: req.partnerApiKey.id,
              label: req.partnerApiKey.label,
              prefix: req.partnerApiKey.prefix,
              rateLimitPerMin: req.partnerApiKey.rateLimitPerMin,
              expiresAt: req.partnerApiKey.expiresAt,
            }
          : { legacy: true },
        effectiveScopes: req.partnerScopes,
      },
      'Authenticated partner',
    )
  }

  /**
   * Open a verification. Send an `Idempotency-Key` to make retries safe: a replay
   * returns the original request rather than prompting the holder twice.
   */
  @Post(PARTNER_API_ROUTES.VERIFICATIONS)
  async create(
    @Body(new ZodValidationPipe(CreatePartnerVerificationSchema))
    dto: CreatePartnerVerificationDto,
    @Req() req: PartnerAuthContext,
    @OptionalIdempotencyKey() idempotencyKey: string | null,
  ) {
    const data = await this.verifications.create(
      this.actor(req),
      dto,
      idempotencyKey,
    )
    return ResponseBuilder.success(
      data,
      data.replayed
        ? 'Existing verification returned (idempotent replay)'
        : 'Verification opened',
    )
  }

  @Get(PARTNER_API_ROUTES.VERIFICATIONS)
  async list(
    @Query(new ZodValidationPipe(PartnerVerificationListQuerySchema))
    query: PartnerVerificationListQueryDto,
    @Req() req: PartnerAuthContext,
  ) {
    const data = await this.verifications.list(req.partner.id, query)
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      query.offset,
      query.limit,
      'Verifications',
    )
  }

  /** Status + verified result. Reading an approved result collects it (burns the nonce). */
  @Get(PARTNER_API_ROUTES.VERIFICATION)
  async detail(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Req() req: PartnerAuthContext,
  ) {
    const data = await this.verifications.detail(this.actor(req), requestId)
    return ResponseBuilder.success(data, 'Verification')
  }

  @Post(PARTNER_API_ROUTES.VERIFICATION_CANCEL)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Body(new ZodValidationPipe(CancelPartnerVerificationSchema))
    dto: CancelPartnerVerificationDto,
    @Req() req: PartnerAuthContext,
  ) {
    const data = await this.verifications.cancel(
      this.actor(req),
      requestId,
      dto.reason,
    )
    return ResponseBuilder.success(data, 'Verification cancelled')
  }

  /** Record the underwriting outcome. Revisable; every revision is audited. */
  @Post(PARTNER_API_ROUTES.VERIFICATION_DECISION)
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Body(new ZodValidationPipe(PartnerDecisionSchema)) dto: PartnerDecisionDto,
    @Req() req: PartnerAuthContext,
  ) {
    const data = await this.verifications.decide(
      this.actor(req),
      requestId,
      dto,
    )
    return ResponseBuilder.success(data, 'Decision recorded')
  }

  /**
   * Verify a presentation handed to the partner directly. 200 whatever the verdict:
   * `valid: false` is a successful answer, not a failed request.
   */
  @Post(PARTNER_API_ROUTES.PRESENTATIONS_VERIFY)
  @HttpCode(HttpStatus.OK)
  async verifyDirect(
    @Body(new ZodValidationPipe(PartnerDirectVerifySchema))
    dto: PartnerDirectVerifyDto,
    @Req() req: PartnerAuthContext,
  ) {
    const data = await this.verifications.verifyDirect(this.actor(req), dto)
    return ResponseBuilder.success(
      data,
      data.valid ? 'Presentation verified' : 'Presentation rejected',
    )
  }

  @Get(PARTNER_API_ROUTES.TEMPLATES)
  async listTemplates(@Req() req: PartnerAuthContext) {
    const data = await this.templates.list(req.partner.id)
    return ResponseBuilder.success(data, 'Templates')
  }

  @Get(PARTNER_API_ROUTES.USAGE)
  async usageSummary(
    @Query(new ZodValidationPipe(PartnerUsageQuerySchema))
    query: PartnerUsageQueryDto,
    @Req() req: PartnerAuthContext,
  ) {
    const data = await this.usage.summary(
      req.partner.id,
      query.period ?? billingPeriod(),
    )
    return ResponseBuilder.success(data, 'Usage')
  }

  private actor(req: PartnerAuthContext): PartnerActor {
    return {
      partner: req.partner,
      scopes: req.partnerScopes,
      apiKeyId: req.partnerApiKey?.id ?? null,
    }
  }
}
