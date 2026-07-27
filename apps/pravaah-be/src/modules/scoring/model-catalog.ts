import type {
  BandsDto,
  FeatureSchemaDto,
  ScorecardParamsDto,
  ScoreFeature,
} from '@pravaah/schema'

import { DEFAULT_BANDS, FEATURE_KEYS } from '@/modules/scoring/scoring.state'

/**
 * The shipped model catalogue — three registered versions so drift, rollback,
 * and the fairness activation gate are all demonstrable rather than theoretical
 * (M2 §7 training note).
 *
 * Why the weights live in code rather than a `.joblib`: the `scorecard` runtime
 * is an ADDITIVE model, so its parameters ARE the model. Keeping them in version
 * control means every score PRAVAAH has ever issued can be recomputed from
 * `inputsHash` + `version` with no binary artefact to lose — which is precisely
 * the reproducibility claim M2 §15 makes. The `fastapi` runtime keeps its
 * gradient-boosted model in `apps/ml/models/` and only the feature ORDER here.
 */

/** Human labels for every feature. Used by explanations and the admin console. */
export const FEATURE_LABELS: Record<ScoreFeature, string> = {
  monthly_inflow: 'Monthly money coming in',
  income_regularity: 'Regularity of your income',
  avg_balance: 'Average account balance',
  balance_retention: 'How well you retain savings',
  obligation_ratio: 'Your debt-to-income load',
  months_covered: 'Length of financial history',
  bounce_count: 'Bounced or failed payments',
  gst_turnover: 'Business turnover (GST)',
  gst_filing_consistency: 'GST filing consistency',
}

/** Which features a business (GST) file supplies — absent for a salaried user. */
export const OPTIONAL_FEATURES: ReadonlySet<ScoreFeature> = new Set<ScoreFeature>(
  ['gst_turnover', 'gst_filing_consistency'],
)

export const DEFAULT_FEATURE_SCHEMA: FeatureSchemaDto = {
  features: FEATURE_KEYS.map((name) => ({
    name,
    dtype: name === 'months_covered' || name === 'bounce_count' ? 'int' : 'float',
    optional: OPTIONAL_FEATURES.has(name),
  })),
}

export const DEFAULT_BANDS_JSON: BandsDto = DEFAULT_BANDS.map((b) => ({
  min: b.min,
  max: b.max,
  band: b.band,
}))

/**
 * v1.0.0 — the production scorecard.
 *
 * `weights` are relative feature importances on the logit scale; `reference` is
 * the population-typical RAW value each contribution is measured against (so
 * `base_value` is literally "the score of a typical file"); `calibration`
 * Platt-scales the log-odds so the population lands mid-scale instead of piling
 * up at the ceiling. Separating calibration from weights means re-centring the
 * score distribution never silently rewrites feature importances.
 *
 * Reference profile → 600 (FAIR), by construction: the intercept is set to
 * −Σwᵢ·tᵢ(refᵢ) so a population-typical file lands exactly mid-scale. The seeded
 * demo file (12 months of regular salary, one bounce) → 732 GOOD on bank data
 * alone, 779 VERY_GOOD once its GST filing record is included.
 *
 * ## Why wealth and tenure are capped at ~22% of the weight
 *
 * This split is a FAIRNESS decision the audit forced, twice.
 *
 * An early version weighted `months_covered` at 0.90. The fairness audit failed
 * it on `age_band` — 18–25 approval near zero — even though the model never sees
 * an age. Cutting that weight moved the failure to `avg_balance`, because savings
 * proxy age just as well. The lesson generalises: **every wealth-or-tenure feature
 * is an age proxy**, so they have to be capped together, not swapped one for
 * another. The mitigation applied is the one named in the admin fairness report
 * ("drop proxy features"), and the freed weight went onto behaviour a 22-year-old
 * can demonstrate as readily as a 50-year-old.
 *
 * This is also the entire premise of PRAVAAH: if accumulated wealth and tenure
 * dominate the score, thin-file users cannot be scored at all, and there was no
 * point building an alternative-data engine. `scripts/verify-scoring.ts` asserts
 * the resulting split holds.
 */
