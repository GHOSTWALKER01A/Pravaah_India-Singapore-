import type { Posting } from '@/modules/payments/services/ledger.service'
import { convertMinor, sumMinor } from '@/modules/payments/money.util'

import { LedgerDirection, LedgerLeg } from 'generated/prisma/client'

/**
 * The posting plans — what each leg of the saga does to the ledger.
 *
 * PURE. Every function here takes already-resolved account ids and returns entries;
 * none of them touch the database. That separation is the point: the question "does
 * this flow conserve money?" becomes a unit test over integers rather than something
 * only observable by running a transfer and inspecting the aftermath.
 *
 * Each plan is balanced PER CURRENCY on its own, so any one of them can be posted
 * atomically without a partner. A cross-border settlement crosses two currencies,
 * and the FX position accounts are what absorb the crossing — that is why the rate
 * exposure ends up as a visible balance rather than a silent leak.
 */

/** The accounts one transaction can touch. Resolved once, passed around. */
export interface TransactionAccounts {
  /** The payer's wallet, in the source currency. */
  walletSrc: string
  suspenseSrc: string
  /** Same id as `suspenseSrc` for a same-currency transfer. */
  suspenseDst: string
  /** Platform fee income, source currency. Also carries the tax leg. */
  feeSrc: string
  fxSrc: string
  /** Same id as `fxSrc` for a same-currency transfer. */
  fxDst: string
  /**
   * Where the money lands: the outside world for a rail payout, or ANOTHER USER'S
   * WALLET when both parties are on `@pravaah` and the transfer never leaves us.
   */
  payee: string
  /** Booked only on a recovery. */
  receivableSrc?: string
}

export interface TransferAmounts {
  sourceCurrency: string
  destCurrency: string
  sourceAmount: bigint
  destAmount: bigint
  feeMinor: bigint
  taxMinor: bigint
  /** `sourceAmount + feeMinor + taxMinor`. What leaves the wallet. */
  totalDebitMinor: bigint
  /** The rate the transfer was locked at. Needed to size a partial refund's far leg. */
  rateE8?: bigint
}

function entry(
  accountId: string,
  direction: LedgerDirection,
  amountMinor: bigint,
  currency: string,
  leg: LedgerLeg,
  legRef = '',
): Posting {
  return { accountId, direction, amountMinor, currency, leg, legRef }
}

/**
 * RESERVE — lock the payer's funds.
 *
 * Wallet → suspense, for the FULL debit including fee and tax. The money stops
 * being spendable at this instant and before anything is handed to a rail, which is
 * what makes a double-spend impossible: the second transfer's balance check sees
 * the first one's debit.
 *
 * Suspense rather than straight out of the wallet, because a crash between here and
 * the rail must leave the money somewhere findable. A wallet debit with no
 * counterpart is money that has simply gone.
 */
export function reservePlan(
  accounts: Pick<TransactionAccounts, 'walletSrc' | 'suspenseSrc'>,
  amounts: Pick<TransferAmounts, 'sourceCurrency' | 'totalDebitMinor'>,
): Posting[] {
  const { sourceCurrency: currency, totalDebitMinor: total } = amounts
  return [
    entry(
      accounts.walletSrc,
      LedgerDirection.DEBIT,
      total,
      currency,
      LedgerLeg.RESERVE,
    ),
    entry(
      accounts.suspenseSrc,
      LedgerDirection.CREDIT,
      total,
      currency,
      LedgerLeg.RESERVE,
    ),
  ]
}

/**
 * REVERSE — release a reserve that was never submitted, or that the rail refused.
 *
 * The exact mirror of {@link reservePlan}. A compensation, not a correction: no rail
 * leg ever existed, so there is nothing to unwind on the far side.
 */
export function reverseReservePlan(
  accounts: Pick<TransactionAccounts, 'walletSrc' | 'suspenseSrc'>,
  amounts: Pick<TransferAmounts, 'sourceCurrency' | 'totalDebitMinor'>,
): Posting[] {
  const { sourceCurrency: currency, totalDebitMinor: total } = amounts
  return [
    entry(
      accounts.suspenseSrc,
      LedgerDirection.DEBIT,
      total,
      currency,
      LedgerLeg.REVERSE,
    ),
    entry(
      accounts.walletSrc,
      LedgerDirection.CREDIT,
      total,
      currency,
      LedgerLeg.REVERSE,
    ),
  ]
}

/**
 * SETTLE — the money actually leaves.
 *
 * One balanced set covering every leg of the settlement, so the fee, the currency
 * crossing and the payout commit together. Posting them separately would allow a
 * crash to leave a transaction that had booked our fee but not paid the
 * beneficiary — the worst possible partial state, because it looks like revenue.
 *
 * The currency crossing goes through FX_POSITION rather than netting the two
 * suspense accounts directly. Netting them would balance arithmetically while
 * making the rate exposure invisible; routing it through a position account means a
 * rate move shows up as a P&L balance somebody can look at.
 */
