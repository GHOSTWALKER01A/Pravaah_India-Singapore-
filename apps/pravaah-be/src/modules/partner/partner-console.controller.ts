import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import {
  CLAIM_CATALOGUE,
  DISCLOSABLE_CLAIMS,
  PREDICATE_CLAIMS,
  PREDICATE_OPS,
  PRESENTATION_TEMPLATES,
  CancelPartnerVerificationSchema,
  CreatePartnerTemplateSchema,
  CreatePartnerVerificationSchema,
  InvitePartnerUserSchema,
  IssuePartnerApiKeySchema,
  PartnerDecisionSchema,
  PartnerUsageQuerySchema,
  PartnerVerificationListQuerySchema,
  RevokePartnerApiKeySchema,
  RotatePartnerApiKeySchema,
  UpdatePartnerProfileSchema,
  UpdatePartnerTemplateSchema,
  UpdatePartnerUserSchema,
  WebhookDeliveryQuerySchema,
  describeClaims,
  type CancelPartnerVerificationDto,
  type CreatePartnerTemplateDto,
  type CreatePartnerVerificationDto,
  type InvitePartnerUserDto,
  type IssuePartnerApiKeyDto,
  type PartnerDecisionDto,
  type PartnerUsageQueryDto,
  type PartnerVerificationListQueryDto,
  type RevokePartnerApiKeyDto,
  type RotatePartnerApiKeyDto,
  type UpdatePartnerProfileDto,
  type UpdatePartnerTemplateDto,
  type UpdatePartnerUserDto,
  type WebhookDeliveryQueryDto,
} from '@pravaah/schema'

import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { PartnerRole } from 'generated/prisma/client'

