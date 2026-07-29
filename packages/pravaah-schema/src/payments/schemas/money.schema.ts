import { z } from 'zod'

/**
 * The money primitives every M4 payload is built from.
 *
 * One rule governs this whole file: an amount is an INTEGER COUNT OF MINOR UNITS
 * (paise, cents) that crosses the wire as a decimal STRING. Not a float, not a
 * major-unit decimal, and not a JavaScript number.
 *
 * The string is the part people push back on, so the reasoning is worth stating.
 * `JSON.parse` produces a `number` for any numeric literal, so a rupee amount
 * that arrived as `1234.56` has already been through binary floating point
 * before a single line of our code runs, and there is no way to detect after the
 * fact whether the value we hold is the value that was sent. A digit string has
 * no such stage: it round-trips byte for byte, converts to `BigInt` exactly, and
 * fails loudly if a client ever sends `1e5` or `0.1`.
 */

// ── currencies ──────────────────────────────────────────────────────────────
/**
 * The currencies this corridor supports, with their minor-unit exponent.
 *
 * The exponent is data, not a constant `100`. Not every currency has two decimal
 * places — JPY has none, KWD has three — so a hard-coded 100 is a bug waiting for
 * the first corridor that is not INR/SGD, and it would be a bug that silently
 * multiplies an amount by 100.
 */
export const SUPPORTED_CURRENCIES = {
  INR: { code: 'INR', exponent: 2, symbol: '₹', label: 'Indian Rupee' },
  SGD: { code: 'SGD', exponent: 2, symbol: 'S$', label: 'Singapore Dollar' },
} as const

export type CurrencyCode = keyof typeof SUPPORTED_CURRENCIES

export const CurrencySchema = z.enum(['INR', 'SGD'])

export function currencyExponent(code: string): number {
  const entry = SUPPORTED_CURRENCIES[code as CurrencyCode]
  if (!entry) throw new Error(`Unsupported currency: ${code}`)
  return entry.exponent
}

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return code in SUPPORTED_CURRENCIES
}

// ── amounts ─────────────────────────────────────────────────────────────────
/** Up to 18 digits — comfortably inside `BigInt`, and past any real payment. */
const MINOR_DIGITS = /^(0|[1-9][0-9]{0,17})$/

/**
 * A non-negative integer count of minor units.
 *
 * Accepts a digit string (canonical) or a safe integer for client convenience,
 * and NORMALISES to the string form. The normalisation matters beyond tidiness:
 * the idempotency key's request hash is taken over the parsed DTO, so `1000` and
 * `"1000"` must not hash differently — otherwise the same retry, sent by two
 * versions of the app, would be rejected as a key reused with a different body.
 */
export const MinorAmountSchema = z
  .union([
    z.string().trim().regex(MINOR_DIGITS, 'Amount must be integer minor units'),
    z
      .number()
      .int('Amount must be an integer number of minor units')
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => String(value))

export type MinorAmount = z.infer<typeof MinorAmountSchema>

/** A minor amount that must be strictly positive — every real transfer. */
export const PositiveMinorAmountSchema = MinorAmountSchema.refine(
  (value) => value !== '0',
  'Amount must be greater than zero',
)

// ── UPI identifiers ─────────────────────────────────────────────────────────
/**
 * A UPI ID / VPA — `name@psp`.
 *
 * Deliberately strict. A VPA is an address money is pushed to with no
 * confirmation step of its own, so a string that merely *looks* addressable is
 * the most dangerous input in the module: whitespace or a homoglyph that slips
 * through here becomes a transfer to somebody else. Lower-cased on parse,
 * because UPI handles are case-insensitive and two casings of one VPA must not
 * become two beneficiary rows with two separate cooling periods.
 */
export const VPA_REGEX = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$/

export const VpaSchema = z
  .string()
  .trim()
  .min(4)
  .max(256)
  .toLowerCase()
  .regex(VPA_REGEX, 'Not a valid UPI ID (expected name@psp)')

/** IFSC — 4 letters, a mandatory `0`, then 6 alphanumerics. */
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/

export const IfscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(IFSC_REGEX, 'Not a valid IFSC code')

/** Indian bank account numbers run 9–18 digits. */
export const AccountNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{9,18}$/, 'Account number must be 9–18 digits')

/** Merchant Category Code — 4 digits, ISO 18245. */
export const MccSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4}$/, 'MCC must be 4 digits')

/**
 * The payer's note.
 *
 * UPI caps this at 50 characters and rejects most punctuation; the rail will
 * silently mangle or reject anything else, and a payment that fails at the PSP
 * because of a stray emoji is a failure the user cannot diagnose.
 */
export const NarrationSchema = z
  .string()
  .trim()
  .max(50)
  .regex(/^[a-zA-Z0-9 .,\-_/@&()]*$/, 'Note contains unsupported characters')

/**
 * An idempotency key. A client-chosen, high-entropy string.
 *
 * Minimum 8 characters is a floor against the failure mode where a client sends
 * `"1"`: short keys collide across users' intents, and a colliding key does not
 * error — it silently replays somebody's earlier response.
 */
export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key has unsupported characters')

