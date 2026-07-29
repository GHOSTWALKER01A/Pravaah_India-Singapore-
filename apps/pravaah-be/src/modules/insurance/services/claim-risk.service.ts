import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { SIGNAL_WEIGHTS } from '@/modules/fraud/fraud.config'
import type { Signal } from '@/modules/fraud/fraud.state'
import { RiskService } from '@/modules/fraud/services/risk.service'
import {
  CLAIM_AUTO_APPROVE_RISK_CEILING,
  CLAIM_RISK_POLICY,
} from '@/modules/insurance/insurance.config'
import { addDays } from '@/modules/insurance/insurance.state'
import { BPS_SCALE, mulDivRound } from '@/modules/payments/money.util'

import {
  ClaimStatus,
  RiskDecision,
  RiskSubjectType,
  type Claim,
  type Policy,
} from 'generated/prisma/client'

export interface ClaimRiskAssessment {
  /** 0..1. Not a probability — an ordered severity, like M4's payment risk. */
  value: number
  /** Whether a human MUST decide. True on any tamper hit, regardless of score. */
  forceReview: boolean
  /** The signals that fired, for the reviewer's queue and the audit trail. */
  flags: string[]
  /** Why, in words a reviewer can act on. */
  reasons: string[]
  /** The full M6 decision, for callers that want the four-way outcome. */
  decision: RiskDecision
  /** The `RiskAssessment` row, so the claim can point at its own reasoning. */
  assessmentId: string
  /** Present when the decision opened an analyst case. */
  caseId?: string
}

/**
 * Claim-domain fraud signals, scored by M6's engine.
 *
 * ## What changed when M6 landed
 *
 * This service used to BE the fraud engine for claims — it collected signals, summed
 * them, and compared the total against one ceiling. Its own header called itself "the M6
 * hook, wired now", and that is what it turned out to be.
 *
 * It is now a **domain signal collector**. It still computes the claims-specific facts
 * that only M5 can know — waiting-period proximity, full-cover proportion, prior
 * rejections on the same policy — and hands them to {@link RiskService}, which adds the
 * cross-cutting layers (device, velocity, behaviour, mule graph, watchlists) and decides.
 *
 * That addition is not cosmetic. A claim filed from a device bound minutes ago, on an
 * account that sits in a mule cluster, was previously invisible to claims scoring: those
 * are exactly the signals a synthetic-identity ring produces, and M5 alone had no way to
 * see any of them.
 *
 * ## The asymmetry that survives the migration
 *
 * A tamper hit does not merely ADD to the score. It carries the heaviest claim weight
 * (0.55) AND sets `forceReview` outright, so no combination of favourable signals can
 * outweigh it. A forged document is not a probabilistic concern — it is evidence that the
 * claim itself is a fabrication — and a system that could average it away would eventually
 * auto-pay one.
 *
 * That is implemented as a belt-and-braces pair on purpose. Noisy-OR aggregation would put
 * a lone 0.55 tamper signal in the STEP_UP band, not the HOLD band, and a step-up on a
 * forged claim is meaningless: the claimant CAN answer their own OTP. The explicit
 * `forceReview` flag is what routes it to a person.
 *
 * ## What a high score does and does not do
 *
 * It blocks AUTO-APPROVAL. It never rejects a claim. A false positive costs a human
 * review; an automated rejection would cost somebody with a hospital bill their claim,
 * decided by a heuristic nobody can appeal to. That distinction is why these signals can
 * afford to be blunt.
 */
