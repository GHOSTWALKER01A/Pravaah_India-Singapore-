import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  CASE_SLA_MS,
  RISK_MODEL_VERSION,
  SIGNAL_WEIGHTS,
} from '@/modules/fraud/fraud.config'
import {
  aggregateRisk,
  decide,
  needsCase,
  severityFor,
  type Signal,
} from '@/modules/fraud/fraud.state'
import { hashIdentifier, hashIpNetwork } from '@/modules/fraud/risk-hash.util'
import type { RiskContext, RiskOutcome } from '@/modules/fraud/risk.types'
import { BehaviourService } from '@/modules/fraud/services/behaviour.service'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { MuleGraphService } from '@/modules/fraud/services/mule-graph.service'
import { VelocityService } from '@/modules/fraud/services/velocity.service'
import { WatchlistService } from '@/modules/fraud/services/watchlist.service'

import {
  ActorType,
  RiskDecision,
  RiskSubjectType,
  type Prisma,
} from 'generated/prisma/client'

/**
 * The risk engine — M6's single decision authority.
 *
 * Every sensitive action in the product routes through here and gets back one of
 * `ALLOW / REVIEW / STEP_UP / HOLD / BLOCK`, with the signals that produced it. M0
 * calls it at device bind, Auth at login, M1 at consent creation, M4 before a
 * transfer submits, and M5 before a claim auto-approves.
 *
 * ## Why one engine rather than five
 *
 * Because the alternative drifts. M4 and M5 each shipped their own risk heuristic
 * (`PaymentRiskService`, `ClaimRiskService`), both self-described as "the M6 hook,
 * wired now", and both already using slightly different aggregation (additive) and
 * different thresholds. Left alone, a third module would have added a fourth. One
 * engine means the device layer, the velocity layer and the graph layer apply to a
 * claim and a login without being written three times — and it means a threshold
 * change is one edit, not a search.
 *
 * Those two services are not deleted. They keep their DOMAIN signals — corridor-aware
 * structuring, waiting-period proximity — and contribute them as `domainSignals`. The
 * engine adds the cross-cutting layers and makes the decision. That split is why one
 * ladder can cover payments, claims and logins without M6 having to understand
 * insurance.
 *
 * ## The layered-defence property, concretely
 *
 * Collectors run in PARALLEL and each fails independently:
 *
 *  - Graph store unavailable → `MuleGraphService.signals` returns `[]`, the other
 *    four layers decide.
 *  - Telco down → the SIM anchor comparison still runs.
 *  - A collector THROWS → `settleAllCollectors` records the failure as a signal and
 *    keeps going.
 *
 * Every layer degrades to a weaker decision, never to `ALLOW`. That is what "fails
 * safe" has to mean in code, as opposed to in a slide.
 */
