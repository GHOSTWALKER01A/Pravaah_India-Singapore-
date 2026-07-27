import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { OverrideScoreDto, ScoreListQueryDto } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { ScoreStatus, type AdminUser } from 'generated/prisma/client'

import { FEATURE_LABELS } from '@/modules/scoring/model-catalog'
import { canTransition } from '@/modules/scoring/scoring.state'

import type { ScoreFeature } from '@pravaah/schema'

/**
 * Admin-side score oversight: the audit view and the manual override.
 *
 * The audit view is the model-risk exhibit — for any score it answers "which
 * inputs, which model version, which runtime, which reasons, and who touched
 * it". Note what it does NOT expose: the feature VALUES. It shows the
 * `inputsHash`, which proves the score is reproducible without handing an admin
 * a window into a user's bank statement.
 */
@Injectable()
export class ScoreAdminService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ScoreAdminService.name })
  }

  async list(query: ScoreListQueryDto) {
    const where = {
      ...(query.status && query.status in ScoreStatus
        ? { status: query.status as ScoreStatus }
        : {}),
      ...(query.modelVersionId ? { modelVersionId: query.modelVersionId } : {}),
    }

    const [rows, total] = await Promise.all([
      this.prisma.score.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          userId: true,
          value: true,
          band: true,
          confidence: true,
          coverageScore: true,
          status: true,
          servedBy: true,
          computedAt: true,
          expiresAt: true,
          createdAt: true,
          modelVersion: { select: { version: true, runtime: true } },
          _count: { select: { overrides: true } },
          // The console labels users by their Pravaah ID, never by the row id.
          user: { select: { pravaahId: true } },
        },
      }),
      this.prisma.score.count({ where }),
    ])

    return {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userRef: r.user.pravaahId,
        value: r.value,
        band: r.band,
        confidence: r.confidence,
        coverage: r.coverageScore,
        status: r.status,
        servedBy: r.servedBy,
        modelVersion: r.modelVersion.version,
        runtime: r.modelVersion.runtime,
        overrideCount: r._count.overrides,
        computedAt: r.computedAt,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      })),
      total,
      offset: query.offset,
      limit: query.limit,
    }
  }

  /** Everything a model-risk reviewer needs about one score. */
  async detail(scoreId: string) {
    const score = await this.prisma.score.findUnique({
      where: { id: scoreId },
      include: {
        factors: { orderBy: { rank: 'asc' } },
        improvements: { orderBy: { rank: 'asc' } },
        modelVersion: {
          select: {
            id: true,
            name: true,
            version: true,
            runtime: true,
            bands: true,
            datasetRef: true,
            trainedAt: true,
            fairnessPassed: true,
            fairnessAt: true,
          },
        },
        overrides: {
          orderBy: { createdAt: 'desc' },
          include: { admin: { select: { id: true, email: true, role: true } } },
        },
        user: {
          select: {
            id: true,
            pravaahId: true,
            primaryCountry: true,
            kycStatus: true,
          },
        },
      },
    })
    if (!score) throw new NotFoundException('Score not found')

    // The consent that authorised this score — provenance, not decoration.
    const consent = await this.prisma.consent.findUnique({
      where: { id: score.consentId },
      select: {
        id: true,
        purpose: true,
        purposeCode: true,
        fiTypes: true,
        status: true,
        aaProvider: true,
        artefactVerified: true,
        dataRangeFrom: true,
        dataRangeTo: true,
        activatedAt: true,
        expiresAt: true,
      },
    })

    return {
      id: score.id,
      userId: score.userId,
      userRef: score.user.pravaahId,
      user: score.user,
      value: score.value,
      band: score.band,
      confidence: score.confidence,
      bandLow: score.bandLow,
      bandHigh: score.bandHigh,
      coverage: score.coverageScore,
      missingCount: score.missingCount,
      status: score.status,
      failureReason: score.failureReason,
      servedBy: score.servedBy,
      computedAt: score.computedAt,
      expiresAt: score.expiresAt,
      createdAt: score.createdAt,
      // The reproducibility receipt. Same hash + same version ⇒ same score.
      inputsHash: score.inputsHash,
      provenance: {
        consent,
        model: score.modelVersion,
      },
      factors: score.factors.map((f) => ({
        ...f,
        label: FEATURE_LABELS[f.feature as ScoreFeature] ?? f.feature,
      })),
      improvements: score.improvements.map((im) => ({
        ...im,
        label: FEATURE_LABELS[im.feature as ScoreFeature] ?? im.feature,
      })),
      overrides: score.overrides,
    }
  }

  /** The append-only trail for one score. */
  async auditTrail(scoreId: string) {
    const exists = await this.prisma.score.findUnique({
      where: { id: scoreId },
      select: { id: true },
    })
    if (!exists) throw new NotFoundException('Score not found')
    return this.prisma.auditLog.findMany({
      where: { entity: 'Score', entityId: scoreId },
      orderBy: { createdAt: 'asc' },
    })
  }

  /**
   * Override a score's band.
   *
   * Guard-railed on purpose: senior role only (enforced at the controller), a
   * mandatory substantive reason (enforced by the DTO), the previous band
   * recorded so the delta is legible, and a permanent attribution to the acting
   * admin. The `value` is deliberately left untouched — an override is a
   * documented human judgement about the BAND, not a rewrite of what the model
   * computed. Keeping both means the audit can always show the gap.
   */
  async override(
    scoreId: string,
    dto: OverrideScoreDto,
    admin: AdminUser,
    ipAddress?: string,
  ) {
    const score = await this.prisma.score.findUnique({
      where: { id: scoreId },
      select: { id: true, band: true, status: true, value: true, userId: true },
    })
    if (!score) throw new NotFoundException('Score not found')
    if (!score.band || score.value === null) {
      throw new BadRequestException(
        'This score has no computed band to override.',
      )
    }
    if (score.band === dto.newBand) {
      throw new BadRequestException(
        `This score is already banded ${dto.newBand}.`,
      )
    }
    // An OVERRIDDEN score can be overridden again (judgement can be revised),
    // but an EXPIRED or FAILED one cannot — there is no live assertion to amend.
    if (
      score.status !== ScoreStatus.OVERRIDDEN &&
      !canTransition(score.status, ScoreStatus.OVERRIDDEN)
    ) {
      throw new BadRequestException(
        `A ${score.status} score cannot be overridden.`,
      )
    }

    const previousBand = score.band
    const [override] = await this.prisma.$transaction([
      this.prisma.scoreOverride.create({
        data: {
          scoreId,
          adminId: admin.id,
          previousBand,
          newBand: dto.newBand,
          reason: dto.reason,
        },
      }),
      this.prisma.score.update({
        where: { id: scoreId },
        data: {
          band: dto.newBand,
          status: ScoreStatus.OVERRIDDEN,
        },
      }),
    ])

    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'score.overridden',
      entity: 'Score',
      entityId: scoreId,
      ipAddress,
      metadata: {
        previousBand,
        newBand: dto.newBand,
        modelValue: score.value,
        reason: dto.reason,
        adminRole: admin.role,
      },
    })
    this.logger.warn('[override] Score band overridden by an admin', {
      scoreId,
      previousBand,
      newBand: dto.newBand,
      adminId: admin.id,
    })

    return {
      ok: true,
      scoreId,
      previousBand,
      newBand: dto.newBand,
      overrideId: override.id,
    }
  }
}
