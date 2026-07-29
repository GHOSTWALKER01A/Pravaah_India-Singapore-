import { createHmac, timingSafeEqual } from 'crypto'

import { isSupportedCurrency } from '@pravaah/schema'

import { majorToMinor, fromMinor } from '@/modules/payments/money.util'
import { parseVpa } from '@/modules/payments/vpa.util'

/**
 * UPI deep links / QR codes — the `upi://pay?...` intent string.
 *
 * Pure, and deliberately server-side. A QR is ATTACKER-SUPPLIED INPUT that
 * resolves to a payee and an amount: whoever prints the code chooses every byte
 * of it. Two parsers that disagree about a malformed one — ours and the app's —
 * are two different answers to "who gets the money", so there is exactly one
 * parser and the app asks it.
 */

export const UPI_SCHEME = 'upi://pay'

/** The parameters the UPI deep-linking specification defines. */
export const UPI_PARAMS = {
  PAYEE_ADDRESS: 'pa',
  PAYEE_NAME: 'pn',
  MERCHANT_CODE: 'mc',
  TXN_ID: 'tid',
  TXN_REF: 'tr',
  NOTE: 'tn',
  AMOUNT: 'am',
  MIN_AMOUNT: 'mam',
  CURRENCY: 'cu',
  INVOICE_URL: 'url',
  MODE: 'mode',
  ORG_ID: 'orgid',
  SIGN: 'sign',
} as const

export interface UpiIntent {
  payeeAddress: string
  payeeName?: string
  /** Minor units. Absent for a static (amount-less) QR. */
  amountMinor?: bigint
  currency: string
  merchantCode?: string
  txnRef?: string
  note?: string
  invoiceUrl?: string
  signature?: string
}

// ── build ───────────────────────────────────────────────────────────────────
/**
 * Encode an intent.
 *
 * The amount goes out in MAJOR units with the currency's full precision, because
 * that is what the specification says and what every payer app parses. It is
 * derived from the minor-unit integer we hold, never from a float — the conversion
 * is the only place major units exist, and it happens once, here.
 */
export function buildUpiIntent(intent: UpiIntent): string {
  const parsed = parseVpa(intent.payeeAddress)
  if (!parsed) {
    throw new Error(`buildUpiIntent: invalid payee address`)
  }
  if (!isSupportedCurrency(intent.currency)) {
    throw new Error(`buildUpiIntent: unsupported currency ${intent.currency}`)
  }

  const params: Array<[string, string]> = [
    [UPI_PARAMS.PAYEE_ADDRESS, parsed.vpa],
  ]
  if (intent.payeeName) params.push([UPI_PARAMS.PAYEE_NAME, intent.payeeName])
  if (intent.amountMinor !== undefined) {
    if (intent.amountMinor <= 0n) {
      throw new Error('buildUpiIntent: amount must be positive when present')
    }
    params.push([
      UPI_PARAMS.AMOUNT,
      fromMinor(intent.amountMinor, intent.currency),
    ])
  }
  params.push([UPI_PARAMS.CURRENCY, intent.currency])
  if (intent.merchantCode) {
    params.push([UPI_PARAMS.MERCHANT_CODE, intent.merchantCode])
  }
  if (intent.txnRef) params.push([UPI_PARAMS.TXN_REF, intent.txnRef])
  if (intent.note) params.push([UPI_PARAMS.NOTE, intent.note])
  if (intent.invoiceUrl)
    params.push([UPI_PARAMS.INVOICE_URL, intent.invoiceUrl])
  if (intent.signature) params.push([UPI_PARAMS.SIGN, intent.signature])

  const query = params
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  return `${UPI_SCHEME}?${query}`
}

// ── parse ───────────────────────────────────────────────────────────────────
export type UpiParseResult =
  { ok: true; intent: UpiIntent } | { ok: false; reason: string }

/**
 * Decode a scanned intent string, strictly.
 *
 * The strictness is the feature, and one rule deserves singling out: a DUPLICATED
 * PARAMETER IS REJECTED. `upi://pay?pa=shop@psp&pa=attacker@psp` is a real attack,
 * and it works because implementations disagree about which value wins —
 * `URLSearchParams.get` returns the first, some parsers keep the last, and a
 * preview screen rendering one while the payment uses the other shows the payer a
 * payee they are not paying. There is no correct value to pick, so nothing is
 * picked.
 */
