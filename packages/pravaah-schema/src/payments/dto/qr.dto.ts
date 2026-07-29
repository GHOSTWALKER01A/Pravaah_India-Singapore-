import { z } from 'zod'

import {
  CurrencySchema,
  MccSchema,
  NarrationSchema,
  PositiveMinorAmountSchema,
  PurposeCodeSchema,
} from '../schemas/money.schema'
import { QrKindSchema } from '../schemas/payment-enums.schema'

/**
 * Mint a UPI QR.
 *
 * The two kinds are genuinely different objects wearing the same picture, and
 * treating them alike is a real vulnerability:
 *
 *  - STATIC is amount-less and reusable — the sticker on a shopfront. It is not a
 *    payment instruction (the payer types the amount), so it needs no signature
 *    and cannot be "spent".
 *  - DYNAMIC carries an amount, so it IS a payment instruction. It is signed,
 *    short-lived, and consumed on first success. An unsigned amount-bearing QR
 *    can be edited in transit: change `am=1.00` to `am=100.00` in a forwarded
 *    image and the payer's app faithfully presents the attacker's number.
 */
export const CreateQrSchema = z
  .object({
    kind: QrKindSchema,
    /** Required for DYNAMIC, forbidden for STATIC — enforced below. */
    amountMinor: PositiveMinorAmountSchema.optional(),
    currency: CurrencySchema.default('INR'),
    purposeCode: PurposeCodeSchema,
    mcc: MccSchema.optional(),
    narration: NarrationSchema.optional(),
    /** Seconds. DYNAMIC only; capped so a stale instruction cannot be paid. */
    expiresInSeconds: z.coerce.number().int().min(60).max(3600).optional(),
  })
  .refine((v) => v.kind === 'STATIC' || v.amountMinor !== undefined, {
    message: 'A dynamic QR must carry an amount',
    path: ['amountMinor'],
  })
  .refine((v) => v.kind === 'DYNAMIC' || v.amountMinor === undefined, {
    message:
      'A static QR must not carry an amount — the payer enters it, which is what makes it reusable',
    path: ['amountMinor'],
  })
export type CreateQrDto = z.infer<typeof CreateQrSchema>

/**
 * Decode a scanned `upi://pay?...` string.
 *
 * Parsed server-side rather than in the app, so one implementation decides what a
 * scanned code means. A QR is attacker-supplied input that resolves to a payee,
 * and two parsers — ours and the app's — that disagree about, say, a duplicated
 * `pa` parameter are two different answers to "who gets the money".
 */
export const ParseQrSchema = z.object({
  payload: z.string().trim().min(8).max(2048),
})
export type ParseQrDto = z.infer<typeof ParseQrSchema>

/**
 * Pay a scanned QR.
 *
 * Takes the QR payload plus the same confirmations a transfer takes. The amount
 * still comes from a quote: a scanned code proposes an amount, it does not get to
 * set the price.
 */
export const PayQrSchema = z.object({
  payload: z.string().trim().min(8).max(2048),
  quoteId: z.uuid(),
  expectedTotalDebitMinor: z
    .string()
    .trim()
    .regex(/^(0|[1-9][0-9]{0,17})$/),
  /** For a STATIC QR the payer chose the amount; it must match the quote. */
  confirmedRegisteredName: z.string().trim().min(1).max(120),
  confirmedName: z.literal(true),
  narration: NarrationSchema.optional(),
  deviceId: z.uuid().optional(),
})
export type PayQrDto = z.infer<typeof PayQrSchema>
