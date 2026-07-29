import {
  ClaimStatus,
  InsuranceQuoteStatus,
  PolicyStatus,
} from 'generated/prisma/client'

import {
  CLAIM_FILING_WINDOW_DAYS,
  GRACE_PERIOD_DAYS,
  PREMIUM_PERIOD_DAYS,
} from '@/modules/insurance/insurance.config'

/**
 * Pure M5 logic — NO I/O, so every rule is unit-testable and the meaning of a
 * quote, a policy or a claim cannot drift between the quoting service, the
 * claims service, three cron sweeps, the insurer webhook and the admin console.
 * This is the M5 counterpart to M1's `consent.state.ts`, M2's `scoring.state.ts`,
 * M3's `passport.state.ts` and M4's `payments.state.ts`.
 *
 * Six different callers move a policy's status, two of them on a schedule and one
 * of them from outside our process. The only thing keeping them consistent is
 * that they all ask this file first.
 *
 * The insurance-specific point: in payments a wrong transition loses money once.
 * Here a wrong transition decides whether somebody WAS COVERED at the moment
 * something happened to them — and that question gets asked retroactively, after
 * the event, by a person with a hospital bill. So the predicates below
 * (`isCoverLive`, `isIncidentCovered`) are written to be answerable about a
 * point in the past, not just about now.
 */

// ── date arithmetic ─────────────────────────────────────────────────────────
/**
 * Add whole days.
 *
 * Milliseconds rather than `setDate`, deliberately. Every M5 window (waiting
 * period, free look, grace, term) is a fixed count of 24-hour periods measured
 * from an instant, and `setDate` would shift the time-of-day across a DST
 * boundary. A waiting period that ends an hour early is a claim paid that should
 * not have been; an hour late is a claim refused that should have been paid, to
 * somebody holding a hospital bill.
 */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000)
}

/** Whole days between two instants, truncated. Used for display and for windows. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

/** The UTC calendar day, `YYYY-MM-DD`. The claim dedupe fingerprint's date part. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10)
}

// ── quote lifecycle ─────────────────────────────────────────────────────────
/**
 * ```
 *   DRAFT ──▶ PRICED ──▶ CONVERTED        (bought)
 *     │         └──────▶ EXPIRED          (validUntil passed)
 *     └──────▶ DECLINED                   (tier = DECLINE / ineligible)
 * ```
 *
 * `DECLINED` is terminal and is NOT reachable from `PRICED`. That asymmetry is
 * load-bearing: once a person has been shown a price, we do not get to withdraw
 * it inside its window because their score moved. The offer stands for its
 * thirty minutes, and a re-quote after that is a new decision on new evidence.
 */
const QUOTE_ALLOWED: Record<InsuranceQuoteStatus, InsuranceQuoteStatus[]> = {
  DRAFT: [
    InsuranceQuoteStatus.PRICED,
    InsuranceQuoteStatus.DECLINED,
    InsuranceQuoteStatus.EXPIRED,
  ],
  PRICED: [InsuranceQuoteStatus.CONVERTED, InsuranceQuoteStatus.EXPIRED],
  DECLINED: [],
  EXPIRED: [],
  CONVERTED: [],
}

export function canQuoteTransition(
  from: InsuranceQuoteStatus,
  to: InsuranceQuoteStatus,
): boolean {
  return QUOTE_ALLOWED[from]?.includes(to) ?? false
}

/** Whether a quote can still be bought from. */
export function isQuoteBuyable(
  status: InsuranceQuoteStatus,
  validUntil: Date,
  now = new Date(),
): boolean {
  return status === InsuranceQuoteStatus.PRICED && validUntil > now
}

