import {
  CLAIM_FILING_WINDOW_DAYS,
  GRACE_PERIOD_DAYS,
  PREMIUM_PERIOD_DAYS,
} from '@/modules/insurance/insurance.config'
import {
  addDays,
  allowedClaimTransitions,
  allowedPolicyTransitions,
  canAttachDocuments,
  canClaimTransition,
  canPolicyTransition,
  canQuoteTransition,
  COVERAGE_REFUSAL_MESSAGE,
  coverageRefusalFor,
  daysBetween,
  graceEndsAt,
  isClaimInFlight,
  isClaimTerminal,
  isCoverLive,
  isDecidable,
  isPolicyClosed,
  isPremiumDue,
  isQuoteBuyable,
  isWithinFreeLook,
  needsAdjudication,
  needsPayoutRetry,
  nextPremiumDueAt,
  premiumPeriod,
  utcDayKey,
} from '@/modules/insurance/insurance.state'

import {
  ClaimStatus,
  InsuranceQuoteStatus,
  PolicyStatus,
} from 'generated/prisma/client'

const DAY = 86_400_000

describe('insurance.state — quote lifecycle', () => {
  it('walks the happy path', () => {
    expect(
      canQuoteTransition(
        InsuranceQuoteStatus.DRAFT,
        InsuranceQuoteStatus.PRICED,
      ),
    ).toBe(true)
    expect(
      canQuoteTransition(
        InsuranceQuoteStatus.PRICED,
        InsuranceQuoteStatus.CONVERTED,
      ),
    ).toBe(true)
  })

  it('refuses to withdraw an offer that has already been priced', () => {
    // Once a person has been shown a price we do not get to decline them inside
    // its window because their score moved. The offer stands for its 30 minutes.
    expect(
      canQuoteTransition(
        InsuranceQuoteStatus.PRICED,
        InsuranceQuoteStatus.DECLINED,
      ),
    ).toBe(false)
  })

  it('treats DECLINED, EXPIRED and CONVERTED as terminal', () => {
    for (const status of [
      InsuranceQuoteStatus.DECLINED,
      InsuranceQuoteStatus.EXPIRED,
      InsuranceQuoteStatus.CONVERTED,
    ]) {
      expect(canQuoteTransition(status, InsuranceQuoteStatus.PRICED)).toBe(
        false,
      )
    }
  })

  it('is only buyable while PRICED and unexpired', () => {
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)

    expect(isQuoteBuyable(InsuranceQuoteStatus.PRICED, future)).toBe(true)
    expect(isQuoteBuyable(InsuranceQuoteStatus.PRICED, past)).toBe(false)
    expect(isQuoteBuyable(InsuranceQuoteStatus.DECLINED, future)).toBe(false)
    expect(isQuoteBuyable(InsuranceQuoteStatus.CONVERTED, future)).toBe(false)
  })
})

