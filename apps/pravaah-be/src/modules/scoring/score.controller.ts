import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  FairnessConsentSchema,
  type FairnessConsentDto,
} from '@pravaah/schema'

import { User, type AuthenticatedUser } from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { SCORE_ROUTES } from '@/modules/scoring/scoring.route'
import { FairnessService } from '@/modules/scoring/services/fairness.service'
import { ScoringService } from '@/modules/scoring/services/scoring.service'

/**
 * M2 user-facing scoring API. Every route is JWT-guarded and scoped to the
 * authenticated `user.id` — a score is never addressable by id from the client,
 * so there is no object to enumerate.
 *
 * `GET /score` never computes: a read must not silently spend an inference call,
 * and the app polls this endpoint while a compute is PENDING.
 */
@Controller(SCORE_ROUTES.BASE)
@UseGuards(AuthGuard)
export class ScoreController {
  private readonly logger: AppLogger

  constructor(
    private readonly scoring: ScoringService,
    private readonly fairness: FairnessService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ScoreController.name })
  }

  /** Current score + factors + improvements, or the state explaining its absence. */
  @Get(SCORE_ROUTES.CURRENT)
  async current(@User() user: AuthenticatedUser) {
    const data = await this.scoring.getCurrent(user.id)
    return ResponseBuilder.success(data, 'Reputation score')
  }

  /** (Re)compute — e.g. after linking more accounts through M1. */
  @Post(SCORE_ROUTES.COMPUTE)
  async compute(@User() user: AuthenticatedUser) {
    this.logger.info(`[${this.compute.name}] Computing reputation score`, {
      userId: user.id,
    })
    const data = await this.scoring.compute(user.id)
    return ResponseBuilder.success(data, 'Reputation score computed')
  }

  /** How the score has moved, and under which model version. */
  @Get(SCORE_ROUTES.HISTORY)
  async history(
    @User() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit)
    const take = Number.isInteger(parsed) && parsed > 0 && parsed <= 50 ? parsed : 12
    const data = await this.scoring.history(user.id, take)
    return ResponseBuilder.success(data, 'Score history')
  }

  /**
   * The separate, explicit consent for audit-only protected attributes. Kept off
   * the M1 consent flow on purpose: bundling "share my bank data" with "record my
   * gender" would make neither a real choice.
   */
  @Get(SCORE_ROUTES.FAIRNESS_CONSENT)
  async fairnessConsentStatus(@User() user: AuthenticatedUser) {
    const data = await this.fairness.fairnessConsentStatus(user.id)
    return ResponseBuilder.success(data, 'Fairness consent status')
  }

  @Post(SCORE_ROUTES.FAIRNESS_CONSENT)
  async setFairnessConsent(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(FairnessConsentSchema)) dto: FairnessConsentDto,
  ) {
    this.logger.info(
      `[${this.setFairnessConsent.name}] Updating fairness consent`,
      { userId: user.id, consentGiven: dto.consentGiven },
    )
    const data = await this.fairness.setFairnessConsent(user.id, dto)
    return ResponseBuilder.success(
      data,
      dto.consentGiven
        ? 'Fairness consent recorded'
        : 'Fairness consent withdrawn and attributes deleted',
    )
  }
}
