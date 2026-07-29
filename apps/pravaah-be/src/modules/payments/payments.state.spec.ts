import {
  allowedTransitions,
  bucketKeyFor,
  bucketResetAt,
  canCollectTransition,
  canMandateTransition,
  canTransition,
  corridorFor,
  hasFundsInSuspense,
  hasStatusCheckBudget,
  isCollectOpen,
  isHandleSupported,
  isInFlight,
  isMandateDebitable,
  isRefundable,
  isSettled,
  isTerminal,
  isUserVisibleSuccess,
  needsHumanAttention,
  needsReconciliation,
  nextDebitDate,
  nextPollAt,
  railFor,
  supportsCollect,
} from '@/modules/payments/payments.state'

import {
  BeneficiaryHandleType,
  CollectStatus,
  Corridor,
  MandateStatus,
  PaymentRail,
  TxnStatus,
} from 'generated/prisma/client'

describe('payments.state — transaction saga', () => {
  it('walks the happy path', () => {
    expect(canTransition(TxnStatus.INITIATED, TxnStatus.VALIDATED)).toBe(true)
    expect(canTransition(TxnStatus.VALIDATED, TxnStatus.RESERVED)).toBe(true)
    expect(canTransition(TxnStatus.RESERVED, TxnStatus.SUBMITTED)).toBe(true)
    expect(canTransition(TxnStatus.SUBMITTED, TxnStatus.PENDING)).toBe(true)
    expect(canTransition(TxnStatus.PENDING, TxnStatus.SUCCESS)).toBe(true)
  })

  it('allows FAILED → SUCCESS — the late-settlement correction', () => {
    // The single most expensive event in payments: we timed out, marked the
    // transfer failed, and the rail settled it anyway. A state machine that
    // treats FAILED as terminal cannot represent the correction, so it silently
    // keeps a beneficiary paid out of our own pocket.
    expect(canTransition(TxnStatus.FAILED, TxnStatus.SUCCESS)).toBe(true)
  })

  it('allows REVERSED → SUCCESS and REFUNDED → SUCCESS — recovery after we gave the money back', () => {
    // The money genuinely left, so it must be bookable somewhere. That is what
    // AccountType.RECEIVABLE exists for; refusing the transition would break the
    // trial balance instead.
    expect(canTransition(TxnStatus.REVERSED, TxnStatus.SUCCESS)).toBe(true)
    expect(canTransition(TxnStatus.REFUNDED, TxnStatus.SUCCESS)).toBe(true)
  })

  it('never lets a settled payment un-settle', () => {
    expect(canTransition(TxnStatus.SUCCESS, TxnStatus.FAILED)).toBe(false)
    expect(canTransition(TxnStatus.SUCCESS, TxnStatus.PENDING)).toBe(false)
    expect(canTransition(TxnStatus.SUCCESS, TxnStatus.RESERVED)).toBe(false)
    expect(canTransition(TxnStatus.SUCCESS, TxnStatus.REVERSED)).toBe(false)
  })

  it('lets a DEEMED transaction resolve in either direction', () => {
    expect(canTransition(TxnStatus.DEEMED, TxnStatus.SUCCESS)).toBe(true)
    expect(canTransition(TxnStatus.DEEMED, TxnStatus.FAILED)).toBe(true)
    expect(canTransition(TxnStatus.DEEMED, TxnStatus.REVERSED)).toBe(true)
  })

  it('treats EXPIRED as the only truly terminal state', () => {
    expect(allowedTransitions(TxnStatus.EXPIRED)).toEqual([])
    expect(isTerminal(TxnStatus.EXPIRED)).toBe(true)

    // Everything else can still be contradicted by the rail.
    for (const status of [
      TxnStatus.SUCCESS,
      TxnStatus.FAILED,
      TxnStatus.REVERSED,
      TxnStatus.REFUNDED,
      TxnStatus.DEEMED,
    ]) {
      expect(isTerminal(status)).toBe(false)
    }
  })

  it('expresses a second partial refund as a self-edge', () => {
    expect(
      canTransition(TxnStatus.PARTIALLY_REFUNDED, TxnStatus.PARTIALLY_REFUNDED),
    ).toBe(true)
    expect(
      canTransition(TxnStatus.PARTIALLY_REFUNDED, TxnStatus.REFUNDED),
    ).toBe(true)
  })

  it('never skips the reserve on the way to the rail', () => {
    expect(canTransition(TxnStatus.VALIDATED, TxnStatus.SUBMITTED)).toBe(false)
    expect(canTransition(TxnStatus.INITIATED, TxnStatus.RESERVED)).toBe(false)
  })

  it('rejects an unknown transition rather than defaulting to allowed', () => {
    expect(canTransition(TxnStatus.RISK_HELD, TxnStatus.SUCCESS)).toBe(false)
    expect(canTransition(TxnStatus.EXPIRED, TxnStatus.SUCCESS)).toBe(false)
  })
})

