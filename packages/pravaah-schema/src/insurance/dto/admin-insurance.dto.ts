import { z } from 'zod'

import {
  CurrencySchema,
  PositiveMinorAmountSchema,
} from '../../payments/schemas/money.schema'
import {
  ClaimStatusSchema,
  InsuranceProductTypeSchema,
  PolicyStatusSchema,
} from '../schemas/insurance-enums.schema'

/**
 * Create or replace a product in the catalogue.
 *
 * Admin-managed so a new cover — or a repriced one — needs no deploy. Every
 * numeric field is an integer for the reason that governs the whole module: the
 * premium is computed in BigInt from `baseRateBps`, and a float rate here would
 * reintroduce the drift the integer pipeline exists to prevent.
 *
 * The cross-field refinements are the ones that would otherwise produce a product
 * nobody can buy, or one that is unsafe to sell.
 */
export const UpsertInsuranceProductSchema = z
  .object({
    type: InsuranceProductTypeSchema,
    name: z.string().trim().min(3).max(120),
    tagline: z.string().trim().min(10).max(240).optional(),
    currency: CurrencySchema,

    /**
     * The annual base rate, in basis points of coverage.
     *
     * Bounded at both ends. A rate under 10bps (0.1%) prices cover at less than
     * the cost of administering it; one over 5000bps (50% of the sum insured per
     * year) is not insurance, and if it is ever legitimately needed it should be
     * a deliberate schema change rather than a value somebody typed into a form.
     */
    baseRateBps: z.coerce.number().int().min(10).max(5_000),

    minCoverMinor: PositiveMinorAmountSchema,
    maxCoverMinor: PositiveMinorAmountSchema,

    termDays: z.coerce.number().int().min(1).max(3_650),
    /**
     * The waiting period.
     *
     * Allowed to be zero only for TRAVEL_ACCIDENT, enforced below. For the other
     * two a zero waiting period makes buy-after-the-event rational, and the book
     * is insolvent by construction rather than by bad luck.
     */
    waitingPeriodDays: z.coerce.number().int().min(0).max(365),
    freeLookDays: z.coerce.number().int().min(0).max(30).default(7),

    /** Plain-language exclusions. One short sentence each, not a legal document. */
    exclusions: z.array(z.string().trim().min(5).max(300)).min(1).max(20),
    disclaimer: z.string().trim().min(20).max(2_000),
    isActive: z.boolean().default(true),
  })
  .refine(
    (value) => BigInt(value.maxCoverMinor) >= BigInt(value.minCoverMinor),
    {
      message: 'The maximum cover cannot be lower than the minimum',
      path: ['maxCoverMinor'],
    },
  )
  /**
   * A waiting period longer than the term is a product that can never pay out.
   *
   * Worth a hard refusal rather than a warning: it would sell, collect premium,
   * and reject every claim — the exact behaviour that makes people distrust
   * micro-insurance in the first place.
   */
  .refine((value) => value.waitingPeriodDays < value.termDays, {
    message:
      'The waiting period must be shorter than the term, or no claim could ever be paid',
    path: ['waitingPeriodDays'],
  })
  .refine(
    (value) =>
      value.type === 'TRAVEL_ACCIDENT' || value.waitingPeriodDays > 0,
    {
      message:
        'Income Protection and Health Top-up need a non-zero waiting period — without one, buying cover after the incident is the rational move',
      path: ['waitingPeriodDays'],
    },
  )
  /**
   * The free-look window must fit inside the term.
   *
   * Otherwise a policy could be cancelled for a full refund after it had already
   * expired, which is a free option on the insurer's book.
   */
  .refine((value) => value.freeLookDays < value.termDays, {
    message: 'The free-look window must be shorter than the term',
    path: ['freeLookDays'],
  })
export type UpsertInsuranceProductDto = z.infer<
  typeof UpsertInsuranceProductSchema
>

/** Toggle a product's availability without deleting its history. */
export const SetProductActiveSchema = z.object({
  isActive: z.boolean(),
})
export type SetProductActiveDto = z.infer<typeof SetProductActiveSchema>

/**
 * The claim queue.
 *
 * Defaults to `UNDER_REVIEW` because that is the only status a reviewer can act
 * on — a queue that opened on "everything" would bury the actionable rows under
 * settled ones.
 */
export const AdminClaimQueueQuerySchema = z.object({
  status: ClaimStatusSchema.default('UNDER_REVIEW'),
  /** Show only claims the fraud hook flagged. The triage view. */
  flaggedOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type AdminClaimQueueQueryDto = z.infer<
  typeof AdminClaimQueueQuerySchema
>

export const AdminPolicyListQuerySchema = z.object({
  status: PolicyStatusSchema.optional(),
  type: InsuranceProductTypeSchema.optional(),
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type AdminPolicyListQueryDto = z.infer<
  typeof AdminPolicyListQuerySchema
>

/**
 * The book's health, per product.
 *
 * `LOSS RATIO = Σ claims paid ÷ Σ premiums earned` is the one number an insurer
 * judge looks for, and it is derived from the LEDGER rather than from these
 * tables — see `InsuranceAdminService.book`. The query only chooses the window.
 */
export const LossRatioQuerySchema = z.object({
  currency: CurrencySchema.optional(),
  type: InsuranceProductTypeSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type LossRatioQueryDto = z.infer<typeof LossRatioQuerySchema>

/**
 * Retry a premium collection the dunning cron could not complete.
 *
 * Takes no amount and no period: both come from the PremiumPayment row. An
 * operator-supplied amount would be a way to debit a policyholder a figure they
 * never agreed to.
 */
export const RetryPremiumSchema = z.object({
  reason: z.string().trim().min(3).max(300),
})
export type RetryPremiumDto = z.infer<typeof RetryPremiumSchema>
