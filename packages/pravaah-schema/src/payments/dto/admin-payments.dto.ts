import { z } from 'zod'

import {
  CurrencySchema,
  PositiveMinorAmountSchema,
} from '../schemas/money.schema'
import {
  AccountTypeSchema,
  CorridorSchema,
  DisputeKindSchema,
  DisputeStatusSchema,
  ReconStatusSchema,
  TxnStatusSchema,
} from '../schemas/payment-enums.schema'

export const AdminTxnListQuerySchema = z.object({
  status: TxnStatusSchema.optional(),
  corridor: CorridorSchema.optional(),
  userId: z.uuid().optional(),
  /** Only rows a human needs to look at: DEEMED, RISK_HELD, stuck mid-saga. */
  needsAttention: z.coerce.boolean().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type AdminTxnListQueryDto = z.infer<typeof AdminTxnListQuerySchema>

export const ReconListQuerySchema = z.object({
  status: ReconStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type ReconListQueryDto = z.infer<typeof ReconListQuerySchema>

/**
 * The dispute work queue, across every user.
 *
 * Distinct from the customer-facing `DisputeListQuerySchema`, which is scoped to one user and
 * ordered newest-first. This one exists to be WORKED, so it defaults to ordering by `slaDueAt`
 * ascending — the most-overdue obligation at the top. `breachingSla` answers "what have we already
 * missed?"; this answers "what am I about to miss?", and a queue that only showed the former would
 * let every dispute go late before anyone saw it.
 */
export const AdminDisputeListQuerySchema = z.object({
  status: DisputeStatusSchema.optional(),
  kind: DisputeKindSchema.optional(),
  userId: z.uuid().optional(),
  transactionId: z.uuid().optional(),
  /** Open work only — OPEN and UNDER_REVIEW. Ignored when `status` is given. */
  openOnly: z.coerce.boolean().optional(),
  /** Already past `slaDueAt`. The subset `breachingSla` returns. */
  breachedOnly: z.coerce.boolean().optional(),
  orderBy: z.enum(['sla', 'created']).default('sla'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type AdminDisputeListQueryDto = z.infer<
  typeof AdminDisputeListQuerySchema
>

export const LedgerQuerySchema = z.object({
  accountId: z.uuid().optional(),
  accountType: AccountTypeSchema.optional(),
  currency: CurrencySchema.optional(),
  transactionId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export type LedgerQueryDto = z.infer<typeof LedgerQuerySchema>

/**
 * Force a refund by hand.
 *
 * The break-glass control, and the reason it demands a written reason and the
 * exact amount: an admin-initiated movement of customer money is the one ledger
 * entry with no rail event behind it to corroborate it. The acting admin comes
 * from the authenticated session, never from this body.
 */
export const ManualReversalSchema = z.object({
  amountMinor: PositiveMinorAmountSchema,
  reason: z.string().trim().min(10).max(500),
  /** Typed confirmation that this releases real money. */
  confirmed: z.literal(true),
})
export type ManualReversalDto = z.infer<typeof ManualReversalSchema>

/**
 * Resolve a DEEMED transaction — one the rail never gave a final answer for.
 *
 * A human decides, because the two options are opposites and both are
 * irreversible: SETTLE credits the beneficiary and closes the ledger; REVERSE
 * gives the money back to the sender. Guessing wrong pays twice or not at all,
 * which is exactly why the saga parks these instead of picking for itself.
 */
export const ResolveDeemedSchema = z.object({
  resolution: z.enum(['SETTLE', 'REVERSE']),
  /** Cite the evidence — a bank statement line, a rail ticket number. */
  evidenceRef: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(10).max(500),
  confirmed: z.literal(true),
})
export type ResolveDeemedDto = z.infer<typeof ResolveDeemedSchema>

export const ResolveDisputeSchema = z.object({
  status: DisputeStatusSchema.refine(
    (s) => s === 'RESOLVED_CREDITED' || s === 'RESOLVED_REJECTED',
    'A dispute resolves to credited or rejected',
  ),
  resolution: z.string().trim().min(10).max(1000),
  /** Present when the resolution is to credit the customer. */
  refundAmountMinor: PositiveMinorAmountSchema.optional(),
})
export type ResolveDisputeDto = z.infer<typeof ResolveDisputeSchema>

/**
 * Release a transaction held by the risk engine.
 *
 * Attributed and reasoned. A hold that anyone can clear with one tap and no note
 * is not a control — it is a delay.
 */
export const ReleaseRiskHoldSchema = z.object({
  decision: z.enum(['RELEASE', 'BLOCK']),
  reason: z.string().trim().min(10).max(500),
})
export type ReleaseRiskHoldDto = z.infer<typeof ReleaseRiskHoldSchema>

export const TrialBalanceQuerySchema = z.object({
  currency: CurrencySchema.optional(),
  /** Include per-account detail rather than only the per-currency net. */
  detailed: z.coerce.boolean().default(false),
})
export type TrialBalanceQueryDto = z.infer<typeof TrialBalanceQuerySchema>
