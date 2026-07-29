import { z } from 'zod'

import {
  CurrencySchema,
  MccSchema,
  MinorAmountSchema,
  NarrationSchema,
  PositiveMinorAmountSchema,
  PurposeCodeSchema,
  isCrossBorderPurpose,
} from '../schemas/money.schema'
import {
  TransferTypeSchema,
  TxnStatusSchema,
  TxnTypeSchema,
} from '../schemas/payment-enums.schema'

/**
 * Ask for a price.
 *
 * `POST /payments/quote` returns a locked, single-use {@link FxQuote} carrying the
 * complete breakdown — rate, fee, tax, what leaves the wallet, what the
 * beneficiary receives — valid for 90 seconds. Every transfer is then submitted
 * against a quote id.
 *
 * That indirection is the point, and it applies to DOMESTIC transfers too, where
 * there is no rate to lock. A quote is really a PRICED INTENT: the exact numbers
 * the user was shown, frozen server-side. Without it, the app displays one total
 * and the server independently derives another from a fee table that may have been
 * reloaded in between — and the user is charged a figure they never agreed to.
 */
export const QuoteRequestSchema = z
  .object({
    sourceCurrency: CurrencySchema,
    destCurrency: CurrencySchema,
    /**
     * Quote from the SEND side or the RECEIVE side.
     *
     * Both directions are genuinely needed: a migrant sending money home thinks
     * in "they must receive ₹20,000", while someone paying a bill thinks in "I
     * am sending S$50". Making the client reverse-engineer the other side means
     * it re-implements our rounding, and it will get it wrong in the last paisa.
     */
    mode: z.enum(['SOURCE', 'DEST']).default('SOURCE'),
    /** Interpreted per `mode`: the amount to send, or the amount to receive. */
    amountMinor: PositiveMinorAmountSchema,
    type: TransferTypeSchema,
    purposeCode: PurposeCodeSchema,
  })
  /**
   * The purpose code must match the corridor the currencies imply.
   *
   * A cross-border transfer carries an RBI/FEMA purpose code because a regulated
   * PSP may not move money abroad without one; a domestic transfer must NOT
   * carry one, because filing a FEMA purpose against a rupee-to-rupee payment
   * misreports it. Checked here so the mismatch is a 400 at the quote — the
   * first moment we know both currencies — rather than a rejection at the rail
   * after the user has already confirmed.
   */
  .refine(
    (v) =>
      isCrossBorderPurpose(v.purposeCode) ===
      (v.sourceCurrency !== v.destCurrency),
    {
      message:
        'Purpose code does not match the corridor: cross-border transfers need an RBI purpose code, domestic ones must not use it',
      path: ['purposeCode'],
    },
  )
export type QuoteRequestDto = z.infer<typeof QuoteRequestSchema>

/**
 * Create a transfer.
 *
 * Carries no amount of its own — the amount lives on the quote. What it carries
 * instead are three CONFIRMATIONS, each closing a specific failure mode:
 *
 *  - `expectedTotalDebitMinor` — the number printed on the button the user
 *    pressed. If the quote says something else, the client was showing a stale
 *    screen and the request is rejected rather than silently charged correctly.
 *  - `confirmedRegisteredName` — the payee name the user actually read. NPCI
 *    mandates displaying the bank-held name; comparing it back is what turns that
 *    display into a control instead of decoration.
 *  - `confirmedName` — an explicit, non-defaultable acknowledgement.
 */
export const CreateTransferSchema = z.object({
  beneficiaryId: z.uuid(),
  /** The locked, single-use price. See {@link QuoteRequestSchema}. */
  quoteId: z.uuid(),

  type: TransferTypeSchema,
  purposeCode: PurposeCodeSchema,
  narration: NarrationSchema.optional(),
  /** Merchant Category Code. Required for P2M by the rail, absent for P2P. */
  mcc: MccSchema.optional(),

  /**
   * The total the user saw. A cross-check, not an instruction: the server never
   * charges this number, it only refuses to proceed when the quote disagrees.
   */
  expectedTotalDebitMinor: MinorAmountSchema,

  /**
   * The bank-registered payee name the user confirmed, verbatim.
   *
   * Compared against the name on file. A mismatch means the beneficiary was
   * re-verified between the confirmation screen and this request — an unlikely
   * but real window in which the payer's confirmation refers to a different
   * person than the one about to be paid.
   */
  confirmedRegisteredName: z.string().trim().min(1).max(120),
  /** Must be explicitly `true`. There is no default, on purpose. */
  confirmedName: z.literal(true),

  /**
   * The device that authorised this. Bound in M6, and read by the risk engine:
   * a large cross-border transfer from a device first seen an hour ago is the
   * signature of an account takeover.
   */
  deviceId: z.uuid().optional(),

  /**
   * Coarse location — a country or country-region code, never a coordinate.
   *
   * Read by M6's geo-velocity check: two different countries inside an hour is
   * physically impossible, so one of the two sessions is not the account holder.
   * "IN-MH" is enough to establish that; a latitude is not needed and would make
   * this a location-tracking field under a much heavier DPDP consent and
   * retention regime.
   */
  geoHint: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}(-[A-Z0-9]{2,3})?$/, 'Expected a code like "SG" or "IN-MH"')
    .optional(),

  /**
   * The M3 presentation that justified a DISBURSAL — the audit link between
   * "a lender trusted the passport" and "the lender paid out".
   */
  passportRef: z.string().trim().max(200).optional(),
})
export type CreateTransferDto = z.infer<typeof CreateTransferSchema>

export const TransferListQuerySchema = z.object({
  status: TxnStatusSchema.optional(),
  type: TxnTypeSchema.optional(),
  beneficiaryId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type TransferListQueryDto = z.infer<typeof TransferListQuerySchema>

/**
 * Add money to the wallet: a UPI collect raised against the user's OWN account.
 *
 * Its own endpoint rather than a transfer `type`, because the counterparty must
 * be an own-account beneficiary and that check belongs on the route that can
 * enforce it.
 */
export const TopupSchema = z.object({
  /** An own-account beneficiary (`isSelf`). Verified server-side. */
  sourceBeneficiaryId: z.uuid(),
  amountMinor: PositiveMinorAmountSchema,
  currency: CurrencySchema,
})
export type TopupDto = z.infer<typeof TopupSchema>

/** Move wallet funds out to the user's own verified bank account. */
export const WithdrawSchema = z.object({
  destBeneficiaryId: z.uuid(),
  amountMinor: PositiveMinorAmountSchema,
  currency: CurrencySchema,
})
export type WithdrawDto = z.infer<typeof WithdrawSchema>

/**
 * Retry a transfer that failed.
 *
 * Mints a NEW transaction rather than resurrecting the failed one, which is why
 * it takes a fresh idempotency key. Re-driving a FAILED row would mean a single
 * transaction id had two rail references and two ledger histories, and no
 * reconciliation could ever say which one the rail was talking about.
 */
export const RetryTransferSchema = z.object({
  /** Confirm again — the payee's registered name may have changed since. */
  confirmedRegisteredName: z.string().trim().min(1).max(120),
  confirmedName: z.literal(true),
  /** A FRESH quote. The original's price expired with it. */
  quoteId: z.uuid(),
  expectedTotalDebitMinor: MinorAmountSchema,
  deviceId: z.uuid().optional(),
})
export type RetryTransferDto = z.infer<typeof RetryTransferSchema>
