import { z } from 'zod'

import { PositiveMinorAmountSchema } from '../schemas/money.schema'
import {
  DisputeKindSchema,
  DisputeStatusSchema,
} from '../schemas/payment-enums.schema'

/**
 * Raise a UDIR dispute — the in-app complaint every UPI app is obliged to offer.
 *
 * UDIR exists because the alternative is a customer with a debited account, an
 * uncredited payee, and a bank branch queue. The categories are the ones a person
 * would actually describe ("I was debited twice"), not internal failure codes, and
 * the SLA is set server-side rather than promised in a support script.
 */
const RaiseDisputeShape = z.object({
  transactionId: z.uuid(),
  kind: DisputeKindSchema,
  description: z.string().trim().min(10).max(1000),
  /**
   * How much the user says is wrong. Required for the amount-shaped
   * complaints, where "some of it came back" and "none of it came back" lead to
   * completely different investigations.
   */
  claimedAmountMinor: PositiveMinorAmountSchema.optional(),
  /** Screenshots, the payee's own statement, a chat log. */
  evidence: z.record(z.string(), z.unknown()).optional(),
})

/**
 * The kinds that are meaningless without a figure.
 *
 * "A different amount arrived" and "I paid and got nothing" are both claims ABOUT an amount, so a
 * reviewer cannot open either without knowing which amount. The other four kinds are about the whole
 * payment and need no figure.
 */
const AMOUNT_SHAPED_KINDS = ['AMOUNT_MISMATCH', 'CHARGEBACK']

/**
 * The cross-field rule, as a standalone predicate.
 *
 * Extracted so it can be applied to BOTH exported schemas below rather than living inside one of
 * them. Zod 4 refuses `.omit()` on an object that already carries a refinement, so a caller wanting
 * the body-only shape has to build it from the unrefined object — and the obvious way to do that is
 * to omit and move on, which silently DROPS this check on the one route where it applies. Keeping
 * the rule addressable by name is what makes re-applying it the easy path.
 */
const statesAmountWhenRequired = (v: {
  kind: string
  claimedAmountMinor?: string | undefined
}): boolean =>
  !AMOUNT_SHAPED_KINDS.includes(v.kind) || v.claimedAmountMinor !== undefined

/**
 * A fresh issue descriptor per call.
 *
 * A function rather than a shared constant because Zod's `path` is typed as a mutable
 * `PropertyKey[]`, so handing the same array to two refinements would have both schemas pointing at
 * one object that either of them is free to mutate.
 */
const amountRequiredIssue = () => ({
  message: 'State the amount you are disputing',
  path: ['claimedAmountMinor'],
})

export const RaiseDisputeSchema = RaiseDisputeShape.refine(
  statesAmountWhenRequired,
  amountRequiredIssue(),
)
export type RaiseDisputeDto = z.infer<typeof RaiseDisputeSchema>

/**
 * The same dispute, minus `transactionId`, for routes that take the payment id in the PATH.
 *
 * Exported pre-built rather than left to the controller to derive. `POST /transfers/:id/dispute`
 * previously did `RaiseDisputeSchema.omit({ transactionId: true })`, which **threw at module load**
 * under Zod 4 (`.omit() cannot be used on object schemas containing refinements`) and took the whole
 * application down before it could serve a request.
 *
 * Building it here rather than exporting the bare shape is deliberate: the refinement is
 * re-attached, so the body-only route keeps the "state the amount" rule instead of quietly losing
 * it. A controller that omitted from an unrefined shape would boot cleanly and accept an
 * AMOUNT_MISMATCH dispute with no amount, which is a worse outcome than the crash.
 */
export const RaiseDisputeBodySchema = RaiseDisputeShape.omit({
  transactionId: true,
}).refine(statesAmountWhenRequired, amountRequiredIssue())
export type RaiseDisputeBodyDto = z.infer<typeof RaiseDisputeBodySchema>

export const WithdrawDisputeSchema = z.object({
  reason: z.string().trim().max(300).optional(),
})
export type WithdrawDisputeDto = z.infer<typeof WithdrawDisputeSchema>

export const DisputeListQuerySchema = z.object({
  status: DisputeStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type DisputeListQueryDto = z.infer<typeof DisputeListQuerySchema>
