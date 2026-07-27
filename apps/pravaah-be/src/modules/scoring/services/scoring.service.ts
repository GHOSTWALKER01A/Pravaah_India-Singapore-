import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ConsentStatus,
  KycStatus,
  Prisma,
  ScoreBand,
  ScoreStatus,
  type Consent,
  type ModelVersion,
  type Score,
} from 'generated/prisma/client'

import { canFetch } from '@/modules/consent/consent.state'
import { FEATURE_LABELS } from '@/modules/scoring/model-catalog'
import { InferenceProviderRegistry } from '@/modules/scoring/providers/inference-registry'
import {
  confidenceBand,
  isFresh,
  parseBands,
} from '@/modules/scoring/scoring.state'
import {
  FeatureAssemblerService,
  type AssembledFeatures,
} from '@/modules/scoring/services/feature-assembler.service'
import { ExplanationService } from '@/modules/scoring/services/explanation.service'

import type { ScoreFeature } from '@pravaah/schema'

/** Public shape returned by `GET /score` when there is nothing to show yet. */
export type ScoreState =
  | { state: 'NO_CONSENT'; message: string }
  | { state: 'INSUFFICIENT_DATA'; message: string; monthsCovered: number; coverage: number }
  | { state: 'PENDING'; scoreId: string; message: string }
  | { state: 'EXPIRED'; scoreId: string; expiredAt: Date | null; message: string }
  | { state: 'FAILED'; scoreId: string; message: string }

/**
 * M2 orchestrator: guards → assemble → cache → infer → explain → persist.
 *
 * Owns everything the model does NOT: consent/KYC gating, the idempotent cache,
 * version stamping, the audit trail, and the honest-refusal states. The model is
 * one call in the middle of this, behind {@link InferenceProviderRegistry}.
 */
