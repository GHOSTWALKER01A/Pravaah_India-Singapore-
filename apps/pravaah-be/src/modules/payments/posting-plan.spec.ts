import { rateE8FromString, RATE_SCALE } from '@/modules/payments/money.util'
import {
  adjustmentPlan,
  inboundCreditPlan,
  recoveryPlan,
  refundPlan,
  reservePlan,
  reverseReservePlan,
  settlePlan,
  type TransactionAccounts,
  type TransferAmounts,
} from '@/modules/payments/posting-plan'
import { priceTransfer } from '@/modules/payments/pricing.util'
import {
  aggregatePostings,
  type Posting,
} from '@/modules/payments/services/ledger.service'

import { LedgerDirection, LedgerLeg } from 'generated/prisma/client'

// ── helpers ─────────────────────────────────────────────────────────────────
/**
 * The invariant every plan must satisfy: debits equal credits, PER CURRENCY.
 *
 * Applied to the AGGREGATED postings, exactly as `LedgerService.post` does, so the
 * test exercises the same merge the database sees.
 */
function netByCurrency(postings: Posting[]): Map<string, bigint> {
  const net = new Map<string, bigint>()
  for (const posting of aggregatePostings(postings)) {
    const signed =
      posting.direction === LedgerDirection.DEBIT
        ? -posting.amountMinor
        : posting.amountMinor
    net.set(posting.currency, (net.get(posting.currency) ?? 0n) + signed)
  }
  return net
}

function expectBalanced(postings: Posting[]): void {
  for (const [currency, net] of netByCurrency(postings)) {
    expect({ currency, net }).toEqual({ currency, net: 0n })
  }
}

/** No two entries may collide on the ledger's unique key after aggregation. */
function expectNoDuplicateKeys(postings: Posting[]): void {
  const keys = aggregatePostings(postings).map((posting) =>
    [
      posting.accountId,
      posting.direction,
      posting.leg,
      posting.legRef ?? '',
    ].join('|'),
  )
  expect(new Set(keys).size).toBe(keys.length)
}

function expectPositiveAmounts(postings: Posting[]): void {
  for (const posting of aggregatePostings(postings)) {
    expect(posting.amountMinor > 0n).toBe(true)
  }
}

function creditTo(postings: Posting[], accountId: string): bigint {
  return aggregatePostings(postings)
    .filter(
      (posting) =>
        posting.accountId === accountId &&
        posting.direction === LedgerDirection.CREDIT,
    )
    .reduce((total, posting) => total + posting.amountMinor, 0n)
}

function debitFrom(postings: Posting[], accountId: string): bigint {
  return aggregatePostings(postings)
    .filter(
      (posting) =>
        posting.accountId === accountId &&
        posting.direction === LedgerDirection.DEBIT,
    )
    .reduce((total, posting) => total + posting.amountMinor, 0n)
}

// ── fixtures ────────────────────────────────────────────────────────────────
const CROSS_ACCOUNTS: TransactionAccounts = {
  walletSrc: 'acct-wallet-sgd',
  suspenseSrc: 'acct-suspense-sgd',
  suspenseDst: 'acct-suspense-inr',
  feeSrc: 'acct-fee-sgd',
  fxSrc: 'acct-fx-sgd',
  fxDst: 'acct-fx-inr',
  payee: 'acct-external-inr',
  receivableSrc: 'acct-receivable-sgd',
}

/**
 * A same-currency transfer SHARES account ids across the src/dst slots.
 *
 * Modelled explicitly because it is where the duplicate-key collisions live: with
 * one currency, `suspenseSrc === suspenseDst` and `fxSrc === fxDst`, so several
 * plans emit two movements against one account in one leg.
 */
const DOMESTIC_ACCOUNTS: TransactionAccounts = {
  walletSrc: 'acct-wallet-inr',
  suspenseSrc: 'acct-suspense-inr',
  suspenseDst: 'acct-suspense-inr',
  feeSrc: 'acct-fee-inr',
  fxSrc: 'acct-fx-inr',
  fxDst: 'acct-fx-inr',
  payee: 'acct-external-inr',
  receivableSrc: 'acct-receivable-inr',
}

const SGD_INR = rateE8FromString('65.40')

function crossAmounts(sourceMinor: bigint): TransferAmounts {
  const priced = priceTransfer({
    mode: 'SOURCE',
    amountMinor: sourceMinor,
    sourceCurrency: 'SGD',
    destCurrency: 'INR',
    midRateE8: SGD_INR,
  })
  return { ...priced, rateE8: priced.rateE8 }
}

