import {
  BAND_TIER_POLICY,
  BEHAVIOUR_NUDGE_SPAN_BPS,
  MAX_MULTIPLIER_BPS,
  MIN_MULTIPLIER_BPS,
} from '@/modules/insurance/insurance.config'
import {
  behaviourNudgeBps,
  computePremium,
  confidencePenaltyBps,
  effectiveMultiplierBps,
  frequencyFor,
  isAmountMismatch,
  lossRatioBps,
  remainingCoverMinor,
  savingsBps,
  tierCoverCeilingMinor,
} from '@/modules/insurance/insurance-pricing.util'

import { PremiumFrequency, RiskTier } from 'generated/prisma/client'

describe('insurance-pricing — the confidence gate', () => {
  it('penalises thin evidence and leaves strong evidence alone', () => {
    expect(confidencePenaltyBps(0.95)).toBe(0)
    expect(confidencePenaltyBps(0.75)).toBe(0)
    expect(confidencePenaltyBps(0.6)).toBe(1_500)
    expect(confidencePenaltyBps(0.3)).toBe(3_000)
  })

  it('treats a MISSING confidence as the worst bucket, not the best', () => {
    // M2 reports confidence on every score it computes, so an absent value means
    // something upstream did not answer. Pricing an unknown as though it were
    // certain is exactly the assumption that fills a book with unmeasured risk.
    expect(confidencePenaltyBps(null)).toBe(3_000)
    expect(confidencePenaltyBps(null)).toBe(confidencePenaltyBps(0))
  })
})

describe('insurance-pricing — the usage-based behaviour nudge', () => {
  it('lowers the premium for favourable behaviour', () => {
    // In M2 a POSITIVE shapValue pushes the score UP, so a positive contribution
    // on a favourable feature is good behaviour and must reduce the premium.
    expect(behaviourNudgeBps({ favourable: [0.8], adverse: [] })).toBeLessThan(
      0,
    )
  })

  it('raises it for adverse behaviour', () => {
    expect(
      behaviourNudgeBps({ favourable: [], adverse: [0.8] }),
    ).toBeGreaterThan(0)
  })

  it('returns zero when M2 reported none of the behaviour features', () => {
    expect(behaviourNudgeBps({ favourable: [], adverse: [] })).toBe(0)
  })

  it('clamps a single outlier so one extreme month cannot dominate a year', () => {
    // SHAP values are unbounded in margin space. Without the per-feature clamp a
    // single freak contribution would swing the whole term to its limit.
    const extreme = behaviourNudgeBps({ favourable: [50], adverse: [] })
    const atLimit = behaviourNudgeBps({ favourable: [1], adverse: [] })
    expect(extreme).toBe(atLimit)
    expect(Math.abs(extreme)).toBeLessThanOrEqual(BEHAVIOUR_NUDGE_SPAN_BPS)
  })

  it('stays inside the span for any input', () => {
    const worst = behaviourNudgeBps({
      favourable: [-1, -1],
      adverse: [1, 1],
    })
    const best = behaviourNudgeBps({ favourable: [1, 1], adverse: [-1, -1] })
    expect(worst).toBe(BEHAVIOUR_NUDGE_SPAN_BPS)
    expect(best).toBe(-BEHAVIOUR_NUDGE_SPAN_BPS)
  })

  it('uses the MEAN, so more reported features is not itself a penalty', () => {
    // A sum would make the term depend on how many features happened to be in a
    // score's factor list — a data-completeness penalty wearing a behaviour label,
    // and precisely the kind of proxy M2's fairness audit exists to catch.
    const one = behaviourNudgeBps({ favourable: [0.5], adverse: [] })
    const two = behaviourNudgeBps({ favourable: [0.5, 0.5], adverse: [] })
    expect(two).toBe(one)
  })
})

describe('insurance-pricing — the effective multiplier', () => {
  it('adds the band, the confidence penalty and the behaviour term', () => {
    const result = effectiveMultiplierBps({
      bandBps: 10_000,
      confidencePenaltyBps: 1_500,
      behaviourBps: -500,
    })
    expect(result.effectiveBps).toBe(11_000)
    expect(result.clamped).toBe(false)
  })

  it('clamps at the floor and REPORTS it', () => {
    // A quote that hit the floor was priced by the floor, not by the applicant's
    // behaviour, and an actuary reviewing the book needs to know which happened.
    const result = effectiveMultiplierBps({
      bandBps: 7_000,
      confidencePenaltyBps: 0,
      behaviourBps: -5_000,
    })
    expect(result.effectiveBps).toBe(MIN_MULTIPLIER_BPS)
    expect(result.clamped).toBe(true)
  })

  it('clamps at the ceiling and REPORTS it', () => {
    const result = effectiveMultiplierBps({
      bandBps: 14_000,
      confidencePenaltyBps: 3_000,
      behaviourBps: 5_000,
    })
    expect(result.effectiveBps).toBe(MAX_MULTIPLIER_BPS)
    expect(result.clamped).toBe(true)
  })

  it('never prices below the floor for any band in the policy table', () => {
    for (const policy of Object.values(BAND_TIER_POLICY)) {
      if (policy.tier === RiskTier.DECLINE) continue
      const result = effectiveMultiplierBps({
        bandBps: policy.multiplierBps,
        confidencePenaltyBps: 0,
        behaviourBps: -BEHAVIOUR_NUDGE_SPAN_BPS,
      })
      expect(result.effectiveBps).toBeGreaterThanOrEqual(MIN_MULTIPLIER_BPS)
    }
  })
})

