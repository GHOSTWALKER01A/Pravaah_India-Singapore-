import { z } from 'zod'

import {
  FraudCaseOutcomeSchema,
  FraudCaseStatusSchema,
  FraudSeveritySchema,
  ListEntityTypeSchema,
  ListKindSchema,
} from '../schemas/fraud-enums.schema'

/** The analyst queue, filtered. Sorted server-side by severity then SLA. */
export const FraudCaseQuerySchema = z.object({
  status: FraudCaseStatusSchema.optional(),
  severity: FraudSeveritySchema.optional(),
  /** `true` shows only cases assigned to the calling analyst. */
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type FraudCaseQueryDto = z.infer<typeof FraudCaseQuerySchema>

/**
 * Resolve a case.
 *
 * There is no `analystId` or `role` field, and their absence is the control. The
 * M6 build doc's version accepted both in the body — which would let any
 * authenticated analyst claim a senior role and confirm a sanctions case by
 * typing `"role": "ADMIN"`. Both come from the authenticated admin session.
 *
 * `note` is mandatory on every branch, including CLEARED. A release nobody had to
 * justify is precisely the shape of insider fraud, and it is also the record the
 * user is owed if they later ask why their money was held.
 */
export const ResolveFraudCaseSchema = z.object({
  outcome: FraudCaseOutcomeSchema,
  note: z.string().trim().min(5).max(2000),
})
export type ResolveFraudCaseDto = z.infer<typeof ResolveFraudCaseSchema>

/** Add a note without resolving. The investigation trail. */
export const AddFraudCaseNoteSchema = z.object({
  note: z.string().trim().min(3).max(2000),
})
export type AddFraudCaseNoteDto = z.infer<typeof AddFraudCaseNoteSchema>

/**
 * Add an entry to a watchlist, blocklist, mule registry or sanctions list.
 *
 * Takes the identifier in PLAINTEXT and hashes it server-side. That is
 * deliberate, and the opposite of what the build doc specified: a `valueHash`
 * field in the body means the client chooses the salt, so two consoles would
 * produce two different hashes for the same VPA and neither would ever match a
 * lookup. The salt is a server secret; only the server can compute the key.
 */
export const AddListEntrySchema = z.object({
  kind: ListKindSchema,
  entityType: ListEntityTypeSchema,
  /** The VPA, device id, mobile number or user id being listed. */
  value: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(5).max(500),
  /** ISO-8601. Omit for an indefinite listing. */
  expiresAt: z.coerce.date().optional(),
})
export type AddListEntryDto = z.infer<typeof AddListEntrySchema>

/** Lift a listing. Kept as a row (`active: false`) rather than deleted. */
export const RemoveListEntrySchema = z.object({
  kind: ListKindSchema,
  entityType: ListEntityTypeSchema,
  value: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(5).max(500),
})
export type RemoveListEntryDto = z.infer<typeof RemoveListEntrySchema>
