import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  BAND_TIER_POLICY,
  BEHAVIOUR_FEATURES,
  PRICING_MODEL_VERSION,
  SUBSTANDARD_EXTRA_WAITING_DAYS,
  THIN_FILE_POLICY,
} from '@/modules/insurance/insurance.config'
import {
  behaviourNudgeBps,
  confidencePenaltyBps,
  effectiveMultiplierBps,
  type MultiplierBreakdown,
} from '@/modules/insurance/insurance-pricing.util'
import { isFresh } from '@/modules/scoring/scoring.state'

import {
  RiskTier,
  ScoreStatus,
  type InsuranceProductType,
  type ScoreBand,
} from 'generated/prisma/client'

/** The underwriting verdict, and everything needed to explain it. */
export interface RiskDecision {
  tier: RiskTier
  /** Applied to the product's `baseRateBps`. 10000 = 1.0×. */
  multiplierBps: number
  /** The product's own waiting period, possibly extended. */
  waitingPeriodDays: number

  /** M2 provenance. All null on a thin file — visibly, not as a zero. */
  scoreId: string | null
  scoreBand: ScoreBand | null
  scoreValue: number | null
  confidence: number | null

  /** How the multiplier was arrived at. Persisted, encrypted, on the quote. */
  breakdown: MultiplierBreakdown
  /** Set only when the tier is DECLINE. Plain language, with a route back. */
  declineReason: string | null
  /** Why the price is what it is, in words the applicant reads. */
  explanation: string[]
  pricingModelVersion: string
}

/**
 * Reputation-driven underwriting — the reason M5 exists.
 *
 * An insurer looking at a migrant daily-wage worker sees no salary slip, no credit
 * bureau file and no claims history, so they either refuse or price for the worst
 * case. M2 produced something they have never had: an explainable, consented,
 * behaviour-derived score for exactly that person. This service turns it into a
 * price.
 *
 * ## Four controls, and each is code rather than a UI hint
 *
 *  1. **Band-tied pricing.** EXCELLENT pays 0.70× what STANDARD pays for identical
 *     cover. That discount is the incentive to bring data; without it there is no
 *     reason for a good-behaviour customer to consent to anything.
 *  2. **The confidence gate.** M2 reports honest uncertainty. Six weeks of one bank
 *     account is not the same evidence as eighteen months of three, and pricing them
 *     identically fills a book with risk nobody measured.
 *  3. **The waiting period.** Extended for SUBSTANDARD risks. The single control
 *     that makes buy-after-the-incident irrational.
 *  4. **A decline floor.** POOR is not sold this cover. A premium high enough to
 *     cover that risk would be unaffordable to the person quoted, so offering it
 *     would be a product that functions as a refusal while taking their money first.
 *
 * ## What is deliberately absent
 *
 * No protected attribute is read here, and none CAN be: M2 never puts gender, age
 * band or nationality in the feature vector, so there is no SHAP factor for this
 * service to find. The fairness guarantee is inherited by construction rather than
 * by this file remembering to be careful — which is the only way it survives a
 * future edit. `ProtectedAttribute` has exactly one reader in the codebase,
 * `FairnessService`, and it exists to PROVE the model is equitable, not to price.
 */