// ── purpose codes ───────────────────────────────────────────────────────────
/**
 * Purpose codes. Cross-border entries are RBI/FEMA purpose codes and are
 * MANDATORY on the wire; domestic ones are ours.
 *
 * The code is recorded on every transaction because a cross-border payment
 * without a declared purpose is not a compliance gap to close later — it is a
 * payment a regulated PSP is not permitted to make at all.
 */
export const PURPOSE_CODES = {
  // domestic
  P2P_TRANSFER: { code: 'P2P_TRANSFER', label: 'Money transfer', crossBorder: false },
  MERCHANT_PAYMENT: { code: 'MERCHANT_PAYMENT', label: 'Merchant payment', crossBorder: false },
  LOAN_DISBURSAL: { code: 'LOAN_DISBURSAL', label: 'Loan disbursal', crossBorder: false },
  LOAN_REPAYMENT: { code: 'LOAN_REPAYMENT', label: 'Loan repayment', crossBorder: false },
  INSURANCE_PREMIUM: { code: 'INSURANCE_PREMIUM', label: 'Insurance premium', crossBorder: false },
  WALLET_TOPUP: { code: 'WALLET_TOPUP', label: 'Add money', crossBorder: false },
  WALLET_WITHDRAWAL: { code: 'WALLET_WITHDRAWAL', label: 'Withdraw to bank', crossBorder: false },
  // cross-border (RBI purpose codes)
  P1301: { code: 'P1301', label: 'Family maintenance / remittance to family', crossBorder: true },
  P1302: { code: 'P1302', label: 'Personal gift or donation', crossBorder: true },
  P0103: { code: 'P0103', label: 'Travel — personal', crossBorder: true },
  P1007: { code: 'P1007', label: 'Education-related expenses', crossBorder: true },
  P1006: { code: 'P1006', label: 'Medical treatment expenses', crossBorder: true },
  P1401: { code: 'P1401', label: 'Loan repayment (cross-border)', crossBorder: true },
} as const

export type PurposeCode = keyof typeof PURPOSE_CODES

export const PurposeCodeSchema = z.enum([
  'P2P_TRANSFER',
  'MERCHANT_PAYMENT',
  'LOAN_DISBURSAL',
  'LOAN_REPAYMENT',
  'INSURANCE_PREMIUM',
  'WALLET_TOPUP',
  'WALLET_WITHDRAWAL',
  'P1301',
  'P1302',
  'P0103',
  'P1007',
  'P1006',
  'P1401',
])

export function isCrossBorderPurpose(code: string): boolean {
  return PURPOSE_CODES[code as PurposeCode]?.crossBorder ?? false
}

// ── the caps, as published ──────────────────────────────────────────────────
/**
 * Regulatory limits, in minor units.
 *
 * Shared with the clients so the app can warn BEFORE a user types an amount it
 * will have to reject — but the server is the only enforcer. A client-side cap is
 * a courtesy; `LimitService` is the control.
 *
 * The asymmetry is the headline: the cross-border cap is roughly one sixtieth of
 * the domestic one. UPI↔PayNow allows unlimited transaction COUNT but caps daily
 * VALUE at SGD 1,000, while domestic UPI allows ₹1,00,000 per day and caps the
 * count instead. Any code that treats the two rails alike is wrong by 60×.
 */
export const UPI_LIMITS = {
  DOMESTIC: {
    /** ₹1,00,000 per day, in paise. */
    DAILY_VALUE_MINOR: '10000000',
    /** ₹1,00,000 in a single P2P transaction. */
    PER_TXN_VALUE_MINOR: '10000000',
    /** NPCI caps the NUMBER of P2P transactions per day, not only the value. */
    DAILY_COUNT: 20,
    /**
     * ₹5,000 to a beneficiary added in the last 24 hours.
     *
     * The single highest-yield anti-fraud control in UPI: nearly every
     * social-engineering scam ends in a large transfer to an address the victim
     * saved minutes earlier, and a sliding-window cap is what turns a life's
     * savings into ₹5,000.
     */
    NEW_BENEFICIARY_24H_MINOR: '500000',
    CURRENCY: 'INR',
  },
  CROSS_BORDER: {
    /** SGD 1,000 per day, in cents. Set by the RBI/MAS linkage, not by us. */
    DAILY_VALUE_MINOR: '100000',
    PER_TXN_VALUE_MINOR: '100000',
    /** The linkage caps value only — the number of transfers is unlimited. */
    DAILY_COUNT: 0,
    NEW_BENEFICIARY_24H_MINOR: '100000',
    /** LRS: USD 250,000 per financial year, carried here as SGD ≈ 337,500.00. */
    ANNUAL_LRS_MINOR: '33750000',
    CURRENCY: 'SGD',
  },
} as const

/**
 * How long a quoted FX rate stands.
 *
 * Short on purpose. The window is the platform's own market exposure: every
 * second between quoting and submitting is a second the rate can move against
 * whoever bears it. 90 seconds is long enough to read a confirmation screen and
 * short enough that the position stays small.
 */
export const FX_QUOTE_TTL_MS = 90_000

/** UPI collect requests are short-lived; an unanswered one must expire, not linger. */
export const COLLECT_TTL_MS = 300_000

/** A dynamic (amount-bearing) QR is a payment instruction with a short life. */
export const DYNAMIC_QR_TTL_MS = 900_000