function domesticAmounts(minor: bigint): TransferAmounts {
  const priced = priceTransfer({
    mode: 'SOURCE',
    amountMinor: minor,
    sourceCurrency: 'INR',
    destCurrency: 'INR',
    midRateE8: RATE_SCALE,
  })
  return { ...priced, rateE8: priced.rateE8 }
}

// ── tests ───────────────────────────────────────────────────────────────────
describe('posting-plan — reserve', () => {
  it('locks the FULL debit, fee and tax included', () => {
    // If the reserve were only the transfer amount, the fee would be charged at
    // settlement out of money that was never locked — and a wallet with exactly
    // the transfer amount would go negative at the last step.
    const amounts = crossAmounts(10_000n)
    const plan = reservePlan(CROSS_ACCOUNTS, amounts)

    expectBalanced(plan)
    expect(debitFrom(plan, CROSS_ACCOUNTS.walletSrc)).toBe(
      amounts.totalDebitMinor,
    )
    expect(creditTo(plan, CROSS_ACCOUNTS.suspenseSrc)).toBe(
      amounts.totalDebitMinor,
    )
  })

  it('mirrors exactly on reversal', () => {
    const amounts = crossAmounts(10_000n)
    const reserve = reservePlan(CROSS_ACCOUNTS, amounts)
    const reverse = reverseReservePlan(CROSS_ACCOUNTS, amounts)

    expectBalanced(reverse)
    // Whatever the reserve took out of the wallet comes back.
    expect(creditTo(reverse, CROSS_ACCOUNTS.walletSrc)).toBe(
      debitFrom(reserve, CROSS_ACCOUNTS.walletSrc),
    )
    expect(debitFrom(reverse, CROSS_ACCOUNTS.suspenseSrc)).toBe(
      creditTo(reserve, CROSS_ACCOUNTS.suspenseSrc),
    )
  })
})

describe('posting-plan — settle', () => {
  it('empties the suspense it was reserved into, exactly', () => {
    // The property that makes suspense meaningful: after reserve + settle, the
    // suspense account is flat. Any residue is money the platform is holding for
    // nobody, and it would sit there forever.
    const amounts = crossAmounts(10_000n)
    const combined = [
      ...reservePlan(CROSS_ACCOUNTS, amounts),
      ...settlePlan(CROSS_ACCOUNTS, amounts),
    ]

    const suspenseSrcNet =
      creditTo(combined, CROSS_ACCOUNTS.suspenseSrc) -
      debitFrom(combined, CROSS_ACCOUNTS.suspenseSrc)
    const suspenseDstNet =
      creditTo(combined, CROSS_ACCOUNTS.suspenseDst) -
      debitFrom(combined, CROSS_ACCOUNTS.suspenseDst)

    expect(suspenseSrcNet).toBe(0n)
    expect(suspenseDstNet).toBe(0n)
  })

  it('pays the beneficiary exactly the quoted destination amount', () => {
    const amounts = crossAmounts(10_000n)
    const plan = settlePlan(CROSS_ACCOUNTS, amounts)
    expect(creditTo(plan, CROSS_ACCOUNTS.payee)).toBe(amounts.destAmount)
  })

  it('books the fee and the tax on separate legs', () => {
    const amounts: TransferAmounts = {
      ...crossAmounts(10_000n),
      // Force a tax component to check the leg split, even though an SGD fee
      // attracts none under the real policy.
      taxMinor: 9n,
      totalDebitMinor: 10_000n + 50n + 9n,
    }
    const plan = settlePlan(CROSS_ACCOUNTS, amounts)
    const legs = plan.map((posting) => posting.leg)

    expect(legs).toContain(LedgerLeg.FEE)
    expect(legs).toContain(LedgerLeg.TAX)
    expectBalanced([...reservePlan(CROSS_ACCOUNTS, amounts), ...plan])
  })

  it('routes the currency crossing through the FX positions', () => {
    // Netting the two suspense accounts directly would balance arithmetically
    // while making the rate exposure invisible.
    const amounts = crossAmounts(10_000n)
    const plan = settlePlan(CROSS_ACCOUNTS, amounts)

    expect(creditTo(plan, CROSS_ACCOUNTS.fxSrc)).toBe(amounts.sourceAmount)
    expect(debitFrom(plan, CROSS_ACCOUNTS.fxDst)).toBe(amounts.destAmount)
    expect(plan.map((p) => p.leg)).toEqual(
      expect.arrayContaining([LedgerLeg.FX_OUT, LedgerLeg.FX_IN]),
    )
  })

  it('emits no FX legs for a same-currency transfer', () => {
    const amounts = domesticAmounts(500_000n)
    const plan = settlePlan(DOMESTIC_ACCOUNTS, amounts)

    expect(plan.map((p) => p.leg)).not.toContain(LedgerLeg.FX_OUT)
    expect(plan.map((p) => p.leg)).not.toContain(LedgerLeg.FX_IN)
    expectBalanced([...reservePlan(DOMESTIC_ACCOUNTS, amounts), ...plan])
  })

  it('uses the WITHDRAW leg when asked', () => {
    const amounts = domesticAmounts(500_000n)
    const plan = settlePlan(DOMESTIC_ACCOUNTS, amounts, {
      payoutLeg: LedgerLeg.WITHDRAW,
    })
    expect(plan.map((p) => p.leg)).toContain(LedgerLeg.WITHDRAW)
    expectBalanced(plan)
  })
})

