import { PremiumFrequency, RiskTier } from 'generated/prisma/client'

import {
  BEHAVIOUR_NUDGE_SPAN_BPS,
  CONFIDENCE_PENALTY_BPS,
  MAX_MULTIPLIER_BPS,
  MIN_MULTIPLIER_BPS,
  TIER_COVER_CEILING_BPS,
} from '@/modules/insurance/insurance.config'
import { BPS_SCALE, mulDivRound } from '@/modules/payments/money.util'

/**
 * The premium formula. PURE — no I/O, no dates, no randomness.
 *
 * Every rupee a policyholder is charged comes out of this file, which is the
 * point: "why is my premium this number?" becomes a unit test over integers
 * rather than something only observable by buying a policy.
 *
 * Two rules govern it, and both are inherited from M4 rather than invented here:
 *
 *  1. **Integer minor units, all the way down.** The rate is basis points, the
 *     multiplier is basis points, and the division happens ONCE at the end
 *     through `mulDivRound`. The tempting version —
 *     `coverage * (baseRate/10000) * (mult/10000)` — rounds each rate to an
 *     integer before using it, and on a 350bps base rate that is a premium wrong
 *     by a factor, not by paise.
 *  2. **Rounding is a policy with a direction.** Premiums round UP and payouts
 *     round DOWN, always in the direction that does not create money the book has
 *     not received. Each call site below states its mode and its reason; there is
 *     no default, because a default would mean the direction of the half-paisa is
 *     decided by whoever wrote the call last.
 */

// ── the multiplier ──────────────────────────────────────────────────────────
/** How the effective multiplier was arrived at, for the quote's audit blob. */
export interface MultiplierBreakdown {
  /** The band's own multiplier, before adjustment. */
  bandBps: number
  /** Added because the score's confidence was low. Never negative. */
  confidencePenaltyBps: number
  /** The usage-based behaviour term. Negative LOWERS the premium. */
  behaviourBps: number
  /** The final, clamped multiplier actually applied. */
  effectiveBps: number
  /** True when a clamp bound the result — the quote says so, honestly. */
  clamped: boolean
}

/**
 * The confidence penalty for a score's reported confidence.
 *
 * A missing confidence is treated as the WORST bucket rather than the best. M2
 * reports confidence on every score it computes, so an absent value means
 * something upstream did not answer — and pricing an unknown as though it were
 * certain is precisely the assumption that fills a book with unmeasured risk.
 */
export function confidencePenaltyBps(confidence: number | null): number {
  const value = confidence ?? 0
  for (const rule of CONFIDENCE_PENALTY_BPS) {
    if (value < rule.below) return rule.penaltyBps
  }
  return 0
}

/**
 * The usage-based behaviour term, in basis points.
 *
 * Takes SHAP contributions from M2 — the same numbers that produced the user's
 * "why this score" explanation — so the premium and the explanation cannot tell
 * two different stories about one month of data.
 *
 * A FAVOURABLE contribution lowers the premium and an ADVERSE one raises it, and
 * the net is scaled into `±BEHAVIOUR_NUDGE_SPAN_BPS`. The contributions are
 * clamped to `[-1, +1]` individually first: a single outlier feature must not be
 * able to swing the whole term, because SHAP values are unbounded in margin space
 * and one extreme month would otherwise dominate a year of behaviour.
 */
export function behaviourNudgeBps(params: {
  favourable: number[]
  adverse: number[]
}): number {
  const clamp = (value: number): number => Math.max(-1, Math.min(1, value))

  const favourableSum = params.favourable.reduce(
    (total, value) => total + clamp(value),
    0,
  )
  const adverseSum = params.adverse.reduce(
    (total, value) => total + clamp(value),
    0,
  )

  const considered = params.favourable.length + params.adverse.length
  if (considered === 0) return 0

  /**
   * The mean, not the sum.
   *
   * A sum would make the term depend on HOW MANY features happened to be present
   * in a score's factor list — so a user with more complete data would be nudged
   * harder in whichever direction their features pointed, purely because there
   * were more of them. That is a data-completeness penalty wearing a behaviour
   * label, and it is exactly the kind of proxy the M2 fairness audit exists to
   * catch.
   */
  const net = (adverseSum - favourableSum) / considered
  return Math.round(net * BEHAVIOUR_NUDGE_SPAN_BPS)
}