// ── policy lifecycle ────────────────────────────────────────────────────────
/**
 * ```
 *   PENDING_PAYMENT ──▶ ACTIVE                (first premium settled)
 *          └──────────▶ CANCELLED             (payment abandoned)
 *   ACTIVE ──▶ GRACE ──▶ ACTIVE               (recurring premium recovered)
 *     │          └─────▶ LAPSED               (grace window elapsed)
 *     ├──▶ CANCELLED                          (free-look or anytime cancel)
 *     └──▶ EXPIRED                            (term ended)
 * ```
 *
 * Three edges deserve their reasons stated, because each is a place a naive
 * implementation costs somebody their cover:
 *
 *  - **`GRACE → ACTIVE`.** A missed premium that is later paid RESTORES cover
 *    rather than requiring a new policy. Forcing a re-purchase would reset the
 *    waiting period, which means a daily-wage earner whose wallet was empty on
 *    the due date loses months of accrued cover over a one-week gap.
 *  - **`GRACE → EXPIRED` is present.** A policy can reach the end of its term
 *    while in grace. Without this edge the term-expiry sweep would skip it and
 *    the row would sit in GRACE for ever, reading as though cover were still
 *    live.
 *  - **`LAPSED` is terminal.** Once cover has genuinely ended, money arriving
 *    later must not silently revive it — a claim decided against a policy that
 *    resurrected itself is unarguable in both directions. The premium is
 *    refunded and the user buys again, with the reset waiting period stated up
 *    front.
 */
const POLICY_ALLOWED: Record<PolicyStatus, PolicyStatus[]> = {
  PENDING_PAYMENT: [PolicyStatus.ACTIVE, PolicyStatus.CANCELLED],
  ACTIVE: [PolicyStatus.GRACE, PolicyStatus.CANCELLED, PolicyStatus.EXPIRED],
  GRACE: [
    PolicyStatus.ACTIVE,
    PolicyStatus.LAPSED,
    PolicyStatus.CANCELLED,
    PolicyStatus.EXPIRED,
  ],
  LAPSED: [],
  CANCELLED: [],
  EXPIRED: [],
}

export function canPolicyTransition(
  from: PolicyStatus,
  to: PolicyStatus,
): boolean {
  return POLICY_ALLOWED[from]?.includes(to) ?? false
}

export function allowedPolicyTransitions(from: PolicyStatus): PolicyStatus[] {
  return [...(POLICY_ALLOWED[from] ?? [])]
}

/**
 * Whether cover is LIVE right now.
 *
 * `GRACE` is included, and that inclusion is the whole reason the state exists.
 * A policyholder inside the grace window is still insured — the premium is late,
 * not abandoned — and a claim filed during it is payable. It is a real cost the
 * book carries knowingly, and excluding grace here would make the state a
 * cosmetic label on a policy that had already been quietly voided.
 */
export function isCoverLive(status: PolicyStatus): boolean {
  return status === PolicyStatus.ACTIVE || status === PolicyStatus.GRACE
}

/** A policy that will never cover anything again. Drives the wallet's UI. */
export function isPolicyClosed(status: PolicyStatus): boolean {
  return (
    status === PolicyStatus.LAPSED ||
    status === PolicyStatus.CANCELLED ||
    status === PolicyStatus.EXPIRED
  )
}

/** Whether a recurring premium is still owed on this policy. */
export function isPremiumDue(
  status: PolicyStatus,
  nextPremiumDueAt: Date | null,
  now = new Date(),
): boolean {
  if (!nextPremiumDueAt) return false
  return isCoverLive(status) && nextPremiumDueAt <= now
}

/** Whether the policy is inside its cancel-for-full-refund window. */
export function isWithinFreeLook(
  freeLookEndsAt: Date | null,
  now = new Date(),
): boolean {
  return freeLookEndsAt !== null && freeLookEndsAt > now
}

/**
 * The reason an incident is NOT covered, or `null` when it is.
 *
 * Returns a REASON rather than a boolean, because every one of these branches is
 * something a claimant has to be told in words they can act on — and because the
 * same function is the audit answer to "why was this refused?". A boolean here
 * would force the caller to re-derive the explanation, and the two would drift.
 *
 * Evaluated entirely from values passed in, so it can answer the question about a
 * point in the PAST: a reviewer looking at a claim six weeks later gets the same
 * verdict the submission did.
 */
