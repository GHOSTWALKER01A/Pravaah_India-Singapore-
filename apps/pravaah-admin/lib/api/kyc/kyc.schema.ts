import { z } from 'zod';

import { APIResponseSchema } from '../core/api.schema';

/**
 * A KYC review case as surfaced to admins. The backend maps the raw Prisma
 * graph into this flat, masked projection (see review.mapper.ts) — no raw PII,
 * no encrypted payload. `id` is the real UUID (route param); `caseCode` /
 * `userRef` are the human-readable reference codes shown in the UI.
 */
export const KycCaseListItemSchema = z.object({
  id: z.string(),
  caseCode: z.string(),
  status: z.string(),
  country: z.string(),
  userRef: z.string(),
  userName: z.string(),
  reason: z.string().optional(),
  slaDueAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KycCaseListItem = z.infer<typeof KycCaseListItemSchema>;

const KycCheckSchema = z.object({
  checkType: z.string(),
  status: z.string(),
  provider: z.string(),
  confidence: z.number().nullable().optional(),
  attempt: z.number().optional(),
  updatedAt: z.string().optional(),
});

export type KycCheckRow = z.infer<typeof KycCheckSchema>;

/** Full case detail: the list fields plus the profile, user and every check. */
export const KycCaseDetailSchema = KycCaseListItemSchema.extend({
  claimedBy: z.string().nullable().optional(),
  decision: z.string().nullable().optional(),
  decisionNotes: z.string().nullable().optional(),
  resolvedAt: z.string().nullable().optional(),
  user: z.object({
    ref: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    country: z.string(),
    kycStatus: z.string(),
    suspended: z.boolean().optional(),
    createdAt: z.string(),
  }),
  profile: z.object({
    overallStatus: z.string(),
    verifiedName: z.string().nullable().optional(),
    nameMatchScore: z.number().nullable().optional(),
    riskScore: z.number().nullable().optional(),
    startedAt: z.string(),
    completedAt: z.string().nullable().optional(),
  }),
  checks: z.array(KycCheckSchema),
});

export type KycCaseDetail = z.infer<typeof KycCaseDetailSchema>;

export const KycCaseListResponseSchema = APIResponseSchema(
  z.array(KycCaseListItemSchema),
);

export const KycCaseDetailResponseSchema = APIResponseSchema(KycCaseDetailSchema);

/** Backend ReviewDecision enum expects APPROVED / REJECTED (not APPROVE/REJECT). */
export const DecisionRequestSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().min(1),
});

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
