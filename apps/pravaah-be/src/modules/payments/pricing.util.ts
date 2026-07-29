import {
  FEE_POLICY,
  FX_SPREAD_BPS,
  GST_BPS,
  gstApplies,
} from '@/modules/payments/payments.config'
import {
  RATE_SCALE,
  applyBps,
  applySpread,
  convertMinor,
  invertMinor,
  sumMinor,
} from '@/modules/payments/money.util'
import { corridorFor } from '@/modules/payments/payments.state'

import { Corridor } from 'generated/prisma/client'

/**
 * Pricing — pure, and the single place a transfer's numbers are decided.
 *
 * One function computes every figure the user sees and every figure the ledger
 * posts, from one input. That is not tidiness: the alternative is the quote screen
 * deriving a total one way and the reserve posting deriving it another, agreeing
 * in testing and differing by a paisa on the amount that happens to round
 * differently. Whichever one is wrong, the user is charged something they did not
 * agree to, and the ledger cannot be balanced without deciding which number was
 * the truth.
 *
 * The result of {@link priceTransfer} is written verbatim onto the FxQuote, and the
 * orchestrator READS IT BACK rather than recomputing. Recomputation is the bug.
 */

export interface PricedTransfer {
  corridor: Corridor
  sourceCurrency: string
  destCurrency: string
  /** Market mid, before our spread. Shown so the spread is visible, not implied. */
  midRateE8: bigint
  /** The customer's rate: mid, less the spread. */
  rateE8: bigint
  spreadBps: number
  /** What is converted. */
  sourceAmount: bigint
  /** What the beneficiary receives. */
  destAmount: bigint
  feeMinor: bigint
  taxMinor: bigint
  /** What actually leaves the wallet: source + fee + tax. */
  totalDebitMinor: bigint
}

/**
 * Our fee, in the SOURCE currency.
 *
 * Charged on top of the transfer rather than deducted from it, because a
 * beneficiary who was promised ₹20,000 must receive ₹20,000. Deducting the fee
 * from the transferred amount is the other common model, and it is the one that
 * produces "they said they sent 20,000 but only 19,900 arrived" support tickets.
 */
export function feeFor(corridor: Corridor, sourceAmount: bigint): bigint {
  const schedule = FEE_POLICY[corridor]

  // No fee configured means no fee — not the floor. A `minMinor` that applied
  // when `bps` and `fixedMinor` are both zero would silently start charging for
  // domestic UPI, which NPCI does not permit.
  if (schedule.bps === 0 && schedule.fixedMinor === 0n) return 0n

  let fee =
    applyBps(sourceAmount, schedule.bps, 'HALF_UP') + schedule.fixedMinor
  if (fee < schedule.minMinor) fee = schedule.minMinor
  if (schedule.maxMinor > 0n && fee > schedule.maxMinor) fee = schedule.maxMinor
  return fee
}

/** GST on the fee. Zero when the fee is not an Indian supply — see the config. */
export function taxFor(feeMinor: bigint, feeCurrency: string): bigint {
  if (feeMinor === 0n) return 0n
  return gstApplies(feeCurrency) ? applyBps(feeMinor, GST_BPS, 'HALF_UP') : 0n
}

/**
 * Price a transfer from either side.
 *
 * `mode: 'SOURCE'` — "I am sending S$50, what do they get?"
 * `mode: 'DEST'`   — "They must receive ₹20,000, what does it cost me?"
 *
 * Both are real user intents and they round in opposite directions: the send side
 * rounds the received amount DOWN (never create money), the receive side rounds
 * the sent amount UP (never deliver short of the figure the user named). Doing
 * this in one place is what keeps the two consistent — a client reimplementing the
 * reverse would get the last minor unit wrong, and the quote and the debit would
 * disagree.
 */
export function priceTransfer(input: {
  mode: 'SOURCE' | 'DEST'
  amountMinor: bigint
  sourceCurrency: string
  destCurrency: string
  midRateE8: bigint
}): PricedTransfer {
  const { mode, amountMinor, sourceCurrency, destCurrency, midRateE8 } = input
  if (amountMinor <= 0n) {
    throw new Error('priceTransfer: amount must be positive')
  }

  const corridor = corridorFor(sourceCurrency, destCurrency)
  const sameCurrency = sourceCurrency === destCurrency

  /**
   * A same-currency transfer is never re-rated.
   *
   * Guarded rather than assumed: a bad rate row (or a feed returning `SGD_SGD:
   * 1.02`) would otherwise silently convert rupees into fewer rupees, and the
   * ledger would balance perfectly while the beneficiary was short. There is no
   * legitimate reason for a rate other than exactly 1 here.
   */
  if (sameCurrency && midRateE8 !== RATE_SCALE) {
    throw new Error(
      `priceTransfer: ${sourceCurrency}→${destCurrency} must be rated 1:1, got ${midRateE8.toString()}`,
    )
  }

  const spreadBps = sameCurrency ? 0 : FX_SPREAD_BPS[corridor]
  const rateE8 = sameCurrency ? RATE_SCALE : applySpread(midRateE8, spreadBps)

  let sourceAmount: bigint
  let destAmount: bigint

  if (mode === 'SOURCE') {
    sourceAmount = amountMinor
    destAmount = sameCurrency
      ? amountMinor
      : convertMinor({
          amountMinor,
          rateE8,
          sourceCurrency,
          destCurrency,
          mode: 'DOWN',
        })
  } else {
    destAmount = amountMinor
    sourceAmount = sameCurrency
      ? amountMinor
      : invertMinor({
          destAmountMinor: amountMinor,
          rateE8,
          sourceCurrency,
          destCurrency,
          mode: 'UP',
        })
  }

  /**
   * A rate so unfavourable, or an amount so small, that the converted result is
   * zero.
   *
   * Rejected rather than shipped. A transfer that debits the sender and credits
   * the beneficiary nothing is arithmetically balanced and completely wrong, and
   * it is exactly what rounding DOWN produces for sub-minor-unit amounts.
   */
  if (destAmount <= 0n) {
    throw new Error(
      'priceTransfer: amount is too small to convert — the beneficiary would receive nothing',
    )
  }

  const feeMinor = feeFor(corridor, sourceAmount)
  const taxMinor = taxFor(feeMinor, sourceCurrency)

  return {
    corridor,
    sourceCurrency,
    destCurrency,
    midRateE8: sameCurrency ? RATE_SCALE : midRateE8,
    rateE8,
    spreadBps,
    sourceAmount,
    destAmount,
    feeMinor,
    taxMinor,
    totalDebitMinor: sumMinor(sourceAmount, feeMinor, taxMinor),
  }
}
