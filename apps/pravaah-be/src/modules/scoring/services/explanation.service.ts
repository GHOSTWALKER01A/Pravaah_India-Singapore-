import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { ScoreFeature } from '@pravaah/schema'

import { FactorDirection } from 'generated/prisma/client'

import { FEATURE_LABELS } from '@/modules/scoring/model-catalog'
import type {
  ContributionOut,
  FeatureVector,
  InferenceProvider,
} from '@/modules/scoring/providers/inference.provider'

/** How many drivers the "why" panel shows. Five is what fits without scrolling. */
const TOP_FACTORS = 5
/** How many improvement tips to offer. Three actions is a plan; ten is noise. */
const TOP_IMPROVEMENTS = 3
/** Ignore contributions this close to zero — they are not an explanation. */
const NEGLIGIBLE = 1e-4

export interface PlainFactor {
  feature: string
  shapValue: number
  direction: FactorDirection
  plainText: string
  rank: number
}

export interface PlainImprovement {
  feature: string
  currentValue: number
  targetValue: number
  estimatedGain: number
  plainText: string
  rank: number
}

/**
 * Money formatting for user-facing copy. INR grouping (lakh/crore) because the
 * numbers are read by Indian users about their own bank accounts.
 */
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

/**
 * Turns signed contributions into sentences a person can act on.
 *
 * Two separate jobs, deliberately not conflated:
 *
 *  - `toFactors`      — WHY the score is what it is. Reads the contributions from
 *    the SAME prediction call that produced the score, so the explanation can
 *    never drift from the number (M2 §13, "explanation/score mismatch").
 *
 *  - `toImprovements` — WHAT to change. Each tip's point gain is obtained by
 *    RE-RUNNING the model with that one feature moved to its target, everything
 *    else held. The doc's shortcut (`|shap| × 40`) would be a fabricated number:
 *    contributions live in log-odds space and the score is a non-linear squash of
 *    them, so points are not additively decomposable. A real counterfactual is
 *    both honest and cheap here.
 */
@Injectable()
export class ExplanationService {
  private readonly logger: AppLogger

  constructor(@Inject(APP_LOGGER) logger: AppLogger) {
    this.logger = logger.child({ context: ExplanationService.name })
  }

  toFactors(
    contributions: readonly ContributionOut[],
    features: FeatureVector,
  ): PlainFactor[] {
    return contributions
      .filter((c) => Math.abs(c.shapValue) > NEGLIGIBLE)
      .slice(0, TOP_FACTORS)
      .map((c, i) => ({
        feature: c.feature,
        shapValue: Number(c.shapValue.toFixed(6)),
        direction:
          c.shapValue >= 0
            ? FactorDirection.POSITIVE
            : FactorDirection.NEGATIVE,
        plainText: this.factorSentence(
          c.feature,
          c.shapValue >= 0,
          features[c.feature],
        ),
        rank: i + 1,
      }))
  }

  /**
   * Counterfactual tips on the biggest NEGATIVE drivers. Each candidate target is
   * a modest, reachable move (not "double your balance"), and a tip is dropped
   * entirely if re-running the model shows it would gain nothing — advice that
   * doesn't move the number is worse than no advice.
   */
  async toImprovements(
    contributions: readonly ContributionOut[],
    features: FeatureVector,
    baselineScore: number,
    ctx: {
      provider: InferenceProvider
      coverage: number
      modelVersion: string
    },
  ): Promise<PlainImprovement[]> {
    // Only features with an honest, reachable target are worth a model call.
    const candidates = contributions
      .filter((c) => c.shapValue < -NEGLIGIBLE)
      .slice(0, TOP_IMPROVEMENTS + 2)
      .map((c) => {
        const current = features[c.feature] ?? 0
        return { feature: c.feature, current, target: this.suggestTarget(c.feature, current) }
      })
      .filter(
        (c): c is { feature: ScoreFeature; current: number; target: number } =>
          c.target !== null && c.target !== c.current,
      )

    // Run the counterfactuals CONCURRENTLY. They are independent single-feature
    // interventions, so sequencing them bought nothing and cost real latency: over
    // the external runtime each is an HTTP round trip with an 8s timeout, so five
    // in series could keep a user waiting 40s for a screen that already has its
    // score. The in-process runtime is unaffected either way.
    const settled = await Promise.all(
      candidates.map(async (c) => ({
        ...c,
        result: await ctx.provider.counterfactual({
          features,
          coverage: ctx.coverage,
          modelVersion: ctx.modelVersion,
          feature: c.feature,
          targetValue: c.target,
        }),
      })),
    )

    const tips: PlainImprovement[] = []
    // Ordered by the original contribution ranking, not by whichever call
    // returned first — the biggest drag on the score should be the first tip.
    for (const c of settled) {
      if (tips.length >= TOP_IMPROVEMENTS) break
      if (!c.result.ok) {
        this.logger.warn('[toImprovements] Counterfactual failed — skipping tip', {
          feature: c.feature,
          error: c.result.error.message,
        })
        continue
      }

      const gain = c.result.value - baselineScore
      if (gain < 1) continue // no honest gain to promise

      tips.push({
        feature: c.feature,
        currentValue: Number(c.current.toFixed(4)),
        targetValue: Number(c.target.toFixed(4)),
        estimatedGain: Math.round(gain),
        plainText: this.tipSentence(c.feature, c.current, c.target),
        rank: tips.length + 1,
      })
    }
    return tips
  }

