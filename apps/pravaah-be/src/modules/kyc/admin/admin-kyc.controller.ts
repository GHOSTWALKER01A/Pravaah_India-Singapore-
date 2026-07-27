import {
  Body,
  Controller,
  Get,
  Inject,
  type MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { DecisionSchema, type DecisionDto } from '@pravaah/schema'
import { map, type Observable } from 'rxjs'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { AdminRole, type AdminUser } from 'generated/prisma/client'

import { ADMIN_KYC_ROUTES } from '@/modules/kyc/kyc.route'
import { ReviewEventsService } from '@/modules/kyc/admin/review-events.service'
import { ReviewService } from '@/modules/kyc/admin/review.service'

@Controller(ADMIN_KYC_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
export class AdminKycController {
  private readonly logger: AppLogger

  constructor(
    private readonly review: ReviewService,
    private readonly events: ReviewEventsService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminKycController.name })
  }

  @Get(ADMIN_KYC_ROUTES.CASES)
  async list(@Query('status') status = 'OPEN') {
    const data = await this.review.queue(status)
    return ResponseBuilder.success(data, 'Review queue')
  }

  /**
   * Live review-queue stream (Server-Sent Events). The console opens this once
   * and refreshes its queue whenever a case is opened/claimed/resolved on any
   * API instance. EventSource can't set an Authorization header, so the guard
   * also accepts the token via `?access_token=` (see JwtStrategy).
   */
  @Sse(ADMIN_KYC_ROUTES.STREAM)
  stream(): Observable<MessageEvent> {
    return this.events.stream().pipe(map((event) => ({ data: event })))
  }

  @Get(ADMIN_KYC_ROUTES.CASE_DETAIL)
  async detail(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.review.detail(id)
    return ResponseBuilder.success(data, 'Review case detail')
  }

  @Post(ADMIN_KYC_ROUTES.CASE_CLAIM)
  async claim(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(`[${this.claim.name}] Claiming case`, {
      caseId: id,
      adminId: req.admin.id,
    })
    const data = await this.review.claim(id, req.admin.id)
    return ResponseBuilder.success(data, 'Case claimed')
  }

  @Post(ADMIN_KYC_ROUTES.CASE_DECISION)
  async decide(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) dto: DecisionDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(`[${this.decide.name}] Recording decision`, {
      caseId: id,
      adminId: req.admin.id,
      decision: dto.decision,
    })
    const data = await this.review.decide(id, req.admin, dto.decision, dto.notes)
    return ResponseBuilder.success(data, 'Case decision recorded')
  }
}
