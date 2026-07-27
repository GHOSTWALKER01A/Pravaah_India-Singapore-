import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { ConsentStatus, ScoreStatus } from 'generated/prisma/client'

import { ScoringService } from '@/modules/scoring/services/scoring.service'

/** Retry window: only recently-FAILED scores are worth re-driving. */
const RETRY_LOOKBACK_MS = 6 * 60 * 60_000
const RETRY_BATCH = 20

/**
 * Drift alert thresholds. Deliberately generous — a drift monitor that cries wolf
 * every hour gets muted, and a muted monitor is worse than none.
 */
const DRIFT_MEAN_POINTS = 40
const DRIFT_APPROVAL_RATE = 0.15
const DRIFT_MIN_SAMPLE = 20

/**
 * The safety nets that keep scores honest between requests:
 *  - expire scores whose consent data-life has lapsed or been revoked,
 *  - retry transient inference failures,
 *  - watch for population drift in the score distribution.
 *
 * Modelled on M1's `ConsentSchedulerService`: every one of these is a defensive
 * backstop, not the primary path. Revocation already purges data synchronously in
 * M1 — this is what catches the case where that path was missed.
 */
@Injectable()
export class ScoreLifecycleService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: ScoringService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ScoreLifecycleService.name })
  }

  /**
   * Expire scores whose data life lapsed, or whose consent is no longer active.
   *
   * A score outliving the consent that justified it is the single worst failure
   * mode in M2: it is a live credit assertion with no lawful basis behind it.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async expireStale(): Promise<void> {
    const now = new Date()
    const servable = [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN]

    const byDataLife = await this.prisma.score.updateMany({
      where: { status: { in: servable }, expiresAt: { lt: now } },
      data: { status: ScoreStatus.EXPIRED },
    })

    // Consent-revoked/expired scores → EXPIRED. Defensive: M1's revoke already
    // purges the underlying features, which would make a recompute return
    // INSUFFICIENT_DATA anyway — but the stale score must not stay visible in
    // the meantime.
    const dead = await this.prisma.consent.findMany({
      where: {
        status: {
          in: [
            ConsentStatus.REVOKED,
            ConsentStatus.EXPIRED,
            ConsentStatus.REJECTED,
            ConsentStatus.FAILED,
          ],
        },
      },
      select: { id: true },
    })
    const byConsent = dead.length
      ? await this.prisma.score.updateMany({
          where: {
            consentId: { in: dead.map((c) => c.id) },
            status: { in: servable },
          },
          data: { status: ScoreStatus.EXPIRED },
        })
      : { count: 0 }

    const total = byDataLife.count + byConsent.count
    if (total > 0) {
      this.logger.info('[expireStale] Scores expired', {
        byDataLife: byDataLife.count,
        byConsentState: byConsent.count,
      })
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'score.expired_batch',
        entity: 'Score',
        metadata: {
          byDataLife: byDataLife.count,
          byConsentState: byConsent.count,
        },
      })
    }
  }

  /**
   * Retry recently-FAILED scores. Only failures with a still-active consent are
   * re-driven; the rest would just fail again for a reason a retry cannot fix.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryFailed(): Promise<void> {
    const failed = await this.prisma.score.findMany({
      where: {
        status: ScoreStatus.FAILED,
        updatedAt: { gt: new Date(Date.now() - RETRY_LOOKBACK_MS) },
      },
      orderBy: { updatedAt: 'asc' },
      take: RETRY_BATCH,
      select: { id: true, userId: true },
    })
    if (!failed.length) return

    let recovered = 0
    for (const row of failed) {
      try {
        // `force` skips the cache: the point of a retry is to actually re-run.
        const result = await this.scoring.compute(row.userId, { force: true })
        if ((result as { state?: string }).state === 'COMPUTED') recovered++
      } catch {
        // Still failing. The circuit breaker will keep this cheap, and the next
        // tick tries again until the lookback window closes.
      }
    }
    this.logger.info('[retryFailed] Retry sweep complete', {
      attempted: failed.length,
      recovered,
    })
  }

  /**
   * Population drift: compare the last 24 hours of scores against the 7 days
   * before them. A shifting distribution under an unchanged model means the
   * incoming population changed — which is when a model quietly stops being the
   * model that was audited (M2 §13).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async driftCheck(): Promise<void> {
    const report = await this.drift()
    if (!report.alert) return

    this.logger.warn('[driftCheck] Score distribution drift detected', report)
    await this.audit.log({
      actorType: 'SYSTEM',
      action: 'score.drift_detected',
      entity: 'ModelVersion',
      entityId: report.modelVersionId ?? undefined,
      metadata: { ...report },
    })
  }

  /**
   * The drift computation, exposed so the admin console can render the same
   * numbers the cron alerts on rather than a second, subtly different metric.
   */
  async drift(): Promise<{
    alert: boolean
    reasons: string[]
    modelVersionId: string | null
    modelVersion: string | null
    recent: DriftWindow
    baseline: DriftWindow
    meanShift: number
    approvalRateShift: number
    thresholds: { meanPoints: number; approvalRate: number; minSample: number }
  }> {
    const active = await this.prisma.modelVersion.findFirst({
      where: { isActive: true },
      select: { id: true, version: true },
    })

    const now = Date.now()
    const recent = await this.window(
      new Date(now - 24 * 60 * 60_000),
      new Date(now),
      active?.id,
    )
    const baseline = await this.window(
      new Date(now - 8 * 24 * 60 * 60_000),
      new Date(now - 24 * 60 * 60_000),
      active?.id,
    )

    const reasons: string[] = []
    const meanShift = Number((recent.mean - baseline.mean).toFixed(1))
    const approvalRateShift = Number(
      (recent.approvalRate - baseline.approvalRate).toFixed(3),
    )

    const comparable =
      recent.count >= DRIFT_MIN_SAMPLE && baseline.count >= DRIFT_MIN_SAMPLE
    if (comparable) {
      if (Math.abs(meanShift) >= DRIFT_MEAN_POINTS) {
        reasons.push(
          `Mean score moved ${meanShift > 0 ? '+' : ''}${meanShift} points versus the previous week.`,
        )
      }
      if (Math.abs(approvalRateShift) >= DRIFT_APPROVAL_RATE) {
        reasons.push(
          `Share of GOOD-or-better scores moved ${(approvalRateShift * 100).toFixed(1)} points.`,
        )
      }
    }

    return {
      alert: reasons.length > 0,
      reasons,
      modelVersionId: active?.id ?? null,
      modelVersion: active?.version ?? null,
      recent,
      baseline,
      meanShift,
      approvalRateShift,
      thresholds: {
        meanPoints: DRIFT_MEAN_POINTS,
        approvalRate: DRIFT_APPROVAL_RATE,
        minSample: DRIFT_MIN_SAMPLE,
      },
    }
  }

  private async window(
    from: Date,
    to: Date,
    modelVersionId?: string,
  ): Promise<DriftWindow> {
    const rows = await this.prisma.score.findMany({
      where: {
        status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN] },
        computedAt: { gte: from, lt: to },
        ...(modelVersionId ? { modelVersionId } : {}),
        value: { not: null },
      },
      select: { value: true, confidence: true },
    })
    const values = rows
      .map((r) => r.value)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b)

    if (!values.length) {
      return {
        count: 0,
        mean: 0,
        p10: 0,
        median: 0,
        p90: 0,
        approvalRate: 0,
        meanConfidence: 0,
      }
    }
    const confidences = rows
      .map((r) => r.confidence)
      .filter((c): c is number => c !== null)

    return {
      count: values.length,
      mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)),
      p10: percentile(values, 0.1),
      median: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      // "Approval" proxied by GOOD-or-better, the same cut the fairness audit
      // defaults to, so drift and fairness talk about the same threshold.
      approvalRate: Number(
        (values.filter((v) => v >= 670).length / values.length).toFixed(3),
      ),
      meanConfidence: confidences.length
        ? Number(
            (
              confidences.reduce((a, b) => a + b, 0) / confidences.length
            ).toFixed(3),
          )
        : 0,
    }
  }
}

/**
 * A type alias rather than an interface on purpose: only aliases get TypeScript's
 * implicit index signature, which is what lets a drift report be written straight
 * into the audit trail's `Prisma.InputJsonValue` metadata without a cast.
 */
export type DriftWindow = {
  count: number
  mean: number
  p10: number
  median: number
  p90: number
  approvalRate: number
  meanConfidence: number
}

/** Nearest-rank percentile over a pre-sorted array. */
function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  )
  return sorted[idx]!
}
