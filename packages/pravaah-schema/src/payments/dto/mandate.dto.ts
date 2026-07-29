import { z } from 'zod'

import {
  CurrencySchema,
  NarrationSchema,
  PositiveMinorAmountSchema,
  PurposeCodeSchema,
} from '../schemas/money.schema'
import {
  MandateAmountRuleSchema,
  MandateFrequencySchema,
  MandateStatusSchema,
} from '../schemas/payment-enums.schema'

/**
 * Create a UPI AutoPay mandate — a standing permission to debit.
 *
 * The most dangerous object a user can create, because it is the only one that
 * moves money without them being present. Everything below is a bound on that:
 *
 *  - `maxAmountMinor` with `amountRule` is the ceiling the payer authorised. With
 *    `EXACT` a debit must equal it; with `MAX` the merchant may present less. No
 *    execution may ever exceed it, and that is checked per debit rather than at
 *    creation, because the merchant chooses the amount later.
 *  - `validUntil` is mandatory. A mandate with no end date is a permission the
 *    user has to remember to revoke, and they will not.
 *  - The pre-debit notification (NPCI: ≥24h before each debit) is not a field
 *    here because it is not optional — the scheduler refuses to execute a debit
 *    that was not notified.
 */
export const CreateMandateSchema = z
  .object({
    /** The payee. A mandate always names one fixed counterparty. */
    beneficiaryId: z.uuid(),
    frequency: MandateFrequencySchema,
    amountRule: MandateAmountRuleSchema.default('EXACT'),
    maxAmountMinor: PositiveMinorAmountSchema,
    currency: CurrencySchema,
    purposeCode: PurposeCodeSchema,
    narration: NarrationSchema.optional(),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
    /** Explicit acknowledgement of the ceiling and the schedule. */
    confirmedMandate: z.literal(true),
  })
  .refine((v) => v.validUntil > v.validFrom, {
    message: 'validUntil must be after validFrom',
    path: ['validUntil'],
  })
  .refine(
    (v) => v.validUntil.getTime() - v.validFrom.getTime() <= 5 * 365 * 86_400_000,
    {
      message: 'A mandate may not run longer than 5 years',
      path: ['validUntil'],
    },
  )
export type CreateMandateDto = z.infer<typeof CreateMandateSchema>

/**
 * Pause, resume, or revoke.
 *
 * Revocation is separated from pausing and is irreversible. A user who wants a
 * subscription to stop permanently should not be one mis-tap away from resuming
 * it, and a merchant should not be able to treat "paused" as "will come back".
 */
export const MandateActionSchema = z.object({
  action: z.enum(['PAUSE', 'RESUME', 'REVOKE']),
  reason: z.string().trim().max(200).optional(),
})
export type MandateActionDto = z.infer<typeof MandateActionSchema>

/**
 * Present a debit against an existing mandate (the merchant/payee side).
 *
 * `amountMinor` is required even for an `EXACT` mandate, so the presented figure
 * is always explicit and always checked against the authorised ceiling, rather
 * than inferred from the mandate and therefore never verified.
 */
export const PresentMandateDebitSchema = z.object({
  amountMinor: PositiveMinorAmountSchema,
  /**
   * When the debit is due. Must leave room for the 24-hour pre-debit notice, so
   * a merchant cannot schedule a debit for "now" and bypass the warning.
   */
  dueAt: z.coerce.date(),
  narration: NarrationSchema.optional(),
})
export type PresentMandateDebitDto = z.infer<typeof PresentMandateDebitSchema>

export const MandateListQuerySchema = z.object({
  status: MandateStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type MandateListQueryDto = z.infer<typeof MandateListQuerySchema>