@Injectable()
export class ClaimRiskService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ClaimRiskService.name })
  }

  async scoreClaim(params: {
    claim: Claim
    policy: Policy
    /** Any attached document scored at or above the tamper threshold. */
    hasTamperedDocument: boolean
    /** A document amount materially below the claimed amount. */
    hasAmountMismatch: boolean
    documentCount: number
    documentsRequired: boolean
    /** Passed through so the device and network layers can contribute. */
    deviceId?: string | null
    ipAddress?: string | null
    geoHint?: string | null
  }): Promise<ClaimRiskAssessment> {
    const domainSignals = await this.domainSignals(params)

    const outcome = await this.risk.scoreClaim({
      userId: params.claim.userId,
      subjectType: RiskSubjectType.CLAIM,
      subjectId: params.claim.id,
      clientDeviceId: params.deviceId,
      ipAddress: params.ipAddress,
      geoHint: params.geoHint,
      /**
       * The claimed amount, so the value-gated REVIEW band and the behavioural amount
       * baseline both apply. Note this is an insurance claim, not a transfer, so the
       * baseline comparison is against the holder's payment history — a weak signal here,
       * and weighted as such.
       */
      amountMinor: params.claim.amountClaimedMinor,
      sensitive: true,
      domainSignals,
    })

    /**
     * `forceReview` is the union of the tamper switch and any non-ALLOW decision.
     *
     * `REVIEW` counts, and that is the point of including it: M6's shadow-review band means
     * "let it through but sample it", which is correct for a payment the user is waiting on
     * and wrong for a claim that would otherwise be AUTO-PAID. For money leaving on an
     * automated decision, a sampled review has to be a real one.
     */
    const forceReview =
      params.hasTamperedDocument ||
      outcome.decision !== RiskDecision.ALLOW ||
      outcome.score >= CLAIM_AUTO_APPROVE_RISK_CEILING

    if (forceReview) {
      this.logger.warn(
        `[${this.scoreClaim.name}] Claim routed to human review`,
        {
          claimId: params.claim.id,
          claimNumber: params.claim.claimNumber,
          score: outcome.score,
          decision: outcome.decision,
          tamper: params.hasTamperedDocument,
          flags: outcome.signals.map((signal) => signal.type),
        },
      )
    }

    return {
      value: outcome.score,
      forceReview,
      flags: outcome.signals.map((signal) => signal.type),
      reasons: outcome.reasons,
      decision: outcome.decision,
      assessmentId: outcome.assessmentId,
      caseId: outcome.caseId,
    }
  }

  /**
   * The claims-specific signals. Facts only M5 can establish.
   *
   * Every one is a pattern from real claims fraud rather than a generic anomaly heuristic.
   */
  private async domainSignals(params: {
    claim: Claim
    policy: Policy
    hasTamperedDocument: boolean
    hasAmountMismatch: boolean
    documentCount: number
    documentsRequired: boolean
  }): Promise<Signal[]> {
    const signals: Signal[] = []
    const { claim, policy } = params
    const now = new Date()

    /**
     * Claimed immediately after the waiting period ended.
     *
     * The strongest signal in short-tail micro-insurance. Somebody who already knew about
     * the loss waited out the clock, and the shape of that is a claim on day 31 of a
     * 30-day wait.
     */
    if (policy.waitingPeriodEndsAt) {
      const windowEnd = addDays(
        policy.waitingPeriodEndsAt,
        CLAIM_RISK_POLICY.POST_WAITING_WINDOW_DAYS,
      )
      if (
        claim.incidentDate >= policy.waitingPeriodEndsAt &&
        claim.incidentDate <= windowEnd
      ) {
        signals.push({
          type: 'IMMEDIATELY_AFTER_WAITING_PERIOD',
          weight: SIGNAL_WEIGHTS.IMMEDIATELY_AFTER_WAITING_PERIOD,
          value: 1,
          reason: `The incident falls within ${CLAIM_RISK_POLICY.POST_WAITING_WINDOW_DAYS} days of the waiting period ending`,
        })
      }
    }

    // ── the claim is essentially the whole sum insured ──────────────────────
    const fullCoverThreshold = mulDivRound(
      policy.coverageMinor,
      BigInt(CLAIM_RISK_POLICY.FULL_COVER_BPS),
      BPS_SCALE,
      'DOWN',
    )
    if (claim.amountClaimedMinor >= fullCoverThreshold) {
      signals.push({
        type: 'FULL_COVER_CLAIM',
        weight: SIGNAL_WEIGHTS.FULL_COVER_CLAIM,
        value: 1,
        reason: 'The claim is for essentially the entire sum insured',
      })
    }

    // ── velocity across the holder's policies ───────────────────────────────
    const recentClaims = await this.prisma.claim.count({
      where: {
        userId: claim.userId,
        id: { not: claim.id },
        submittedAt: {
          gt: addDays(now, -CLAIM_RISK_POLICY.VELOCITY_WINDOW_DAYS),
        },
        /**
         * Withdrawn claims are excluded.
         *
         * A claimant who filed and then withdrew — because they realised the incident was
         * inside their waiting period, say — has not done anything suspicious, and counting
         * it would penalise somebody for correcting themselves.
         */
        status: { not: ClaimStatus.WITHDRAWN },
      },
    })
    if (recentClaims >= CLAIM_RISK_POLICY.VELOCITY_CLAIM_COUNT) {
      signals.push({
        type: 'CLAIM_VELOCITY',
        weight: SIGNAL_WEIGHTS.CLAIM_VELOCITY,
        value: Math.min(
          1,
          recentClaims / (CLAIM_RISK_POLICY.VELOCITY_CLAIM_COUNT * 2),
        ),
        reason: `${recentClaims} other claims in the last ${CLAIM_RISK_POLICY.VELOCITY_WINDOW_DAYS} days`,
      })
    }

    // ── the documents disagree with the claim ───────────────────────────────
    if (params.hasAmountMismatch) {
      signals.push({
        type: 'CLAIM_AMOUNT_MISMATCH',
        weight: SIGNAL_WEIGHTS.CLAIM_AMOUNT_MISMATCH,
        value: 1,
        reason:
          'The amount on the uploaded document is materially lower than the amount claimed',
      })
    }

    if (params.documentsRequired && params.documentCount === 0) {
      signals.push({
        type: 'NO_DOCUMENTS',
        weight: SIGNAL_WEIGHTS.NO_DOCUMENTS,
        value: 1,
        reason: 'No supporting documents were attached',
      })
    }

    // ── a policy bought days ago ────────────────────────────────────────────
    const policyAgeDays = policy.startAt
      ? (now.getTime() - policy.startAt.getTime()) / 86_400_000
      : 0
    if (policy.startAt && policyAgeDays < CLAIM_RISK_POLICY.NEW_POLICY_DAYS) {
      signals.push({
        type: 'NEW_POLICY',
        weight: SIGNAL_WEIGHTS.NEW_POLICY,
        value: 1,
        reason: `The policy is ${Math.floor(policyAgeDays)} days old`,
      })
    }

    // ── a prior rejection on this policy ────────────────────────────────────
    const priorRejections = await this.prisma.claim.count({
      where: {
        policyId: policy.id,
        id: { not: claim.id },
        status: ClaimStatus.REJECTED,
      },
    })
    if (priorRejections > 0) {
      signals.push({
        type: 'PRIOR_REJECTED_CLAIM',
        weight: SIGNAL_WEIGHTS.PRIOR_REJECTED_CLAIM,
        value: 1,
        reason: `${priorRejections} previously rejected claim${priorRejections > 1 ? 's' : ''} on this policy`,
      })
    }

    /**
     * The tamper signal.
     *
     * Carries the heaviest claim weight, AND the caller sets `forceReview` from the same
     * fact. Both, because neither alone is sufficient: the weight makes the score honest
     * for an analyst reading the case, and the flag is what actually stops the auto-payment
     * — a 0.55 signal alone lands in the STEP_UP band, and a step-up on a forged claim is
     * meaningless because the claimant can answer their own OTP.
     */
    if (params.hasTamperedDocument) {
      signals.push({
        type: 'CLAIM_TAMPER',
        weight: SIGNAL_WEIGHTS.CLAIM_TAMPER,
        value: 1,
        reason:
          'One or more uploaded documents show signs of alteration and must be checked by a person',
      })
    }

    return signals
  }
}
