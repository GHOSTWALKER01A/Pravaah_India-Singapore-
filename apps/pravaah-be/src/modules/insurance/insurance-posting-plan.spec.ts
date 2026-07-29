import {
  claimPayoutPlan,
  claimReservePlan,
  premiumEarnPlan,
  premiumRefundPlan,
  premiumReleasePlan,
  premiumReservePlan,
  type InsuranceAccounts,
} from '@/modules/insurance/insurance-posting-plan'
import { aggregatePostings } from '@/modules/payments/services/ledger.service'

import { LedgerDirection, LedgerLeg } from 'generated/prisma/client'

import type { Posting } from '@/modules/payments/services/ledger.service'

const ACCOUNTS: InsuranceAccounts = {
  wallet: 'acc-wallet',
  suspense: 'acc-suspense',
  float: 'acc-float',
}

/**
 * Every account, listed rather than derived with `Object.values`.
 *
 * `InsuranceAccounts` has named keys and no index signature, so `Object.values`
 * falls through to the `{}` overload and returns `any[]` — which would make the
 * "nets to zero on every account" assertions type-unchecked, in the one test whose
 * whole job is to be checked.
 */
const ALL_ACCOUNTS: string[] = [
  ACCOUNTS.wallet,
  ACCOUNTS.suspense,
  ACCOUNTS.float,
]

const INR = 'INR'
/** ₹150.00 — one month of income-protection premium at standard risk. */
const PREMIUM = 15_000n
/** ₹8,000.00 — an approved wage-loss claim. */
const PAYOUT = 800_000n

/**
 * `Σ credits − Σ debits`, per currency.
 *
 * The one assertion that matters about every plan in this module. `LedgerService.post`
 * rejects an unbalanced set at runtime, so this test is what turns "money is
 * conserved" from a property observable only by buying a policy into a property
 * checked on every commit.
 */
function net(postings: Posting[]): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const posting of postings) {
    const signed =
      posting.direction === LedgerDirection.DEBIT
        ? -posting.amountMinor
        : posting.amountMinor
    totals.set(posting.currency, (totals.get(posting.currency) ?? 0n) + signed)
  }
  return totals
}

function expectBalanced(postings: Posting[]): void {
  for (const [currency, balance] of net(postings)) {
    expect({ currency, balance }).toEqual({ currency, balance: 0n })
  }
}

/** The signed movement a plan produces on one account. */
function movement(postings: Posting[], accountId: string): bigint {
  return postings
    .filter((posting) => posting.accountId === accountId)
    .reduce(
      (total, posting) =>
        posting.direction === LedgerDirection.DEBIT
          ? total - posting.amountMinor
          : total + posting.amountMinor,
      0n,
    )
}

describe('insurance-posting-plan — every plan conserves money', () => {
  it('balances the premium reserve', () => {
    expectBalanced(premiumReservePlan(ACCOUNTS, INR, PREMIUM))
  })

  it('balances the premium earn', () => {
    expectBalanced(premiumEarnPlan(ACCOUNTS, INR, PREMIUM))
  })

  it('balances the premium release', () => {
    expectBalanced(premiumReleasePlan(ACCOUNTS, INR, PREMIUM))
  })

  it('balances the claim reserve', () => {
    expectBalanced(claimReservePlan(ACCOUNTS, INR, PAYOUT))
  })

  it('balances the claim payout', () => {
    expectBalanced(claimPayoutPlan(ACCOUNTS, INR, PAYOUT))
  })

  it('balances the premium refund', () => {
    expectBalanced(premiumRefundPlan(ACCOUNTS, INR, PREMIUM, 'premium-1'))
  })
})

