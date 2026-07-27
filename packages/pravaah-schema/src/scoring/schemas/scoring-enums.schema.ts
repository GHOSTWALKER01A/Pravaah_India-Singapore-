import { z } from 'zod'

/**
 * M2 · Reputation Engine enums. Each mirrors a Prisma enum so the RN app, admin
 * console, and backend validate against one source of truth.
 */

/** Score lifecycle. Mirrors the Prisma `ScoreStatus` enum. */
export const SCORE_STATUS = {
  PENDING: 'PENDING',
  COMPUTED: 'COMPUTED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  OVERRIDDEN: 'OVERRIDDEN',
} as const

export const ScoreStatusSchema = z.enum([
  SCORE_STATUS.PENDING,
  SCORE_STATUS.COMPUTED,
  SCORE_STATUS.EXPIRED,
  SCORE_STATUS.FAILED,
  SCORE_STATUS.INSUFFICIENT_DATA,
  SCORE_STATUS.OVERRIDDEN,
])
export type ScoreStatusInput = z.infer<typeof ScoreStatusSchema>

/** Score band. Cutoffs travel with the M3 credential so a foreign lender can read it. */
export const SCORE_BAND = {
  POOR: 'POOR',
  FAIR: 'FAIR',
  GOOD: 'GOOD',
  VERY_GOOD: 'VERY_GOOD',
  EXCELLENT: 'EXCELLENT',
} as const

export const ScoreBandSchema = z.enum([
  SCORE_BAND.POOR,
  SCORE_BAND.FAIR,
  SCORE_BAND.GOOD,
  SCORE_BAND.VERY_GOOD,
  SCORE_BAND.EXCELLENT,
])
export type ScoreBandInput = z.infer<typeof ScoreBandSchema>

/** Whether a factor helped or hurt the score. */
export const FACTOR_DIRECTION = {
  POSITIVE: 'POSITIVE',
  NEGATIVE: 'NEGATIVE',
} as const

export const FactorDirectionSchema = z.enum([
  FACTOR_DIRECTION.POSITIVE,
  FACTOR_DIRECTION.NEGATIVE,
])
export type FactorDirectionInput = z.infer<typeof FactorDirectionSchema>

/**
 * Which runtime serves a model version.
 *  - `scorecard` — in-process additive model; contributions are EXACT Shapley
 *    values (an additive model's Shapley value is its centred partial score).
 *  - `fastapi`   — external XGBoost + TreeSHAP service (`apps/ml`).
 */
export const MODEL_RUNTIME = {
  SCORECARD: 'scorecard',
  FASTAPI: 'fastapi',
} as const

export const ModelRuntimeSchema = z.enum([
  MODEL_RUNTIME.SCORECARD,
  MODEL_RUNTIME.FASTAPI,
])
export type ModelRuntimeInput = z.infer<typeof ModelRuntimeSchema>

/** Fairness metrics computed per protected group. */
export const FAIRNESS_METRIC = {
  DISPARATE_IMPACT: 'disparate_impact',
  DEMOGRAPHIC_PARITY: 'demographic_parity',
  EQUAL_OPPORTUNITY: 'equal_opportunity',
} as const

export const FairnessMetricSchema = z.enum([
  FAIRNESS_METRIC.DISPARATE_IMPACT,
  FAIRNESS_METRIC.DEMOGRAPHIC_PARITY,
  FAIRNESS_METRIC.EQUAL_OPPORTUNITY,
])
export type FairnessMetricInput = z.infer<typeof FairnessMetricSchema>

/**
 * The ordered feature vector the model consumes. NO protected attributes — by
 * construction, not by convention. The order is the contract between the
 * feature assembler and every runtime; changing it is a new model version.
 */
export const SCORE_FEATURES = [
  // Deliberately a MONTHLY RATE, not the raw window total the M2 spec's §6 table
  // named `total_inflow`. A sum over a variable-length data range is not
  // comparable between users and silently double-counts `months_covered`: the
  // same salary over six months looks like a third of the income it does over
  // eighteen. The fairness audit surfaced this as an age disparity, because
  // younger applicants have shorter windows. A monthly rate is both the honest
  // income proxy and what §6 says the feature is FOR.
  'monthly_inflow',
  'income_regularity',
  'avg_balance',
  'balance_retention',
  'obligation_ratio',
  'months_covered',
  'bounce_count',
  'gst_turnover',
  'gst_filing_consistency',
] as const

export type ScoreFeature = (typeof SCORE_FEATURES)[number]

export const ScoreFeatureSchema = z.enum(SCORE_FEATURES)
