import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { PIN_POLICY, SIGNAL_WEIGHTS } from '@/modules/fraud/fraud.config'
import type { Signal } from '@/modules/fraud/fraud.state'
import { RiskService } from '@/modules/fraud/services/risk.service'
import { RISK_POLICY } from '@/modules/payments/payments.config'

import {
  Corridor,
  RiskDecision,
  RiskSubjectType,
  TxnStatus,
  type Beneficiary,
} from 'generated/prisma/client'

export interface RiskAssessment {
  /** 0..1. Not a probability — an ordered severity. */
  value: number
  /** Whether to park the transaction as RISK_HELD. */
  hold: boolean
  /**
   * Whether a dynamic second factor must pass before this transfer may proceed.
   *
   * New with M6. `hold` and `stepUp` are mutually exclusive and mean different things: a
   * HOLD needs a human, a STEP_UP needs the user. Before M6 there was only `hold`, so
   * every medium-risk transfer was either waved through or parked for an analyst — the
   * two worst options, since one accepts the risk and the other punishes a legitimate
   * user with a review queue.
   */
  stepUp: boolean
  /** The signals that fired, for the admin review queue and the audit trail. */
  flags: string[]
  /** Why, in words a reviewer can act on. */
  reasons: string[]
  /** The full M6 decision, for callers that want the four-way outcome. */
  decision: RiskDecision
  /** The `RiskAssessment` row, so the transaction can point at its own reasoning. */
  assessmentId: string
  /** Present when a HOLD or BLOCK opened an analyst case. */
  caseId?: string
}

/**
 * Payment-domain risk signals, scored by M6's engine.
 *
 * ## What changed when M6 landed
 *
 * This service used to BE the risk engine for payments — it collected signals, summed
 * them, and compared the total against one threshold. Its own header called itself "the
 * M6 hook, wired now", and that is exactly what it turned out to be.
 *
 * It is now a **domain signal collector**. It still computes the payment-specific facts
 * that only M4 can know — corridor asymmetry, structuring at the daily cap, an open
 * unauthorised dispute — and hands them to {@link RiskService}, which adds the
 * cross-cutting layers (device binding, SIM swap, velocity, behavioural baselines, the
 * mule graph, watchlists) and makes the decision.
 *
 * ## Why the split rather than moving everything into M6
 *
 * Because the signals below need to understand payments. "Repeated transfers at exactly
 * the daily cap" is meaningless without knowing what a corridor's cap IS, and "first
 * international payment to a payee added yesterday" needs `Corridor` and `Beneficiary`.
 * Pushing those into M6 would make the fraud engine depend on M4's row shapes and its
 * limit policy — and then M6 could not be the module M4 depends on. The dependency has to
 * point one way, so the domain knowledge stays here and only typed `Signal`s cross the
 * boundary.
 *
 * ## Why the additive weights became noisy-OR weights
 *
 * The numbers below are mostly the ones this service already used. What changed is how
 * they combine: `value += 0.35` became a `weight` in `1 − Π(1 − wᵢ·vᵢ)`. That fixes a
 * real defect in the old form — a plain sum has no ceiling, so five weak signals summed
 * past the 0.70 hold threshold and parked a transfer on nothing but circumstantial colour.
 * Noisy-OR saturates toward 1.0 instead, and stays monotonic, so adding a signal can
 * never lower a score.
 *
 * ## What a HOLD still is, and is not
 *
 * Not a decline. The transaction parks in `RISK_HELD` with the funds NOT yet reserved, and
 * an analyst or a step-up releases it. That distinction is why these signals can afford to
 * be blunt: a false positive costs a review, not a customer.
 */