describe('insurance.state — policy lifecycle', () => {
  it('activates only from PENDING_PAYMENT', () => {
    expect(
      canPolicyTransition(PolicyStatus.PENDING_PAYMENT, PolicyStatus.ACTIVE),
    ).toBe(true)
    expect(canPolicyTransition(PolicyStatus.LAPSED, PolicyStatus.ACTIVE)).toBe(
      false,
    )
  })

  it('allows GRACE → ACTIVE, so a recovered premium restores cover', () => {
    // Forcing a new policy after a one-week gap would reset the waiting period,
    // costing a daily-wage earner months of accrued cover because their wallet
    // happened to be empty on a Tuesday.
    expect(canPolicyTransition(PolicyStatus.GRACE, PolicyStatus.ACTIVE)).toBe(
      true,
    )
  })

  it('allows GRACE → EXPIRED, so a term can end while a premium is overdue', () => {
    // Without this edge the expiry sweep skips the row and it sits in GRACE for
    // ever, reading as though cover were still live months after the term ended.
    expect(canPolicyTransition(PolicyStatus.GRACE, PolicyStatus.EXPIRED)).toBe(
      true,
    )
  })

  it('makes LAPSED terminal — money arriving later must not revive cover', () => {
    expect(allowedPolicyTransitions(PolicyStatus.LAPSED)).toEqual([])
    expect(canPolicyTransition(PolicyStatus.LAPSED, PolicyStatus.ACTIVE)).toBe(
      false,
    )
  })

  it('refuses to activate from CANCELLED or EXPIRED', () => {
    expect(
      canPolicyTransition(PolicyStatus.CANCELLED, PolicyStatus.ACTIVE),
    ).toBe(false)
    expect(canPolicyTransition(PolicyStatus.EXPIRED, PolicyStatus.ACTIVE)).toBe(
      false,
    )
  })

  it('counts GRACE as live cover', () => {
    // The whole reason the state exists: the premium is late, not abandoned, and a
    // claim filed during grace is payable. It is a real cost the book carries.
    expect(isCoverLive(PolicyStatus.ACTIVE)).toBe(true)
    expect(isCoverLive(PolicyStatus.GRACE)).toBe(true)

    expect(isCoverLive(PolicyStatus.PENDING_PAYMENT)).toBe(false)
    expect(isCoverLive(PolicyStatus.LAPSED)).toBe(false)
    expect(isCoverLive(PolicyStatus.CANCELLED)).toBe(false)
    expect(isCoverLive(PolicyStatus.EXPIRED)).toBe(false)
  })

  it('does not count PENDING_PAYMENT as closed — it is still becoming a policy', () => {
    expect(isPolicyClosed(PolicyStatus.PENDING_PAYMENT)).toBe(false)
    expect(isPolicyClosed(PolicyStatus.LAPSED)).toBe(true)
    expect(isPolicyClosed(PolicyStatus.CANCELLED)).toBe(true)
    expect(isPolicyClosed(PolicyStatus.EXPIRED)).toBe(true)
  })

  it('only calls a premium due on live cover with a due date in the past', () => {
    const past = new Date(Date.now() - DAY)
    const future = new Date(Date.now() + DAY)

    expect(isPremiumDue(PolicyStatus.ACTIVE, past)).toBe(true)
    expect(isPremiumDue(PolicyStatus.GRACE, past)).toBe(true)
    expect(isPremiumDue(PolicyStatus.ACTIVE, future)).toBe(false)
    // A one-time product has no due date and must never enter dunning.
    expect(isPremiumDue(PolicyStatus.ACTIVE, null)).toBe(false)
    expect(isPremiumDue(PolicyStatus.LAPSED, past)).toBe(false)
  })

  it('closes the free-look window at its stated instant', () => {
    expect(isWithinFreeLook(new Date(Date.now() + 1_000))).toBe(true)
    expect(isWithinFreeLook(new Date(Date.now() - 1_000))).toBe(false)
    expect(isWithinFreeLook(null)).toBe(false)
  })
})

describe('insurance.state — coverage refusals', () => {
  const now = new Date('2026-07-28T12:00:00.000Z')
  const base = {
    status: PolicyStatus.ACTIVE,
    startAt: new Date('2026-05-01T00:00:00.000Z'),
    endAt: new Date('2027-05-01T00:00:00.000Z'),
    waitingPeriodEndsAt: new Date('2026-05-31T00:00:00.000Z'),
  }

  it('covers an incident after the waiting period and inside the term', () => {
    expect(
      coverageRefusalFor(base, new Date('2026-07-01T00:00:00.000Z'), now),
    ).toBeNull()
  })

  it('refuses an incident inside the waiting period', () => {
    expect(
      coverageRefusalFor(base, new Date('2026-05-15T00:00:00.000Z'), now),
    ).toBe('WITHIN_WAITING_PERIOD')
  })

  it('compares the INCIDENT date, not the filing date', () => {
    // A claim filed today for an incident inside the waiting period is not
    // covered however long the claimant waited to file it. This is THE
    // anti-adverse-selection control, and getting the comparison operand wrong
    // silently disables it.
    expect(
      coverageRefusalFor(base, new Date('2026-05-20T00:00:00.000Z'), now),
    ).toBe('WITHIN_WAITING_PERIOD')

    // An incident on the exact boundary IS covered — the period "ends at" that
    // instant rather than including it.
    expect(coverageRefusalFor(base, base.waitingPeriodEndsAt, now)).toBeNull()
  })

  it('refuses an incident before cover started', () => {
    expect(
      coverageRefusalFor(base, new Date('2026-04-20T00:00:00.000Z'), now),
    ).toBe('BEFORE_COVER_START')
  })

  it('refuses an incident after the term ended', () => {
    const later = new Date('2027-06-01T00:00:00.000Z')
    expect(
      coverageRefusalFor(base, new Date('2027-05-15T00:00:00.000Z'), later),
    ).toBe('AFTER_COVER_END')
  })

  it('refuses a claim filed outside the filing window', () => {
    const incident = new Date('2026-01-05T00:00:00.000Z')
    const policy = {
      ...base,
      startAt: new Date('2025-01-01T00:00:00.000Z'),
      waitingPeriodEndsAt: new Date('2025-01-31T00:00:00.000Z'),
      endAt: new Date('2027-01-01T00:00:00.000Z'),
    }

    expect(
      coverageRefusalFor(
        policy,
        incident,
        addDays(incident, CLAIM_FILING_WINDOW_DAYS + 1),
      ),
    ).toBe('FILING_WINDOW_CLOSED')
    // The last day of the window is still inside it.
    expect(
      coverageRefusalFor(
        policy,
        incident,
        addDays(incident, CLAIM_FILING_WINDOW_DAYS),
      ),
    ).toBeNull()
  })

  it('refuses any claim on a policy that is not live', () => {
    for (const status of [
      PolicyStatus.LAPSED,
      PolicyStatus.CANCELLED,
      PolicyStatus.EXPIRED,
      PolicyStatus.PENDING_PAYMENT,
    ]) {
      expect(
        coverageRefusalFor(
          { ...base, status },
          new Date('2026-07-01T00:00:00.000Z'),
          now,
        ),
      ).toBe('POLICY_NOT_LIVE')
    }
  })

  it('has a plain-language message for every refusal', () => {
    // A refusal the claimant cannot understand is the experience this product
    // exists to replace.
    for (const refusal of [
      'POLICY_NOT_LIVE',
      'WITHIN_WAITING_PERIOD',
      'BEFORE_COVER_START',
      'AFTER_COVER_END',
      'FILING_WINDOW_CLOSED',
    ] as const) {
      expect(COVERAGE_REFUSAL_MESSAGE[refusal].length).toBeGreaterThan(20)
    }
  })
})

