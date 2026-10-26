import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'

import {
  TrustRegistryEntrySchema,
  UpdateTrustRegistryEntrySchema,
  type TrustRegistryEntryDto,
  type UpdateTrustRegistryEntryDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { AdminRole, type AdminUser } from 'generated/prisma/client'

import { ADMIN_TRUST_REGISTRY_ROUTES } from '@/modules/partner/partner.route'
import { TrustRegistryService } from '@/modules/partner/services/trust-registry.service'

/**
 * PRAVAAH admin — the trust registry.
 *
 * Accepting an issuer is the cross-border trust decision made explicit and
 * auditable; distrusting one is the incident kill switch. Both are ADMIN-only:
 * either one changes the verdict of every future verification naming that issuer.
 */
@Controller(ADMIN_TRUST_REGISTRY_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
export class AdminTrustRegistryController {
  constructor(private readonly trust: TrustRegistryService) {}

  @Get(ADMIN_TRUST_REGISTRY_ROUTES.LIST)
  async list() {
    const data = await this.trust.list()
    return ResponseBuilder.success(data, 'Trust registry')
  }

  @Post(ADMIN_TRUST_REGISTRY_ROUTES.LIST)
  @AdminRoles(AdminRole.ADMIN)
  async add(
    @Body(new ZodValidationPipe(TrustRegistryEntrySchema))
    dto: TrustRegistryEntryDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.trust.add(dto, req.admin.id)
    return ResponseBuilder.success(data, 'Issuer added to the trust registry')
  }

  @Patch(ADMIN_TRUST_REGISTRY_ROUTES.ENTRY)
  @AdminRoles(AdminRole.ADMIN)
  async update(
    @Param('entryId', new UUIDValidationPipe()) entryId: string,
    @Body(new ZodValidationPipe(UpdateTrustRegistryEntrySchema))
    dto: UpdateTrustRegistryEntryDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.trust.update(entryId, dto, req.admin.id)
    return ResponseBuilder.success(
      data,
      data.accepted
        ? 'Trust registry entry updated'
        : 'Issuer distrusted — its credentials now fail verification',
    )
  }
}