describe('insurance-pricing — the premium', () => {
  /** ₹20,000 of cover, in paise. */
  const COVER = 2_000_000n

  it('computes an annual premium as coverage × baseRate × multiplier', () => {
    // 9% of ₹20,000 at 1.0× = ₹1,800/year = 180000 paise.
    const quote = computePremium({
      coverageMinor: COVER,
      baseRateBps: 900,
      multiplierBps: 10_000,
      termDays: 365,
    })
    expect(quote.annualPremiumMinor).toBe(180_000n)
    expect(quote.frequency).toBe(PremiumFrequency.MONTHLY)
    // ₹150/month.
    expect(quote.premiumMinor).toBe(15_000n)
  })

  it('divides ONCE, so a 350bps rate is not rounded to an integer rate first', () => {
    // The classic bug is `coverage * (baseRate/10000) * (mult/10000)`, which
    // truncates each rate before use and is wrong by a factor, not by paise.
    const quote = computePremium({
      coverageMinor: 1_000_000n,
      baseRateBps: 350,
      multiplierBps: 8_500,
      termDays: 365,
    })
    // 1_000_000 × 350 × 8500 / 1e8 = 29_750 exactly.
    expect(quote.annualPremiumMinor).toBe(29_750n)
  })

  it('gives a PREFERRED applicant a materially lower premium than STANDARD', () => {
    // The product's entire pitch, as an assertion.
    const preferred = computePremium({
      coverageMinor: COVER,
      baseRateBps: 900,
      multiplierBps: BAND_TIER_POLICY.EXCELLENT.multiplierBps,
      termDays: 365,
    })
    const standard = computePremium({
      coverageMinor: COVER,
      baseRateBps: 900,
      multiplierBps: BAND_TIER_POLICY.GOOD.multiplierBps,
      termDays: 365,
    })

    expect(preferred.premiumMinor).toBeLessThan(standard.premiumMinor)
    // 0.70× — a 30% discount, so the saving is legible on a monthly premium.
    expect(savingsBps(preferred.premiumMinor, standard.premiumMinor)).toBe(
      3_000,
    )
  })

  it('charges a SUBSTANDARD applicant more, and reports it as a negative saving', () => {
    const substandard = computePremium({
      coverageMinor: COVER,
      baseRateBps: 900,
      multiplierBps: BAND_TIER_POLICY.FAIR.multiplierBps,
      termDays: 365,
    })
    const standard = computePremium({
      coverageMinor: COVER,
      baseRateBps: 900,
      multiplierBps: BAND_TIER_POLICY.GOOD.multiplierBps,
      termDays: 365,
    })
    expect(savingsBps(substandard.premiumMinor, standard.premiumMinor)).toBe(
      -3_000,
    )
  })

  it('rounds UP, so cover is never sold below its priced value', () => {
    // A premium rounded down is funded from the float — the account that has to
    // pay the claims.
    const quote = computePremium({
      coverageMinor: 101n,
      baseRateBps: 900,
      multiplierBps: 10_000,
      termDays: 365,
    })
    // 101 × 900 / 10000 = 9.09 → 10.
    expect(quote.annualPremiumMinor).toBe(10n)
  })

  it('pro-rates a short-term product instead of charging a full year', () => {
    // Without pro-rating, a 30-day travel policy would cost the same as a year of
    // accident cover — a 12× overcharge on the product most likely to be bought
    // impulsively before a flight.
    const travel = computePremium({
      coverageMinor: 100_000n,
      baseRateBps: 1_200,
      multiplierBps: 10_000,
      termDays: 30,
    })
    expect(travel.frequency).toBe(PremiumFrequency.ONE_TIME)
    // 100_000 × 1200 / 10000 = 12_000/year; × 30/365 = 986.30… → 987.
    expect(travel.annualPremiumMinor).toBe(12_000n)
    expect(travel.premiumMinor).toBe(987n)
    expect(travel.premiumMinor).toBeLessThan(travel.annualPremiumMinor)
  })

  it('picks the frequency from the term, not from the product type', () => {
    // A monthly premium on a 30-day policy would bill after the cover had ended.
    expect(frequencyFor(30)).toBe(PremiumFrequency.ONE_TIME)
    expect(frequencyFor(90)).toBe(PremiumFrequency.ONE_TIME)
    expect(frequencyFor(365)).toBe(PremiumFrequency.MONTHLY)
  })

  it('refuses nonsensical inputs rather than producing a plausible number', () => {
    expect(() =>
      computePremium({
        coverageMinor: 0n,
        baseRateBps: 900,
        multiplierBps: 10_000,
        termDays: 365,
      }),
    ).toThrow(/coverage/)
    expect(() =>
      computePremium({
        coverageMinor: 100n,
        baseRateBps: 0,
        multiplierBps: 10_000,
        termDays: 365,
      }),
    ).toThrow(/baseRateBps/)
    expect(() =>
      computePremium({
        coverageMinor: 100n,
        baseRateBps: 900,
        multiplierBps: 0,
        termDays: 365,
      }),
    ).toThrow(/multiplierBps/)
  })
})