export function settlePlan(
  accounts: TransactionAccounts,
  amounts: TransferAmounts,
  options: { payoutLeg?: LedgerLeg } = {},
): Posting[] {
  const {
    sourceCurrency,
    destCurrency,
    sourceAmount,
    destAmount,
    feeMinor,
    taxMinor,
  } = amounts
  const payoutLeg = options.payoutLeg ?? LedgerLeg.PAYOUT
  const postings: Posting[] = []

  if (feeMinor > 0n) {
    postings.push(
      entry(
        accounts.suspenseSrc,
        LedgerDirection.DEBIT,
        feeMinor,
        sourceCurrency,
        LedgerLeg.FEE,
      ),
      entry(
        accounts.feeSrc,
        LedgerDirection.CREDIT,
        feeMinor,
        sourceCurrency,
        LedgerLeg.FEE,
      ),
    )
  }
  if (taxMinor > 0n) {
    // Its own leg, so the tax line is separable from the fee in any audit.
    postings.push(
      entry(
        accounts.suspenseSrc,
        LedgerDirection.DEBIT,
        taxMinor,
        sourceCurrency,
        LedgerLeg.TAX,
      ),
      entry(
        accounts.feeSrc,
        LedgerDirection.CREDIT,
        taxMinor,
        sourceCurrency,
        LedgerLeg.TAX,
      ),
    )
  }

  if (sourceCurrency !== destCurrency) {
    // Cross the currency explicitly: source suspense → source position, then
    // destination position → destination suspense.
    postings.push(
      entry(
        accounts.suspenseSrc,
        LedgerDirection.DEBIT,
        sourceAmount,
        sourceCurrency,
        LedgerLeg.FX_OUT,
      ),
      entry(
        accounts.fxSrc,
        LedgerDirection.CREDIT,
        sourceAmount,
        sourceCurrency,
        LedgerLeg.FX_OUT,
      ),
      entry(
        accounts.fxDst,
        LedgerDirection.DEBIT,
        destAmount,
        destCurrency,
        LedgerLeg.FX_IN,
      ),
      entry(
        accounts.suspenseDst,
        LedgerDirection.CREDIT,
        destAmount,
        destCurrency,
        LedgerLeg.FX_IN,
      ),
    )
  }

  postings.push(
    entry(
      accounts.suspenseDst,
      LedgerDirection.DEBIT,
      destAmount,
      destCurrency,
      payoutLeg,
    ),
    entry(
      accounts.payee,
      LedgerDirection.CREDIT,
      destAmount,
      destCurrency,
      payoutLeg,
    ),
  )

  return postings
}

/**
 * REFUND — return a settled payment.
 *
 * Full and partial are one function because they differ only in the amount, and
 * splitting them is how the two drift apart. Two rules do differ, and both are
 * deliberate:
 *
 *  - A FULL refund returns the fee and the tax as well. We did not deliver the
 *    service, so keeping the fee would be charging for a failure.
 *  - A PARTIAL refund returns only part of the transferred amount and no fee. The
 *    service WAS delivered; some of the money is coming back for another reason
 *    (goods not received, an agreed adjustment).
 *
 * The far leg of a partial refund is sized at the ORIGINAL locked rate, never
 * today's. Re-rating it would silently book an FX gain or loss into a customer's
 * refund, and the customer would be short (or over-refunded) by however much the
 * market had moved since.
 */
export function refundPlan(
  accounts: TransactionAccounts,
  amounts: TransferAmounts,
  refund: { amountMinor: bigint; full: boolean; legRef: string },
): Posting[] {
  const { sourceCurrency, destCurrency, feeMinor, taxMinor, rateE8 } = amounts
  const { amountMinor, full, legRef } = refund
  // One leg for both shapes; `legRef` (the Reversal's id) is what keeps successive
  // partial refunds from colliding on the unique constraint.
  const leg = LedgerLeg.REFUND
  const sameCurrency = sourceCurrency === destCurrency

  // What has to come back off the far side. For a full refund that is the whole
  // settled destination amount; for a partial one it is the portion, converted at
  // the locked rate.
  const destPortion = full
    ? amounts.destAmount
    : sameCurrency
      ? amountMinor
      : convertMinor({
          amountMinor,
          rateE8: requireRate(rateE8),
          sourceCurrency,
          destCurrency,
          mode: 'DOWN',
        })

  const feeBack = full ? sumMinor(feeMinor, taxMinor) : 0n
  const walletBack = full
    ? sumMinor(amounts.sourceAmount, feeBack)
    : amountMinor

  const postings: Posting[] = []

  if (sameCurrency) {
    // One currency: the money comes straight back off the payee and (on a full
    // refund) off our fee income, into the wallet.
    postings.push(
      entry(
        accounts.payee,
        LedgerDirection.DEBIT,
        destPortion,
        destCurrency,
        leg,
        legRef,
      ),
    )
    if (feeBack > 0n) {
      postings.push(
        entry(
          accounts.feeSrc,
          LedgerDirection.DEBIT,
          feeBack,
          sourceCurrency,
          leg,
          legRef,
        ),
      )
    }
    postings.push(
      entry(
        accounts.walletSrc,
        LedgerDirection.CREDIT,
        walletBack,
        sourceCurrency,
        leg,
        legRef,
      ),
    )
    return postings
  }

  // Cross-border: unwind the crossing in the opposite direction.
  postings.push(
    entry(
      accounts.payee,
      LedgerDirection.DEBIT,
      destPortion,
      destCurrency,
      leg,
      legRef,
    ),
    entry(
      accounts.fxDst,
      LedgerDirection.CREDIT,
      destPortion,
      destCurrency,
      leg,
      legRef,
    ),
    entry(
      accounts.fxSrc,
      LedgerDirection.DEBIT,
      full ? amounts.sourceAmount : amountMinor,
      sourceCurrency,
      leg,
      legRef,
    ),
  )
  if (feeBack > 0n) {
    postings.push(
      entry(
        accounts.feeSrc,
        LedgerDirection.DEBIT,
        feeBack,
        sourceCurrency,
        leg,
        legRef,
      ),
    )
  }
  postings.push(
    entry(
      accounts.walletSrc,
      LedgerDirection.CREDIT,
      walletBack,
      sourceCurrency,
      leg,
      legRef,
    ),
  )
  return postings
}