@Injectable()
export class PaymentRiskService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentRiskService.name })
  }

  async score(params: {
    userId: string
    corridor: Corridor
    beneficiary: Beneficiary
    totalDebitMinor: bigint
    limitAmountMinor: bigint
    dailyCapMinor: bigint
    deviceId?: string | null
    /** Passed through to M6 so the network can be counted and list-checked. */
    ipAddress?: string | null
    geoHint?: string | null
    /** The transaction id, once it exists. A pre-flight scores against a synthetic key. */
    subjectId?: string
  }): Promise<RiskAssessment> {
    const domainSignals = await this.domainSignals(params)

    const outcome = await this.risk.scoreTransaction({
      userId: params.userId,
      subjectType: RiskSubjectType.TRANSACTION,
      /**
       * A synthetic subject id when the transaction row does not exist yet.
       *
       * Scoring happens BEFORE the insert (the score decides the row's initial status),
       * so there is nothing to point at. The pre-flight marker keeps the assessment
       * findable and is why `RiskAssessment.subjectId` is TEXT rather than a uuid — a
       * uuid column would have rejected it with `22P02`, the same way
       * `KycCheck.providerRefId` once did.
       */
      subjectId: params.subjectId ?? `pending:${params.beneficiary.id}`,
      clientDeviceId: params.deviceId,
      ipAddress: params.ipAddress,
      geoHint: params.geoHint,
      amountMinor: params.limitAmountMinor,
      corridor: params.corridor,
      beneficiaryHandle: params.beneficiary.handle,
      beneficiaryAgeMs: beneficiaryAgeMs(params.beneficiary),
      sensitive: true,
      domainSignals,
    })

    const hold =
      outcome.decision === RiskDecision.HOLD ||
      outcome.decision === RiskDecision.BLOCK

    /**
     * A transfer needs a second factor when the LADDER asks for one, or when the AMOUNT does.
     *
     * ## Why the amount alone can demand it
     *
     * Real UPI apps require the PIN on every payment, full stop — GPay, PhonePe and Paytm all
     * do, because the factor is what authorises the debit rather than what reacts to
     * suspicion. NPCI's one exception is **UPI Lite**, an on-device wallet with no PIN below
     * ₹500, where they judged the friction not worth its cost.
     *
     * Pravaah borrows that line exactly: below `EXEMPT_BELOW_MINOR` a clean payment is
     * frictionless, above it the factor is unconditional. So a ₹50,000 transfer that scored
     * 0.02 still asks — which is the behaviour a user coming from any other UPI app expects,
     * and the behaviour the risk ladder alone would NOT produce.
     *
     * The two conditions are an OR, not a replacement: the ladder can still demand a factor
     * BELOW the threshold when signals warrant. The exemption is on the amount, never on the
     * risk.
     *
     * ## Why this measures `totalDebitMinor` and not `limitAmountMinor`
     *
     * `limitAmountMinor` is denominated in the CORRIDOR'S CAP CURRENCY — rupees for
     * DOMESTIC, Singapore dollars for CROSS_BORDER (see `LimitService.limitBasis`).
     * `EXEMPT_BELOW_MINOR` is ₹500 in paise. Comparing the two would read `50000` as
     * "SGD 500.00" on the cross-border leg and silently exempt every transfer up to about
     * ₹32,500 — wrong by the exchange rate, in the direction that waives the factor.
     *
     * So the exemption is scoped to DOMESTIC only, measured on what actually leaves the
     * wallet. Cross-border ALWAYS asks. That is not just the safe reading of the arithmetic,
     * it is the right policy: UPI Lite's no-PIN window exists for low-value, high-frequency,
     * in-country spending — the chai stall, the auto fare. Nobody wires money to Singapore
     * absent-mindedly, and there is no volume argument for shaving one factor off an
     * international remittance.
     */
    const amountDemandsFactor =
      params.corridor === Corridor.DOMESTIC
        ? params.totalDebitMinor >= PIN_POLICY.EXEMPT_BELOW_MINOR
        : true
    const stepUp =
      !hold &&
      (outcome.decision === RiskDecision.STEP_UP || amountDemandsFactor)

    if (hold || stepUp) {
      this.logger.warn(
        `[${this.score.name}] Transfer ${hold ? 'held' : 'challenged'} on risk`,
        {
          userId: params.userId,
          corridor: params.corridor,
          score: outcome.score,
          decision: outcome.decision,
          flags: outcome.signals.map((signal) => signal.type),
        },
      )
    }

    return {
      value: outcome.score,
      hold,
      stepUp,
      flags: outcome.signals.map((signal) => signal.type),
      reasons: outcome.reasons,
      decision: outcome.decision,
      assessmentId: outcome.assessmentId,
      caseId: outcome.caseId,
    }
  }

  /**
   * The payment-specific signals. Facts only M4 can establish.
   *
   * Every one is a pattern from real UPI fraud rather than a generic anomaly heuristic.
   * The cross-cutting layers — device, velocity, behaviour, graph, lists — are M6's and
   * are deliberately NOT duplicated here; an earlier version of this file computed its own
   * device checks against a `Device` table nothing ever wrote to, so all three of those
   * branches were dead code that scored every transfer as `UNKNOWN_DEVICE`.
   */
  private async domainSignals(params: {
    userId: string
    corridor: Corridor
    beneficiary: Beneficiary
    limitAmountMinor: bigint
    dailyCapMinor: bigint
  }): Promise<Signal[]> {
    const signals: Signal[] = []
    const now = Date.now()
    const isCrossBorder = params.corridor === Corridor.CROSS_BORDER

    // ── velocity of in-flight and settled payments ──────────────────────────
    /**
     * Kept alongside M6's bucketed counters rather than replaced by them, because it
     * measures something different: this is an HOURLY sliding count over the
     * `Transaction` table, which spans the bucket boundaries M6's tumbling windows
     * necessarily have. Two overlapping views of velocity is the point — see the
     * two-window rationale in `fraud.config.ts`.
     */
    const recentCount = await this.prisma.transaction.count({
      where: {
        userId: params.userId,
        createdAt: { gt: new Date(now - 60 * 60 * 1_000) },
        /**
         * In-flight and settled both count. Excluding failures is deliberate: a run of
         * FAILED attempts is card-testing behaviour and belongs in its own signal, not
         * in the velocity of successful spend.
         */
        status: { notIn: [TxnStatus.FAILED, TxnStatus.EXPIRED] },
      },
    })
    if (recentCount >= RISK_POLICY.VELOCITY_HOURLY_COUNT) {
      signals.push({
        type: 'VELOCITY_HOURLY',
        weight: SIGNAL_WEIGHTS.VELOCITY_HOURLY,
        value: Math.min(
          1,
          recentCount / (RISK_POLICY.VELOCITY_HOURLY_COUNT * 2),
        ),
        reason: `${recentCount} payments in the last hour`,
      })
    }

    // ── repeated failures: somebody probing ─────────────────────────────────
    const recentFailures = await this.prisma.transaction.count({
      where: {
        userId: params.userId,
        createdAt: { gt: new Date(now - 30 * 60 * 1_000) },
        status: TxnStatus.FAILED,
      },
    })
    if (recentFailures >= 5) {
      signals.push({
        type: 'REPEATED_FAILURES',
        weight: SIGNAL_WEIGHTS.REPEATED_FAILURES,
        value: Math.min(1, recentFailures / 10),
        reason: `${recentFailures} failed attempts in the last 30 minutes`,
      })
    }

    // ── a payee nobody has paid before ──────────────────────────────────────
    const ageMs = beneficiaryAgeMs(params.beneficiary)
    if (ageMs < RISK_POLICY.NEW_BENEFICIARY_MS) {
      /**
       * Cross-border to a brand-new payee is the social-engineering signature: the
       * victim is talked into adding an address and sending everything at once.
       * Domestically the same shape is ordinary behaviour and scores a quarter as much.
       */
      signals.push(
        isCrossBorder
          ? {
              type: 'NEW_BENEFICIARY',
              weight: SIGNAL_WEIGHTS.NEW_BENEFICIARY,
              value: 1,
              reason:
                'First international payment to a payee added in the last 24 hours',
            }
          : {
              type: 'NEW_BENEFICIARY',
              weight: SIGNAL_WEIGHTS.NEW_BENEFICIARY_DOMESTIC,
              value: 1,
              reason: 'Payee was added in the last 24 hours',
            },
      )
    }

    // ── amount shape ────────────────────────────────────────────────────────
    if (
      isCrossBorder &&
      params.limitAmountMinor >= RISK_POLICY.CROSS_BORDER_ATTENTION_MINOR
    ) {
      signals.push({
        type: 'LARGE_CROSS_BORDER',
        weight: SIGNAL_WEIGHTS.LARGE_CROSS_BORDER,
        value: 1,
        reason: 'A large international transfer',
      })
    }

    /**
     * Sending exactly the daily maximum.
     *
     * Structuring: breaking one large transfer into a series of at-the-cap ones to stay
     * under a reporting threshold. A single at-cap transfer is unremarkable; a repeat
     * within the week is the pattern.
     */
    if (params.limitAmountMinor === params.dailyCapMinor) {
      const atCapBefore = await this.prisma.transaction.count({
        where: {
          userId: params.userId,
          corridor: params.corridor,
          createdAt: { gt: new Date(now - 7 * 24 * 60 * 60 * 1_000) },
          status: { in: [TxnStatus.SUCCESS, TxnStatus.PENDING] },
        },
      })
      if (atCapBefore >= 2) {
        signals.push({
          type: 'POSSIBLE_STRUCTURING',
          weight: SIGNAL_WEIGHTS.POSSIBLE_STRUCTURING,
          value: 1,
          reason: 'Repeated payments at exactly the daily limit',
        })
      }
    }

    // ── the account itself ──────────────────────────────────────────────────
    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { createdAt: true },
    })
    if (
      user &&
      isCrossBorder &&
      now - user.createdAt.getTime() < 24 * 60 * 60 * 1_000
    ) {
      signals.push({
        type: 'NEW_ACCOUNT_CROSS_BORDER',
        weight: SIGNAL_WEIGHTS.NEW_ACCOUNT_CROSS_BORDER,
        value: 1,
        reason: 'First international payment from a day-old account',
      })
    }

    /**
     * A dispute the user themselves raised recently is a signal about the ACCOUNT, not
     * just that payment — either they are being targeted or they are the problem.
     */
    const openDisputes = await this.prisma.paymentDispute.count({
      where: {
        userId: params.userId,
        status: { in: ['OPEN', 'UNDER_REVIEW'] },
        kind: 'UNAUTHORISED',
      },
    })
    if (openDisputes > 0) {
      signals.push({
        type: 'OPEN_UNAUTHORISED_DISPUTE',
        weight: SIGNAL_WEIGHTS.OPEN_UNAUTHORISED_DISPUTE,
        value: 1,
        reason: 'An unauthorised-payment dispute is open on this account',
      })
    }

    return signals
  }
}

/**
 * How long ago a payee was established.
 *
 * Measured from `verifiedAt` when present, falling back to `createdAt` — the same rule
 * M4's `assertNewBeneficiaryWindow` uses, and for the same reason: a row a user created
 * days ago and only verified a minute before a large transfer is precisely the pattern
 * being caught.
 */
function beneficiaryAgeMs(beneficiary: Beneficiary): number {
  const establishedAt = beneficiary.verifiedAt ?? beneficiary.createdAt
  return Date.now() - establishedAt.getTime()
}