describe('posting-plan — refund', () => {
  it('returns the fee and tax on a FULL refund', () => {
    // We did not deliver the service, so keeping the fee would be charging for a
    // failure.
    const amounts = crossAmounts(10_000n)
    const plan = refundPlan(CROSS_ACCOUNTS, amounts, {
      amountMinor: amounts.sourceAmount,
      full: true,
      legRef: 'rev-1',
    })

    expectBalanced(plan)
    expect(creditTo(plan, CROSS_ACCOUNTS.walletSrc)).toBe(
      amounts.totalDebitMinor,
    )
    expect(debitFrom(plan, CROSS_ACCOUNTS.feeSrc)).toBe(
      amounts.feeMinor + amounts.taxMinor,
    )
  })

  it('returns only the portion, and no fee, on a PARTIAL refund', () => {
    // The service WAS delivered; some of the money is coming back for another
    // reason.
    const amounts = crossAmounts(10_000n)
    const plan = refundPlan(CROSS_ACCOUNTS, amounts, {
      amountMinor: 2_500n,
      full: false,
      legRef: 'rev-2',
    })

    expectBalanced(plan)
    expect(creditTo(plan, CROSS_ACCOUNTS.walletSrc)).toBe(2_500n)
    expect(debitFrom(plan, CROSS_ACCOUNTS.feeSrc)).toBe(0n)
  })

  it('sizes a partial refund at the ORIGINAL locked rate', () => {
    // Re-rating would silently book an FX gain or loss into a customer's refund.
    const amounts = crossAmounts(10_000n)
    const plan = refundPlan(CROSS_ACCOUNTS, amounts, {
      amountMinor: 5_000n,
      full: false,
      legRef: 'rev-3',
    })
    // Half the source amount, converted at the locked 65.073.
    expect(debitFrom(plan, CROSS_ACCOUNTS.payee)).toBe(325_365n)
  })

  it('refuses a cross-currency partial refund with no locked rate', () => {
    const amounts = { ...crossAmounts(10_000n), rateE8: undefined }
    expect(() =>
      refundPlan(CROSS_ACCOUNTS, amounts, {
        amountMinor: 2_500n,
        full: false,
        legRef: 'rev-4',
      }),
    ).toThrow(/locked rate/)
  })

  it('lets successive partial refunds coexist, distinguished by legRef', () => {
    // Without the discriminator, the second legitimate partial refund would fail as
    // though it were a duplicate of the first.
    const amounts = domesticAmounts(500_000n)
    const first = refundPlan(DOMESTIC_ACCOUNTS, amounts, {
      amountMinor: 100_000n,
      full: false,
      legRef: 'rev-a',
    })
    const second = refundPlan(DOMESTIC_ACCOUNTS, amounts, {
      amountMinor: 100_000n,
      full: false,
      legRef: 'rev-b',
    })
    expectNoDuplicateKeys([...first, ...second])
  })

  it('collapses a same-currency full refund into one wallet credit', () => {
    // Two credits to the same wallet in the same leg would collide on the unique
    // key; aggregation is what makes the legitimate operation possible.
    const amounts: TransferAmounts = {
      ...domesticAmounts(500_000n),
      feeMinor: 1_000n,
      taxMinor: 180n,
      totalDebitMinor: 501_180n,
    }
    const plan = refundPlan(DOMESTIC_ACCOUNTS, amounts, {
      amountMinor: amounts.sourceAmount,
      full: true,
      legRef: 'rev-5',
    })

    expectNoDuplicateKeys(plan)
    expectBalanced(plan)
    expect(creditTo(plan, DOMESTIC_ACCOUNTS.walletSrc)).toBe(501_180n)
  })
})

