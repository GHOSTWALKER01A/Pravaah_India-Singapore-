import { z } from 'zod'

import {
  ModelRuntimeSchema,
  ScoreBandSchema,
  ScoreFeatureSchema,
} from '../schemas/scoring-enums.schema'

/**
 * Ordered feature schema of a model version. THE reproducibility contract: a
 * score can only be reproduced from `inputsHash` if this order is pinned.
 */
export const FeatureSchemaSchema = z.object({
  features: z
    .array(
      z.object({
        name: ScoreFeatureSchema,
        dtype: z.enum(['float', 'int']),
        /** Optional features do not pull confidence down as hard when absent. */
        optional: z.boolean().default(false),
      }),
    )
    .min(1, 'A model needs at least one feature'),
})
export type FeatureSchemaDto = z.infer<typeof FeatureSchemaSchema>

/** Band cutoffs, inclusive, over the 300..900 range. */
export const BandsSchema = z
  .array(
    z.object({
      min: z.number().int().min(300).max(900),
      max: z.number().int().min(300).max(900),
      band: ScoreBandSchema,
    }),
  )
  .min(1)
  .refine((bands) => bands.every((b) => b.min <= b.max), {
    message: 'Every band needs min <= max',
  })
  .refine(
    (bands) =>
      [...bands]
        .sort((a, b) => a.min - b.min)
        .every((b, i, all) => i === 0 || all[i - 1]!.max + 1 === b.min),
    { message: 'Bands must be contiguous with no gaps or overlaps' },
  )
export type BandsDto = z.infer<typeof BandsSchema>

/**
 * Parameters for the in-process scorecard runtime. The model is additive on the
 * logit scale:
 *
 *   z = intercept + Σ wᵢ · tᵢ(xᵢ)      p = σ(z)      score = 300 + 600·p
 *
 * Because it is additive, each feature's EXACT Shapley value is
 * `wᵢ · (tᵢ(xᵢ) − tᵢ(refᵢ))` — no approximation, no sampling. That is what
 * makes the "why" defensible without a Python runtime in the loop.
 */
export const ScorecardParamsSchema = z.object({
  intercept: z.number(),
  weights: z.record(ScoreFeatureSchema, z.number()),
  /**
   * Reference (population-typical) RAW value per feature. Contributions are
   * measured against this, so `base_value` is the score of a reference profile.
   */
  reference: z.record(ScoreFeatureSchema, z.number()),
  /** Per-feature normalising transform applied before weighting. */
  transforms: z.record(
    ScoreFeatureSchema,
    z.discriminatedUnion('kind', [
      // Monetary/count features: log1p(x/scale) clamped to [0,1] at `cap`.
      z.object({
        kind: z.literal('logScale'),
        scale: z.number().positive(),
        cap: z.number().positive(),
      }),
      // Already-normalised ratios: clamp to [lo,hi] then min-max to [0,1].
      z.object({
        kind: z.literal('clamp'),
        lo: z.number(),
        hi: z.number(),
      }),
      // Penalty features (lower is better): 1 - min(1, x/worst).
      z.object({
        kind: z.literal('inverse'),
        worst: z.number().positive(),
      }),
    ]),
  ),
  /** Platt-style calibration on the logit before σ: z' = a·z + b. */
  calibration: z
    .object({ a: z.number().positive(), b: z.number() })
    .default({ a: 1, b: 0 }),
})
export type ScorecardParamsDto = z.infer<typeof ScorecardParamsSchema>

/** Body for `POST /admin/score/models` — register a new version (inactive). */
export const RegisterModelSchema = z
  .object({
    name: z.string().trim().min(3).max(64),
    // Semver-ish: the version string is the join key for every score ever made.
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+$/, 'version must be semver (e.g. 1.0.3)'),
    runtime: ModelRuntimeSchema.default('scorecard'),
    featureSchema: FeatureSchemaSchema,
    bands: BandsSchema,
    scorecard: ScorecardParamsSchema.optional(),
    trainedAt: z.iso.datetime({ offset: true }).or(z.iso.date()),
    datasetRef: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  // A scorecard-runtime version is unservable without its parameters, and its
  // weights must cover exactly the features it declares.
  .refine((v) => v.runtime !== 'scorecard' || !!v.scorecard, {
    message: 'A scorecard runtime requires `scorecard` parameters',
    path: ['scorecard'],
  })
  .refine(
    (v) =>
      v.runtime !== 'scorecard' ||
      !v.scorecard ||
      v.featureSchema.features.every(
        (f) =>
          v.scorecard!.weights[f.name] !== undefined &&
          v.scorecard!.reference[f.name] !== undefined &&
          v.scorecard!.transforms[f.name] !== undefined,
      ),
    {
      message:
        'Every declared feature needs a weight, reference, and transform',
      path: ['scorecard'],
    },
  )
export type RegisterModelDto = z.infer<typeof RegisterModelSchema>
