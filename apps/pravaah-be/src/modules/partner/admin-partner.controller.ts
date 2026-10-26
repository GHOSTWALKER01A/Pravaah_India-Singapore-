import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AdminPartnerListQuerySchema,
  ApprovePartnerSchema,
  InvitePartnerUserSchema,
  IssuePartnerApiKeySchema,
  PartnerStatusChangeSchema,
  PartnerUsageQuerySchema,
  UpdatePartnerPolicySchema,
  type AdminPartnerListQueryDto,
  type ApprovePartnerDto,
  type InvitePartnerUserDto,
  type IssuePartnerApiKeyDto,
  type PartnerStatusChangeDto,
  type PartnerUsageQueryDto,
  type UpdatePartnerPolicyDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { ResponseBuilder } from '@/utils/response-builder'

import {
  AdminRole,
  PartnerStatus,
  type AdminUser,
} from 'generated/prisma/client'

import { billingPeriod } from '@/modules/partner/partner.state'
import { ADMIN_PARTNER_ROUTES } from '@/modules/partner/partner.route'
import { PartnerApiKeyService } from '@/modules/partner/services/partner-api-key.service'
import { PartnerRegistryService } from '@/modules/partner/services/partner-registry.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import { PartnerUserService } from '@/modules/partner/services/partner-user.service'

/**
 * PRAVAAH admin — partner approvals, policy and oversight.
 *
 * The role split, and why:
 *
 *  - ADMIN alone approves, rejects, reinstates, revokes and sets policy. Approval
 *    decides which holder data a business may ever ask for; it is not a case-level
 *    decision.
 *  - SENIOR_REVIEWER may read everything and SUSPEND — the reversible emergency
 *    brake. Somebody on shift must be able to stop a partner that is harvesting
 *    without waiting for an admin, and nothing a suspension does is irreversible.
 *
 * The acting admin always comes from `req.admin`, never a body field — the approval
 * trail is only worth something if nobody can type someone else's id into it.
 */