@Injectable()
export class RiskService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DeviceTrustService,
    private readonly velocity: VelocityService,
    private readonly behaviour: BehaviourService,
    private readonly graph: MuleGraphService,
    private readonly watchlist: WatchlistService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: RiskService.name })
  }

  // ── the entry points ──────────────────────────────────────────────────────
  /**
   * Score a money movement. Called INLINE by M4 before submit.
   *
   * The hot path, so every collector is a small number of indexed reads and they all
   * run concurrently. No synchronous model inference, no graph traversal — the graph's
   * expensive work is precomputed and read as one row.
   */
  async scoreTransaction(ctx: RiskContext): Promise<RiskOutcome> {
    return this.evaluate({
      ...ctx,
      subjectType: RiskSubjectType.TRANSACTION,
      sensitive: true,
    })
  }

  /** Score a claim. Called by M5 between submission and auto-approval. */
  async scoreClaim(ctx: RiskContext): Promise<RiskOutcome> {
    return this.evaluate({
      ...ctx,
      subjectType: RiskSubjectType.CLAIM,
      sensitive: true,
    })
  }

  /**
   * Score a login. Called by Auth after the OTP verdict is known.
   *
   * Records the attempt first, then scores — so the current attempt is counted in its
   * own stuffing evaluation. Scoring before recording would make every attempt appear
   * to be the first.
   */
  async scoreLogin(
    ctx: RiskContext & { identifier: string; success: boolean },
  ): Promise<RiskOutcome> {
    await this.velocity.recordAuthAttempt({
      identifier: ctx.identifier,
      ipAddress: ctx.ipAddress,
      userId: ctx.userId,
      success: ctx.success,
      outcome: ctx.success ? 'OK' : 'OTP_WRONG',
    })

    const stuffing = await this.velocity.loginSignals({
      identifierHash: hashIdentifier(ctx.identifier),
      ipHash: ctx.ipAddress ? hashIpNetwork(ctx.ipAddress) : null,
    })

    return this.evaluate(
      {
        ...ctx,
        subjectType: RiskSubjectType.LOGIN,
        sensitive: true,
        domainSignals: [...(ctx.domainSignals ?? []), ...stuffing],
      },
      // Velocity is already accounted for by `loginSignals`; running the transaction
      // collector on a LOGIN would count nothing and cost a query.
      { skipVelocity: true },
    )
  }

  /** Score a device bind. Called by `DeviceTrustService` before issuing a challenge. */
  async scoreDeviceBind(ctx: RiskContext): Promise<RiskOutcome> {
    return this.evaluate({
      ...ctx,
      subjectType: RiskSubjectType.DEVICE_BIND,
      sensitive: true,
    })
  }

  /** Score a consent creation. Called by M1 (T11 — consent farming). */
  async scoreConsent(ctx: RiskContext): Promise<RiskOutcome> {
    return this.evaluate({
      ...ctx,
      subjectType: RiskSubjectType.CONSENT,
      sensitive: true,
    })
  }

  // ── the engine ────────────────────────────────────────────────────────────
  /**
   * Collect, aggregate, decide, persist.
   *
   * The one method that produces a `RiskAssessment`. Every entry point above is a
   * thin wrapper that sets the subject type and the sensitivity, so there is exactly
   * one place where a decision is made and exactly one place it is recorded.
   */
  private async evaluate(
    ctx: RiskContext,
    options: { skipVelocity?: boolean } = {},
  ): Promise<RiskOutcome> {
    const collected = await this.collect(ctx, options)

    /**
     * A suspended account is a hard stop, checked here rather than in five callers.
     *
     * M4 already refuses transfers from a suspended user, but M5, M1 and the bind
     * path did not — so a suspended account could still file a claim or share data.
     * Putting it in the engine means every decision point inherits it.
     */
    const user = await this.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { isSuspended: true },
    })

    const signals = [...collected, ...(ctx.domainSignals ?? [])]

    if (user?.isSuspended) {
      signals.push({
        type: 'WATCHLIST_HIT',
        weight: 1,
        value: 1,
        reason: 'This account is suspended',
        isHard: true,
      })
    }

    const deduped = dedupeSignals(signals)
    const score = aggregateRisk(deduped)
    const decision = decide({
      score,
      signals: deduped,
      sensitive: ctx.sensitive ?? false,
      amountMinor: ctx.amountMinor,
    })

    const assessment = await this.persist(ctx, deduped, score, decision)
    const caseId = needsCase(decision)
      ? await this.openCase(ctx, assessment.id, deduped, score, decision)
      : undefined

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: `risk.${decision.toLowerCase()}`,
      entity: 'RiskAssessment',
      entityId: assessment.id,
      metadata: {
        subjectType: ctx.subjectType,
        subjectId: ctx.subjectId,
        score,
        signals: deduped.map((signal) => signal.type),
      },
      ipAddress: ctx.ipAddress ?? null,
    })

    if (decision !== RiskDecision.ALLOW) {
      this.logger.warn(`[${this.evaluate.name}] Risk decision: ${decision}`, {
        userId: ctx.userId,
        subjectType: ctx.subjectType,
        subjectId: ctx.subjectId,
        score,
        signals: deduped.map((signal) => signal.type),
        caseId,
      })
    }

    return {
      assessmentId: assessment.id,
      score,
      decision,
      signals: deduped,
      caseId,
      reasons: userFacingReasons(deduped),
    }
  }

  /**
   * Run every collector concurrently, tolerating individual failures.
   *
   * `Promise.allSettled`, not `Promise.all`, and that choice is the whole fail-safe
   * story. With `all`, one collector throwing — a graph query timing out, a malformed
   * geo hint — rejects the entire evaluation. The caller then has to choose between
   * failing the user's payment and proceeding with NO risk assessment at all, and
   * under production pressure somebody always picks the second.
   *
   * With `allSettled`, a failed layer contributes a `COLLECTOR_FAILED` signal instead.
   * The decision is made on the layers that DID answer, and it is made slightly more
   * conservatively because a missing layer is itself weak evidence — which is exactly
   * the behaviour "degrades to safe, never to open" describes.
   */
  private async collect(
    ctx: RiskContext,
    options: { skipVelocity?: boolean },
  ): Promise<Signal[]> {
    const tasks: Array<{ layer: string; run: Promise<Signal[]> }> = [
      { layer: 'device', run: this.devices.signals(ctx) },
      { layer: 'behaviour', run: this.behaviour.signals(ctx) },
      { layer: 'graph', run: this.graph.signals(ctx) },
      { layer: 'watchlist', run: this.watchlist.signals(ctx) },
    ]

    if (!options.skipVelocity) {
      tasks.push({ layer: 'velocity', run: this.velocity.signals(ctx) })
    }

    const settled = await Promise.allSettled(tasks.map((task) => task.run))
    const signals: Signal[] = []

    settled.forEach((result, index) => {
      const layer = tasks[index]?.layer ?? 'unknown'

      if (result.status === 'fulfilled') {
        signals.push(...result.value)
        return
      }

      this.logger.error(
        `[${this.collect.name}] Collector "${layer}" failed — degrading to the remaining layers`,
        { err: result.reason, layer, userId: ctx.userId },
      )

      /**
       * A failed layer is recorded as a low-weight signal.
       *
       * Low (0.10) because it is not evidence of fraud — it is evidence of reduced
       * assurance. But it is NOT zero, so a systemic collector outage nudges
       * borderline actions toward a challenge rather than silently loosening every
       * decision in the product while reporting normal operation.
       */
      signals.push({
        type: 'COLLECTOR_FAILED',
        weight: 0.1,
        value: 1,
        reason: 'Some security checks could not be completed',
      })
    })

    return signals
  }

  private persist(
    ctx: RiskContext,
    signals: Signal[],
    score: number,
    decision: RiskDecision,
  ) {
    return this.prisma.riskAssessment.create({
      data: {
        userId: ctx.userId,
        subjectType: ctx.subjectType,
        subjectId: ctx.subjectId,
        score,
        decision,
        modelVersion: RISK_MODEL_VERSION,
        deviceRef: ctx.deviceRef ?? null,
        ipHash: ctx.ipAddress ? hashIpNetwork(ctx.ipAddress) : null,
        geoHint: ctx.geoHint ?? null,
        signals: {
          create: signals.map((signal) => ({
            type: signal.type,
            weight: signal.weight,
            value: signal.value,
            reason: signal.reason,
            isHard: signal.isHard ?? false,
          })),
        },
      },
      select: { id: true },
    })
  }

  /**
   * Open an analyst case for a HOLD or BLOCK.
   *
   * Idempotent through the UNIQUE constraint on `assessmentId`: a retried request
   * that scores identically produces a new assessment (correct — it is a new
   * evaluation), but a second case for the SAME assessment cannot exist. The catch
   * swallows the violation rather than failing the caller, because at this point the
   * decision has already been made and persisted; failing the payment to report a
   * duplicate case would be the wrong end of the trade.
   */
  private async openCase(
    ctx: RiskContext,
    assessmentId: string,
    signals: Signal[],
    score: number,
    decision: RiskDecision,
  ): Promise<string | undefined> {
    try {
      const fraudCase = await this.prisma.fraudCase.create({
        data: {
          userId: ctx.userId,
          assessmentId,
          severity: severityFor(decision, score),
          // Signal TYPES, not the user-facing reasons — this is the analyst's
          // vocabulary and it needs to be greppable across cases.
          reason: signals
            .map((signal) => signal.type)
            .join(',')
            .slice(0, 500),
          subjectType: ctx.subjectType,
          subjectId: ctx.subjectId,
          slaDueAt: new Date(Date.now() + CASE_SLA_MS),
        },
        select: { id: true },
      })
      return fraudCase.id
    } catch (error) {
      this.logger.warn(
        `[${this.openCase.name}] Could not open a case for this assessment`,
        { err: error, assessmentId },
      )
      return undefined
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  /**
   * A user's own recent decisions, for the transparency screen.
   *
   * Returns the reasons but NOT the signal types or weights. A user is owed an
   * explanation of a decision about them (DPDP), and "an unusually large amount from
   * a device registered minutes ago" is that explanation. `MULE_GRAPH, weight 0.55`
   * is not an explanation — it is a specification of the detector, and handing it to
   * an account under investigation is handing over the evasion instructions.
   */
  async assessmentsForUser(userId: string, limit = 20) {
    const rows = await this.prisma.riskAssessment.findMany({
      where: { userId },
      orderBy: { computedAt: 'desc' },
      take: limit,
      include: { signals: { select: { reason: true, isHard: true } } },
    })

    return rows.map((row) => ({
      id: row.id,
      subjectType: row.subjectType,
      decision: row.decision,
      computedAt: row.computedAt,
      /**
       * The score is deliberately absent from the user-facing projection.
       *
       * A precise number invites calibration: an attacker who can read "0.83" after
       * each attempt has an oracle and can tune inputs until it drops below the
       * threshold. The DECISION and the REASONS are what a person needs.
       */
      reasons: dedupeStrings(row.signals.map((signal) => signal.reason)),
    }))
  }

  /**
   * A user's open holds, for the honest "under review" screen.
   *
   * Reads the CASE rather than the assessment, because the case is what carries the
   * state a user needs: is it still open, and how long has it been. An assessment says
   * only what was decided at one instant.
   *
   * The reference is the case id, which is deliberately what support asks for — it ties
   * a user's complaint to the exact signal trail an analyst will read, with no lookup in
   * between.
   */
  async holdsForUser(userId: string) {
    const cases = await this.prisma.fraudCase.findMany({
      where: { userId, resolvedAt: null },
      orderBy: { openedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        status: true,
        openedAt: true,
        assessment: {
          select: { signals: { select: { reason: true } } },
        },
      },
    })

    return cases.map((item) => ({
      reference: item.id,
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      openedAt: item.openedAt,
      /**
       * The status is mapped to a user-facing vocabulary rather than exposed raw.
       *
       * `INVESTIGATING` tells a customer nothing and sounds accusatory; "under review"
       * is the same fact in language that does not imply they are a suspect. The
       * analyst's own states stay in the console.
       */
      status:
        item.status === 'INFO_REQUESTED' ? 'ACTION_NEEDED' : 'UNDER_REVIEW',
      reasons: dedupeStrings(
        (item.assessment?.signals ?? []).map((signal) => signal.reason),
      ),
    }))
  }

  /** The full record, for the analyst console. Includes weights and scores. */
  assessmentDetail(assessmentId: string) {
    return this.prisma.riskAssessment.findUnique({
      where: { id: assessmentId },
      include: {
        signals: true,
        case: { include: { notes: { orderBy: { createdAt: 'asc' } } } },
        user: {
          select: {
            id: true,
            pravaahId: true,
            kycStatus: true,
            isSuspended: true,
          },
        },
      },
    })
  }

  /** Admin queue of assessments, filterable by decision. */
  listAssessments(params: {
    decision?: RiskDecision
    subjectType?: RiskSubjectType
    userId?: string
    limit: number
    offset: number
  }) {
    const where: Prisma.RiskAssessmentWhereInput = {
      ...(params.decision ? { decision: params.decision } : {}),
      ...(params.subjectType ? { subjectType: params.subjectType } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
    }

    return this.prisma.$transaction([
      this.prisma.riskAssessment.findMany({
        where,
        orderBy: { computedAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: { signals: { select: { type: true, isHard: true } } },
      }),
      this.prisma.riskAssessment.count({ where }),
    ])
  }
}

/**
 * Collapse duplicate signal types, keeping the strongest of each.
 *
 * Necessary because signals arrive from several places at once — a collector and a
 * caller's `domainSignals` can both report a new beneficiary, and two windows of one
 * velocity dimension can both breach. In a noisy-OR, two copies of one fact compound
 * as though they were independent observations, so the same anomaly counted twice
 * inflates the score. Hard signals always win, since they change the outcome rather
 * than the number.
 */
export function dedupeSignals(signals: Signal[]): Signal[] {
  const strongest = new Map<string, Signal>()

  for (const signal of signals) {
    const existing = strongest.get(signal.type)

    if (!existing) {
      strongest.set(signal.type, signal)
      continue
    }

    if (signal.isHard && !existing.isHard) {
      strongest.set(signal.type, signal)
      continue
    }
    if (existing.isHard && !signal.isHard) continue

    if (signal.weight * signal.value > existing.weight * existing.value) {
      strongest.set(signal.type, signal)
    }
  }

  return [...strongest.values()]
}

/**
 * The reasons a user may see, ordered by how much they drove the decision.
 *
 * Ordered because the list is often shown truncated ("and 2 more"), and truncating an
 * unordered list can hide the actual cause behind an 0.10-weight odd-hour note.
 */
export function userFacingReasons(signals: Signal[]): string[] {
  return dedupeStrings(
    [...signals]
      .sort((a, b) => {
        if (Boolean(b.isHard) !== Boolean(a.isHard)) {
          return Number(Boolean(b.isHard)) - Number(Boolean(a.isHard))
        }
        return b.weight * b.value - a.weight * a.value
      })
      .map((signal) => signal.reason),
  )
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

/** Re-exported so callers building `domainSignals` use the same weight table. */
export { SIGNAL_WEIGHTS }
