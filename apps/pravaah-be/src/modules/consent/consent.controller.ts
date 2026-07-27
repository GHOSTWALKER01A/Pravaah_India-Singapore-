import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CreateConsentSchema,
  type CreateConsentDto,
} from '@pravaah/schema'

import { User, type AuthenticatedUser } from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { CONSENT_ROUTES } from '@/modules/consent/consent.route'
import { ConsentService } from '@/modules/consent/services/consent.service'
import { DataSessionService } from '@/modules/consent/services/data-session.service'

/**
 * M1 user-facing consent API. Every route is JWT-guarded; the authenticated
 * `user.id` IS the internal `User.id` (Supabase sub). The consent dashboard,
 * revoke (data-purge), and manual re-fetch all live here.
 */
@Controller(CONSENT_ROUTES.BASE)
@UseGuards(AuthGuard)
export class ConsentController {
  private readonly logger: AppLogger

  constructor(
    private readonly consents: ConsentService,
    private readonly sessions: DataSessionService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ConsentController.name })
  }

  @Post(CONSENT_ROUTES.CREATE)
  async create(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateConsentSchema)) dto: CreateConsentDto,
  ) {
    this.logger.info(`[${this.create.name}] Creating AA consent`, {
      userId: user.id,
      fiTypes: dto.fiTypes,
      purposeCode: dto.purposeCode,
    })
    const data = await this.consents.create(user.id, dto)
    return ResponseBuilder.success(data, 'Consent created')
  }

  @Get(CONSENT_ROUTES.LIST)
  async list(@User() user: AuthenticatedUser) {
    const data = await this.consents.list(user.id)
    return ResponseBuilder.success(data, 'Consent dashboard')
  }

  @Get(CONSENT_ROUTES.STATUS)
  async status(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const data = await this.consents.getStatus(user.id, id)
    return ResponseBuilder.success(data, 'Consent status')
  }

  @Delete(CONSENT_ROUTES.REVOKE)
  async revoke(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    this.logger.info(`[${this.revoke.name}] Revoking consent`, {
      userId: user.id,
      consentId: id,
    })
    const data = await this.consents.revoke(user.id, id)
    return ResponseBuilder.success(data, 'Consent revoked and data purged')
  }

  @Post(CONSENT_ROUTES.REFETCH)
  async refetch(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    // Ownership is enforced by getStatus (throws/returns NOT_FOUND for others).
    const owned = await this.consents.getStatus(user.id, id)
    if (owned.status === 'NOT_FOUND') {
      return ResponseBuilder.success(owned, 'Consent not found')
    }
    const session = await this.sessions.createSession(id)
    await this.sessions.fetchAndStore(session.id)
    const data = await this.consents.getStatus(user.id, id)
    return ResponseBuilder.success(data, 'Re-fetch triggered')
  }
}
