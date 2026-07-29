import { z } from 'zod'

import {
  CurrencySchema,
  IdempotencyKeySchema,
  NarrationSchema,
  PositiveMinorAmountSchema,
  PurposeCodeSchema,
  VpaSchema,
} from '../schemas/money.schema'
import { CollectStatusSchema } from '../schemas/payment-enums.schema'

/**
 * Request money — a UPI collect.
 *
 * The mirror image of a transfer: our user is the PAYEE, and the money is pulled
 * from a payer who must approve it in their own PSP app. Two consequences run
 * through the whole flow:
 *
 *  - We never touch the payer's credentials. There is no reserve to take on our
 *    side, because the funds are not ours to lock; the transaction sits in
 *    AWAITING_APPROVAL until the rail says the payer said yes.
 *  - A collect is an authorisation request sitting in a stranger's app, so it
 *    MUST expire. One that can still be approved days later would debit against
 *    a balance and an intent that have both moved on.
 *
 * Cross-border is deliberately absent: the UPI↔PayNow linkage is payer-initiated
 * only, so there is no such thing as a cross-border collect to raise.
 */
export const CreateCollectSchema = z.object({
  /** The payer's UPI ID. Collect is address-based — no account number exists here. */
  payerHandle: VpaSchema,
  amountMinor: PositiveMinorAmountSchema,
  currency: CurrencySchema,
  purposeCode: PurposeCodeSchema,
  narration: NarrationSchema.optional(),
  /**
   * How long the payer has, in seconds. Bounded at both ends: too short and a
   * payer who steps away misses it, too long and the request outlives its intent.
   */
  expiresInSeconds: z.coerce.number().int().min(60).max(1800).default(300),
})
export type CreateCollectDto = z.infer<typeof CreateCollectSchema>

/**
 * The PAYER's answer to a collect raised against them.
 *
 * `approve: true` authorises a debit — it is not a state update, it is a payment
 * instruction, so it carries an idempotency key like any other mutation. What it
 * does NOT carry is a UPI PIN: authorisation happens in the bank/NPCI secure
 * component and the credential never enters our process. This endpoint records
 * the decision and hands the debit to the rail.
 */
export const RespondCollectSchema = z.object({
  approve: z.boolean(),
  /** Required on approval — the amount the payer saw, as a cross-check. */
  expectedAmountMinor: PositiveMinorAmountSchema.optional(),
  declineReason: z.string().trim().max(200).optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
})
export type RespondCollectDto = z.infer<typeof RespondCollectSchema>

export const CollectListQuerySchema = z.object({
  status: CollectStatusSchema.optional(),
  /**
   * `RAISED` — collects this user asked for (they are the payee).
   * `RECEIVED` — collects raised against this user (they are the payer).
   *
   * One list would be actively dangerous: "you owe ₹500" and "you are owed ₹500"
   * are opposite facts, and a UI that mixed them would have people paying money
   * they were expecting to receive.
   */
  side: z.enum(['RAISED', 'RECEIVED']).default('RAISED'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type CollectListQueryDto = z.infer<typeof CollectListQuerySchema>