export type CoverageRefusal =
  | 'POLICY_NOT_LIVE'
  | 'WITHIN_WAITING_PERIOD'
  | 'BEFORE_COVER_START'
  | 'AFTER_COVER_END'
  | 'FILING_WINDOW_CLOSED'

export function coverageRefusalFor(
  policy: {
    status: PolicyStatus
    startAt: Date | null
    endAt: Date | null
    waitingPeriodEndsAt: Date | null
  },
  incidentDate: Date,
  now = new Date(),
): CoverageRefusal | null {
  if (!isCoverLive(policy.status)) return 'POLICY_NOT_LIVE'

  if (policy.startAt && incidentDate < policy.startAt) {
    return 'BEFORE_COVER_START'
  }
  /**
   * The waiting-period check.
   *
   * Compares the INCIDENT date, never `now`. A claim filed today for an incident
   * that happened inside the waiting period is not covered no matter how long the
   * claimant waited to file it — and a claim for an incident after the waiting
   * period is covered even if the policy has since lapsed, which is why the
   * refusal above tests the policy status separately.
   */
  if (policy.waitingPeriodEndsAt && incidentDate < policy.waitingPeriodEndsAt) {
    return 'WITHIN_WAITING_PERIOD'
  }
  if (policy.endAt && incidentDate > policy.endAt) return 'AFTER_COVER_END'

  if (daysBetween(incidentDate, now) > CLAIM_FILING_WINDOW_DAYS) {
    return 'FILING_WINDOW_CLOSED'
  }
  return null
}

/** The refusal, in words the claimant reads. */
export const COVERAGE_REFUSAL_MESSAGE: Record<CoverageRefusal, string> = {
  POLICY_NOT_LIVE:
    'This policy is not active, so there is no cover to claim against.',
  WITHIN_WAITING_PERIOD:
    'This incident falls inside the policy’s waiting period, which is not covered. Your waiting period and its end date are shown on the policy.',
  BEFORE_COVER_START: 'This incident happened before the cover started.',
  AFTER_COVER_END: 'This incident happened after the policy term ended.',
  FILING_WINDOW_CLOSED: `Claims must be filed within ${CLAIM_FILING_WINDOW_DAYS} days of the incident.`,
}

// ── claim lifecycle ────────────────────────────────────────────────────────
/**
 * ```
 *   SUBMITTED ──▶ UNDER_REVIEW ──▶ APPROVED ──▶ PAID
 *      │               │      └──▶ REJECTED
 *      │               └──▶ INFO_REQUESTED ──▶ UNDER_REVIEW
 *      └──▶ WITHDRAWN                    └──▶ WITHDRAWN
 * ```
 *
 * `APPROVED → PAID` is the only edge out of `APPROVED`, and there is deliberately
 * no `APPROVED → REJECTED`. An approval is a commitment: once a claimant has been
 * told their claim is approved, the decision cannot be walked back because a
 * payout failed. A failed payout leaves the claim APPROVED and RETRYABLE, exactly
 * as M4 leaves a settled-but-unbooked transfer recoverable — the money is owed,
 * and the only question is when it arrives.
 *
 * `REJECTED` is terminal, and an appeal is a NEW claim rather than a reopening.
 * Reopening would give one claim two decisions and two decision reasons, and no
 * audit could then say which one the payout (or the refusal) rested on.
 */
const CLAIM_ALLOWED: Record<ClaimStatus, ClaimStatus[]> = {
  SUBMITTED: [ClaimStatus.UNDER_REVIEW, ClaimStatus.WITHDRAWN],
  UNDER_REVIEW: [
    ClaimStatus.INFO_REQUESTED,
    ClaimStatus.APPROVED,
    ClaimStatus.REJECTED,
  ],
  INFO_REQUESTED: [
    ClaimStatus.UNDER_REVIEW,
    ClaimStatus.WITHDRAWN,
    // The claimant never came back. Closed rather than judged — see
    // INFO_REQUEST_TTL_DAYS.
    ClaimStatus.REJECTED,
  ],
  APPROVED: [ClaimStatus.PAID],
  PAID: [],
  REJECTED: [],
  WITHDRAWN: [],
}

