import { z } from 'zod'

import {
  CurrencySchema,
  PositiveMinorAmountSchema,
} from '../../payments/schemas/money.schema'
import { InsuranceProductTypeSchema } from '../schemas/insurance-enums.schema'

/**
 * Ask for a price.
 *
 * `POST /insurance/quote` prices a specific user against a specific product at a
 * specific coverage, reading their M2 score and behaviour features. The result is
 * short-lived and single-use, and a policy can only be bought from one.
 *
 * That indirection matters here for a different reason than it does in M4. An FX
 * quote freezes a market rate; an INSURANCE quote freezes an UNDERWRITING
 * DECISION. Between quoting and buying, a user's score can be recomputed, a
 * model version can be activated, or an admin can edit the product's base rate —
 * and the person must be sold the cover they were shown, at the price they were
 * shown, on the evidence that produced it. Without the quote row there is nothing
 * to point at when they ask why.
 *
 * The request deliberately carries NO premium and NO risk tier. Both are outputs.
 * A client that could name its own tier could buy PREFERRED pricing.
 */
export const InsuranceQuoteRequestSchema = z.object({
  productId: z.uuid(),
  /**
   * How much cover, in integer minor units.
   *
   * Bounded server-side by the product's `[minCoverMinor, maxCoverMinor]` band
   * and then AGAIN by a tier ceiling: a SUBSTANDARD risk cannot buy the maximum
   * cover, because the coverage cap is one of the four anti-adverse-selection
   * controls and the only one the user chooses the input to.
   */
  coverageMinor: PositiveMinorAmountSchema,
})
export type InsuranceQuoteRequestDto = z.infer<
  typeof InsuranceQuoteRequestSchema
>

/**
 * Buy the cover a quote priced.
 *
 * Carries the premium the user saw, for the same reason M4's transfer carries
 * `expectedTotalDebitMinor`: a client showing a stale screen must be REJECTED
 * rather than silently charged the correct-but-unseen figure. A recurring product
 * makes this sharper — the number the user agreed to is one they will be debited
 * every month.
 *
 * `acceptedDisclaimer` has no default and must be literally `true`. An
 * insurance purchase where the non-advice disclaimer could be defaulted through
 * is a purchase nobody acknowledged.
 */
export const BuyPolicySchema = z.object({
  quoteId: z.uuid(),
  /** The premium per period, as printed on the button the user pressed. */
  expectedPremiumMinor: PositiveMinorAmountSchema,
  /** Explicit acknowledgement of the non-advice disclaimer and the exclusions. */
  acceptedDisclaimer: z.literal(true),
  /**
   * The device that authorised the purchase. Bound in M0 and recorded on the
   * premium transaction, so a disputed policy has the same fraud trail a
   * disputed payment does.
   */
  deviceId: z.uuid().optional(),
})
export type BuyPolicyDto = z.infer<typeof BuyPolicySchema>

/**
 * Cancel a policy.
 *
 * Inside the free-look window this triggers a FULL premium refund over the M4
 * ledger; outside it, cover simply ends. The two outcomes are decided by the
 * server from `freeLookEndsAt`, never by the client asking for a refund — a
 * refund flag on this DTO would be a request for money that the caller does not
 * get to make.
 */
export const CancelPolicySchema = z.object({
  reason: z.string().trim().min(3).max(300).optional(),
})
export type CancelPolicyDto = z.infer<typeof CancelPolicySchema>

export const PolicyListQuerySchema = z.object({
  /**
   * `false` (the default) returns every policy including lapsed and expired ones.
   *
   * Defaulting to "active only" would be the friendlier-looking choice and the
   * wrong one: a user whose cover lapsed needs to SEE that it lapsed, and hiding
   * it is how somebody discovers they were uninsured at claim time.
   */
  activeOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PolicyListQueryDto = z.infer<typeof PolicyListQuerySchema>

/**
 * The marketplace query.
 *
 * Currency-filtered because a Singapore-resident holder should not be offered an
 * INR-denominated policy they cannot pay a premium on from an SGD wallet.
 */
export const ProductListQuerySchema = z.object({
  type: InsuranceProductTypeSchema.optional(),
  currency: CurrencySchema.optional(),
})
export type ProductListQueryDto = z.infer<typeof ProductListQuerySchema>