describe('payments.state — derived predicates', () => {
  it('knows exactly which states hold funds in suspense', () => {
    const inSuspense = Object.values(TxnStatus).filter(hasFundsInSuspense)
    expect(inSuspense.sort()).toEqual(
      [
        TxnStatus.DEEMED,
        TxnStatus.PENDING,
        TxnStatus.RESERVED,
        TxnStatus.SUBMITTED,
      ].sort(),
    )
  })

  it('keeps asking the rail about a FAILED transaction', () => {
    // The inclusion IS the money-loss defence. "It failed, we are done" is what
    // leaves a settled payment unrecorded forever.
    expect(needsReconciliation(TxnStatus.FAILED)).toBe(true)
    expect(needsReconciliation(TxnStatus.SUBMITTED)).toBe(true)
    expect(needsReconciliation(TxnStatus.PENDING)).toBe(true)
    expect(needsReconciliation(TxnStatus.DEEMED)).toBe(true)

    // Once the outcome is acted on, we stop.
    expect(needsReconciliation(TxnStatus.SUCCESS)).toBe(false)
    expect(needsReconciliation(TxnStatus.REVERSED)).toBe(false)
    expect(needsReconciliation(TxnStatus.EXPIRED)).toBe(false)
  })

  it('only shows a confirmed settlement as success to the user', () => {
    expect(isUserVisibleSuccess(TxnStatus.SUCCESS)).toBe(true)
    // The rail has it; nobody has received anything.
    expect(isUserVisibleSuccess(TxnStatus.PENDING)).toBe(false)
    expect(isUserVisibleSuccess(TxnStatus.SUBMITTED)).toBe(false)
    expect(isUserVisibleSuccess(TxnStatus.DEEMED)).toBe(false)
  })

  it('permits a refund only against a settled amount', () => {
    expect(isRefundable(TxnStatus.SUCCESS)).toBe(true)
    expect(isRefundable(TxnStatus.PARTIALLY_REFUNDED)).toBe(true)
    expect(isRefundable(TxnStatus.REFUNDED)).toBe(false)
    expect(isRefundable(TxnStatus.PENDING)).toBe(false)
    expect(isRefundable(TxnStatus.FAILED)).toBe(false)
  })

  it('routes DEEMED and RISK_HELD to a human', () => {
    expect(needsHumanAttention(TxnStatus.DEEMED)).toBe(true)
    expect(needsHumanAttention(TxnStatus.RISK_HELD)).toBe(true)
    expect(needsHumanAttention(TxnStatus.SUCCESS)).toBe(false)
  })

  it('marks in-flight states for client polling', () => {
    expect(isInFlight(TxnStatus.AWAITING_APPROVAL)).toBe(true)
    expect(isInFlight(TxnStatus.PENDING)).toBe(true)
    expect(isInFlight(TxnStatus.SUCCESS)).toBe(false)
    expect(isSettled(TxnStatus.SUCCESS)).toBe(true)
  })
})

describe('payments.state — corridor + rail routing', () => {
  it('derives the corridor from the currencies alone', () => {
    expect(corridorFor('INR', 'INR')).toBe(Corridor.DOMESTIC)
    expect(corridorFor('SGD', 'INR')).toBe(Corridor.CROSS_BORDER)
    expect(corridorFor('INR', 'SGD')).toBe(Corridor.CROSS_BORDER)
  })

  it('routes each corridor to its rail', () => {
    expect(railFor(Corridor.DOMESTIC, BeneficiaryHandleType.UPI_VPA)).toBe(
      PaymentRail.UPI,
    )
    expect(railFor(Corridor.DOMESTIC, BeneficiaryHandleType.ACCOUNT_IFSC)).toBe(
      PaymentRail.UPI,
    )
    expect(
      railFor(Corridor.CROSS_BORDER, BeneficiaryHandleType.PAYNOW_UPI),
    ).toBe(PaymentRail.UPI_PAYNOW)
  })

  it('refuses an account+IFSC payout over the cross-border linkage', () => {
    // UPI↔PayNow is ADDRESS-based: the sender enters a registered UPI ID and
    // nothing else. Accepting an account number would build a flow the rail
    // cannot execute — discovered only after the user has been debited.
    expect(
      isHandleSupported(
        Corridor.CROSS_BORDER,
        BeneficiaryHandleType.ACCOUNT_IFSC,
      ),
    ).toBe(false)
    expect(
      isHandleSupported(Corridor.CROSS_BORDER, BeneficiaryHandleType.UPI_VPA),
    ).toBe(false)
    expect(
      isHandleSupported(
        Corridor.CROSS_BORDER,
        BeneficiaryHandleType.PAYNOW_UPI,
      ),
    ).toBe(true)
  })

  it('offers collect on the domestic rail only', () => {
    // A property of the linkage, not a limitation of ours: UPI↔PayNow is
    // payer-initiated only, so "request money from abroad" can never succeed.
    expect(supportsCollect(Corridor.DOMESTIC)).toBe(true)
    expect(supportsCollect(Corridor.CROSS_BORDER)).toBe(false)
  })
})