export function parseUpiIntent(payload: string): UpiParseResult {
  const raw = payload.trim()
  if (raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: 'Payload is empty or too long' }
  }

  // The scheme is matched case-insensitively (`UPI://PAY` occurs in the wild) but
  // must be present in full — a bare query string is not a UPI intent.
  const match = /^upi:\/\/pay\?(.+)$/i.exec(raw)
  if (!match?.[1]) {
    return { ok: false, reason: 'Not a UPI payment link' }
  }

  const seen = new Map<string, string>()
  for (const pair of match[1].split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    // A valueless flag is malformed here: every UPI parameter is a key=value.
    if (eq <= 0) return { ok: false, reason: 'Malformed parameter in QR' }

    const key = pair.slice(0, eq).toLowerCase()
    let value: string
    try {
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
    } catch {
      return { ok: false, reason: 'QR contains invalid encoding' }
    }

    if (seen.has(key)) {
      return {
        ok: false,
        reason: `QR repeats the "${key}" parameter — refusing to guess which one is the real payee`,
      }
    }
    seen.set(key, value)
  }

  const payeeAddress = seen.get(UPI_PARAMS.PAYEE_ADDRESS)
  if (!payeeAddress) return { ok: false, reason: 'QR has no payee address' }
  const parsedVpa = parseVpa(payeeAddress)
  if (!parsedVpa)
    return { ok: false, reason: 'QR payee address is not a valid UPI ID' }

  const currency = (seen.get(UPI_PARAMS.CURRENCY) ?? 'INR').toUpperCase()
  if (!isSupportedCurrency(currency)) {
    return { ok: false, reason: `Unsupported currency ${currency}` }
  }

  let amountMinor: bigint | undefined
  const rawAmount = seen.get(UPI_PARAMS.AMOUNT)
  if (rawAmount !== undefined && rawAmount !== '') {
    try {
      amountMinor = majorToMinor(rawAmount, currency)
    } catch {
      return { ok: false, reason: 'QR amount is not a valid amount' }
    }
    if (amountMinor <= 0n) {
      return { ok: false, reason: 'QR amount must be greater than zero' }
    }
  }

  const merchantCode = seen.get(UPI_PARAMS.MERCHANT_CODE)
  if (merchantCode !== undefined && !/^[0-9]{4}$/.test(merchantCode)) {
    return { ok: false, reason: 'QR merchant category code is malformed' }
  }

  return {
    ok: true,
    intent: {
      payeeAddress: parsedVpa.vpa,
      payeeName: seen.get(UPI_PARAMS.PAYEE_NAME),
      amountMinor,
      currency,
      merchantCode,
      txnRef: seen.get(UPI_PARAMS.TXN_REF),
      note: seen.get(UPI_PARAMS.NOTE),
      invoiceUrl: seen.get(UPI_PARAMS.INVOICE_URL),
      signature: seen.get(UPI_PARAMS.SIGN),
    },
  }
}

// ── signing (dynamic QRs) ───────────────────────────────────────────────────
/**
 * The bytes a dynamic QR's signature covers.
 *
 * Ordered and length-prefixed rather than concatenated, so no combination of
 * field values can be rearranged into the same string. Concatenating with a
 * separator is the version that breaks: a note containing the separator lets an
 * attacker shift the boundary between fields and produce a different intent with
 * an identical signing payload.
 */
function signingPayload(fields: {
  ref: string
  payeeAddress: string
  amountMinor: bigint
  currency: string
  expiresAt: Date
}): string {
  const parts = [
    fields.ref,
    fields.payeeAddress,
    fields.amountMinor.toString(),
    fields.currency,
    fields.expiresAt.toISOString(),
  ]
  return parts.map((part) => `${part.length}:${part}`).join('|')
}

/**
 * Sign an amount-bearing QR.
 *
 * A dynamic QR IS a payment instruction, so an unsigned one can be edited in
 * transit: change `am=1.00` to `am=100.00` in a forwarded image and the payer's
 * app faithfully presents the attacker's number, with the merchant's real VPA
 * beside it to make it convincing. A static QR carries no amount and therefore
 * needs no signature — the payer types the figure themselves.
 */
export function signQr(
  secret: string,
  fields: Parameters<typeof signingPayload>[0],
): string {
  return createHmac('sha256', secret)
    .update(signingPayload(fields))
    .digest('base64url')
}

/** Verify a dynamic QR's signature in constant time. */
export function verifyQrSignature(
  secret: string,
  fields: Parameters<typeof signingPayload>[0],
  signature: string,
): boolean {
  const expected = Buffer.from(signQr(secret, fields), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
  // first — a length difference is not secret, the contents are.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