describe('posting-plan — recovery', () => {
  it('books the settled payout and the payer obligation, balanced', () => {
    // The hardest case: the beneficiary HAS the money and the payer has had their
    // refund. Neither can be undone, so the loss is booked rather than hidden.
    const amounts = crossAmounts(10_000n)
    const plan = recoveryPlan(CROSS_ACCOUNTS, amounts, 'rec-1')

    expectBalanced(plan)
    expect(creditTo(plan, CROSS_ACCOUNTS.payee)).toBe(amounts.destAmount)
    expect(creditTo(plan, CROSS_ACCOUNTS.receivableSrc!)).toBe(
      amounts.totalDebitMinor,
    )
  })

  it('stays balanced when source and destination are the same currency', () => {
    // Here the FX position is debited twice in one leg; only aggregation keeps it
    // insertable.
    const amounts = domesticAmounts(500_000n)
    const plan = recoveryPlan(DOMESTIC_ACCOUNTS, amounts, 'rec-2')

    expectBalanced(plan)
    expectNoDuplicateKeys(plan)
    expect(debitFrom(plan, DOMESTIC_ACCOUNTS.fxSrc)).toBe(
      amounts.destAmount + amounts.totalDebitMinor,
    )
  })

  it('refuses to run without a receivable account', () => {
    const amounts = crossAmounts(10_000n)
    expect(() =>
      recoveryPlan(
        { ...CROSS_ACCOUNTS, receivableSrc: undefined },
        amounts,
        'rec-3',
      ),
    ).toThrow(/receivable/)
  })
})

describe('posting-plan — inbound + adjustment', () => {
  it('credits the wallet against the external account', () => {
    const plan = inboundCreditPlan(
      { external: 'acct-external-inr', wallet: 'acct-wallet-inr' },
      'INR',
      250_000n,
    )
    expectBalanced(plan)
    expect(creditTo(plan, 'acct-wallet-inr')).toBe(250_000n)
  })

  it('keeps an admin adjustment double-entry', () => {
    // An "adjustment" able to post a single-sided entry would be a way to make the
    // trial balance lie.
    const plan = adjustmentPlan('acct-a', 'acct-b', 'INR', 100n, 'adj-1')
    expectBalanced(plan)
    expect(plan).toHaveLength(2)
  })
})

describe('posting-plan — money conservation across the whole lifecycle', () => {
  const amountsUnderTest = [
    1n,
    7n,
    99n,
    100n,
    5_000n,
    10_000n,
    100_000n,
    99_999_999n,
  ]

  it.each(amountsUnderTest)(
    'conserves money end-to-end for a cross-border transfer of %s',
    (sourceMinor) => {
      const amounts = crossAmounts(sourceMinor)

      // Every combination of legs a transaction can actually take.
      const settled = [
        ...reservePlan(CROSS_ACCOUNTS, amounts),
        ...settlePlan(CROSS_ACCOUNTS, amounts),
      ]
      const reversed = [
        ...reservePlan(CROSS_ACCOUNTS, amounts),
        ...reverseReservePlan(CROSS_ACCOUNTS, amounts),
      ]
      const refunded = [
        ...settled,
        ...refundPlan(CROSS_ACCOUNTS, amounts, {
          amountMinor: amounts.sourceAmount,
          full: true,
          legRef: 'r1',
        }),
      ]
      const recovered = [
        ...reversed,
        ...recoveryPlan(CROSS_ACCOUNTS, amounts, 'r2'),
      ]

      for (const plan of [settled, reversed, refunded, recovered]) {
        expectBalanced(plan)
        expectPositiveAmounts(plan)
      }

      // After a full refund the payer is exactly whole again, and the platform's
      // fee income is back to zero.
      const walletNet =
        creditTo(refunded, CROSS_ACCOUNTS.walletSrc) -
        debitFrom(refunded, CROSS_ACCOUNTS.walletSrc)
      expect(walletNet).toBe(0n)
      const feeNet =
        creditTo(refunded, CROSS_ACCOUNTS.feeSrc) -
        debitFrom(refunded, CROSS_ACCOUNTS.feeSrc)
      expect(feeNet).toBe(0n)
    },
  )

  it.each(amountsUnderTest)(
    'conserves money end-to-end for a domestic transfer of %s',
    (minor) => {
      const amounts = domesticAmounts(minor)
      const settled = [
        ...reservePlan(DOMESTIC_ACCOUNTS, amounts),
        ...settlePlan(DOMESTIC_ACCOUNTS, amounts),
      ]
      const refunded = [
        ...settled,
        ...refundPlan(DOMESTIC_ACCOUNTS, amounts, {
          amountMinor: amounts.sourceAmount,
          full: true,
          legRef: 'r1',
        }),
      ]

      for (const plan of [settled, refunded]) {
        expectBalanced(plan)
        expectPositiveAmounts(plan)
        expectNoDuplicateKeys(plan)
      }

      const walletNet =
        creditTo(refunded, DOMESTIC_ACCOUNTS.walletSrc) -
        debitFrom(refunded, DOMESTIC_ACCOUNTS.walletSrc)
      expect(walletNet).toBe(0n)
    },
  )
})