@Injectable()
export class ScoringService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly assembler: FeatureAssemblerService,
    private readonly registry: InferenceProviderRegistry,
    private readonly explain: ExplanationService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ScoringService.name })
  }

  // ── read ──────────────────────────────────────────────────────────────────
  /**
   * The user's current score, or the honest state that explains its absence.
   * Never computes: a GET must not silently spend an inference call.
   */
  async getCurrent(userId: string): Promise<ScoreState | Record<string, unknown>> {
    const latest = await this.prisma.score.findFirst({
      where: { userId },
      orderBy: [{ computedAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        factors: { orderBy: { rank: 'asc' } },
        improvements: { orderBy: { rank: 'asc' } },
        modelVersion: {
          select: { name: true, version: true, runtime: true, bands: true },
        },
        overrides: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { newBand: true, reason: true, createdAt: true },
        },
      },
    })

    if (!latest) {
      const consent = await this.activeConsent(userId)
      return consent
        ? {
            state: 'INSUFFICIENT_DATA' as const,
            message:
              'Your data is shared but there is not enough history yet to score it.',
            monthsCovered: 0,
            coverage: 0,
          }
        : {
            state: 'NO_CONSENT' as const,
            message:
              'Share your bank or GST data through the Account Aggregator to build your score.',
          }
    }

    switch (latest.status) {
      case ScoreStatus.PENDING:
        return {
          state: 'PENDING' as const,
          scoreId: latest.id,
          message: 'Working out your score…',
        }
      case ScoreStatus.INSUFFICIENT_DATA:
        return {
          state: 'INSUFFICIENT_DATA' as const,
          message:
            'We need a little more history — link a bank account or widen the date range.',
          monthsCovered: 0,
          coverage: latest.coverageScore ?? 0,
        }
      case ScoreStatus.FAILED:
        return {
          state: 'FAILED' as const,
          scoreId: latest.id,
          message:
            'Scoring is temporarily unavailable. We will retry automatically.',
        }
      case ScoreStatus.EXPIRED:
        return {
          state: 'EXPIRED' as const,
          scoreId: latest.id,
          expiredAt: latest.expiresAt,
          message:
            'Your consent’s data life has ended, so this score has expired. Re-share your data to refresh it.',
        }
      default:
        break
    }

    // COMPUTED / OVERRIDDEN — but the lifecycle cron may not have run yet, so
    // freshness is re-checked at read time rather than trusted from the column.
    if (!isFresh(latest.status, latest.expiresAt)) {
      return {
        state: 'EXPIRED' as const,
        scoreId: latest.id,
        expiredAt: latest.expiresAt,
        message:
          'Your consent’s data life has ended, so this score has expired. Re-share your data to refresh it.',
      }
    }
    return this.toPublicScore(latest)
  }

  /** Score history — how the number moved, and under which model version. */
  async history(userId: string, limit = 12) {
    const rows = await this.prisma.score.findMany({
      where: { userId, status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN, ScoreStatus.EXPIRED] } },
      orderBy: { computedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        value: true,
        band: true,
        confidence: true,
        status: true,
        computedAt: true,
        modelVersion: { select: { version: true } },
      },
    })
    return rows.map((r) => ({
      id: r.id,
      value: r.value,
      band: r.band,
      confidence: r.confidence,
      status: r.status,
      computedAt: r.computedAt,
      modelVersion: r.modelVersion.version,
    }))
  }

  // ── compute ───────────────────────────────────────────────────────────────
  /**
   * (Re)compute this user's score.
   *
   * Order of business matters: every guard that can refuse cheaply runs before
   * the model is touched, and the thin-file gate refuses BEFORE inference rather
   * than dressing up an imputed vector as a result.
   */
  async compute(
    userId: string,
    opts: { force?: boolean } = {},
  ): Promise<ScoreState | Record<string, unknown>> {
    // GUARD 1 — identity. A score is an assertion about a verified person; an
    // unverified or suspended account cannot make one.
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('User not found')
    if (user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException('Complete identity verification first')
    }
    if (user.isSuspended) throw new ForbiddenException('Account suspended')

    // GUARD 2 — consent. No live consent means no lawful basis to score.
    const consent = await this.activeConsent(userId)
    if (!consent) {
      return {
        state: 'NO_CONSENT' as const,
        message:
          'Share your bank or GST data through the Account Aggregator to build your score.',
      }
    }

    // GUARD 3 — an active, fairness-passed model must exist.
    const model = await this.prisma.modelVersion.findFirst({
      where: { isActive: true },
    })
    if (!model) {
      throw new ServiceUnavailableException(
        'No active scoring model — an administrator must activate one',
      )
    }

    const order = this.orderOf(model)
    const asm = await this.assembler.assemble(userId, consent.id, order)

    // GUARD 4 — the thin-file gate. An honest refusal, not a fabricated number.
    if (!asm.hasEnoughData) {
      const row = await this.recordInsufficient(userId, consent, model, asm)
      return {
        state: 'INSUFFICIENT_DATA' as const,
        scoreId: row.id,
        message:
          'We need at least two months of transaction history, or a GST filing record, before we can score you.',
        monthsCovered: asm.monthsCovered,
        coverage: asm.coverage,
      }
    }

    // Cache: identical inputs + identical model + still fresh ⇒ the same score,
    // by definition. Recomputing would burn an inference call to produce a
    // byte-identical row.
    const cached = await this.prisma.score.findUnique({
      where: {
        userId_modelVersionId_inputsHash: {
          userId,
          modelVersionId: model.id,
          inputsHash: asm.inputsHash,
        },
      },
      include: {
        factors: { orderBy: { rank: 'asc' } },
        improvements: { orderBy: { rank: 'asc' } },
        modelVersion: {
          select: { name: true, version: true, runtime: true, bands: true },
        },
        overrides: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { newBand: true, reason: true, createdAt: true },
        },
      },
    })
    if (
      !opts.force &&
      cached &&
      isFresh(cached.status, cached.expiresAt) &&
      cached.factors.length > 0
    ) {
      this.logger.info('[compute] Serving cached score', {
        userId,
        scoreId: cached.id,
      })
      return this.toPublicScore(cached)
    }

    // Claim the row up front. The unique key on (user, model, inputsHash) makes
    // two concurrent computes collapse onto one row instead of racing to insert.
    const pending = await this.prisma.score.upsert({
      where: {
        userId_modelVersionId_inputsHash: {
          userId,
          modelVersionId: model.id,
          inputsHash: asm.inputsHash,
        },
      },
      create: {
        userId,
        consentId: consent.id,
        modelVersionId: model.id,
        inputsHash: asm.inputsHash,
        coverageScore: asm.coverage,
        missingCount: asm.missingCount,
        status: ScoreStatus.PENDING,
      },
      update: {
        status: ScoreStatus.PENDING,
        consentId: consent.id,
        coverageScore: asm.coverage,
        missingCount: asm.missingCount,
        failureReason: null,
      },
    })

    const provider = this.registry.byRuntime(model.runtime)
    const res = await provider.predict({
      features: asm.features,
      coverage: asm.coverage,
      modelVersion: model.version,
    })

    if (!res.ok) {
      await this.prisma.score.update({
        where: { id: pending.id },
        data: {
          status: ScoreStatus.FAILED,
          failureReason: `${res.error.code}: ${res.error.message}`,
        },
      })
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'score.failed',
        entity: 'Score',
        entityId: pending.id,
        metadata: {
          modelVersion: model.version,
          runtime: model.runtime,
          code: res.error.code,
          retryable: res.error.retryable,
        },
      })
      this.logger.error('[compute] Inference failed', {
        userId,
        scoreId: pending.id,
        code: res.error.code,
        retryable: res.error.retryable,
      })

      // A retryable failure is not a dead end: serve the last good score if the
      // user has one, and let the scheduler retry in the background.
      if (res.error.retryable) {
        const lastGood = await this.lastServableScore(userId)
        if (lastGood) return this.toPublicScore(lastGood)
      }
      throw new ServiceUnavailableException(
        'Scoring is temporarily unavailable. We will retry automatically.',
      )
    }

    const out = res.value
    const factors = this.explain.toFactors(out.contributions, asm.features)
    const improvements = await this.explain.toImprovements(
      out.contributions,
      asm.features,
      out.score,
      { provider, coverage: asm.coverage, modelVersion: model.version },
    )

    // One transaction so a score is never visible without the explanation that
    // justifies it — a bare number would be the exact DPDP liability M2 exists
    // to avoid.
    await this.prisma.$transaction(async (tx) => {
      await tx.score.update({
        where: { id: pending.id },
        data: {
          value: out.score,
          band: out.band as ScoreBand,
          confidence: out.confidence,
          bandLow: out.bandLow,
          bandHigh: out.bandHigh,
          coverageScore: asm.coverage,
          missingCount: out.missingCount,
          status: ScoreStatus.COMPUTED,
          servedBy: out.servedBy,
          failureReason: null,
          computedAt: new Date(),
          expiresAt: consent.expiresAt,
          dataLifeExpiresAt: consent.expiresAt,
        },
      })
      // Replace rather than merge: a recompute's explanation must describe THIS
      // prediction, with no orphan factors surviving from the previous one.
      await tx.scoreFactor.deleteMany({ where: { scoreId: pending.id } })
      await tx.scoreImprovement.deleteMany({ where: { scoreId: pending.id } })
      if (factors.length) {
        await tx.scoreFactor.createMany({
          data: factors.map((f) => ({ scoreId: pending.id, ...f })),
        })
      }
      if (improvements.length) {
        await tx.scoreImprovement.createMany({
          data: improvements.map((im) => ({ scoreId: pending.id, ...im })),
        })
      }
    })

    await this.audit.log({
      actorType: 'SYSTEM',
      actorId: userId,
      action: 'score.computed',
      entity: 'Score',
      entityId: pending.id,
      metadata: {
        value: out.score,
        band: out.band,
        confidence: out.confidence,
        modelVersion: model.version,
        servedBy: out.servedBy,
        inputsHash: asm.inputsHash,
        consentId: consent.id,
        coverage: asm.coverage,
        missingCount: out.missingCount,
        // Anti-gaming flag travels into the audit trail even though it is not a
        // model input, so a suspicious pattern is reviewable after the fact.
        boundarySpikeRatio: asm.boundarySpikeRatio,
      },
    })
    this.logger.info('[compute] Score computed', {
      userId,
      scoreId: pending.id,
      value: out.score,
      band: out.band,
      confidence: out.confidence,
      servedBy: out.servedBy,
    })

    const full = await this.prisma.score.findUniqueOrThrow({
      where: { id: pending.id },
      include: {
        factors: { orderBy: { rank: 'asc' } },
        improvements: { orderBy: { rank: 'asc' } },
        modelVersion: {
          select: { name: true, version: true, runtime: true, bands: true },
        },
        overrides: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { newBand: true, reason: true, createdAt: true },
        },
      },
    })
    return this.toPublicScore(full)
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async activeConsent(userId: string): Promise<Consent | null> {
    const consent = await this.prisma.consent.findFirst({
      where: { userId, status: ConsentStatus.ACTIVE },
      orderBy: { activatedAt: 'desc' },
    })
    // Re-check against the shared M1 predicate rather than trusting the status
    // column alone — an ACTIVE consent past its data life is not fetchable.
    return consent && canFetch(consent.status, consent.expiresAt)
      ? consent
      : null
  }

  private async lastServableScore(userId: string) {
    return this.prisma.score.findFirst({
      where: {
        userId,
        status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { computedAt: 'desc' },
      include: {
        factors: { orderBy: { rank: 'asc' } },
        improvements: { orderBy: { rank: 'asc' } },
        modelVersion: {
          select: { name: true, version: true, runtime: true, bands: true },
        },
        overrides: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { newBand: true, reason: true, createdAt: true },
        },
      },
    })
  }

  private async recordInsufficient(
    userId: string,
    consent: Consent,
    model: ModelVersion,
    asm: AssembledFeatures,
  ): Promise<Score> {
    const row = await this.prisma.score.upsert({
      where: {
        userId_modelVersionId_inputsHash: {
          userId,
          modelVersionId: model.id,
          inputsHash: asm.inputsHash,
        },
      },
      create: {
        userId,
        consentId: consent.id,
        modelVersionId: model.id,
        inputsHash: asm.inputsHash,
        coverageScore: asm.coverage,
        missingCount: asm.missingCount,
        status: ScoreStatus.INSUFFICIENT_DATA,
      },
      update: {
        status: ScoreStatus.INSUFFICIENT_DATA,
        coverageScore: asm.coverage,
        missingCount: asm.missingCount,
        // A thin file has no defensible value, so any stale one is cleared
        // rather than left on screen next to an INSUFFICIENT_DATA badge.
        value: null,
        band: null,
        confidence: null,
        bandLow: null,
        bandHigh: null,
      },
    })
    this.logger.info('[compute] Thin file — refusing to score', {
      userId,
      monthsCovered: asm.monthsCovered,
      coverage: asm.coverage,
      missingCount: asm.missingCount,
    })
    return row
  }

  /** The feature order this model version was registered with. */
  private orderOf(model: ModelVersion): readonly ScoreFeature[] | undefined {
    const declared = (
      model.featureSchema as { features?: { name?: string }[] } | null
    )?.features
    if (!Array.isArray(declared) || declared.length === 0) return undefined
    const names = declared
      .map((f) => f?.name)
      .filter((n): n is ScoreFeature => !!n && n in FEATURE_LABELS)
    return names.length ? names : undefined
  }

  /**
   * The client-facing projection. Deliberately excludes `inputsHash` and the raw
   * feature values: the app shows the user their score and its reasons, not the
   * cryptographic provenance an auditor needs.
   */
  private toPublicScore(
    score: Score & {
      factors: Array<{
        feature: string
        shapValue: number
        direction: string
        plainText: string
        rank: number
      }>
      improvements: Array<{
        feature: string
        currentValue: number
        targetValue: number
        estimatedGain: number
        plainText: string
        rank: number
      }>
      modelVersion: {
        name: string
        version: string
        runtime: string
        bands: Prisma.JsonValue
      }
      overrides: Array<{ newBand: ScoreBand; reason: string; createdAt: Date }>
    },
  ) {
    const confidence = score.confidence ?? 0
    // Recompute the band from the same pure helper if the columns predate it, so
    // an older row still renders a correct interval instead of a missing one.
    const interval =
      score.bandLow !== null && score.bandHigh !== null
        ? { low: score.bandLow, high: score.bandHigh }
        : score.value !== null
          ? confidenceBand(score.value, confidence)
          : null

    const override = score.overrides[0] ?? null

    return {
      state: 'COMPUTED' as const,
      id: score.id,
      value: score.value,
      band: score.band,
      confidence,
      confidenceLabel: this.confidenceLabel(confidence),
      bandLow: interval?.low ?? null,
      bandHigh: interval?.high ?? null,
      coverage: score.coverageScore,
      missingCount: score.missingCount,
      // Told plainly rather than buried: "based on 87% of the expected data".
      coverageLabel:
        score.coverageScore !== null
          ? `Based on ${Math.round(score.coverageScore * 100)}% of the data we expected`
          : null,
      computedAt: score.computedAt,
      expiresAt: score.expiresAt,
      isOverridden: score.status === ScoreStatus.OVERRIDDEN,
      override: override
        ? {
            band: override.newBand,
            reason: override.reason,
            at: override.createdAt,
          }
        : null,
      model: {
        name: score.modelVersion.name,
        version: score.modelVersion.version,
        runtime: score.modelVersion.runtime,
        bands: parseBands(score.modelVersion.bands),
      },
      factors: score.factors.map((f) => ({
        feature: f.feature,
        label: FEATURE_LABELS[f.feature as ScoreFeature] ?? f.feature,
        direction: f.direction,
        contribution: f.shapValue,
        plainText: f.plainText,
        rank: f.rank,
      })),
      improvements: score.improvements.map((im) => ({
        feature: im.feature,
        label: FEATURE_LABELS[im.feature as ScoreFeature] ?? im.feature,
        currentValue: im.currentValue,
        targetValue: im.targetValue,
        estimatedGain: im.estimatedGain,
        plainText: im.plainText,
        rank: im.rank,
      })),
    }
  }

  private confidenceLabel(confidence: number): string {
    if (confidence >= 0.75) return 'High confidence'
    if (confidence >= 0.5) return 'Moderate confidence'
    if (confidence >= 0.3) return 'Low confidence — thin data'
    return 'Very low confidence — treat as indicative only'
  }
}