export function canClaimTransition(
  from: ClaimStatus,
  to: ClaimStatus,
): boolean {
  return CLAIM_ALLOWED[from]?.includes(to) ?? false
}

export function allowedClaimTransitions(from: ClaimStatus): ClaimStatus[] {
  return [...(CLAIM_ALLOWED[from] ?? [])]
}

/** Whether the claimant may still add or replace documents. */
export function canAttachDocuments(status: ClaimStatus): boolean {
  return (
    status === ClaimStatus.SUBMITTED || status === ClaimStatus.INFO_REQUESTED
  )
}

/** Whether an adjudicator may decide this claim. */
export function isDecidable(status: ClaimStatus): boolean {
  return (
    status === ClaimStatus.UNDER_REVIEW || status === ClaimStatus.INFO_REQUESTED
  )
}

/** A claim that will never move again on its own. */
export function isClaimTerminal(status: ClaimStatus): boolean {
  return (
    status === ClaimStatus.PAID ||
    status === ClaimStatus.REJECTED ||
    status === ClaimStatus.WITHDRAWN
  )
}

/**
 * Whether the app should keep polling this claim.
 *
 * `APPROVED` is in the set. An approved-but-unpaid claim is still in flight from
 * the claimant's point of view: they have been promised money that has not
 * arrived, and a client that stopped polling would leave them looking at
 * "approved" with no idea when it becomes cash.
 */
export function isClaimInFlight(status: ClaimStatus): boolean {
  return (
    status === ClaimStatus.SUBMITTED ||
    status === ClaimStatus.UNDER_REVIEW ||
    status === ClaimStatus.INFO_REQUESTED ||
    status === ClaimStatus.APPROVED
  )
}

/** Claims a human has to look at. Drives the admin queue's count badge. */
export function needsAdjudication(status: ClaimStatus): boolean {
  return status === ClaimStatus.UNDER_REVIEW
}

/**
 * An approved claim whose payout has not settled.
 *
 * The M5 equivalent of M4's `needsReconciliation`, and it exists for the same
 * reason: the expensive failure is not a payout that errored loudly, it is one
 * everybody stopped looking at.
 */
export function needsPayoutRetry(
  status: ClaimStatus,
  payoutTxnId: string | null,
): boolean {
  return status === ClaimStatus.APPROVED && payoutTxnId === null
}

// ── premium period arithmetic ───────────────────────────────────────────────
/**
 * The cover period a premium buys, from its start.
 *
 * A fixed 30-day period rather than a calendar month, and the reason is the
 * unique constraint on `(policyId, periodStart)`: a deterministic period start is
 * what makes a dunning retry an UPSERT of the same obligation instead of a second
 * one. Calendar months would make "the period starting 31 January" ambiguous, and
 * the ambiguity would be resolved differently by the cron and by a manual retry.
 */
export function premiumPeriod(start: Date): { start: Date; end: Date } {
  return { start, end: addDays(start, PREMIUM_PERIOD_DAYS) }
}

/** When the grace window closes for a premium that came due at `dueAt`. */
export function graceEndsAt(dueAt: Date): Date {
  return addDays(dueAt, GRACE_PERIOD_DAYS)
}

/**
 * The next premium due date, or `null` for a one-time product.
 *
 * `null` rather than a fabricated date, for the same reason M4's
 * `nextDebitDate` returns null for `AS_PRESENTED`: a one-time policy with a due
 * date would be swept into the dunning cron and lapsed for not paying a premium
 * it never owed.
 */
export function nextPremiumDueAt(
  frequency: 'ONE_TIME' | 'MONTHLY',
  periodEnd: Date,
): Date | null {
  return frequency === 'MONTHLY' ? periodEnd : null
}