import { OptionalIdempotencyKey } from '@/modules/partner/decorators/optional-idempotency-key.decorator'
import {
  PartnerConsoleGuard,
  PartnerMinRole,
  PartnerRolesGuard,
  type PartnerConsoleContext,
} from '@/modules/partner/guards/partner-console.guard'
import { billingPeriod } from '@/modules/partner/partner.state'
import { PARTNER_CONSOLE_ROUTES } from '@/modules/partner/partner.route'
import { PartnerApiKeyService } from '@/modules/partner/services/partner-api-key.service'
import { PartnerRegistryService } from '@/modules/partner/services/partner-registry.service'
import { PartnerTemplateService } from '@/modules/partner/services/partner-template.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import { PartnerUserService } from '@/modules/partner/services/partner-user.service'
import {
  PartnerVerificationService,
  type PartnerActor,
} from '@/modules/partner/services/partner-verification.service'
import { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'

/**
 * The partner's web console.
 *
 * Authenticated as a PERSON (a pre-provisioned console user on the ordinary OTP
 * login), where the partner API is authenticated as an INTEGRATION (a key). Roles
 * are a ladder — VIEWER reads, ANALYST verifies and decides, ADMIN manages keys,
 * webhooks, templates and the team — enforced per route with `@PartnerMinRole`.
 *
 * Every write is scoped to the caller's own partner by construction: the partner id
 * comes from `req.consolePartner`, resolved by the guard, never from a path or body.
 */
@Controller(PARTNER_CONSOLE_ROUTES.BASE)
@UseGuards(PartnerConsoleGuard, PartnerRolesGuard)
export class PartnerConsoleController {
  constructor(
    private readonly registry: PartnerRegistryService,
    private readonly keys: PartnerApiKeyService,
    private readonly users: PartnerUserService,
    private readonly templates: PartnerTemplateService,
    private readonly verifications: PartnerVerificationService,
    private readonly usage: PartnerUsageService,
    private readonly webhooks: PartnerWebhookService,
  ) {}

  // ── identity + profile ────────────────────────────────────────────────────
  @Get(PARTNER_CONSOLE_ROUTES.ME)
  async me(@Req() req: PartnerConsoleContext) {
    const partner = await this.registry.profile(req.consolePartner.id)
    return ResponseBuilder.success(
      {
        user: {
          id: req.partnerUser.id,
          email: req.partnerUser.email,
          name: req.partnerUser.name,
          role: req.partnerUser.role,
        },
        partner,
      },
      'Console session',
    )
  }

  @Patch(PARTNER_CONSOLE_ROUTES.PROFILE)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async updateProfile(
    @Body(new ZodValidationPipe(UpdatePartnerProfileSchema))
    dto: UpdatePartnerProfileDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.registry.updateProfile(
      req.consolePartner.id,
      dto,
      req.partnerUser.id,
    )
    return ResponseBuilder.success(data, 'Profile updated')
  }

  /** What the request builder offers, each claim marked in or out of this partner's scope. */
  @Get(PARTNER_CONSOLE_ROUTES.CATALOGUE)
  catalogue(@Req() req: PartnerConsoleContext) {
    const scope = new Set(req.consolePartner.allowedScopes)
    return ResponseBuilder.success(
      {
        claims: DISCLOSABLE_CLAIMS.map((claim) => ({
          ...CLAIM_CATALOGUE[claim],
          inScope: scope.has(claim),
        })),
        templates: Object.values(PRESENTATION_TEMPLATES).map((template) => ({
          id: template.id,
          label: template.label,
          purpose: template.purpose,
          claims: describeClaims(template.claims),
          usable: template.claims.every((claim) => scope.has(claim)),
        })),
        predicates: {
          claims: PREDICATE_CLAIMS,
          ops: PREDICATE_OPS,
          example: { claim: 'score_band', op: 'GTE', value: 'GOOD' },
          note: 'A predicate is answered with issuer-signed booleans — the holder never discloses the band or the score.',
        },
      },
      'Request catalogue',
    )
  }

  // ── webhooks ──────────────────────────────────────────────────────────────
  @Post(PARTNER_CONSOLE_ROUTES.WEBHOOK_SECRET_ROTATE)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async rotateWebhookSecret(@Req() req: PartnerConsoleContext) {
    const data = await this.registry.rotateWebhookSecret(
      req.consolePartner.id,
      req.partnerUser.id,
    )
    return ResponseBuilder.success(data, 'Webhook secret rotated')
  }

  @Post(PARTNER_CONSOLE_ROUTES.WEBHOOK_TEST)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async testWebhook(@Req() req: PartnerConsoleContext) {
    const data = await this.webhooks.sendTest(req.consolePartner.id)
    return ResponseBuilder.success(
      data,
      data.delivered ? 'Test delivered' : 'Test delivery failed',
    )
  }

  @Get(PARTNER_CONSOLE_ROUTES.WEBHOOK_DELIVERIES)
  @PartnerMinRole(PartnerRole.PARTNER_ANALYST)
  async deliveries(
    @Query(new ZodValidationPipe(WebhookDeliveryQuerySchema))
    query: WebhookDeliveryQueryDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.webhooks.listDeliveries(
      req.consolePartner.id,
      query,
    )
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      query.offset,
      query.limit,
      'Webhook deliveries',
    )
  }

  @Post(PARTNER_CONSOLE_ROUTES.WEBHOOK_REDELIVER)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async redeliver(
    @Param('deliveryId', new UUIDValidationPipe()) deliveryId: string,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.webhooks.redeliver(
      req.consolePartner.id,
      deliveryId,
    )
    return ResponseBuilder.success(data, 'Delivery re-queued')
  }

  // ── API keys ──────────────────────────────────────────────────────────────
  @Get(PARTNER_CONSOLE_ROUTES.API_KEYS)
  @PartnerMinRole(PartnerRole.PARTNER_ANALYST)
  async listKeys(@Req() req: PartnerConsoleContext) {
    const data = await this.keys.list(req.consolePartner.id)
    return ResponseBuilder.success(data, 'API keys')
  }

  /** The plaintext key is in this response and nowhere else, ever. */
  @Post(PARTNER_CONSOLE_ROUTES.API_KEYS)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async issueKey(
    @Body(new ZodValidationPipe(IssuePartnerApiKeySchema))
    dto: IssuePartnerApiKeyDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.keys.issue(req.consolePartner.id, dto, {
      kind: 'PARTNER_USER',
      id: req.partnerUser.id,
    })
    return ResponseBuilder.success(data, 'API key issued — copy it now')
  }

  @Post(PARTNER_CONSOLE_ROUTES.API_KEY_REVOKE)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async revokeKey(
    @Param('keyId', new UUIDValidationPipe()) keyId: string,
    @Body(new ZodValidationPipe(RevokePartnerApiKeySchema))
    dto: RevokePartnerApiKeyDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.keys.revoke(
      req.consolePartner.id,
      keyId,
      dto.reason,
      {
        kind: 'PARTNER_USER',
        id: req.partnerUser.id,
      },
    )
    return ResponseBuilder.success(data, 'API key revoked')
  }

  @Post(PARTNER_CONSOLE_ROUTES.API_KEY_ROTATE)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async rotateKey(
    @Param('keyId', new UUIDValidationPipe()) keyId: string,
    @Body(new ZodValidationPipe(RotatePartnerApiKeySchema))
    dto: RotatePartnerApiKeyDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.keys.rotate(
      req.consolePartner.id,
      keyId,
      dto.graceHours,
      {
        kind: 'PARTNER_USER',
        id: req.partnerUser.id,
      },
    )
    return ResponseBuilder.success(
      data,
      'API key rotated — copy the new key now',
    )
  }

  // ── verifications ─────────────────────────────────────────────────────────
  @Post(PARTNER_CONSOLE_ROUTES.VERIFICATIONS)
  @PartnerMinRole(PartnerRole.PARTNER_ANALYST)
  async createVerification(
    @Body(new ZodValidationPipe(CreatePartnerVerificationSchema))
    dto: CreatePartnerVerificationDto,
    @Req() req: PartnerConsoleContext,
    @OptionalIdempotencyKey() idempotencyKey: string | null,
  ) {
    const data = await this.verifications.create(
      this.actor(req),
      dto,
      idempotencyKey,
    )
    return ResponseBuilder.success(
      data,
      'Verification opened — show the QR to your customer',
    )
  }

  @Get(PARTNER_CONSOLE_ROUTES.VERIFICATIONS)
  async listVerifications(
    @Query(new ZodValidationPipe(PartnerVerificationListQuerySchema))
    query: PartnerVerificationListQueryDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.verifications.list(req.consolePartner.id, query)
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      query.offset,
      query.limit,
      'Verifications',
    )
  }

  @Get(PARTNER_CONSOLE_ROUTES.VERIFICATION)
  async verification(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.verifications.detail(this.actor(req), requestId)
    return ResponseBuilder.success(data, 'Verification')
  }

  @Post(PARTNER_CONSOLE_ROUTES.VERIFICATION_CANCEL)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ANALYST)
  async cancelVerification(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Body(new ZodValidationPipe(CancelPartnerVerificationSchema))
    dto: CancelPartnerVerificationDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.verifications.cancel(
      this.actor(req),
      requestId,
      dto.reason,
    )
    return ResponseBuilder.success(data, 'Verification cancelled')
  }

  @Post(PARTNER_CONSOLE_ROUTES.VERIFICATION_DECISION)
  @HttpCode(HttpStatus.OK)
  @PartnerMinRole(PartnerRole.PARTNER_ANALYST)
  async decide(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @Body(new ZodValidationPipe(PartnerDecisionSchema)) dto: PartnerDecisionDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.verifications.decide(
      this.actor(req),
      requestId,
      dto,
    )
    return ResponseBuilder.success(data, 'Decision recorded')
  }

  // ── templates ─────────────────────────────────────────────────────────────
  @Get(PARTNER_CONSOLE_ROUTES.TEMPLATES)
  async listTemplates(@Req() req: PartnerConsoleContext) {
    const data = await this.templates.list(req.consolePartner.id, true)
    return ResponseBuilder.success(data, 'Templates')
  }

  @Post(PARTNER_CONSOLE_ROUTES.TEMPLATES)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async createTemplate(
    @Body(new ZodValidationPipe(CreatePartnerTemplateSchema))
    dto: CreatePartnerTemplateDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.templates.create(
      req.consolePartner.id,
      req.consolePartner.allowedScopes,
      dto,
    )
    return ResponseBuilder.success(data, 'Template created')
  }

  @Patch(PARTNER_CONSOLE_ROUTES.TEMPLATE)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async updateTemplate(
    @Param('templateId', new UUIDValidationPipe()) templateId: string,
    @Body(new ZodValidationPipe(UpdatePartnerTemplateSchema))
    dto: UpdatePartnerTemplateDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.templates.update(
      req.consolePartner.id,
      templateId,
      req.consolePartner.allowedScopes,
      dto,
    )
    return ResponseBuilder.success(data, 'Template updated')
  }

  // ── usage ─────────────────────────────────────────────────────────────────
  @Get(PARTNER_CONSOLE_ROUTES.USAGE)
  async usageSummary(
    @Query(new ZodValidationPipe(PartnerUsageQuerySchema))
    query: PartnerUsageQueryDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.usage.summary(
      req.consolePartner.id,
      query.period ?? billingPeriod(),
    )
    return ResponseBuilder.success(data, 'Usage')
  }

  @Get(PARTNER_CONSOLE_ROUTES.USAGE_LINE_ITEMS)
  async usageLineItems(
    @Query(new ZodValidationPipe(PartnerUsageQuerySchema))
    query: PartnerUsageQueryDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.usage.lineItems(
      req.consolePartner.id,
      query.period ?? billingPeriod(),
      query.limit,
      query.offset,
    )
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      query.offset,
      query.limit,
      'Billable line items',
    )
  }

  // ── team ──────────────────────────────────────────────────────────────────
  @Get(PARTNER_CONSOLE_ROUTES.USERS)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async listUsers(@Req() req: PartnerConsoleContext) {
    const data = await this.users.list(req.consolePartner.id)
    return ResponseBuilder.success(data, 'Team')
  }

  @Post(PARTNER_CONSOLE_ROUTES.USERS)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async inviteUser(
    @Body(new ZodValidationPipe(InvitePartnerUserSchema))
    dto: InvitePartnerUserDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.users.invite(req.consolePartner.id, dto, {
      kind: 'PARTNER_USER',
      id: req.partnerUser.id,
    })
    return ResponseBuilder.success(data, 'Team member added')
  }

  @Patch(PARTNER_CONSOLE_ROUTES.USER)
  @PartnerMinRole(PartnerRole.PARTNER_ADMIN)
  async updateUser(
    @Param('userId', new UUIDValidationPipe()) userId: string,
    @Body(new ZodValidationPipe(UpdatePartnerUserSchema))
    dto: UpdatePartnerUserDto,
    @Req() req: PartnerConsoleContext,
  ) {
    const data = await this.users.update(req.consolePartner.id, userId, dto, {
      kind: 'PARTNER_USER',
      id: req.partnerUser.id,
    })
    return ResponseBuilder.success(data, 'Team member updated')
  }

  private actor(req: PartnerConsoleContext): PartnerActor {
    // A console user acts with the partner's full approved scope; there is no key
    // to narrow it. Attribution is the person.
    return {
      partner: req.consolePartner,
      scopes: req.consolePartner.allowedScopes,
      partnerUserId: req.partnerUser.id,
    }
  }
}
