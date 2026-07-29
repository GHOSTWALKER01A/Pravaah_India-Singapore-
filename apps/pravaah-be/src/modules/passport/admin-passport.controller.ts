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

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AdminRevokeCredentialSchema,
  AdminSuspendCredentialSchema,
  CredentialListQuerySchema,
  RegisterPartnerSchema,
  type AdminRevokeCredentialDto,
  type AdminSuspendCredentialDto,
  type CredentialListQueryDto,
  type RegisterPartnerDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { ActorType, AdminRole, type AdminUser } from 'generated/prisma/client'

import { ADMIN_PASSPORT_ROUTES } from '@/modules/passport/passport.route'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { PassportAdminService } from '@/modules/passport/services/passport-admin.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'

/**
 * M3 admin console API — the credential-risk surface.
 *
 * The role split mirrors M2's and is deliberate:
 *
 *  - ADMIN alone rotates issuer keys and registers verifiers. A key rotation touches
 *    every credential we will ever sign, and a registered verifier can open requests
 *    against any holder — neither is a case-level decision.
 *  - SENIOR_REVIEWER may read everything and revoke or suspend a single credential.
 *    That is a judgement about one person, permanently attributed.
 *  - Plain REVIEWER has no business here, so the class guard excludes them.
 *
 * The acting admin always comes from `req.admin` (populated by {@link AdminAuthGuard}),
 * never from a request body — a self-declared actor id would make the whole attribution
 * trail worthless.
 */
@Controller(ADMIN_PASSPORT_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
export class AdminPassportController {
  private readonly logger: AppLogger

  constructor(
    private readonly admin: PassportAdminService,
    private readonly revocation: RevocationService,
    private readonly keys: KeyManagementService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminPassportController.name })
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  @Get(ADMIN_PASSPORT_ROUTES.LIST)
  async list(
    @Query(new ZodValidationPipe(CredentialListQuerySchema))
    query: CredentialListQueryDto,
  ) {
    const data = await this.admin.list(query)
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      data.offset,
      data.limit,
      'Issued passports',
    )
  }

  /**
   * Operational overview.
   *
   * Surfaces the FAILED presentation rate, not just issuance volume. A spike in
   * invalid presentations against one credential is the shape a theft attempt makes,
   * and it is invisible on a dashboard that only counts successes.
   */
  @Get(ADMIN_PASSPORT_ROUTES.STATS)
  async stats() {
    const data = await this.admin.stats()
    return ResponseBuilder.success(data, 'Passport statistics')
  }

  @Get(ADMIN_PASSPORT_ROUTES.DETAIL)
  async detail(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.admin.detail(id)
    return ResponseBuilder.success(data, 'Passport detail')
  }

  @Get(ADMIN_PASSPORT_ROUTES.AUDIT)
  async audit(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.admin.auditTrail(id)
    return ResponseBuilder.success(data, 'Passport audit trail')
  }

  // ── intervention ──────────────────────────────────────────────────────────
  /**
   * Revoke. Terminal — the holder re-issues rather than being un-revoked, because
   * un-revoking would let a credential a verifier already rejected start passing again,
   * and no verifier caches revocation with that possibility in mind.
   */
  @Post(ADMIN_PASSPORT_ROUTES.REVOKE)
  // A status transition, not a creation.
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
  async revoke(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(AdminRevokeCredentialSchema))
    dto: AdminRevokeCredentialDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.warn(`[${this.revoke.name}] Admin revoking a passport`, {
      credentialId: id,
      adminId: req.admin.id,
    })
    const data = await this.revocation.revoke(id, dto.reason, {
      type: ActorType.ADMIN,
      id: req.admin.id,
    })
    return ResponseBuilder.success(
      data,
      data.changed
        ? 'Passport revoked — every verifier will now reject it'
        : 'No change: the passport was already in that state',
    )
  }

  /** Reversible hold. Flips the same bit as a revocation, so verifiers fail closed. */
  @Post(ADMIN_PASSPORT_ROUTES.SUSPEND)
  // A status transition, not a creation.
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
  async suspend(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(AdminSuspendCredentialSchema))
    dto: AdminSuspendCredentialDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.warn(`[${this.suspend.name}] Admin suspending a passport`, {
      credentialId: id,
      adminId: req.admin.id,
    })
    const data = await this.revocation.suspend(id, dto.reason, {
      type: ActorType.ADMIN,
      id: req.admin.id,
    })
    return ResponseBuilder.success(data, 'Passport suspended')
  }

  @Post(ADMIN_PASSPORT_ROUTES.RESUME)
  // A status transition, not a creation.
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
  async resume(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(AdminSuspendCredentialSchema))
    dto: AdminSuspendCredentialDto,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.revocation.resume(id, dto.reason, {
      type: ActorType.ADMIN,
      id: req.admin.id,
    })
    return ResponseBuilder.success(data, 'Passport hold lifted')
  }

  // ── issuer keys ───────────────────────────────────────────────────────────
  @Get(ADMIN_PASSPORT_ROUTES.KEYS)
  async listKeys() {
    const data = await this.keys.list()
    return ResponseBuilder.success(data, 'Issuer key registry')
  }

  /**
   * Rotate the signing key.
   *
   * ADMIN only, and safe by construction: the old key stays in the DID document and
   * JWKS until every credential it signed has expired, so rotation never invalidates a
   * credential already in the wild. That guarantee is what makes this button pressable
   * during an incident rather than a mass revocation with extra steps.
   */
  @Post(ADMIN_PASSPORT_ROUTES.KEYS_ROTATE)
  @AdminRoles(AdminRole.ADMIN)
  async rotateKey(@Req() req: { admin: AdminUser }) {
    this.logger.warn(`[${this.rotateKey.name}] Admin rotating the issuer key`, {
      adminId: req.admin.id,
    })
    const kid = await this.keys.rotate({
      reason: 'admin_rotation',
      adminId: req.admin.id,
    })
    return ResponseBuilder.success(
      { kid },
      'Issuer key rotated. Previously-issued passports continue to verify against the retained public keys.',
    )
  }

  // ── verifier partners ─────────────────────────────────────────────────────
  @Get(ADMIN_PASSPORT_ROUTES.PARTNERS)
  async listPartners() {
    const data = await this.admin.listPartners()
    return ResponseBuilder.success(data, 'Registered verifiers')
  }

  /** Register a verifier. The API key is shown ONCE and only its hash is stored. */
  @Post(ADMIN_PASSPORT_ROUTES.PARTNERS)
  @AdminRoles(AdminRole.ADMIN)
  async registerPartner(
    @Body(new ZodValidationPipe(RegisterPartnerSchema)) dto: RegisterPartnerDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(
      `[${this.registerPartner.name}] Registering a verifier partner`,
      { audience: dto.audience, adminId: req.admin.id },
    )
    const data = await this.admin.registerPartner(dto, req.admin.id)
    return ResponseBuilder.success(data, 'Verifier registered')
  }

  @Post(ADMIN_PASSPORT_ROUTES.PARTNER_REVOKE)
  // A status transition, not a creation.
  @HttpCode(HttpStatus.OK)
  @AdminRoles(AdminRole.ADMIN)
  async deactivatePartner(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Req() req: { admin: AdminUser },
  ) {
    const data = await this.admin.deactivatePartner(id, req.admin.id)
    return ResponseBuilder.success(data, 'Verifier deactivated')
  }
}