describe('insurance-posting-plan — premium collection, end to end', () => {
  it('moves the premium from the wallet to the float and touches nothing else', () => {
    const all = [
      ...premiumReservePlan(ACCOUNTS, INR, PREMIUM),
      ...premiumEarnPlan(ACCOUNTS, INR, PREMIUM),
    ]

    expectBalanced(all)
    expect(movement(all, ACCOUNTS.wallet)).toBe(-PREMIUM)
    expect(movement(all, ACCOUNTS.float)).toBe(PREMIUM)
    // Suspense is a WAYPOINT, not a destination. A non-zero net here would mean
    // money parked in suspense that nothing is going to come back for.
    expect(movement(all, ACCOUNTS.suspense)).toBe(0n)
  })

  it('leaves the holder whole when a reserve is released instead of earned', () => {
    const all = [
      ...premiumReservePlan(ACCOUNTS, INR, PREMIUM),
      ...premiumReleasePlan(ACCOUNTS, INR, PREMIUM),
    ]

    expectBalanced(all)
    expect(movement(all, ACCOUNTS.wallet)).toBe(0n)
    expect(movement(all, ACCOUNTS.suspense)).toBe(0n)
    // Nothing reached the float: the premium was never EARNED, so there is nothing
    // to refund and the book must not record income it did not receive.
    expect(movement(all, ACCOUNTS.float)).toBe(0n)
  })

  it('uses the RESERVE leg, so M4 suspense reporting covers a premium unchanged', () => {
    // Reusing M4's leg name is what lets its existing suspense view, overdraft
    // guard and duplicate-posting constraint apply to an insurance premium with no
    // special-casing.
    const legs = premiumReservePlan(ACCOUNTS, INR, PREMIUM).map((p) => p.leg)
    expect(legs).toEqual([LedgerLeg.RESERVE, LedgerLeg.RESERVE])
  })

  it('credits the float on its OWN leg, so earned premium is readable off the ledger', () => {
    // `Σ credits on the PREMIUM leg` is the loss ratio's denominator. Folding it
    // into PAYOUT would make the number reconstructible only from application
    // tables, which drift from the money.
    const earn = premiumEarnPlan(ACCOUNTS, INR, PREMIUM)
    const floatCredit = earn.find(
      (posting) =>
        posting.accountId === ACCOUNTS.float &&
        posting.direction === LedgerDirection.CREDIT,
    )
    expect(floatCredit?.leg).toBe(LedgerLeg.PREMIUM)
    expect(floatCredit?.amountMinor).toBe(PREMIUM)
  })
})