/**
 * RECOVERY — a payment we had already reversed or refunded turns out to have settled.
 *
 * The hardest case in the module, and the one most systems get wrong by refusing to
 * represent it at all. The facts on the ground: the beneficiary HAS the money, and
 * the payer has had their refund and may well have spent it. Both are true, and
 * neither can be undone.
 *
 * So the loss is booked rather than hidden. The payout is funded by going short the
 * destination currency, and the payer's obligation is recorded as a RECEIVABLE. The
 * alternative — leaving the settled payout unbooked — would break the trial
 * balance, which is the one alarm that must never be silenced. A receivable somebody
 * has to chase is an honest problem; a ledger that no longer balances is an
 * unbounded one.
 */
export function recoveryPlan(
  accounts: TransactionAccounts,
  amounts: TransferAmounts,
  legRef: string,
): Posting[] {
  const { sourceCurrency, destCurrency, destAmount, totalDebitMinor } = amounts
  if (!accounts.receivableSrc) {
    throw new Error('recoveryPlan: a receivable account is required')
  }

  return [
    // The money left to the beneficiary, funded from our own position.
    entry(
      accounts.fxDst,
      LedgerDirection.DEBIT,
      destAmount,
      destCurrency,
      LedgerLeg.RECOVERY,
      legRef,
    ),
    entry(
      accounts.payee,
      LedgerDirection.CREDIT,
      destAmount,
      destCurrency,
      LedgerLeg.RECOVERY,
      legRef,
    ),
    // The payer owes us what we refunded them.
    entry(
      accounts.fxSrc,
      LedgerDirection.DEBIT,
      totalDebitMinor,
      sourceCurrency,
      LedgerLeg.RECOVERY,
      legRef,
    ),
    entry(
      accounts.receivableSrc,
      LedgerDirection.CREDIT,
      totalDebitMinor,
      sourceCurrency,
      LedgerLeg.RECOVERY,
      legRef,
    ),
  ]
}

/**
 * TOPUP / inbound credit — money arriving from outside.
 *
 * The `EXTERNAL` account goes negative here, and legitimately so: a negative
 * external balance is the ledger's way of saying "this much has come in from the
 * outside world". It is one of the few accounts allowed to, which is why the
 * overdraft guard consults the account type rather than applying one rule to
 * everything.
 */
export function inboundCreditPlan(
  accounts: { external: string; wallet: string },
  currency: string,
  amountMinor: bigint,
): Posting[] {
  return [
    entry(
      accounts.external,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.TOPUP,
    ),
    entry(
      accounts.wallet,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.TOPUP,
    ),
  ]
}

/**
 * An admin correction.
 *
 * Always paired with an audit entry naming the human, and always through the same
 * balanced-posting path as everything else. The break-glass control still obeys
 * double-entry — an "adjustment" that could post a single-sided entry would be a
 * way to make the trial balance lie, which is the one capability nobody should have.
 */
export function adjustmentPlan(
  fromAccountId: string,
  toAccountId: string,
  currency: string,
  amountMinor: bigint,
  legRef: string,
): Posting[] {
  return [
    entry(
      fromAccountId,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.ADJUSTMENT,
      legRef,
    ),
    entry(
      toAccountId,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.ADJUSTMENT,
      legRef,
    ),
  ]
}

function requireRate(rateE8: bigint | undefined): bigint {
  if (rateE8 === undefined || rateE8 <= 0n) {
    throw new Error(
      'A cross-currency partial refund needs the original locked rate — re-rating it would book an FX movement into a customer refund',
    )
  }
  return rateE8
}