/**
 * Assemble and clamp the effective multiplier.
 *
 * Clamped at both ends, and the clamp is REPORTED rather than silent. A quote
 * that hit the floor was priced by the floor, not by the applicant's behaviour,
 * and an actuary reviewing the book needs to know which of the two happened.
 */
export function effectiveMultiplierBps(params: {
  bandBps: number
  confidencePenaltyBps: number
  behaviourBps: number
}): MultiplierBreakdown {
  const raw = params.bandBps + params.confidencePenaltyBps + params.behaviourBps
  const effectiveBps = Math.max(
    MIN_MULTIPLIER_BPS,
    Math.min(MAX_MULTIPLIER_BPS, raw),
  )

  return {
    bandBps: params.bandBps,
    confidencePenaltyBps: params.confidencePenaltyBps,
    behaviourBps: params.behaviourBps,
    effectiveBps,
    clamped: effectiveBps !== raw,
  }
}

// ── the premium ─────────────────────────────────────────────────────────────
export interface PremiumQuote {
  /** What one period of `frequency` costs. */
  premiumMinor: bigint
  /** The annual cost, before the frequency split. For the receipt's breakdown. */
  annualPremiumMinor: bigint
  frequency: PremiumFrequency
  /** The effective annual rate actually charged, in bps of coverage. */
  effectiveAnnualBps: number
}

/**
 * How often a product's premium is collected.
 *
 * A term product (travel) is ONE_TIME because the cover is a single trip: a
 * monthly premium on a fourteen-day policy would bill somebody after the cover
 * ended. The two continuing products are MONTHLY because a daily-wage earner
 * cannot pre-pay a year of cover — and a product priced annually for this
 * population is a product they do not buy.
 */
export function frequencyFor(termDays: number): PremiumFrequency {
  return termDays <= 90 ? PremiumFrequency.ONE_TIME : PremiumFrequency.MONTHLY
}

/**
 * `premium = coverage × baseRateBps × multiplierBps / 1e8`, then split by
 * frequency.
 *
 * One `mulDivRound` for the two rates together, so the intermediate keeps full
 * precision. Rounded UP, because a premium rounded down is cover sold for
 * fractionally less than it was priced at, and across a book that shortfall is
 * funded from the float — the account that has to pay the claims.
 *
 * The monthly split rounds UP for the same reason and creates a knowable
 * artefact: twelve monthly premiums can exceed the annual figure by up to eleven
 * minor units. That is stated rather than hidden, and it is the correct direction
 * — the alternative rounds each of twelve collections down and leaves the book
 * short on every policy.
 */
export function computePremium(params: {
  coverageMinor: bigint
  baseRateBps: number
  multiplierBps: number
  termDays: number
}): PremiumQuote {
  const { coverageMinor, baseRateBps, multiplierBps, termDays } = params

  if (coverageMinor <= 0n) {
    throw new Error('computePremium: coverage must be positive')
  }
  if (!Number.isInteger(baseRateBps) || baseRateBps <= 0) {
    throw new Error('computePremium: baseRateBps must be a positive integer')
  }
  if (!Number.isInteger(multiplierBps) || multiplierBps <= 0) {
    throw new Error('computePremium: multiplierBps must be a positive integer')
  }

  // coverage × baseBps × multBps / (10_000 × 10_000). A single division.
  const annualPremiumMinor = mulDivRound(
    coverageMinor,
    BigInt(baseRateBps) * BigInt(multiplierBps),
    BPS_SCALE * BPS_SCALE,
    'UP',
  )

  const frequency = frequencyFor(termDays)
  const premiumMinor =
    frequency === PremiumFrequency.MONTHLY
      ? mulDivRound(annualPremiumMinor, 1n, 12n, 'UP')
      : /**
         * A term product is charged pro-rata for the days it actually covers, not
         * a full year's premium.
         *
         * Without this, a fourteen-day travel policy would cost the same as a
         * year of accident cover — which is not a rounding problem, it is a 26×
         * overcharge on the product most likely to be bought impulsively at an
         * airport.
         */
        mulDivRound(annualPremiumMinor, BigInt(termDays), 365n, 'UP')

  return {
    premiumMinor,
    annualPremiumMinor,
    frequency,
    effectiveAnnualBps: Math.round((baseRateBps * multiplierBps) / 10_000),
  }
}