@Controller(ADMIN_PARTNER_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
export class AdminPartnerController {
  private readonly logger: AppLogger

  constructor(
    private readonly registry: PartnerRegistryService,
    private readonly keys: PartnerApiKeyService,
    private readonly users: PartnerUserService,
    private readonly usage: PartnerUsageService,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminPartnerController.name })
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  @Get(ADMIN_PARTNER_ROUTES.LIST)
  async list(
    @Query(new ZodValidationPipe(AdminPartnerListQuerySchema))
    query: AdminPartnerListQueryDto,
  ) {
    const data = await this.registry.list(query)
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      query.offset,
      query.limit,
      'Partners',
    )
  }

  /** The approval queue size, the partner base, and this period's billable volume. */
  @Get(ADMIN_PARTNER_ROUTES.OVERVIEW)
  async overview(
    @Query(new ZodValidationPipe(PartnerUsageQuerySchema))
    query: PartnerUsageQueryDto,
  ) {
    const [byStatus, usage] = await Promise.all([
      this.prisma.verifierPartner.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.usage.platformOverview(query.period ?? billingPeriod()),
    ])
    return ResponseBuilder.success(
      {
        partners: Object.fromEntries(
          Object.values(PartnerStatus).map((status) => [
            status,
            byStatus.find((row) => row.status === status)?._count._all ?? 0,
          ]),
        ),
        usage,
      },
      'Partner overview',
    )
  }

  @Get(ADMIN_PARTNER_ROUTES.DETAIL)
  async detail(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
  ) {
    const data = await this.registry.detail(partnerId)
    return ResponseBuilder.success(data, 'Partner detail')
  }

  @Get(ADMIN_PARTNER_ROUTES.USAGE)
  async partnerUsage(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Query(new ZodValidationPipe(PartnerUsageQuerySchema))
    query: PartnerUsageQueryDto,
  ) {
    const data = await this.usage.summary(
      partnerId,
      query.period ?? billingPeriod(),
    )
    return ResponseBuilder.success(data, 'Partner usage')
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  @Post(ADMIN_PARTNER_ROUTES.APPROVE)
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN)
  async approve(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(ApprovePartnerSchema)) dto: ApprovePartnerDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(`[${this.approve.name}] Admin approving a partner`, {
      partnerId,
      adminId: req.admin.id,
      scopes: dto.allowedScopes,
    })
    const data = await this.registry.approve(partnerId, dto, req.admin.id)
    return ResponseBuilder.success(data, 'Partner approved')
  }

  @Post(ADMIN_PARTNER_ROUTES.REJECT)
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN)
  async reject(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(PartnerStatusChangeSchema))
    dto: PartnerStatusChangeDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.registry.reject(partnerId, dto.reason, req.admin.id)
    return ResponseBuilder.success(data, 'Application rejected')
  }

  /** The emergency brake. Open to SENIOR_REVIEWER on purpose — see the class note. */
  @Post(ADMIN_PARTNER_ROUTES.SUSPEND)
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
  async suspend(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(PartnerStatusChangeSchema))
    dto: PartnerStatusChangeDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.warn(`[${this.suspend.name}] Admin suspending a partner`, {
      partnerId,
      adminId: req.admin.id,
    })
    const data = await this.registry.suspend(
      partnerId,
      dto.reason,
      req.admin.id,
    )
    return ResponseBuilder.success(
      data,
      'Partner suspended — its keys stop working immediately',
    )
  }

  @Post(ADMIN_PARTNER_ROUTES.REINSTATE)
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN)
  async reinstate(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(PartnerStatusChangeSchema))
    dto: PartnerStatusChangeDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.registry.reinstate(
      partnerId,
      dto.reason,
      req.admin.id,
    )
    return ResponseBuilder.success(data, 'Partner reinstated')
  }

  @Post(ADMIN_PARTNER_ROUTES.REVOKE)
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN)
  async revoke(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(PartnerStatusChangeSchema))
    dto: PartnerStatusChangeDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.warn(`[${this.revoke.name}] Admin revoking a partner`, {
      partnerId,
      adminId: req.admin.id,
    })
    const data = await this.registry.revoke(partnerId, dto.reason, req.admin.id)
    return ResponseBuilder.success(
      data,
      'Partner revoked — this cannot be undone',
    )
  }

  @Patch(ADMIN_PARTNER_ROUTES.POLICY)
  @AdminRoles(AdminRole.ADMIN)
  async updatePolicy(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(UpdatePartnerPolicySchema))
    dto: UpdatePartnerPolicyDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.registry.updatePolicy(partnerId, dto, req.admin.id)
    return ResponseBuilder.success(data, 'Partner policy updated')
  }

  // ── bootstrap: a first console user and a first key ──────────────────────
  @Get(ADMIN_PARTNER_ROUTES.USERS)
  async listUsers(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
  ) {
    const data = await this.users.list(partnerId)
    return ResponseBuilder.success(data, 'Partner team')
  }

  @Post(ADMIN_PARTNER_ROUTES.USERS)
  @AdminRoles(AdminRole.ADMIN)
  async provisionUser(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(InvitePartnerUserSchema))
    dto: InvitePartnerUserDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.users.invite(partnerId, dto, {
      kind: 'ADMIN',
      id: req.admin.id,
    })
    return ResponseBuilder.success(data, 'Console user provisioned')
  }

  @Get(ADMIN_PARTNER_ROUTES.API_KEYS)
  async listKeys(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
  ) {
    const data = await this.keys.list(partnerId)
    return ResponseBuilder.success(data, 'Partner API keys')
  }

  @Post(ADMIN_PARTNER_ROUTES.API_KEYS)
  @AdminRoles(AdminRole.ADMIN)
  async issueKey(
    @Param('partnerId', new UUIDValidationPipe()) partnerId: string,
    @Body(new ZodValidationPipe(IssuePartnerApiKeySchema))
    dto: IssuePartnerApiKeyDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.keys.issue(partnerId, dto, {
      kind: 'ADMIN',
      id: req.admin.id,
    })
    return ResponseBuilder.success(
      data,
      'API key issued — hand it over securely',
    )
  }
}
