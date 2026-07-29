import { currencyExponent } from '@pravaah/schema'

/**
 * Integer money arithmetic. Pure, no I/O, exhaustively unit-tested.
 *
 * Every amount in M4 passes through this file, and it exists because of one fact:
 * `0.1 + 0.2 !== 0.3` in IEEE-754, and in a ledger that discrepancy is a real
 * rupee that has to come from somewhere. So there is no `number` in any signature
 * that represents money — only `bigint` counts of minor units (paise, cents), and
 * even the FX rate is an integer scaled by 1e8.
 *
 * The other reason this file is separate: rounding is a POLICY, not an accident.
 * Every division here takes an explicit {@link RoundingMode}, and each caller has
 * a documented reason for the mode it picks. A default rounding mode would mean
 * the direction of the half-paisa is decided by whoever wrote the call site last.
 */

/**
 * DOWN   truncate toward zero
 * UP     away from zero on any remainder
 * HALF_UP  ties go up — the commercial convention for fees
 * HALF_EVEN  ties go to the even neighbour ("banker's rounding"); over many
 *            roundings the bias cancels instead of accumulating upward
 */
export type RoundingMode = 'DOWN' | 'UP' | 'HALF_UP' | 'HALF_EVEN'

/** The scale of the FX rate: `rateE8 = rate × 1e8`. */
export const RATE_SCALE = 100_000_000n
export const RATE_DECIMALS = 8

/** Basis points: 10,000 bps = 100%. */
export const BPS_SCALE = 10_000n

// ── primitives ──────────────────────────────────────────────────────────────
/**
 * `numerator / denominator`, rounded per `mode`.
 *
 * Rejects negatives rather than defining a behaviour for them. Every amount in
 * this module is non-negative by construction — direction lives in
 * `LedgerDirection`, not in the sign of a number — so a negative reaching here
 * means a caller has confused an amount with a delta, and rounding it silently
 * would bury the bug in a plausible-looking figure.
 */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator <= 0n) {
    throw new Error('divRound: denominator must be positive')
  }
  if (numerator < 0n) {
    throw new Error('divRound: negative amounts are not representable')
  }

  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient

  switch (mode) {
    case 'DOWN':
      return quotient
    case 'UP':
      return quotient + 1n
    case 'HALF_UP':
      return remainder * 2n >= denominator ? quotient + 1n : quotient
    case 'HALF_EVEN': {
      const twice = remainder * 2n
      if (twice > denominator) return quotient + 1n
      if (twice < denominator) return quotient
      return quotient % 2n === 0n ? quotient : quotient + 1n
    }
  }
}

/**
 * `value × multiplier / divisor` in one step.
 *
 * One step matters: multiplying first keeps full precision, whereas dividing
 * first throws away the remainder before the multiplication can use it. The
 * classic version of this bug — `amount * (rate / SCALE)` — rounds the rate to an
 * integer and produces an answer that is wrong by percent, not by paise.
 */
export function mulDivRound(
  value: bigint,
  multiplier: bigint,
  divisor: bigint,
  mode: RoundingMode,
): bigint {
  return divRound(value * multiplier, divisor, mode)
}

/** A percentage expressed in basis points. */
export function applyBps(
  amountMinor: bigint,
  bps: number,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error('applyBps: bps must be a non-negative integer')
  }
  if (bps === 0) return 0n
  return mulDivRound(amountMinor, BigInt(bps), BPS_SCALE, mode)
}

/** 10^exponent, as a BigInt. */
export function minorScale(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 12) {
    throw new Error(`minorScale: unsupported exponent ${exponent}`)
  }
  return 10n ** BigInt(exponent)
}

// ── parsing / formatting ────────────────────────────────────────────────────
const MINOR_STRING = /^(0|[1-9][0-9]{0,24})$/

/**
 * Parse a canonical minor-unit string (or a `bigint`) into a `bigint`.
 *
 * A `number` is accepted only if it is a safe integer, and this asymmetry is
 * intentional: `1500` is unambiguous, `15.5` is a major-unit amount that has
 * arrived in a minor-unit field, and treating it as 15 paise (or 1550, or 16)
 * would be a guess. It throws instead.
 */
export function toMinor(value: string | bigint | number): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('toMinor: amount must be non-negative')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `toMinor: ${value} is not a non-negative safe integer of minor units`,
      )
    }
    return BigInt(value)
  }
  const trimmed = value.trim()
  if (!MINOR_STRING.test(trimmed)) {
    throw new Error(`toMinor: "${value}" is not an integer minor-unit amount`)
  }
  return BigInt(trimmed)
}