  // ── target selection ──────────────────────────────────────────────────────
  /**
   * A realistic next step per feature. Returns `null` where no honest advice
   * exists: nobody can un-bounce a past payment or fast-forward their history,
   * so those features get a coaching sentence but never a fake target.
   */
  private suggestTarget(
    feature: ScoreFeature,
    current: number,
  ): number | null {
    switch (feature) {
      case 'avg_balance':
        // +25%, floored so a near-empty account still gets a concrete number.
        return Math.max(Math.round(current * 1.25), current + 5_000)
      case 'balance_retention':
        return Math.min(1, Number((current + 0.15).toFixed(3)))
      case 'income_regularity':
        return Math.min(0.98, Number((current + 0.15).toFixed(3)))
      case 'obligation_ratio':
        return Math.max(0, Number((current - 0.1).toFixed(3)))
      case 'months_covered':
        // Actionable in the RIGHT way: link an OLDER account through M1 rather
        // than "wait three months".
        return current + 3
      case 'gst_filing_consistency':
        return Math.min(1, Number((current + 0.15).toFixed(3)))
      case 'monthly_inflow':
      case 'gst_turnover':
      case 'bounce_count':
        // Advising someone to earn more, or to not have bounced last November,
        // is not advice. These stay in the "why" panel only.
        return null
    }
  }

  // ── copy ──────────────────────────────────────────────────────────────────
  private factorSentence(
    feature: string,
    helped: boolean,
    value: number | null,
  ): string {
    const label = FEATURE_LABELS[feature as ScoreFeature] ?? feature
    const detail = this.valueDetail(feature as ScoreFeature, value)
    const verb = helped ? 'helped your score' : 'held your score back'
    return detail ? `${label} ${verb} — ${detail}.` : `${label} ${verb}.`
  }

  /** The specific number behind a factor, so the "why" is concrete, not generic. */
  private valueDetail(
    feature: ScoreFeature,
    value: number | null,
  ): string | null {
    if (value === null) return 'we had no data for this'
    switch (feature) {
      case 'monthly_inflow':
        return `${inr.format(value)} coming in per month`
      case 'avg_balance':
        return `${inr.format(value)} on average`
      case 'gst_turnover':
        return `${inr.format(value)} annual turnover`
      case 'income_regularity':
        return `${Math.round(value * 100)}% month-to-month consistency`
      case 'balance_retention':
        return `you kept ${Math.round(value * 100)}% of your peak balance`
      case 'obligation_ratio':
        return `${Math.round(value * 100)}% of your income goes out again`
      case 'months_covered':
        return `${Math.round(value)} month${Math.round(value) === 1 ? '' : 's'} of history`
      case 'bounce_count':
        return value === 0
          ? 'no failed payments'
          : `${Math.round(value)} failed payment${Math.round(value) === 1 ? '' : 's'}`
      case 'gst_filing_consistency':
        return `${Math.round(value * 100)}% of returns filed on time`
    }
  }

  private tipSentence(
    feature: ScoreFeature,
    current: number,
    target: number,
  ): string {
    switch (feature) {
      case 'avg_balance':
        return `Holding an average balance nearer ${inr.format(target)} (up from ${inr.format(current)}) would lift your score.`
      case 'balance_retention':
        return 'Leaving more of each month in the account instead of withdrawing it shows you can build a buffer.'
      case 'income_regularity':
        return 'More even month-to-month income — same amount, steadier timing — is the single strongest signal here.'
      case 'obligation_ratio':
        return `Bringing your outgoings down to about ${Math.round(target * 100)}% of what comes in (from ${Math.round(current * 100)}%) would ease your debt load.`
      case 'months_covered':
        return 'Linking an older account through the Account Aggregator adds history you already have — no waiting required.'
      case 'gst_filing_consistency':
        return 'Filing your remaining GST returns on time would strengthen your business record.'
      default:
        return 'Keeping your activity steady and consistent will improve this over time.'
    }
  }
}
