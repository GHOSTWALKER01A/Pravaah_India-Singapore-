import { z } from 'zod'

import { ScoreBandSchema } from '../schemas/scoring-enums.schema'

/**
 * Body for `POST /admin/score/:scoreId/override`. A band override is a manual
 * departure from the model, so the reason is MANDATORY and substantive — it is
 * the only defence a model-risk reviewer has when asked why a number moved.
 * The acting admin is NEVER taken from the body; it comes from the admin JWT.
 */
export const OverrideScoreSchema = z.object({
  newBand: ScoreBandSchema,
  reason: z
    .string()
    .trim()
    .min(20, 'Give a real reason — at least 20 characters')
    .max(500),
})
export type OverrideScoreDto = z.infer<typeof OverrideScoreSchema>

/**
 * Body for `POST /admin/score/models/:id/audit-fairness`. `positiveBandMin` is
 * the "approved" threshold parity is measured at (default GOOD = 670).
 */
export const AuditFairnessSchema = z.object({
  positiveBandMin: z.number().int().min(300).max(900).default(670),
  /** Max rows sampled from the scored population. */
  sampleSize: z.number().int().min(10).max(5000).default(2000),
})
export type AuditFairnessDto = z.infer<typeof AuditFairnessSchema>

/** Query for `GET /admin/score/scores`. */
export const ScoreListQuerySchema = z.object({
  status: z.string().trim().max(32).optional(),
  modelVersionId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type ScoreListQueryDto = z.infer<typeof ScoreListQuerySchema>