/**
 * A major-unit decimal string (`"100.50"`) → minor units.
 *
 * Needed because two inputs we do not control speak major units: a scanned
 * `upi://pay?am=100.50` intent, and an FX feed. Parsed by string surgery for the
 * usual reason — `Math.round(parseFloat("1.005") * 100)` is `100`, not `101`, on
 * a value a user can trivially produce.
 *
 * MORE decimal places than the currency has is an error, not something to round.
 * A QR that says `am=100.999` for a rupee amount is either malformed or crafted,
 * and quietly turning it into ₹100.99 (or ₹101.00) resolves an ambiguity about
 * somebody's money by guessing.
 */
export function majorToMinor(value: string, currency: string): bigint {
  const trimmed = value.trim()
  if (!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/.test(trimmed)) {
    throw new Error(`majorToMinor: "${value}" is not a valid amount`)
  }
  const exponent = currencyExponent(currency)
  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > exponent) {
    throw new Error(
      `majorToMinor: ${currency} has ${exponent} decimal places, got "${value}"`,
    )
  }
  return (
    BigInt(whole) * minorScale(exponent) +
    BigInt(fraction.padEnd(exponent, '0') || '0')
  )
}

/**
 * Minor units → a plain major-unit decimal string (`"1234.50"`).
 *
 * No symbol, no grouping, always the currency's full number of decimal places.
 * This is the machine-readable projection — the one an API response carries and a
 * client can parse. Human formatting is {@link formatMoney}.
 */
export function fromMinor(amountMinor: bigint, currency: string): string {
  if (amountMinor < 0n) {
    throw new Error('fromMinor: amount must be non-negative')
  }
  const exponent = currencyExponent(currency)
  if (exponent === 0) return amountMinor.toString()

  const scale = minorScale(exponent)
  const whole = amountMinor / scale
  const fraction = amountMinor % scale
  return `${whole}.${fraction.toString().padStart(exponent, '0')}`
}

/**
 * Digit grouping, per currency convention.
 *
 * INR groups as 2,2,3 from the right — `₹12,34,567.89`, not `₹1,234,567.89`. It
 * is not cosmetic: an Indian user reading a Western-grouped figure has to count
 * digits to tell a lakh from a million, and this is the screen where they confirm
 * how much of their money leaves.
 */
export function formatMoney(amountMinor: bigint, currency: string): string {
  const plain = fromMinor(amountMinor, currency)
  const [whole = '0', fraction] = plain.split('.')

  const grouped = currency === 'INR' ? groupIndian(whole) : groupWestern(whole)
  const symbol =
    currency === 'INR' ? '₹' : currency === 'SGD' ? 'S$' : `${currency} `
  return `${symbol}${grouped}${fraction ? `.${fraction}` : ''}`
}

function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * A decimal rate string (`"61.425"`) → `rateE8`.
 *
 * Parsed by string surgery, not `parseFloat`. `parseFloat("61.425") * 1e8` is
 * `6142499999.999999` on some inputs, and a rate that is one hundred-millionth
 * low on every transfer is a systematic, invisible leak.
 */
export function rateE8FromString(rate: string): bigint {
  const trimmed = rate.trim()
  if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,8})?$/.test(trimmed)) {
    throw new Error(`rateE8FromString: "${rate}" is not a valid rate`)
  }
  const [whole = '0', fraction = ''] = trimmed.split('.')
  return (
    BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(RATE_DECIMALS, '0'))
  )
}

