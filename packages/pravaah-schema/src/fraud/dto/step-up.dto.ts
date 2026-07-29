import { z } from 'zod'

import { StepUpPurposeSchema } from '../schemas/fraud-enums.schema'

/**
 * Answer a step-up challenge.
 *
 * There is no `userId` field. The acting user comes from the authenticated
 * session, always — a nonce plus a caller-supplied user id would let anyone who
 * captured a nonce redeem it as somebody else.
 */
export const VerifyStepUpSchema = z.object({
  nonce: z.uuid(),
  /**
   * The OTP, or a device-signed assertion for a biometric challenge.
   *
   * Compared in constant time against a stored hash. Bounded in length so a
   * multi-megabyte "answer" cannot be used to make the comparison itself the
   * denial of service.
   */
  answer: z.string().trim().min(1).max(512),
})
export type VerifyStepUpDto = z.infer<typeof VerifyStepUpSchema>

/**
 * Ask for a fresh challenge on an action that was told to step up.
 *
 * `purpose` and `subjectId` are both required because a challenge is scoped to
 * exactly one action. Without that scoping, a challenge issued for a ₹100
 * transfer could be redeemed against a ₹100,000 one — the classic confused-deputy
 * shape, and the reason `StepUpService.verify` re-checks both.
 */
export const RequestStepUpSchema = z.object({
  purpose: StepUpPurposeSchema,
  subjectId: z.string().trim().min(1).max(200),
})
export type RequestStepUpDto = z.infer<typeof RequestStepUpSchema>
