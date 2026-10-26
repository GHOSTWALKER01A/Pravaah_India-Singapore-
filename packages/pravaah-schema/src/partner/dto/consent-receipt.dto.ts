import { z } from 'zod'

import { ConsentReceiptStatusSchema } from '../schemas/partner-enums.schema'

/** Query for the holder's "who has seen my passport" list. */
export const ConsentReceiptQuerySchema = z.object({
  status: ConsentReceiptStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type ConsentReceiptQueryDto = z.infer<typeof ConsentReceiptQuerySchema>

/**
 * Withdraw a share. The reason is optional and never forwarded to the partner —
 * why a holder changed their mind is not the partner's business, exactly as M3
 * never forwards a decline reason.
 */
export const WithdrawConsentReceiptSchema = z.object({
  reason: z.string().trim().max(300).optional(),
})
export type WithdrawConsentReceiptDto = z.infer<typeof WithdrawConsentReceiptSchema>
