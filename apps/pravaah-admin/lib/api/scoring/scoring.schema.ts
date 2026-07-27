import { z } from 'zod';

import { APIResponseSchema } from '../core/api.schema';

/**
 * M2 · Reputation Engine, as surfaced to admins — the model-risk console.
 *
 * Note what these shapes deliberately do NOT carry: feature VALUES. A score's
 * audit view exposes its `inputsHash` (proving it is reproducible) and its
 * provenance, but never a window into the user's bank statement.
 */

export const ScoreBandSchema = z.enum([
  'POOR',
  'FAIR',
  'GOOD',
  'VERY_GOOD',
  'EXCELLENT',
]);
export type ScoreBand = z.infer<typeof ScoreBandSchema>;

// ── model registry ──────────────────────────────────────────────────────────
export const ModelVersionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  /** "scorecard" (in-process, additive) | "fastapi" (external XGBoost + SHAP). */
  runtime: z.string(),
  trainedAt: z.string(),
  datasetRef: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  fairnessPassed: z.boolean(),
  fairnessAt: z.string().nullable().optional(),
  isActive: z.boolean(),
  activatedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  bands: z.unknown().nullable().optional(),
  scoreCount: z.number().optional(),
  fairnessReportCount: z.number().optional(),
  /**
   * False when the declared runtime has no configuration (e.g. a fastapi version
   * with no ML_BASE_URL set). A CONFIG check, not a health probe — a configured
   * but unreachable service is caught by the circuit breaker at compute time.
   */
  runtimeConfigured: z.boolean().optional(),
});
export type ModelVersion = z.infer<typeof ModelVersionSchema>;

export const FairnessReportRowSchema = z.object({
  id: z.string().optional(),
  metric: z.string(),
  attribute: z.string(),
  group: z.string(),
  value: z.number(),
  threshold: z.number(),
  passed: z.boolean(),
  sampleSize: z.number(),
  approvalRate: z.number().nullable().optional(),
  /**
   * Pooled two-proportion z against the comparison group, and whether the gap is
   * significant at α=0.05. A metric fails only when the disparity is BOTH
   * materially large AND statistically real — the four-fifths ratio on its own is
   * dominated by sampling noise at small group sizes.
   */
  zScore: z.number().nullable().optional(),
  significant: z.boolean().optional(),
  computedAt: z.string().optional(),
  /** Whether a failure here would block activation. */
  blocking: z.boolean().optional(),
  /** Whether the group is large enough to decide the gate. */
  decisive: z.boolean().optional(),
});
export type FairnessReportRow = z.infer<typeof FairnessReportRowSchema>;

export const ModelDetailSchema = ModelVersionSchema.extend({
  featureSchema: z.unknown().nullable().optional(),
  // For the scorecard runtime these ARE the model. A model-risk reviewer must be
  // able to read the weights that priced someone's creditworthiness.
  scorecard: z.unknown().nullable().optional(),
  fairness: z.object({
    passed: z.boolean(),
    auditedAt: z.string().nullable().optional(),
    reportCount: z.number(),
    failingCount: z.number(),
    reports: z.array(FairnessReportRowSchema),
  }),
  /** Non-null means the activate button must stay disabled, with this reason. */
  activationBlockedReason: z.string().nullable().optional(),
});
export type ModelDetail = z.infer<typeof ModelDetailSchema>;

// ── fairness report ─────────────────────────────────────────────────────────
export const FairnessMetricGroupSchema = z.object({
  metric: z.string(),
  threshold: z.number().nullable().optional(),
  interpretation: z.string(),
  failing: z.number(),
  groups: z.array(FairnessReportRowSchema),
});

export const FairnessReportSchema = z.object({
  version: z.string(),
  passed: z.boolean(),
  auditedAt: z.string().nullable().optional(),
  minGroupSize: z.number(),
  thresholds: z.record(z.string(), z.number()),
  blockingAttributes: z.array(z.string()),
  blockingFailures: z.array(FairnessReportRowSchema),
  monitoredConcerns: z.array(FairnessReportRowSchema),
  attributePolicy: z.array(
    z.object({
      attribute: z.string(),
      mode: z.string(),
      rationale: z.string(),
    }),
  ),
  metrics: z.array(FairnessMetricGroupSchema),
  mitigations: z.array(z.object({ name: z.string(), detail: z.string() })),
});
export type FairnessReport = z.infer<typeof FairnessReportSchema>;

export const AuditResultSchema = z.object({
  passed: z.boolean(),
  version: z.string(),
  subjects: z.number(),
  groupCount: z.number(),
  populationApprovalRate: z.number(),
  positiveBandMin: z.number(),
  minGroupSize: z.number(),
  blockingAttributes: z.array(z.string()),
  monitoredConcerns: z.array(FairnessReportRowSchema),
  reports: z.array(FairnessReportRowSchema),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

// ── issued scores ───────────────────────────────────────────────────────────
export const ScoreListItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  /** The user's Pravaah ID — what the console displays instead of `userId`. */
  userRef: z.string().nullable(),
  value: z.number().nullable(),
  band: ScoreBandSchema.nullable(),
  confidence: z.number().nullable(),
  coverage: z.number().nullable(),
  status: z.string(),
  servedBy: z.string().nullable().optional(),
  modelVersion: z.string(),
  runtime: z.string(),
  overrideCount: z.number(),
  computedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type ScoreListItem = z.infer<typeof ScoreListItemSchema>;

const ScoreFactorSchema = z.object({
  feature: z.string(),
  label: z.string(),
  shapValue: z.number(),
  direction: z.string(),
  plainText: z.string(),
  rank: z.number(),
});

const ScoreImprovementSchema = z.object({
  feature: z.string(),
  label: z.string(),
  currentValue: z.number(),
  targetValue: z.number(),
  estimatedGain: z.number(),
  plainText: z.string(),
  rank: z.number(),
});

export const ScoreOverrideRowSchema = z.object({
  id: z.string(),
  previousBand: ScoreBandSchema,
  newBand: ScoreBandSchema,
  reason: z.string(),
  createdAt: z.string(),
  admin: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
  }),
});
export type ScoreOverrideRow = z.infer<typeof ScoreOverrideRowSchema>;