describe('insurance.state — claim lifecycle', () => {
  it('walks the happy path to PAID', () => {
    expect(
      canClaimTransition(ClaimStatus.SUBMITTED, ClaimStatus.UNDER_REVIEW),
    ).toBe(true)
    expect(
      canClaimTransition(ClaimStatus.UNDER_REVIEW, ClaimStatus.APPROVED),
    ).toBe(true)
    expect(canClaimTransition(ClaimStatus.APPROVED, ClaimStatus.PAID)).toBe(
      true,
    )
  })

  it('has PAID as the only edge out of APPROVED', () => {
    // An approval is a commitment. Once a claimant has been told their claim is
    // approved it cannot be walked back because a payout failed — the money is
    // owed, and the only remaining question is when it arrives.
    expect(allowedClaimTransitions(ClaimStatus.APPROVED)).toEqual([
      ClaimStatus.PAID,
    ])
    expect(canClaimTransition(ClaimStatus.APPROVED, ClaimStatus.REJECTED)).toBe(
      false,
    )
  })

  it('allows the INFO_REQUESTED round trip', () => {
    expect(
      canClaimTransition(ClaimStatus.UNDER_REVIEW, ClaimStatus.INFO_REQUESTED),
    ).toBe(true)
    expect(
      canClaimTransition(ClaimStatus.INFO_REQUESTED, ClaimStatus.UNDER_REVIEW),
    ).toBe(true)
  })

  it('makes PAID, REJECTED and WITHDRAWN terminal — an appeal is a NEW claim', () => {
    for (const status of [
      ClaimStatus.PAID,
      ClaimStatus.REJECTED,
      ClaimStatus.WITHDRAWN,
    ]) {
      expect(allowedClaimTransitions(status)).toEqual([])
      expect(isClaimTerminal(status)).toBe(true)
    }
  })

  it('cannot skip review and go straight from SUBMITTED to APPROVED', () => {
    // Even the auto-approve path goes through UNDER_REVIEW, because that is where
    // the fraud gate and the tamper check actually run.
    expect(
      canClaimTransition(ClaimStatus.SUBMITTED, ClaimStatus.APPROVED),
    ).toBe(false)
    expect(canClaimTransition(ClaimStatus.SUBMITTED, ClaimStatus.PAID)).toBe(
      false,
    )
  })

  it('counts APPROVED as still in flight', () => {
    // The claimant has been promised money that has not arrived. A client that
    // stopped polling here would leave them staring at "approved" for ever.
    expect(isClaimInFlight(ClaimStatus.APPROVED)).toBe(true)
    expect(isClaimInFlight(ClaimStatus.PAID)).toBe(false)
    expect(isClaimInFlight(ClaimStatus.REJECTED)).toBe(false)
  })

  it('only takes documents while SUBMITTED or INFO_REQUESTED', () => {
    expect(canAttachDocuments(ClaimStatus.SUBMITTED)).toBe(true)
    expect(canAttachDocuments(ClaimStatus.INFO_REQUESTED)).toBe(true)
    // Not once a reviewer is looking at it — the evidence set has to be stable at
    // the moment of decision.
    expect(canAttachDocuments(ClaimStatus.UNDER_REVIEW)).toBe(false)
    expect(canAttachDocuments(ClaimStatus.PAID)).toBe(false)
  })

  it('is decidable only from UNDER_REVIEW or INFO_REQUESTED', () => {
    expect(isDecidable(ClaimStatus.UNDER_REVIEW)).toBe(true)
    expect(isDecidable(ClaimStatus.INFO_REQUESTED)).toBe(true)
    expect(isDecidable(ClaimStatus.SUBMITTED)).toBe(false)
    expect(isDecidable(ClaimStatus.APPROVED)).toBe(false)
  })

  it('flags an approved-but-unpaid claim for retry', () => {
    // The quietest failure in the module: the claimant was told "approved", no
    // error was logged, and the money never arrived.
    expect(needsPayoutRetry(ClaimStatus.APPROVED, null)).toBe(true)
    expect(needsPayoutRetry(ClaimStatus.APPROVED, 'txn-1')).toBe(false)
    expect(needsPayoutRetry(ClaimStatus.PAID, 'txn-1')).toBe(false)
  })

  it('puts only UNDER_REVIEW in the adjudication queue', () => {
    expect(needsAdjudication(ClaimStatus.UNDER_REVIEW)).toBe(true)
    // INFO_REQUESTED is waiting on the CLAIMANT, not on a reviewer.
    expect(needsAdjudication(ClaimStatus.INFO_REQUESTED)).toBe(false)
    expect(needsAdjudication(ClaimStatus.SUBMITTED)).toBe(false)
  })
})

