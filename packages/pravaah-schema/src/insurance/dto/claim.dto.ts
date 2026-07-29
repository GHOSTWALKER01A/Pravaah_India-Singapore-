import { z } from 'zod'

import { PositiveMinorAmountSchema } from '../../payments/schemas/money.schema'
import {
  ClaimDecisionSchema,
  ClaimDocTypeSchema,
  ClaimStatusSchema,
} from '../schemas/insurance-enums.schema'

/**
 * File a claim.
 *
 * Every field here is checked against the POLICY before a row is created — the
 * policy must be ACTIVE, the incident must fall after the waiting period and
 * inside the term, and the amount must fit inside the remaining cover. Those
 * guards live server-side in `ClaimsService.submit`; this schema only ensures the
 * shape is well-formed enough to check.
 *
 * The incident date is the load-bearing input. It is what the waiting-period
 * guard compares against, which makes it the single field a fraudulent claim most
 * wants to move — so it is validated as a real date, refused if it is in the
 * future, and preserved verbatim on the claim for the audit trail.
 */
export const SubmitClaimSchema = z
  .object({
    policyId: z.uuid(),
    amountClaimedMinor: PositiveMinorAmountSchema,
    /** ISO-8601. Coerced to a Date so the refinement below can compare it. */
    incidentDate: z.coerce.date(),
    /**
     * What happened, in the claimant's own words.
     *
     * A minimum length, because "accident" is not a claim a reviewer can assess
     * and an INFO_REQUESTED round-trip costs the claimant days they may not have.
     */
    description: z.string().trim().min(10).max(2000),
  })
  /**
   * An incident cannot be in the future.
   *
   * Checked here rather than only in the service because it is the one date
   * error with no legitimate reading: a claim for something that has not happened
   * is either a mistyped year or an attempt to sit inside a policy term that has
   * not started.
   */
  .refine((value) => value.incidentDate.getTime() <= Date.now(), {
    message: 'The incident date cannot be in the future',
    path: ['incidentDate'],
  })
export type SubmitClaimDto = z.infer<typeof SubmitClaimSchema>

/**
 * Attach a document to a claim.
 *
 * The FILE arrives as multipart; this is the metadata beside it. `docType` is
 * required and enumerated because the OCR provider's extraction is keyed on it —
 * a bill parser pointed at a boarding pass returns confident nonsense, and a
 * claim decided on confident nonsense is worse than one with no documents.
 */
export const AddClaimDocSchema = z.object({
  docType: ClaimDocTypeSchema,
})
export type AddClaimDocDto = z.infer<typeof AddClaimDocSchema>

/**
 * Withdraw a claim.
 *
 * Available to the claimant while a claim is still SUBMITTED or INFO_REQUESTED.
 * Not available after review has concluded — a decided claim is part of the
 * book's loss history and cannot be retracted to tidy it up.
 */
export const WithdrawClaimSchema = z.object({
  reason: z.string().trim().min(3).max(300).optional(),
})
export type WithdrawClaimDto = z.infer<typeof WithdrawClaimSchema>

export const ClaimListQuerySchema = z.object({
  status: ClaimStatusSchema.optional(),
  policyId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type ClaimListQueryDto = z.infer<typeof ClaimListQuerySchema>

/**
 * An adjudicator's decision.
 *
 * `reason` is mandatory on EVERY branch, including an approval. A reason is not
 * paperwork: an approval nobody has to justify is the shape of internal fraud,
 * and a rejection with no stated ground is one the claimant cannot appeal. There
 * is no `adminId` field — the acting admin comes from the authenticated session,
 * never from the body.
 */
export const ClaimDecisionBodySchema = z
  .object({
    decision: ClaimDecisionSchema,
    reason: z.string().trim().min(5).max(500),
    /**
     * Approve less than was claimed.
     *
     * Omit to approve the full claimed amount. Capped server-side at both the
     * claimed amount and the policy's remaining cover, so a fat-fingered extra
     * zero cannot pay out more than the contract allows.
     */
    approveMinor: PositiveMinorAmountSchema.optional(),
  })
  /**
   * A partial approval only means something on an APPROVE.
   *
   * Rejected rather than ignored: an operator who typed an amount and picked
   * REJECT has contradicted themselves, and silently honouring the reject
   * discards an intent about somebody's money.
   */
  .refine(
    (value) => value.decision === 'APPROVE' || value.approveMinor === undefined,
    {
      message: 'An approved amount can only be set when approving a claim',
      path: ['approveMinor'],
    },
  )
export type ClaimDecisionBodyDto = z.infer<typeof ClaimDecisionBodySchema>