export const ScoreDetailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  /** The user's Pravaah ID — what the console displays instead of `userId`. */
  userRef: z.string().nullable(),
  user: z.object({
    id: z.string(),
    pravaahId: z.string().nullable(),
    primaryCountry: z.string(),
    kycStatus: z.string(),
  }),
  value: z.number().nullable(),
  band: ScoreBandSchema.nullable(),
  confidence: z.number().nullable(),
  bandLow: z.number().nullable(),
  bandHigh: z.number().nullable(),
  coverage: z.number().nullable(),
  missingCount: z.number(),
  status: z.string(),
  failureReason: z.string().nullable().optional(),
  servedBy: z.string().nullable().optional(),
  computedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  /** The reproducibility receipt: same hash + same version ⇒ same score. */
  inputsHash: z.string(),
  provenance: z.object({
    consent: z
      .object({
        id: z.string(),
        purpose: z.string(),
        purposeCode: z.string(),
        fiTypes: z.array(z.string()),
        status: z.string(),
        aaProvider: z.string(),
        artefactVerified: z.boolean(),
        dataRangeFrom: z.string(),
        dataRangeTo: z.string(),
        activatedAt: z.string().nullable().optional(),
        expiresAt: z.string().nullable().optional(),
      })
      .nullable(),
    model: z.object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      runtime: z.string(),
      datasetRef: z.string().nullable().optional(),
      trainedAt: z.string(),
      fairnessPassed: z.boolean(),
      fairnessAt: z.string().nullable().optional(),
    }),
  }),
  factors: z.array(ScoreFactorSchema),
  improvements: z.array(ScoreImprovementSchema),
  overrides: z.array(ScoreOverrideRowSchema),
});
export type ScoreDetail = z.infer<typeof ScoreDetailSchema>;

export const ScoreAuditRowSchema = z.object({
  id: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable().optional(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable().optional(),
  metadata: z.unknown().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type ScoreAuditRow = z.infer<typeof ScoreAuditRowSchema>;

// ── drift ───────────────────────────────────────────────────────────────────
const DriftWindowSchema = z.object({
  count: z.number(),
  mean: z.number(),
  p10: z.number(),
  median: z.number(),
  p90: z.number(),
  approvalRate: z.number(),
  meanConfidence: z.number(),
});

export const DriftReportSchema = z.object({
  alert: z.boolean(),
  reasons: z.array(z.string()),
  modelVersion: z.string().nullable(),
  recent: DriftWindowSchema,
  baseline: DriftWindowSchema,
  meanShift: z.number(),
  approvalRateShift: z.number(),
  thresholds: z.object({
    meanPoints: z.number(),
    approvalRate: z.number(),
    minSample: z.number(),
  }),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;

// ── response envelopes ──────────────────────────────────────────────────────
export const ModelListResponseSchema = APIResponseSchema(
  z.array(ModelVersionSchema),
);
export const ModelDetailResponseSchema = APIResponseSchema(ModelDetailSchema);
/**
 * `POST /models` returns the registry SUMMARY, not the detail projection — it has
 * no `fairness` block or `activationBlockedReason` because a freshly registered
 * version has never been audited. Parsing it as a detail would fail at runtime.
 */
export const ModelRegisterResponseSchema =
  APIResponseSchema(ModelVersionSchema);
export const FairnessReportResponseSchema =
  APIResponseSchema(FairnessReportSchema);
export const AuditResultResponseSchema = APIResponseSchema(AuditResultSchema);
export const ScoreListResponseSchema = APIResponseSchema(
  z.object({
    items: z.array(ScoreListItemSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().optional(),
  }),
);
export const ScoreDetailResponseSchema = APIResponseSchema(ScoreDetailSchema);
export const ScoreAuditResponseSchema = APIResponseSchema(
  z.array(ScoreAuditRowSchema),
);
export const DriftResponseSchema = APIResponseSchema(DriftReportSchema);
export const ActivateResponseSchema = APIResponseSchema(
  z.object({
    ok: z.boolean(),
    version: z.string().optional(),
    replaced: z.string().nullable().optional(),
    alreadyActive: z.boolean().optional(),
    scoresPendingRecompute: z.number().optional(),
  }),
);
export const OverrideResponseSchema = APIResponseSchema(
  z.object({
    ok: z.boolean(),
    scoreId: z.string(),
    previousBand: ScoreBandSchema,
    newBand: ScoreBandSchema,
    overrideId: z.string(),
  }),
);
