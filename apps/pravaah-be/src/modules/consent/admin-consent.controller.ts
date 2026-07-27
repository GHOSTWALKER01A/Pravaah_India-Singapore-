import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { ResponseBuilder } from '@/utils/response-builder'

import { AdminRole, ConsentStatus } from 'generated/prisma/client'

import { ADMIN_CONSENT_ROUTES } from '@/modules/consent/consent.route'

/**
 * Admin oversight of the AA consent estate. Read-only: consent state and its
 * append-only audit trail are the compliance/trust evidence — admins never
 * mutate a user's consent here.
 */
@Controller(ADMIN_CONSENT_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
export class AdminConsentController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(ADMIN_CONSENT_ROUTES.LIST)
  async list(@Query('status') status?: string) {
    const where =
      status && status in ConsentStatus
        ? { status: status as ConsentStatus }
        : {}
    const rows = await this.prisma.consent.findMany({
      where,
      select: {
        id: true,
        userId: true,
        // The console labels users by their Pravaah ID, never by the row id.
        user: { select: { pravaahId: true } },
        aaProvider: true,
        purpose: true,
        purposeCode: true,
        status: true,
        fiTypes: true,
        fetchType: true,
        artefactVerified: true,
        createdAt: true,
        activatedAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    // Flatten the nested relation so the list DTO stays one level deep.
    const data = rows.map(({ user, ...consent }) => ({
      ...consent,
      userRef: user.pravaahId,
    }))
    return ResponseBuilder.success(data, 'Consent estate')
  }

  @Get(ADMIN_CONSENT_ROUTES.DETAIL)
  async detail(@Param('id', new UUIDValidationPipe()) id: string) {
    const consent = await this.prisma.consent.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        aaProvider: true,
        vua: true,
        purpose: true,
        purposeCode: true,
        consentMode: true,
        fetchType: true,
        fiTypes: true,
        status: true,
        artefactVerified: true,
        dataRangeFrom: true,
        dataRangeTo: true,
        dataLifeUnit: true,
        dataLifeValue: true,
        consentExpiry: true,
        createdAt: true,
        activatedAt: true,
        revokedAt: true,
        expiresAt: true,
        user: {
          select: {
            pravaahId: true,
            phone: true,
            email: true,
            primaryCountry: true,
          },
        },
        sessions: {
          orderBy: { requestedAt: 'desc' },
          take: 1,
          select: {
            status: true,
            fipTotal: true,
            fipCompleted: true,
            completedAt: true,
            requestedAt: true,
          },
        },
      },
    })
    if (!consent) throw new NotFoundException('Consent not found')

    const featuresAvailable = await this.prisma.fiNormalized.count({
      where: { consentId: id },
    })
    return ResponseBuilder.success(
      { ...consent, featuresAvailable },
      'Consent detail',
    )
  }

  @Get(ADMIN_CONSENT_ROUTES.AUDIT)
  @AdminRoles(AdminRole.ADMIN)
  async audit(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.prisma.auditLog.findMany({
      where: { entity: 'Consent', entityId: id },
      orderBy: { createdAt: 'asc' },
    })
    return ResponseBuilder.success(data, 'Consent audit trail')
  }
}
