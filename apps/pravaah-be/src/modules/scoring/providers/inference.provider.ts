import type { ScoreFeature } from '@pravaah/schema'

import type { Result } from '@/common/result/result'

/**
 * Inference rail (M2). The model + explainability math hides behind this
 * interface exactly the way M0's KYC rails and M1's AA rails do, so scoring
 * orchestration, caching, versioning, persistence, and the fairness audit depend
 * only on this contract:
 *
 *  - {@link LocalScorecardProvider}   in-process additive scorecard. Its
 *    contributions are EXACT Shapley values, not approximations.
 *  - {@link FastApiInferenceProvider} external XGBoost + TreeSHAP (`apps/ml`),
 *    behind a circuit breaker so a model crash can never take down auth or
 *    payments (M2 §1.6).
 *
 * A feature value of `null` means "the consented data did not contain it". A
 * provider MUST impute it neutrally AND report it in `missingCount`, because
 * that is what pulls confidence down honestly instead of hiding the gap.
 */
export type FeatureVector = Record<ScoreFeature, number | null>

export interface ContributionOut {
  feature: ScoreFeature
  /** Signed contribution in the model's margin (log-odds) space. */
  shapValue: number
}

export interface PredictInput {
  features: FeatureVector
  /** M1 data-coverage, 0..1. Flows into confidence, never into the score. */
  coverage: number
  modelVersion: string
}

export interface PredictOutput {
  score: number
  band: string
  probability: number
  confidence: number
  /** The three confidence components, so a low number is explainable. */
  confidenceParts: {
    coverage: number
    certainty: number
    completeness: number
  }
  bandLow: number
  bandHigh: number
  /** Ordered by |contribution|, biggest driver first. */
  contributions: ContributionOut[]
  /** Model output for the reference profile — SHAP's additivity anchor. */
  baseValue: number
  missingCount: number
  modelVersion: string
  /** Which runtime actually answered. Persisted on `Score.servedBy`. */
  servedBy: string
}

/**
 * A single counterfactual: the score this user would have had with one feature
 * moved to `targetValue`, everything else held. Computed by re-running the model,
 * so the point gain shown to a user is a real delta rather than a multiple of a
 * SHAP value.
 */
export interface CounterfactualInput extends PredictInput {
  feature: ScoreFeature
  targetValue: number
}

/** One row of a batch score request. */
export interface BatchScoreInput {
  rows: FeatureVector[]
  modelVersion: string
}

export interface InferenceProvider {
  /** Stable id persisted on `Score.servedBy` and `ModelVersion.runtime`. */
  readonly name: string
  /**
   * True when this provider has the CONFIGURATION it needs to be attempted.
   *
   * Deliberately not a reachability check: probing a network service would make
   * this async and would still be stale by the time a request arrived. A
   * configured-but-down service is handled where it actually matters — the
   * circuit breaker in {@link predict} — not by a health guess here.
   */
  isConfigured(): boolean
  predict(input: PredictInput): Promise<Result<PredictOutput>>
  /**
   * Score many vectors at once, returning scores only (no explanations).
   *
   * Exists for the fairness audit, which needs a whole cohort scored and nothing
   * else. Doing that one `predict` at a time is not merely slower — over an
   * external runtime it is N HTTP round trips, which turned a 2000-subject audit
   * into minutes and made the pre-activation gate something an admin would skip.
   * The in-process runtime implements this as a plain loop; the external one as a
   * single `/score-batch` call.
   */
  scoreBatch(input: BatchScoreInput): Promise<Result<number[]>>
  /**
   * Score under a single-feature intervention. Returns just the resulting score
   * so the caller can diff it against the baseline.
   */
  counterfactual(input: CounterfactualInput): Promise<Result<number>>
}

/** DI token for the resolved provider registry. */
export const INFERENCE_PROVIDER = 'INFERENCE_PROVIDER'
