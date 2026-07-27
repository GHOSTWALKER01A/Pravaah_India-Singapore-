import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { RegisterModelDto } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { Prisma, ScoreStatus } from 'generated/prisma/client'

import { InferenceProviderRegistry } from '@/modules/scoring/providers/inference-registry'

/**
 * The model registry — register, inspect, activate, roll back.
 *
 * Its one non-negotiable job is the **activation gate** (M2 §11): a version whose
 * fairness audit has not passed cannot be made active, no matter who asks.
 * Fairness here is not a report that gets filed; it is a deploy blocker.
 */
@Injectable()
export class ModelService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: InferenceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ModelService.name })
  }

  /** Register a new version. Always INACTIVE and UNAUDITED on arrival. */
  async register(dto: RegisterModelDto, adminId: string) {
    const clash = await this.prisma.modelVersion.findUnique({
      where: { version: dto.version },
    })
    if (clash) {
      // Versions are immutable because scores are stamped with them: mutating
      // 1.0.0 would silently rewrite the meaning of every score ever issued
      // under it. Publish 1.0.1 instead.
      throw new ConflictException(
        `Version ${dto.version} is already registered. Model versions are immutable — register a new version instead.`,
      )
    }

    const created = await this.prisma.modelVersion.create({
      data: {
        name: dto.name,
        version: dto.version,
        runtime: dto.runtime,
        featureSchema: dto.featureSchema as unknown as Prisma.InputJsonValue,
        bands: dto.bands as unknown as Prisma.InputJsonValue,
        scorecard: (dto.scorecard ?? null) as Prisma.InputJsonValue | undefined,
        trainedAt: new Date(dto.trainedAt),
        datasetRef: dto.datasetRef,
        notes: dto.notes,
        fairnessPassed: false,
        isActive: false,
      },
    })
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'model.registered',
      entity: 'ModelVersion',
      entityId: created.id,
      metadata: {
        version: created.version,
        runtime: created.runtime,
        datasetRef: created.datasetRef,
        features: dto.featureSchema.features.length,
      },
    })
    this.logger.info('[register] Model version registered', {
      version: created.version,
      runtime: created.runtime,
      adminId,
    })
    return this.summarise(created)
  }

  async list() {
    const rows = await this.prisma.modelVersion.findMany({
      orderBy: [{ isActive: 'desc' }, { trainedAt: 'desc' }],
      include: {
        _count: { select: { scores: true, fairnessReports: true } },
      },
    })
    return rows.map((r) => ({
      ...this.summarise(r),
      scoreCount: r._count.scores,
      fairnessReportCount: r._count.fairnessReports,
      // Surfaced so the console can warn BEFORE an admin activates a version
      // whose runtime has no configuration. This is a CONFIG check, not a health
      // probe — see InferenceProvider.isConfigured.
      runtimeConfigured: this.registry
        .all()
        .some((p) => p.name === r.runtime && p.isConfigured()),
    }))
  }

  async detail(id: string) {
    const model = await this.prisma.modelVersion.findUnique({
      where: { id },
      include: {
        fairnessReports: { orderBy: [{ metric: 'asc' }, { group: 'asc' }] },
        _count: { select: { scores: true } },
      },
    })
    if (!model) throw new NotFoundException('Model version not found')

    const failing = model.fairnessReports.filter((r) => !r.passed)
    return {
      ...this.summarise(model),
      featureSchema: model.featureSchema,
      // The full parameter set is intentionally returned: for the scorecard
      // runtime these ARE the model, and a model-risk reviewer must be able to
      // read the weights that priced someone's creditworthiness.
      scorecard: model.scorecard,
      scoreCount: model._count.scores,
      runtimeConfigured: this.registry
        .all()
        .some((p) => p.name === model.runtime && p.isConfigured()),
      fairness: {
        passed: model.fairnessPassed,
        auditedAt: model.fairnessAt,
        reportCount: model.fairnessReports.length,
        failingCount: failing.length,
        reports: model.fairnessReports,
      },
      activationBlockedReason: this.blockReason(model),
    }
  }

  /**
   * Activate a version. Exactly one version is active at a time, and the swap is
   * transactional so there is never a window with zero or two active models.
   */
  async activate(id: string, adminId: string) {
    const model = await this.prisma.modelVersion.findUnique({ where: { id } })
    if (!model) throw new NotFoundException('Model version not found')
    if (model.isActive) {
      return { ok: true, alreadyActive: true, version: model.version }
    }

    const blocked = this.blockReason(model)
    if (blocked) {
      // Refused activations are audited too — an attempt to ship an unaudited
      // model is exactly the event a model-risk review wants to see.
      await this.audit.log({
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'model.activation_blocked',
        entity: 'ModelVersion',
        entityId: model.id,
        metadata: { version: model.version, reason: blocked },
      })
      this.logger.warn('[activate] Activation BLOCKED', {
        version: model.version,
        reason: blocked,
        adminId,
      })
      throw new BadRequestException(blocked)
    }

    const previous = await this.prisma.modelVersion.findFirst({
      where: { isActive: true },
      select: { id: true, version: true },
    })

    await this.prisma.$transaction([
      this.prisma.modelVersion.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      }),
      this.prisma.modelVersion.update({
        where: { id },
        data: { isActive: true, activatedAt: new Date() },
      }),
    ])

    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'model.activated',
      entity: 'ModelVersion',
      entityId: model.id,
      metadata: {
        version: model.version,
        replaced: previous?.version ?? null,
        runtime: model.runtime,
      },
    })
    this.logger.info('[activate] Model version activated', {
      version: model.version,
      replaced: previous?.version ?? null,
      adminId,
    })

    // Existing scores are NOT deleted or silently re-badged: they remain valid
    // under the version that produced them, and are recomputed on the next
    // compute request. That is what makes the model-version stamp meaningful.
    const staleCount = await this.prisma.score.count({
      where: {
        status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN] },
        modelVersionId: { not: id },
      },
    })

    return {
      ok: true,
      version: model.version,
      replaced: previous?.version ?? null,
      scoresPendingRecompute: staleCount,
    }
  }

  /** Roll back to the previously-active version (or an explicit target). */
  async rollback(id: string, adminId: string) {
    const target = await this.prisma.modelVersion.findUnique({ where: { id } })
    if (!target) throw new NotFoundException('Model version not found')
    // Rollback is still an activation — the gate applies. "It used to be live"
    // is not evidence that it is fair.
    const result = await this.activate(id, adminId)
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'model.rolled_back',
      entity: 'ModelVersion',
      entityId: target.id,
      metadata: { version: target.version },
    })
    return result
  }

  /**
   * Why this version cannot go live, or `null` if it can. Single source of truth
   * so the console can grey out the button with the same reason the API enforces.
   */
  private blockReason(model: {
    fairnessPassed: boolean
    runtime: string
    scorecard: Prisma.JsonValue | null
  }): string | null {
    if (!model.fairnessPassed) {
      return 'Fairness audit not passed — activation blocked. Run the fairness audit first.'
    }
    if (model.runtime === 'scorecard' && !model.scorecard) {
      return 'This version declares the scorecard runtime but has no parameters — it cannot serve a score.'
    }
    const provider = this.registry
      .all()
      .find((p) => p.name === model.runtime)
    if (!provider) {
      return `Unknown runtime "${model.runtime}" — no provider can serve it.`
    }
    if (!provider.isConfigured() && this.registry.mode() !== 'auto') {
      // "Not configured", not "not reachable" — `isConfigured` checks that
      // ML_BASE_URL is set, and deliberately does not probe the service. A
      // configured-but-down service is caught by the circuit breaker at compute
      // time, which then serves the last cached score and retries.
      return `The "${model.runtime}" runtime is not configured (set ML_BASE_URL), so activating this version would fail every score.`
    }
    return null
  }

  private summarise(model: {
    id: string
    name: string
    version: string
    runtime: string
    trainedAt: Date
    datasetRef: string | null
    notes: string | null
    fairnessPassed: boolean
    fairnessAt: Date | null
    isActive: boolean
    activatedAt: Date | null
    createdAt: Date
    bands: Prisma.JsonValue
  }) {
    return {
      id: model.id,
      name: model.name,
      version: model.version,
      runtime: model.runtime,
      trainedAt: model.trainedAt,
      datasetRef: model.datasetRef,
      notes: model.notes,
      fairnessPassed: model.fairnessPassed,
      fairnessAt: model.fairnessAt,
      isActive: model.isActive,
      activatedAt: model.activatedAt,
      createdAt: model.createdAt,
      bands: model.bands,
    }
  }
}