/** `rateE8` → a trimmed decimal string, for display and receipts. */
export function rateE8ToString(rateE8: bigint): string {
  if (rateE8 < 0n) throw new Error('rateE8ToString: rate must be non-negative')
  const whole = rateE8 / RATE_SCALE
  const fraction = (rateE8 % RATE_SCALE)
    .toString()
    .padStart(RATE_DECIMALS, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

// ── FX ──────────────────────────────────────────────────────────────────────
/**
 * Convert an amount at a locked rate.
 *
 * `dest = src × rateE8 × 10^(destExp − srcExp) / 1e8`, all in integers. The
 * exponent term is what makes a mixed-precision corridor correct: converting
 * paise (2dp) to a hypothetical 0dp currency without it would inflate the result
 * a hundredfold, and the bug would only appear on the corridor nobody tested.
 *
 * Rounds DOWN by default. The platform must never create money it did not
 * receive, and a half-cent invented on the destination side is money the FX
 * position has to fund out of nothing.
 */
export function convertMinor(params: {
  amountMinor: bigint
  rateE8: bigint
  sourceCurrency: string
  destCurrency: string
  mode?: RoundingMode
}): bigint {
  const { amountMinor, rateE8, sourceCurrency, destCurrency } = params
  if (rateE8 <= 0n) throw new Error('convertMinor: rate must be positive')

  const srcExp = currencyExponent(sourceCurrency)
  const dstExp = currencyExponent(destCurrency)
  const mode = params.mode ?? 'DOWN'

  // Fold the exponent difference into the numerator or the denominator so the
  // whole computation stays a single integer mul-div with no intermediate loss.
  if (dstExp >= srcExp) {
    return mulDivRound(
      amountMinor,
      rateE8 * minorScale(dstExp - srcExp),
      RATE_SCALE,
      mode,
    )
  }
  return mulDivRound(
    amountMinor,
    rateE8,
    RATE_SCALE * minorScale(srcExp - dstExp),
    mode,
  )
}

/**
 * The reverse: how much to send so the beneficiary receives exactly `destMinor`.
 *
 * Rounds UP, and the asymmetry with {@link convertMinor} is deliberate. When the
 * user has specified what the recipient must RECEIVE ("they need ₹20,000"),
 * rounding the source amount down would deliver one paisa short of the figure
 * they asked for — and "one paisa short" on a school fee is a rejected payment.
 * The extra unit is borne by the sender, who chose the target, and it is visible
 * on the quote before they agree.
 */
export function invertMinor(params: {
  destAmountMinor: bigint
  rateE8: bigint
  sourceCurrency: string
  destCurrency: string
  mode?: RoundingMode
}): bigint {
  const { destAmountMinor, rateE8, sourceCurrency, destCurrency } = params
  if (rateE8 <= 0n) throw new Error('invertMinor: rate must be positive')

  const srcExp = currencyExponent(sourceCurrency)
  const dstExp = currencyExponent(destCurrency)
  const mode = params.mode ?? 'UP'

  if (dstExp >= srcExp) {
    return mulDivRound(
      destAmountMinor,
      RATE_SCALE,
      rateE8 * minorScale(dstExp - srcExp),
      mode,
    )
  }
  return mulDivRound(
    destAmountMinor,
    RATE_SCALE * minorScale(srcExp - dstExp),
    rateE8,
    mode,
  )
}

/**
 * Apply our spread to a mid-market rate.
 *
 * The customer's rate is always WORSE than mid — that is what a spread is — so
 * the result is rounded DOWN: rounding a customer rate up would hand out a rate
 * better than the one we can actually cover in the market.
 */
export function applySpread(midRateE8: bigint, spreadBps: number): bigint {
  if (midRateE8 <= 0n) throw new Error('applySpread: rate must be positive')
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new Error(`applySpread: implausible spread ${spreadBps} bps`)
  }
  return mulDivRound(
    midRateE8,
    BPS_SCALE - BigInt(spreadBps),
    BPS_SCALE,
    'DOWN',
  )
}

// ── aggregation ─────────────────────────────────────────────────────────────
export function sumMinor(...amounts: bigint[]): bigint {
  return amounts.reduce((total, amount) => {
    if (amount < 0n) throw new Error('sumMinor: amounts must be non-negative')
    return total + amount
  }, 0n)
}

/**
 * `a − b`, refusing to go negative.
 *
 * Used where a negative result would mean an invariant has already broken —
 * refunding more than was settled, releasing more limit than was consumed. A
 * clamped `max(0, …)` would let the caller carry on with a plausible number and
 * hide the breach; the throw is the point.
 */
export function subMinor(a: bigint, b: bigint, context: string): bigint {
  if (b > a) {
    throw new Error(
      `${context}: would go negative (${a.toString()} − ${b.toString()})`,
    )
  }
  return a - b
}

/**
 * Serialise minor units for an API response.
 *
 * `BigInt` has no JSON representation — `JSON.stringify(1n)` throws — so every
 * amount leaves as a string. Deliberately NOT a number: a client that parses
 * `1000000000000000000` as a JS number gets a different value back, and this is
 * the one field in the payload where that must not be possible.
 */
export function serialiseMinor(amountMinor: bigint): string {
  return amountMinor.toString()
}

/** An amount, in every representation a client might need at once. */
export interface MoneyView {
  minor: string
  major: string
  formatted: string
  currency: string
}

export function moneyView(amountMinor: bigint, currency: string): MoneyView {
  return {
    minor: serialiseMinor(amountMinor),
    major: fromMinor(amountMinor, currency),
    formatted: formatMoney(amountMinor, currency),
    currency,
  }
}