describe('insurance.state — date arithmetic', () => {
  it('adds whole days in milliseconds, not calendar arithmetic', () => {
    const from = new Date('2026-03-28T23:30:00.000Z')
    // Across a DST boundary in local time this is where `setDate` would shift the
    // time of day. A waiting period that ends an hour early is a claim paid that
    // should not have been; an hour late is one refused that should have been paid.
    expect(addDays(from, 3).toISOString()).toBe('2026-03-31T23:30:00.000Z')
    expect(addDays(from, 0)).toEqual(from)
    expect(addDays(from, -1).toISOString()).toBe('2026-03-27T23:30:00.000Z')
  })

  it('truncates days between two instants', () => {
    const a = new Date('2026-01-01T00:00:00.000Z')
    expect(daysBetween(a, new Date('2026-01-04T23:59:59.000Z'))).toBe(3)
    expect(daysBetween(a, a)).toBe(0)
  })

  it('keys the claim fingerprint on the UTC day', () => {
    expect(utcDayKey(new Date('2026-07-14T18:45:12.000Z'))).toBe('2026-07-14')
  })

  it('builds a fixed-length premium period', () => {
    const start = new Date('2026-01-31T00:00:00.000Z')
    const period = premiumPeriod(start)

    expect(period.start).toEqual(start)
    // A fixed 30 days, not a calendar month. Calendar months make "the period
    // starting 31 January" ambiguous, and the dunning cron and a manual retry
    // would resolve it differently — which is two premium rows for one month.
    expect(period.end.getTime() - period.start.getTime()).toBe(
      PREMIUM_PERIOD_DAYS * DAY,
    )
  })

  it('closes the grace window a fixed number of days after the due date', () => {
    const due = new Date('2026-06-10T08:00:00.000Z')
    expect(graceEndsAt(due).getTime() - due.getTime()).toBe(
      GRACE_PERIOD_DAYS * DAY,
    )
  })

  it('gives a one-time product no next due date', () => {
    const end = new Date('2026-08-01T00:00:00.000Z')
    // `null`, not a fabricated date: a one-time policy with a due date would be
    // swept into dunning and lapsed for not paying a premium it never owed.
    expect(nextPremiumDueAt('ONE_TIME', end)).toBeNull()
    expect(nextPremiumDueAt('MONTHLY', end)).toEqual(end)
  })
})
