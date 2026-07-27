import { z } from 'zod';

import { APIResponseSchema } from '../core/api.schema';

/**
 * M1 · Account Aggregator consent, as surfaced to admins. Read-only oversight:
 * consent state + its append-only audit trail (the compliance evidence). No raw
 * FI data, no encrypted payloads — only masked/derived fields.
 */
export const ConsentListItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  /** The user's Pravaah ID — what the console displays instead of `userId`. */
  userRef: z.string().nullable(),
  aaProvider: z.string(),
  purpose: z.string(),
  purposeCode: z.string(),
  status: z.string(),
  fiTypes: z.array(z.string()),
  fetchType: z.string(),
  artefactVerified: z.boolean(),
  createdAt: z.string(),
  activatedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

export type ConsentListItem = z.infer<typeof ConsentListItemSchema>;

const DataSessionSchema = z.object({
  status: z.string(),
  fipTotal: z.number().nullable().optional(),
  fipCompleted: z.number(),
  completedAt: z.string().nullable().optional(),
  requestedAt: z.string(),
});

export const ConsentDetailSchema = ConsentListItemSchema.extend({
  vua: z.string(),
  consentMode: z.string(),
  revokedAt: z.string().nullable().optional(),
  dataRangeFrom: z.string(),
  dataRangeTo: z.string(),
  dataLifeUnit: z.string(),
  dataLifeValue: z.number(),
  consentExpiry: z.string(),
  featuresAvailable: z.number(),
  user: z.object({
    pravaahId: z.string().nullable(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    primaryCountry: z.string(),
  }),
  sessions: z.array(DataSessionSchema),
});

export type ConsentDetail = z.infer<typeof ConsentDetailSchema>;

/** One append-only audit row (who/what/when) scoped to a consent. */
export const ConsentAuditRowSchema = z.object({
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

export type ConsentAuditRow = z.infer<typeof ConsentAuditRowSchema>;

export const ConsentListResponseSchema = APIResponseSchema(
  z.array(ConsentListItemSchema),
);
export const ConsentDetailResponseSchema =
  APIResponseSchema(ConsentDetailSchema);
export const ConsentAuditResponseSchema = APIResponseSchema(
  z.array(ConsentAuditRowSchema),
);
