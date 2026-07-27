import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AuditFairnessSchema,
  OverrideScoreSchema,
  RegisterModelSchema,
  ScoreListQuerySchema,
  type AuditFairnessDto,
  type OverrideScoreDto,
  type RegisterModelDto,
  type ScoreListQueryDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { AdminRole, type AdminUser } from 'generated/prisma/client'

import { ADMIN_SCORE_ROUTES } from '@/modules/scoring/scoring.route'
import { FairnessService } from '@/modules/scoring/services/fairness.service'
import { ModelService } from '@/modules/scoring/services/model.service'
import { ScoreAdminService } from '@/modules/scoring/services/score-admin.service'
import { ScoreLifecycleService } from '@/modules/scoring/services/score-lifecycle.service'

/**
 * M2 admin console API — the model-risk surface.
 *
 * Role split is deliberate:
 *  - ADMIN alone may register, audit, activate, or roll back a model version.
 *    Those decisions change every score the platform issues.
 *  - SENIOR_REVIEWER may read everything and override a single band — a
 *    case-level judgement, permanently attributed, never a fleet-level change.
 *  - Plain REVIEWER has no business here at all, so the class-level guard
 *    excludes them.
 *
 * The acting admin is always taken from `req.admin` (populated by
 * {@link AdminAuthGuard}), never from a request body — a self-declared actor id
 * would make the whole attribution trail worthless.
 */
@Controller(ADMIN_SCORE_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
export class AdminScoreController {
  private readonly logger: AppLogger

  constructor(
    private readonly models: ModelService,
    private readonly fairness: FairnessService,
    private readonly scores: ScoreAdminService,
    private readonly lifecycle: ScoreLifecycleService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminScoreController.name })
  }

  // ── model registry ────────────────────────────────────────────────────────
  @Get(ADMIN_SCORE_ROUTES.MODELS)
  async listModels() {
    const data = await this.models.list()
    return ResponseBuilder.success(data, 'Model registry')
  }

  @Post(ADMIN_SCORE_ROUTES.MODELS)
  @AdminRoles(AdminRole.ADMIN)
  async registerModel(
    @Body(new ZodValidationPipe(RegisterModelSchema)) dto: RegisterModelDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(`[${this.registerModel.name}] Registering model version`, {
      version: dto.version,
      runtime: dto.runtime,
      adminId: req.admin.id,
    })
    const data = await this.models.register(dto, req.admin.id)
    return ResponseBuilder.success(
      data,
      'Model version registered — run a fairness audit before activating it',
    )
  }

  @Get(ADMIN_SCORE_ROUTES.MODEL_DETAIL)
  async modelDetail(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.models.detail(id)
    return ResponseBuilder.success(data, 'Model version detail')
  }

  // ── fairness ──────────────────────────────────────────────────────────────
  /** Run the bias audit. Writes the per-group report AND sets the gate flag. */
  @Post(ADMIN_SCORE_ROUTES.MODEL_AUDIT_FAIRNESS)
  @AdminRoles(AdminRole.ADMIN)
  async auditFairness(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(AuditFairnessSchema)) dto: AuditFairnessDto,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(`[${this.auditFairness.name}] Running fairness audit`, {
      modelVersionId: id,
      adminId: req.admin.id,
    })
    const data = await this.fairness.runAudit(id, dto, req.admin.id)
    return ResponseBuilder.success(
      data,
      data.passed
        ? 'Fairness audit PASSED — this version may now be activated'
        : 'Fairness audit FAILED — activation remains blocked',
    )
  }

  @Get(ADMIN_SCORE_ROUTES.MODEL_FAIRNESS)
  async fairnessReports(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.fairness.reports(id)
    return ResponseBuilder.success(data, 'Fairness report')
  }

  // ── activation ────────────────────────────────────────────────────────────
  /** Blocked unless the fairness audit passed. This is the gate. */
  @Post(ADMIN_SCORE_ROUTES.MODEL_ACTIVATE)
  @AdminRoles(AdminRole.ADMIN)
  async activateModel(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.info(`[${this.activateModel.name}] Activating model version`, {
      modelVersionId: id,
      adminId: req.admin.id,
    })
    const data = await this.models.activate(id, req.admin.id)
    return ResponseBuilder.success(data, 'Model version activated')
  }

  @Post(ADMIN_SCORE_ROUTES.MODEL_ROLLBACK)
  @AdminRoles(AdminRole.ADMIN)
  async rollbackModel(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Req() req: { admin: AdminUser },
  ) {
    this.logger.warn(`[${this.rollbackModel.name}] Rolling back model version`, {
      modelVersionId: id,
      adminId: req.admin.id,
    })
    const data = await this.models.rollback(id, req.admin.id)
    return ResponseBuilder.success(data, 'Rolled back to this model version')
  }

  // ── score oversight ───────────────────────────────────────────────────────
  @Get(ADMIN_SCORE_ROUTES.SCORES)
  async listScores(
    @Query(new ZodValidationPipe(ScoreListQuerySchema)) query: ScoreListQueryDto,
  ) {
    const data = await this.scores.list(query)
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      data.offset,
      data.limit,
      'Issued scores',
    )
  }

  @Get(ADMIN_SCORE_ROUTES.SCORE_DETAIL)
  async scoreDetail(
    @Param('scoreId', new UUIDValidationPipe()) scoreId: string,
  ) {
    const data = await this.scores.detail(scoreId)
    return ResponseBuilder.success(data, 'Score audit detail')
  }

  @Get(ADMIN_SCORE_ROUTES.SCORE_AUDIT)
  async scoreAudit(
    @Param('scoreId', new UUIDValidationPipe()) scoreId: string,
  ) {
    const data = await this.scores.auditTrail(scoreId)
    return ResponseBuilder.success(data, 'Score audit trail')
  }

  /** Manual band override — senior judgement, mandatory reason, permanent record. */
  @Post(ADMIN_SCORE_ROUTES.SCORE_OVERRIDE)
  @AdminRoles(AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async overrideScore(
    @Param('scoreId', new UUIDValidationPipe()) scoreId: string,
    @Body(new ZodValidationPipe(OverrideScoreSchema)) dto: OverrideScoreDto,
    @Req() req: { admin: AdminUser; ip?: string },
  ) {
    this.logger.warn(`[${this.overrideScore.name}] Overriding score band`, {
      scoreId,
      newBand: dto.newBand,
      adminId: req.admin.id,
    })
    const data = await this.scores.override(scoreId, dto, req.admin, req.ip)
    return ResponseBuilder.success(data, 'Score band overridden')
  }

  // ── drift ─────────────────────────────────────────────────────────────────
  /** The same numbers the hourly drift cron alerts on. */
  @Get(ADMIN_SCORE_ROUTES.DRIFT)
  async drift() {
    const data = await this.lifecycle.drift()
    return ResponseBuilder.success(data, 'Score distribution drift')
  }
}