@Injectable()
export class UnderwritingService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: UnderwritingService.name })
  }

  /**
   * Assess a user against a product.
   *
   * Reads the latest SERVABLE score — `COMPUTED` or `OVERRIDDEN` — and re-checks
   * freshness at read time rather than trusting the status column, because M2's
   * lifecycle cron may not have run since a consent's data life ended. Pricing off
   * a score whose underlying permission has expired would be using data we no
   * longer have a lawful basis to hold.
   */
  async assess(
    userId: string,
    product: { type: InsuranceProductType; waitingPeriodDays: number },
  ): Promise<RiskDecision> {
    const score = await this.prisma.score.findFirst({
      where: {
        userId,
        status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN] },
      },
      orderBy: [{ computedAt: 'desc' }, { createdAt: 'desc' }],
      include: { factors: { orderBy: { rank: 'asc' } } },
    })

    if (!score || !score.band || !isFresh(score.status, score.expiresAt)) {
      return this.thinFile(product, score ? 'STALE' : 'ABSENT')
    }

    const band = score.band
    const policy = BAND_TIER_POLICY[band]
    if (!policy) {
      /**
       * A band the policy table does not know.
       *
       * Only reachable if `ScoreBand` gains a value and this table is not updated.
       * Treated as a thin file — the conservative branch — rather than defaulting to
       * STANDARD, because defaulting would silently sell cover at 1.0× to a risk
       * nobody has decided how to price.
       */
      this.logger.error(
        `[${this.assess.name}] No tier policy for score band — pricing as a thin file`,
        { band, userId },
      )
      return this.thinFile(product, 'ABSENT')
    }

    const confidence = score.confidence ?? null

    if (policy.tier === RiskTier.DECLINE) {
      return {
        tier: RiskTier.DECLINE,
        multiplierBps: 0,
        waitingPeriodDays: product.waitingPeriodDays,
        scoreId: score.id,
        scoreBand: band,
        scoreValue: score.value,
        confidence,
        breakdown: {
          bandBps: 0,
          confidencePenaltyBps: 0,
          behaviourBps: 0,
          effectiveBps: 0,
          clamped: false,
        },
        /**
         * A decline that tells the applicant what to do next.
         *
         * "Not eligible" with no reason is the experience this population already
         * gets from every insurer, and repeating it while holding their consented
         * data would be worse than not offering the product. The route back is real:
         * M2's improvement tips are counterfactuals with recomputed point gains.
         */
        declineReason:
          'This cover is not open to your current Pravaah band. It is not a judgement about you — the band reflects the cash-flow history shared so far. The "how to improve" steps on your score page show what would change it, and this cover opens up from the FAIR band.',
        explanation: [
          `Your current band is ${band}.`,
          'This product needs at least a FAIR band to price the risk affordably.',
        ],
        pricingModelVersion: PRICING_MODEL_VERSION,
      }
    }

    const penaltyBps = confidencePenaltyBps(confidence)
    const behaviourBps = behaviourNudgeBps(
      this.behaviourContributions(score.factors),
    )
    const breakdown = effectiveMultiplierBps({
      bandBps: policy.multiplierBps,
      confidencePenaltyBps: penaltyBps,
      behaviourBps,
    })

    const waitingPeriodDays =
      policy.tier === RiskTier.SUBSTANDARD
        ? product.waitingPeriodDays + SUBSTANDARD_EXTRA_WAITING_DAYS
        : product.waitingPeriodDays

    return {
      tier: policy.tier,
      multiplierBps: breakdown.effectiveBps,
      waitingPeriodDays,
      scoreId: score.id,
      scoreBand: band,
      scoreValue: score.value,
      confidence,
      breakdown,
      declineReason: null,
      explanation: this.explain({
        band,
        confidence,
        penaltyBps,
        behaviourBps,
        breakdown,
        waitingPeriodDays,
        productWaitingPeriodDays: product.waitingPeriodDays,
      }),
      pricingModelVersion: PRICING_MODEL_VERSION,
    }
  }

  /**
   * The STANDARD-risk comparison, so a quote can show what the discount is worth.
   *
   * Deliberately NOT derived by dividing the quoted premium by the multiplier. That
   * would round twice and could show a "saving" of a paisa in the wrong direction on
   * a small premium; quoting the comparison through the same `computePremium` path
   * means the two numbers on the screen were produced identically.
   */
  standardDecision(product: {
    type: InsuranceProductType
    waitingPeriodDays: number
  }): Pick<RiskDecision, 'tier' | 'multiplierBps' | 'waitingPeriodDays'> {
    return {
      tier: RiskTier.STANDARD,
      multiplierBps: BAND_TIER_POLICY.GOOD.multiplierBps,
      waitingPeriodDays: product.waitingPeriodDays,
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * The thin-file branch: a conservative price, not a refusal.
   *
   * This is the newly-arrived migrant in their first week in the corridor — the
   * single most important person for this product to serve, and the one an
   * insurer's rulebook rejects automatically. So they are quoted at 1.4× with a
   * longer waiting period and a halved coverage ceiling, and the quote says exactly
   * that, with the route to a better price.
   *
   * The longer waiting period is what makes the conservative price safe rather than
   * merely expensive: it is the control that stops somebody with a known loss buying
   * cover on day one at a price we could not have measured.
   */
  private thinFile(
    product: { waitingPeriodDays: number },
    cause: 'ABSENT' | 'STALE',
  ): RiskDecision {
    const breakdown = effectiveMultiplierBps({
      bandBps: THIN_FILE_POLICY.multiplierBps,
      confidencePenaltyBps: 0,
      behaviourBps: 0,
    })

    return {
      tier: THIN_FILE_POLICY.tier,
      multiplierBps: breakdown.effectiveBps,
      waitingPeriodDays:
        product.waitingPeriodDays + THIN_FILE_POLICY.extraWaitingDays,
      scoreId: null,
      scoreBand: null,
      scoreValue: null,
      confidence: null,
      breakdown,
      declineReason: null,
      explanation: [
        cause === 'STALE'
          ? 'Your Pravaah score has expired because the consent behind it ended, so we have priced this conservatively.'
          : 'You do not have a Pravaah score yet, so we have priced this conservatively rather than turning you away.',
        `Your waiting period is ${THIN_FILE_POLICY.extraWaitingDays} days longer and your cover ceiling is lower than for a scored applicant.`,
        'Share your bank or GST data through the Account Aggregator, and a re-quote after your score is computed will usually be cheaper.',
      ],
      pricingModelVersion: PRICING_MODEL_VERSION,
    }
  }

  /**
   * Pull the behaviour contributions out of M2's SHAP factors.
   *
   * The SIGN convention here is the one that matters. In M2 a POSITIVE `shapValue`
   * pushes the score UP, so a positive contribution on a favourable feature means
   * good behaviour and should LOWER the premium. `behaviourNudgeBps` subtracts the
   * favourable mean and adds the adverse one, which is why the two lists are passed
   * separately rather than pre-signed here — one place decides the direction, and it
   * is the pure function with the unit tests.
   *
   * A feature M2 did not report is simply absent rather than imputed as zero. An
   * imputed zero would be counted in the mean's denominator and dilute the whole
   * behaviour term toward nothing for anyone with partial data — a
   * data-completeness penalty wearing a behaviour label.
   */
  private behaviourContributions(
    factors: Array<{ feature: string; shapValue: number }>,
  ): { favourable: number[]; adverse: number[] } {
    const byFeature = new Map(
      factors.map((factor) => [factor.feature, factor.shapValue]),
    )

    const pick = (features: readonly string[]): number[] =>
      features
        .map((feature) => byFeature.get(feature))
        .filter((value): value is number => typeof value === 'number')

    return {
      favourable: pick(BEHAVIOUR_FEATURES.favourable),
      adverse: pick(BEHAVIOUR_FEATURES.adverse),
    }
  }

  /**
   * The price, explained.
   *
   * Assembled here rather than on a screen so the same sentences appear in the app,
   * the admin console and the audit trail. A premium derived from somebody's
   * financial behaviour that cannot explain itself is one they cannot contest, and
   * "priced by an algorithm" is not an answer anybody should accept.
   */
  private explain(params: {
    band: ScoreBand
    confidence: number | null
    penaltyBps: number
    behaviourBps: number
    breakdown: MultiplierBreakdown
    waitingPeriodDays: number
    productWaitingPeriodDays: number
  }): string[] {
    const lines: string[] = []
    const { band, breakdown } = params

    if (breakdown.bandBps < 10_000) {
      lines.push(
        `Your Pravaah band is ${band}, which prices this cover below the standard rate.`,
      )
    } else if (breakdown.bandBps === 10_000) {
      lines.push(
        `Your Pravaah band is ${band} — the standard rate for this cover.`,
      )
    } else {
      lines.push(
        `Your Pravaah band is ${band}, which prices this cover above the standard rate.`,
      )
    }

    if (params.penaltyBps > 0) {
      lines.push(
        `There is not yet much history behind your score (confidence ${(
          (params.confidence ?? 0) * 100
        ).toFixed(
          0,
        )}%), so the premium is set cautiously. More months of shared data lowers this.`,
      )
    }

    if (params.behaviourBps < 0) {
      lines.push(
        'Your regular income and the balance you keep between paydays reduced the premium further.',
      )
    } else if (params.behaviourBps > 0) {
      lines.push(
        'Uneven cash flow and existing obligations raised the premium slightly.',
      )
    }

    if (params.waitingPeriodDays > params.productWaitingPeriodDays) {
      lines.push(
        `Your waiting period is ${params.waitingPeriodDays} days rather than ${params.productWaitingPeriodDays}, because of the risk band.`,
      )
    }

    if (breakdown.clamped) {
      /**
       * Stated, not hidden.
       *
       * A clamped quote was priced by the floor or the ceiling, not by the
       * applicant's behaviour, and an actuary reviewing the book needs to know which
       * of the two produced the number.
       */
      lines.push(
        'This premium sits at our pricing floor or ceiling, so further changes in your score may not move it.',
      )
    }

    return lines
  }
}