/**
 * The coverage ceiling a tier permits, as an amount.
 *
 * Rounded DOWN — a ceiling rounded up is a ceiling exceeded. Applied against the
 * product's own maximum so the tier cap is always a restriction of the catalogue,
 * never an expansion of it.
 */
export function tierCoverCeilingMinor(
  tier: RiskTier,
  productMaxCoverMinor: bigint,
): bigint {
  const ceilingBps = TIER_COVER_CEILING_BPS[tier] ?? 0
  if (ceilingBps <= 0) return 0n
  if (ceilingBps >= 10_000) return productMaxCoverMinor
  return mulDivRound(
    productMaxCoverMinor,
    BigInt(ceilingBps),
    BPS_SCALE,
    'DOWN',
  )
}

/**
 * How much cheaper (or dearer) this premium is than a standard-risk one, in bps.
 *
 * Positive means a DISCOUNT. This is the product's entire pitch rendered as one
 * integer — "because of your Pravaah reputation you pay 15% less than a standard
 * applicant" — so it is computed once, here, from the two premiums that were
 * actually quoted rather than re-derived on a screen from a multiplier.
 */
export function savingsBps(
  premiumMinor: bigint,
  standardPremiumMinor: bigint,
): number {
  if (standardPremiumMinor <= 0n) return 0
  const difference = standardPremiumMinor - premiumMinor
  const negative = difference < 0n
  const magnitude = negative ? -difference : difference

  const bps = Number(
    mulDivRound(magnitude, BPS_SCALE, standardPremiumMinor, 'DOWN'),
  )
  return negative ? -bps : bps
}

/**
 * The remaining cover on a policy.
 *
 * An AGGREGATE limit, not a per-claim one. Two claims of ₹8,000 each against
 * ₹10,000 of cover must not both pay in full, and checking each claim against the
 * sum insured in isolation is exactly how that happens. Clamped at zero rather
 * than throwing, because a policy whose cover is exhausted is an ordinary state
 * that the claims service refuses politely.
 */
export function remainingCoverMinor(policy: {
  coverageMinor: bigint
  claimedMinor: bigint
}): bigint {
  const remaining = policy.coverageMinor - policy.claimedMinor
  return remaining > 0n ? remaining : 0n
}

/**
 * Whether an extracted document amount materially understates the claim.
 *
 * `extracted < claimed − tolerance`. The tolerance exists because a bill total
 * and a claimed amount legitimately differ — a co-pay, a line item the claimant
 * excluded, a rounding at the hospital's till. Asking for materially MORE than
 * the document supports is the signal; asking for less is not, which is why the
 * comparison is one-directional.
 */
export function isAmountMismatch(params: {
  claimedMinor: bigint
  extractedMinor: bigint
  toleranceBps: number
}): boolean {
  const { claimedMinor, extractedMinor, toleranceBps } = params
  const tolerance = mulDivRound(
    claimedMinor,
    BigInt(toleranceBps),
    BPS_SCALE,
    'UP',
  )
  return extractedMinor + tolerance < claimedMinor
}

/**
 * The loss ratio, as a percentage with two decimal places, computed in integers.
 *
 * `Number(paid) / Number(earned)` is the obvious version and it is wrong for the
 * reason this whole module avoids floats: both operands are BigInts that can
 * exceed `Number.MAX_SAFE_INTEGER` on a real book, and the conversion is silent.
 * Returning basis points keeps it exact and lets the caller format it.
 *
 * `null` when nothing has been earned — NOT zero and not infinity. A book with no
 * premiums has no loss ratio, and reporting `0%` on it would read as a perfectly
 * performing product that has simply never sold anything.
 */
export function lossRatioBps(
  paidMinor: bigint,
  earnedMinor: bigint,
): number | null {
  if (earnedMinor <= 0n) return null
  return Number(mulDivRound(paidMinor, BPS_SCALE, earnedMinor, 'HALF_UP'))
}