describe('payments.state — status-check budget', () => {
  const t0 = new Date('2026-07-27T10:00:00.000Z')

  it('waits 90 seconds before the first check', () => {
    // A UPI payment that is going to settle has almost always settled by then, so
    // an earlier check spends a scarce query on an answer of "still pending".
    expect(nextPollAt(0, t0)?.toISOString()).toBe('2026-07-27T10:01:30.000Z')
  })

  it('backs off on each subsequent check', () => {
    expect(nextPollAt(1, t0)?.toISOString()).toBe('2026-07-27T10:05:00.000Z')
    expect(nextPollAt(2, t0)?.toISOString()).toBe('2026-07-27T10:30:00.000Z')
  })

  it('exhausts the budget rather than polling forever', () => {
    // NPCI bounds status checks, and exceeding the bound gets a PSP throttled —
    // turning one stuck transfer into every transfer stuck.
    expect(hasStatusCheckBudget(2)).toBe(true)
    expect(hasStatusCheckBudget(3)).toBe(false)
    expect(nextPollAt(3, t0)).toBeNull()
    expect(nextPollAt(99, t0)).toBeNull()
  })
})

describe('payments.state — limit buckets', () => {
  const IST = 330
  const SGT = 480

  it('buckets the day in the corridor timezone, not UTC', () => {
    // 19:00 UTC is already the NEXT day in IST (00:30). A UTC bucket would roll
    // the daily limit over at 05:30 IST, handing every user a window in which two
    // days' limit is spendable inside one Indian day.
    expect(bucketKeyFor('DAY', new Date('2026-07-27T19:00:00Z'), IST)).toBe(
      '2026-07-28',
    )
    expect(bucketKeyFor('DAY', new Date('2026-07-27T18:29:00Z'), IST)).toBe(
      '2026-07-27',
    )
  })

  it('uses the Indian financial year for the LRS window', () => {
    // The LRS ceiling is measured over 1 April – 31 March. A calendar-year bucket
    // would reset the allowance three months early.
    expect(bucketKeyFor('YEAR', new Date('2026-04-01T00:00:00Z'), SGT)).toBe(
      'FY2026-2027',
    )
    expect(bucketKeyFor('YEAR', new Date('2026-03-31T00:00:00Z'), SGT)).toBe(
      'FY2025-2026',
    )
    expect(bucketKeyFor('YEAR', new Date('2027-01-15T00:00:00Z'), SGT)).toBe(
      'FY2026-2027',
    )
  })

  it('buckets months in local terms', () => {
    expect(bucketKeyFor('MONTH', new Date('2026-07-31T19:00:00Z'), IST)).toBe(
      '2026-08',
    )
  })

  it('resets a day bucket at local midnight', () => {
    // Local midnight IST is 18:30 UTC the previous day.
    expect(
      bucketResetAt('DAY', new Date('2026-07-27T10:00:00Z'), IST).toISOString(),
    ).toBe('2026-07-27T18:30:00.000Z')
  })

  it('resets the LRS bucket on 1 April', () => {
    const reset = bucketResetAt('YEAR', new Date('2026-07-27T10:00:00Z'), SGT)
    // 1 April 2027, 00:00 SGT = 31 March 2027, 16:00 UTC.
    expect(reset.toISOString()).toBe('2027-03-31T16:00:00.000Z')
  })
})