describe('insurance-posting-plan — claim payout, end to end', () => {
  it('moves the payout from the float to the claimant and touches nothing else', () => {
    const all = [
      ...claimReservePlan(ACCOUNTS, INR, PAYOUT),
      ...claimPayoutPlan(ACCOUNTS, INR, PAYOUT),
    ]

    expectBalanced(all)
    expect(movement(all, ACCOUNTS.float)).toBe(-PAYOUT)
    expect(movement(all, ACCOUNTS.wallet)).toBe(PAYOUT)
    expect(movement(all, ACCOUNTS.suspense)).toBe(0n)
  })

  it('debits the float on the RESERVE leg and credits the wallet on CLAIM_PAYOUT', () => {
    const reserve = claimReservePlan(ACCOUNTS, INR, PAYOUT)
    const payout = claimPayoutPlan(ACCOUNTS, INR, PAYOUT)

    expect(reserve.find((p) => p.accountId === ACCOUNTS.float)?.direction).toBe(
      LedgerDirection.DEBIT,
    )
    expect(payout.find((p) => p.accountId === ACCOUNTS.wallet)?.leg).toBe(
      LedgerLeg.CLAIM_PAYOUT,
    )
  })

  it('does not collide with a premium on the same transaction', () => {
    // The unique constraint is `(transaction, account, direction, leg, legRef)`.
    // A reserve and a payout share the suspense account but differ in leg and
    // direction, so both can post against one transaction.
    const all = aggregatePostings([
      ...claimReservePlan(ACCOUNTS, INR, PAYOUT),
      ...claimPayoutPlan(ACCOUNTS, INR, PAYOUT),
    ])
    const keys = all.map((p) =>
      [p.accountId, p.direction, p.leg, p.legRef ?? ''].join('|'),
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('insurance-posting-plan — the free-look refund', () => {
  it('returns the premium from the float to the holder', () => {
    const refund = premiumRefundPlan(ACCOUNTS, INR, PREMIUM, 'premium-1')

    expectBalanced(refund)
    expect(movement(refund, ACCOUNTS.float)).toBe(-PREMIUM)
    expect(movement(refund, ACCOUNTS.wallet)).toBe(PREMIUM)
    // Straight from the float: the premium was already EARNED, so there is nothing
    // sitting in suspense to unwind.
    expect(movement(refund, ACCOUNTS.suspense)).toBe(0n)
  })

  it('carries the legRef, so two refunds on one policy do not collide', () => {
    const first = premiumRefundPlan(ACCOUNTS, INR, PREMIUM, 'premium-1')
    const second = premiumRefundPlan(ACCOUNTS, INR, PREMIUM, 'premium-2')

    const keyOf = (postings: Posting[]) =>
      postings.map((p) =>
        [p.accountId, p.direction, p.leg, p.legRef ?? ''].join('|'),
      )

    // Distinct keys under the ledger's unique constraint. With an empty legRef the
    // second refund would surface as a duplicate-posting error, which the caller
    // reads as "already refunded" — silently keeping a holder's second month.
    expect(keyOf(first)).not.toEqual(keyOf(second))
    for (const posting of [...first, ...second]) {
      expect(posting.legRef).toBeTruthy()
    }
  })

  it('REFUSES an empty legRef rather than defaulting it', () => {
    expect(() => premiumRefundPlan(ACCOUNTS, INR, PREMIUM, '')).toThrow(
      /legRef/,
    )
  })

  it('nets to zero across collect-then-refund, on every account', () => {
    // A free-look cancellation must leave the books exactly as they were before
    // the policy was sold.
    const all = [
      ...premiumReservePlan(ACCOUNTS, INR, PREMIUM),
      ...premiumEarnPlan(ACCOUNTS, INR, PREMIUM),
      ...premiumRefundPlan(ACCOUNTS, INR, PREMIUM, 'premium-1'),
    ]

    expectBalanced(all)
    for (const account of ALL_ACCOUNTS) {
      expect(movement(all, account)).toBe(0n)
    }
  })
})

describe('insurance-posting-plan — refusals', () => {
  it('refuses a zero or negative amount on every plan', () => {
    // `LedgerService.post` also rejects these, but a plan that could BUILD one
    // means the invalid set exists in memory and can be logged, retried, or half
    // applied by a future caller that does its own insert.
    for (const amount of [0n, -1n]) {
      expect(() => premiumReservePlan(ACCOUNTS, INR, amount)).toThrow()
      expect(() => premiumEarnPlan(ACCOUNTS, INR, amount)).toThrow()
      expect(() => premiumReleasePlan(ACCOUNTS, INR, amount)).toThrow()
      expect(() => claimReservePlan(ACCOUNTS, INR, amount)).toThrow()
      expect(() => claimPayoutPlan(ACCOUNTS, INR, amount)).toThrow()
      expect(() =>
        premiumRefundPlan(ACCOUNTS, INR, amount, 'premium-1'),
      ).toThrow()
    }
  })

  it('keeps every posting amount positive — the sign lives in the direction', () => {
    const all = [
      ...premiumReservePlan(ACCOUNTS, INR, PREMIUM),
      ...premiumEarnPlan(ACCOUNTS, INR, PREMIUM),
      ...claimReservePlan(ACCOUNTS, INR, PAYOUT),
      ...claimPayoutPlan(ACCOUNTS, INR, PAYOUT),
      ...premiumRefundPlan(ACCOUNTS, INR, PREMIUM, 'premium-1'),
    ]
    for (const posting of all) {
      expect(posting.amountMinor > 0n).toBe(true)
    }
  })
})

describe('insurance-posting-plan — currency isolation', () => {
  it('never mixes currencies within one plan', () => {
    // A policy's premium and its payout are always in the policy's own currency.
    // Insuring somebody in one currency and paying them in another would move an
    // FX risk onto a claimant at the worst possible moment.
    const sgd = [
      ...premiumReservePlan(ACCOUNTS, 'SGD', 1_000n),
      ...premiumEarnPlan(ACCOUNTS, 'SGD', 1_000n),
    ]
    expect(new Set(sgd.map((p) => p.currency))).toEqual(new Set(['SGD']))
    expect(net(sgd).get('SGD')).toBe(0n)
  })
})