describe('insurance-pricing — the coverage ceiling', () => {
  const MAX = 5_000_000n

  it('lets PREFERRED and STANDARD buy the full product maximum', () => {
    expect(tierCoverCeilingMinor(RiskTier.PREFERRED, MAX)).toBe(MAX)
    expect(tierCoverCeilingMinor(RiskTier.STANDARD, MAX)).toBe(MAX)
  })

  it('halves the ceiling for SUBSTANDARD', () => {
    // The one adverse-selection control whose input the applicant chooses, which
    // is exactly why it needs a server-side cap.
    expect(tierCoverCeilingMinor(RiskTier.SUBSTANDARD, MAX)).toBe(2_500_000n)
  })

  it('gives DECLINE no cover at all', () => {
    expect(tierCoverCeilingMinor(RiskTier.DECLINE, MAX)).toBe(0n)
  })

  it('rounds a ceiling DOWN — a ceiling rounded up is a ceiling exceeded', () => {
    expect(tierCoverCeilingMinor(RiskTier.SUBSTANDARD, 101n)).toBe(50n)
  })
})

describe('insurance-pricing — aggregate cover', () => {
  it('subtracts what has already been paid out', () => {
    // Two claims of ₹8,000 against ₹10,000 of cover must not both pay in full.
    // Checking each claim against the sum insured in isolation is how that happens.
    expect(
      remainingCoverMinor({
        coverageMinor: 1_000_000n,
        claimedMinor: 800_000n,
      }),
    ).toBe(200_000n)
  })

  it('clamps an exhausted policy at zero rather than going negative', () => {
    expect(
      remainingCoverMinor({
        coverageMinor: 1_000_000n,
        claimedMinor: 1_200_000n,
      }),
    ).toBe(0n)
  })
})

describe('insurance-pricing — the document amount mismatch signal', () => {
  it('flags a claim for materially more than the document supports', () => {
    expect(
      isAmountMismatch({
        claimedMinor: 1_000_000n,
        extractedMinor: 500_000n,
        toleranceBps: 500,
      }),
    ).toBe(true)
  })

  it('tolerates a small difference — a co-pay, a rounding, an excluded line', () => {
    expect(
      isAmountMismatch({
        claimedMinor: 1_000_000n,
        extractedMinor: 960_000n,
        toleranceBps: 500,
      }),
    ).toBe(false)
  })

  it('is one-directional: asking for LESS than the document is not a signal', () => {
    expect(
      isAmountMismatch({
        claimedMinor: 500_000n,
        extractedMinor: 1_000_000n,
        toleranceBps: 500,
      }),
    ).toBe(false)
  })
})

describe('insurance-pricing — the loss ratio', () => {
  it('computes basis points exactly, in integers', () => {
    // 4,000bps = 40%: a healthy book.
    expect(lossRatioBps(400_000n, 1_000_000n)).toBe(4_000)
    // Over 100% — claims have outrun premiums, and it must be reportable.
    expect(lossRatioBps(1_500_000n, 1_000_000n)).toBe(15_000)
  })

  it('returns null on an empty book, NOT zero', () => {
    // A book with no premiums has no loss ratio. Reporting 0% would read as a
    // perfectly performing product that has simply never sold anything.
    expect(lossRatioBps(0n, 0n)).toBeNull()
    expect(lossRatioBps(500n, 0n)).toBeNull()
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    // `Number(paid) / Number(earned)` is the obvious version and it loses
    // precision silently on a real book's cumulative totals.
    const earned = 9_007_199_254_740_993n * 100n
    const paid = earned / 2n
    expect(lossRatioBps(paid, earned)).toBe(5_000)
  })
})