describe('payments.state — collect lifecycle', () => {
  it('lets an approved collect still fail', () => {
    // A payer's approval is not a settlement: their bank can still decline for
    // insufficient funds, and a UI treating "approved" as "received" shows the
    // payee money that never arrives.
    expect(
      canCollectTransition(CollectStatus.APPROVED, CollectStatus.FAILED),
    ).toBe(true)
  })

  it('keeps every answered state terminal', () => {
    for (const from of [
      CollectStatus.DECLINED,
      CollectStatus.EXPIRED,
      CollectStatus.REVOKED,
    ]) {
      expect(canCollectTransition(from, CollectStatus.APPROVED)).toBe(false)
    }
  })

  it('closes a collect once it expires', () => {
    const now = new Date('2026-07-27T10:00:00Z')
    expect(
      isCollectOpen(
        CollectStatus.PENDING,
        new Date('2026-07-27T10:05:00Z'),
        now,
      ),
    ).toBe(true)
    expect(
      isCollectOpen(
        CollectStatus.PENDING,
        new Date('2026-07-27T09:59:00Z'),
        now,
      ),
    ).toBe(false)
    expect(
      isCollectOpen(
        CollectStatus.APPROVED,
        new Date('2026-07-27T10:05:00Z'),
        now,
      ),
    ).toBe(false)
  })
})

describe('payments.state — mandate lifecycle', () => {
  it('makes revocation terminal but pausing reversible', () => {
    // The entire user-facing point of having both: a person cancelling a
    // subscription must not be one mis-tap away from it resuming.
    expect(
      canMandateTransition(MandateStatus.PAUSED, MandateStatus.ACTIVE),
    ).toBe(true)
    expect(
      canMandateTransition(MandateStatus.REVOKED, MandateStatus.ACTIVE),
    ).toBe(false)
  })

  it('debits only an active, in-window mandate', () => {
    const now = new Date('2026-07-27T10:00:00Z')
    const from = new Date('2026-01-01T00:00:00Z')
    const until = new Date('2027-01-01T00:00:00Z')

    expect(isMandateDebitable(MandateStatus.ACTIVE, from, until, now)).toBe(
      true,
    )
    expect(isMandateDebitable(MandateStatus.PAUSED, from, until, now)).toBe(
      false,
    )
    expect(
      isMandateDebitable(
        MandateStatus.ACTIVE,
        from,
        new Date('2026-07-01T00:00:00Z'),
        now,
      ),
    ).toBe(false)
    expect(
      isMandateDebitable(
        MandateStatus.ACTIVE,
        new Date('2026-08-01T00:00:00Z'),
        until,
        now,
      ),
    ).toBe(false)
  })

  it('clamps the day of month instead of overflowing', () => {
    // `setMonth` turns 31 January plus one month into 3 March, which for a
    // monthly mandate means skipping February's debit and then debiting twice in
    // March.
    expect(
      nextDebitDate('MONTHLY', new Date('2026-01-31T00:00:00Z'))?.toISOString(),
    ).toBe('2026-02-28T00:00:00.000Z')
    expect(
      nextDebitDate('MONTHLY', new Date('2026-03-31T00:00:00Z'))?.toISOString(),
    ).toBe('2026-04-30T00:00:00.000Z')
    expect(
      nextDebitDate('MONTHLY', new Date('2026-01-15T00:00:00Z'))?.toISOString(),
    ).toBe('2026-02-15T00:00:00.000Z')
  })

  it('handles a leap February', () => {
    expect(
      nextDebitDate('MONTHLY', new Date('2028-01-31T00:00:00Z'))?.toISOString(),
    ).toBe('2028-02-29T00:00:00.000Z')
  })

  it('walks the longer recurrences', () => {
    const base = new Date('2026-07-27T00:00:00Z')
    expect(nextDebitDate('WEEKLY', base)?.toISOString()).toBe(
      '2026-08-03T00:00:00.000Z',
    )
    expect(nextDebitDate('QUARTERLY', base)?.toISOString()).toBe(
      '2026-10-27T00:00:00.000Z',
    )
    expect(nextDebitDate('YEARLY', base)?.toISOString()).toBe(
      '2027-07-27T00:00:00.000Z',
    )
  })

  it('returns no schedule for AS_PRESENTED and ONETIME', () => {
    // There is no schedule — the merchant presents a debit when one is due.
    // Fabricating a date would make the scheduler debit a mandate nobody claimed
    // against.
    const base = new Date('2026-07-27T00:00:00Z')
    expect(nextDebitDate('AS_PRESENTED', base)).toBeNull()
    expect(nextDebitDate('ONETIME', base)).toBeNull()
  })
})