export const SCORECARD_V1: ScorecardParamsDto = {
  intercept: -3.43,
  weights: {
    // BEHAVIOUR — 67% of the total weight. Things a 22-year-old can demonstrate
    // as well as a 50-year-old.
    income_regularity: 1.55,
    obligation_ratio: 1.35,
    balance_retention: 1.05,
    bounce_count: 0.85,
    // WEALTH AND TENURE — 22%. Every one of these proxies age, so they are
    // capped, together, at roughly a fifth of the score.
    monthly_inflow: 0.6,
    avg_balance: 0.55,
    months_covered: 0.4,
    // BUSINESS RECORD — optional; absent for a salaried file at zero cost.
    gst_filing_consistency: 0.45,
    gst_turnover: 0.35,
  },
  reference: {
    monthly_inflow: 45_000,
    income_regularity: 0.7,
    avg_balance: 45_000,
    balance_retention: 0.55,
    obligation_ratio: 0.8,
    months_covered: 8,
    bounce_count: 0.3,
    // Most files have no GST at all, so the reference is zero: a missing
    // business record then contributes EXACTLY nothing — it neither flatters a
    // salaried user nor penalises them for not running a business.
    gst_turnover: 0,
    gst_filing_consistency: 0,
  },
  transforms: {
    monthly_inflow: { kind: 'logScale', scale: 20_000, cap: 250_000 },
    avg_balance: { kind: 'logScale', scale: 25_000, cap: 500_000 },
    gst_turnover: { kind: 'logScale', scale: 500_000, cap: 20_000_000 },
    // Regularity below 0.3 is noise, above 0.98 is indistinguishable from
    // perfect — squeezing the ends stops a synthetic-looking file from
    // out-scoring a real one on this alone.
    income_regularity: { kind: 'clamp', lo: 0.3, hi: 0.98 },
    balance_retention: { kind: 'clamp', lo: 0, hi: 1 },
    gst_filing_consistency: { kind: 'clamp', lo: 0, hi: 1 },
    // Saturating, NOT linear — and this is a fairness decision, not a modelling
    // nicety. History depth is the strongest age PROXY in the vector (you cannot
    // hold 24 months of history at 19), so a linear 0→24 ramp hands a young
    // applicant a penalty they cannot ever pay off. Diminishing returns match
    // reality anyway: six clean months carry most of the signal, and the step
    // from 18 to 24 months carries almost none. The fairness audit found this by
    // failing v1.0.0 on `age_band` before this change.
    months_covered: { kind: 'logScale', scale: 4, cap: 24 },
    obligation_ratio: { kind: 'inverse', worst: 1.2 },
    bounce_count: { kind: 'inverse', worst: 6 },
  },
  // `a` sets how wide the population spreads across the 300–900 scale. Too small
  // and everyone lands inside one band, which turns every band cutoff into a
  // knife-edge where a few points of systematic difference become a total
  // approval/rejection split — that alone can fail a fairness audit on an
  // otherwise reasonable model. `b` shifts the whole distribution; the intercept
  // already centres the reference profile at 600, so it stays 0.
  calibration: { a: 0.65, b: 0 },
}

/**
 * v0.9.0 — the PREVIOUS generation, kept registered so rollback is a real
 * operation with a real target. It leans hard on `avg_balance` and barely looks
 * at trend features, which is exactly the design M2 §12 argues against: a
 * balance-heavy model is the one you can game by parking money. It is retained
 * as the cautionary exhibit, and its fairness report is expected to fail.
 */
export const SCORECARD_V0_9: ScorecardParamsDto = {
  intercept: -2.6,
  weights: {
    avg_balance: 2.4,
    monthly_inflow: 1.5,
    obligation_ratio: 0.6,
    months_covered: 0.3,
    income_regularity: 0.3,
    balance_retention: 0.1,
    bounce_count: 0.4,
    gst_turnover: 0.2,
    gst_filing_consistency: 0.1,
  },
  reference: {
    monthly_inflow: 45_000,
    income_regularity: 0.7,
    avg_balance: 45_000,
    balance_retention: 0.55,
    obligation_ratio: 0.8,
    months_covered: 8,
    bounce_count: 0.3,
    gst_turnover: 0,
    gst_filing_consistency: 0,
  },
  transforms: SCORECARD_V1.transforms,
  calibration: { a: 0.42, b: 0 },
}

/**
 * v1.1.0 — the candidate. Same shape as v1.0.0 with more weight on retention and
 * bounces. Registered but NOT fairness-audited, so trying to activate it is what
 * demonstrates the gate (M2 §11): activation is refused until an audit passes.
 */
export const SCORECARD_V1_1: ScorecardParamsDto = {
  ...SCORECARD_V1,
  intercept: -3.42,
  weights: {
    ...SCORECARD_V1.weights,
    balance_retention: 1.05,
    bounce_count: 0.95,
    avg_balance: 0.65,
  },
}

export interface CatalogEntry {
  name: string
  version: string
  runtime: 'scorecard' | 'fastapi'
  scorecard: ScorecardParamsDto | null
  trainedAt: string
  datasetRef: string
  notes: string
}

export const MODEL_CATALOG: readonly CatalogEntry[] = [
  {
    name: 'pravaah-credit',
    version: '0.9.0',
    runtime: 'scorecard',
    scorecard: SCORECARD_V0_9,
    trainedAt: '2026-03-02T00:00:00+05:30',
    datasetRef: 'synthetic-v0.9 (30k rows, balance-weighted)',
    notes:
      'Legacy balance-weighted model. Retained as a rollback target and as the ' +
      'worked example of a gameable design.',
  },
  {
    name: 'pravaah-credit',
    version: '1.0.0',
    runtime: 'scorecard',
    scorecard: SCORECARD_V1,
    trainedAt: '2026-06-18T00:00:00+05:30',
    datasetRef: 'synthetic-v1.0 (50k rows, trend-weighted, group-balanced)',
    notes:
      'Trend-weighted scorecard. Contributions are exact Shapley values because ' +
      'the model is additive.',
  },
  {
    name: 'pravaah-credit',
    version: '1.1.0',
    runtime: 'scorecard',
    scorecard: SCORECARD_V1_1,
    trainedAt: '2026-07-20T00:00:00+05:30',
    datasetRef: 'synthetic-v1.1 (50k rows, retention-weighted)',
    notes:
      'Candidate: heavier retention/bounce weighting. Not yet fairness-audited — ' +
      'activation is blocked until it is.',
  },
]
