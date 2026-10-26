import type { CorridorInput } from '@pravaah/schema'

import {
  MAX_STATUS_CHECKS,
  STATUS_CHECK_SCHEDULE_MS,
} from '@/modules/payments/payments.config'

import {
  BeneficiaryHandleType,
  CollectStatus,
  Corridor,
  MandateStatus,
  PaymentRail,
  TxnStatus,
  TxnType,
} from 'generated/prisma/client'

/**
 * Pure M4 logic — NO I/O, so every rule is unit-testable and the meaning of a
 * transaction's state cannot drift between the orchestrator, the webhook handler,
 * the reconciler, the schedulers, and the admin console. This is the M4
 * counterpart to M1's `consent.state.ts`, M2's `scoring.state.ts` and M3's
 * `passport.state.ts`.
 *
 * Five different callers move a transaction's status, three of them concurrently
 * and two of them from outside our process. The only thing keeping them
 * consistent is that they all ask this file first.
 */

// ── the saga's transition graph ─────────────────────────────────────────────
/**
 * What may follow what.
 *
 * Most of this is unsurprising. Four edges are not, and they are the ones that
 * make the difference between a payments system and a demo:
 *
 *  - `FAILED → SUCCESS`. We timed out, marked the transfer failed, and the rail
 *    settled it anyway. This is the single most expensive event in payments, and a
 *    state machine that treats FAILED as terminal cannot represent the
 *    correction — so it silently keeps a beneficiary paid out of our own pocket.
 *    Reconciliation trusts the rail, and this edge is how.
 *  - `REVERSED → SUCCESS` and `REFUNDED → SUCCESS`. The same story after we had
 *    already given the money back. The correction still has to be bookable, which
 *    is what `AccountType.RECEIVABLE` exists for: the money genuinely left, so it
 *    must appear somewhere, and refusing to book it would break the trial balance
 *    — the one alarm that must never be silenced.
 *  - `DEEMED → *`. A rail that never answered is not a rail that said no.
 *
 * `EXPIRED` is the only truly terminal state: nothing was ever submitted, so
 * there is nothing for the rail to contradict later.
 */
const ALLOWED: Record<TxnStatus, TxnStatus[]> = {
  INITIATED: [TxnStatus.VALIDATED, TxnStatus.RISK_HELD, TxnStatus.FAILED],

  VALIDATED: [
    TxnStatus.RISK_HELD,
    TxnStatus.RESERVED,
    // A collect: our user is the payee, so there is nothing of ours to reserve.
    TxnStatus.AWAITING_APPROVAL,
    TxnStatus.FAILED,
  ],

  // A hold is reversible — that is the difference between a review and a block.
  RISK_HELD: [TxnStatus.VALIDATED, TxnStatus.FAILED],

  AWAITING_APPROVAL: [
    TxnStatus.SUBMITTED,
    TxnStatus.PENDING,
    TxnStatus.SUCCESS,
    TxnStatus.FAILED,
    // Nobody answered. Nothing moved, so nothing needs unwinding.
    TxnStatus.EXPIRED,
  ],

  RESERVED: [
    TxnStatus.SUBMITTED,
    // Pre-submission failure: release the reserve. No rail leg was ever created.
    TxnStatus.REVERSED,
    TxnStatus.FAILED,
  ],

  SUBMITTED: [
    TxnStatus.PENDING,
    TxnStatus.SUCCESS,
    TxnStatus.FAILED,
    TxnStatus.DEEMED,
  ],

  PENDING: [TxnStatus.SUCCESS, TxnStatus.FAILED, TxnStatus.DEEMED],

  // Settled money can still come back — but it can never un-settle.
  SUCCESS: [TxnStatus.PARTIALLY_REFUNDED, TxnStatus.REFUNDED],

  /**
   * NOT terminal. `SUCCESS` is the late-settlement correction; `REVERSED` and
   * `REFUNDED` are the compensations that return the funds.
   */
  FAILED: [TxnStatus.SUCCESS, TxnStatus.REVERSED, TxnStatus.REFUNDED],

  /** Recovery: we released the reserve, then the rail settled after all. */
  REVERSED: [TxnStatus.SUCCESS],
  REFUNDED: [TxnStatus.SUCCESS],

  /** The self-edge is how a second partial refund is expressed. */
  PARTIALLY_REFUNDED: [TxnStatus.PARTIALLY_REFUNDED, TxnStatus.REFUNDED],

  EXPIRED: [],

  /** A human or the rail eventually resolves it, in either direction. */
  DEEMED: [TxnStatus.SUCCESS, TxnStatus.FAILED, TxnStatus.REVERSED],
}

export function canTransition(from: TxnStatus, to: TxnStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/** The transitions available from a state — for the admin console's action list. */
export function allowedTransitions(from: TxnStatus): TxnStatus[] {
  return [...(ALLOWED[from] ?? [])]
}

// ── saga ownership ──────────────────────────────────────────────────────────
/**
 * Transaction types whose saga another module owns.
 *
 * M5 writes PREMIUM and CLAIM_PAYOUT rows through `createRaw` so they share the
 * transaction table and the ledger, but it drives them with its OWN steps
 * (`InsuranceMoneyService.settlePremium` / `settleClaimPayout`) and resumes them
 * with its OWN sweep (`InsuranceLifecycleService.resumeStuckTransactions`). They are
 * internal wallet ↔ book moves: no UPI cap applies and no rail is ever asked.
 *
 * Running one through M4's transfer saga is wrong at every step. An SGD premium dies
 * in `limitBasis` ("No INR leg to measure the DOMESTIC cap against") — and is then
 * re-driven every minute, forever, by `recoverStuckSagas`. An INR premium is worse,
 * because it SUCCEEDS: it consumes the holder's UPI daily cap for a payment that never
 * touched UPI, then submits an internal premium to a payment rail.
 */
export const EXTERNALLY_DRIVEN_TYPES: readonly TxnType[] = [
  TxnType.PREMIUM,
  TxnType.CLAIM_PAYOUT,
]

/** Whether M4's transfer saga (`TransferOrchestratorService.drive`) may move this row. */
export function isDrivenByTransferSaga(type: TxnType): boolean {
  return !EXTERNALLY_DRIVEN_TYPES.includes(type)
}

// ── derived predicates ──────────────────────────────────────────────────────
/**
 * Whether the sender's funds are currently sitting in suspense.
 *
 * The states where money has left the wallet but has not yet reached the
 * beneficiary. Anything in this set represents a real balance the platform is
 * holding on someone's behalf, which is why the suspense account's balance and
 * the sum over these rows must agree — and why an admin dashboard that lists them
 * is an operational necessity rather than a nicety.
 */
export function hasFundsInSuspense(status: TxnStatus): boolean {
  return (
    status === TxnStatus.RESERVED ||
    status === TxnStatus.SUBMITTED ||
    status === TxnStatus.PENDING ||
    status === TxnStatus.DEEMED
  )
}

/** Money reached the beneficiary. */
export function isSettled(status: TxnStatus): boolean {
  return (
    status === TxnStatus.SUCCESS ||
    status === TxnStatus.PARTIALLY_REFUNDED ||
    status === TxnStatus.REFUNDED
  )
}

/** A settled payment that can still be (further) refunded. */
export function isRefundable(status: TxnStatus): boolean {
  return status === TxnStatus.SUCCESS || status === TxnStatus.PARTIALLY_REFUNDED
}

/**
 * Whether reconciliation should still ask the rail about this row.
 *
 * `FAILED` is in the set, and that inclusion IS the money-loss defence. The
 * obvious reading — "it failed, we are done" — is what leaves a settled payment
 * unrecorded forever. We stop asking only once the rail has given a final answer
 * we have acted on, and a timeout is not a final answer.
 */
export function needsReconciliation(status: TxnStatus): boolean {
  return (
    status === TxnStatus.SUBMITTED ||
    status === TxnStatus.PENDING ||
    status === TxnStatus.DEEMED ||
    status === TxnStatus.FAILED
  )
}

/** Rows a human must look at. Drives the admin queue. */
export function needsHumanAttention(status: TxnStatus): boolean {
  return status === TxnStatus.DEEMED || status === TxnStatus.RISK_HELD
}

/**
 * A transaction that will never move again on its own.
 *
 * Note what is NOT here: SUCCESS, FAILED, REVERSED and REFUNDED are all
 * *closed* but still correctable, because the rail can contradict any of them.
 * Only EXPIRED is beyond correction, and only because nothing was submitted.
 */
export function isTerminal(status: TxnStatus): boolean {
  return status === TxnStatus.EXPIRED
}

/** Whether the app should keep polling for a status change. */
export function isInFlight(status: TxnStatus): boolean {
  return (
    status === TxnStatus.INITIATED ||
    status === TxnStatus.VALIDATED ||
    status === TxnStatus.RESERVED ||
    status === TxnStatus.SUBMITTED ||
    status === TxnStatus.PENDING ||
    status === TxnStatus.AWAITING_APPROVAL
  )
}

/**
 * Whether this state may be shown to the user as "sent".
 *
 * Only a confirmed settlement. SUBMITTED and PENDING mean the rail has it, not
 * that anyone received anything — and a receipt shown at PENDING is one the user
 * will act on (hand over the goods, close the loan) before the money exists.
 */
export function isUserVisibleSuccess(status: TxnStatus): boolean {
  return status === TxnStatus.SUCCESS || status === TxnStatus.PARTIALLY_REFUNDED
}

// ── corridor + rail routing ─────────────────────────────────────────────────
/**
 * Which rulebook applies, derived from the currencies alone.
 *
 * Deliberately not a client-supplied field. The corridor decides the cap, the
 * fee, the screening obligation and the provider, so a client that could name its
 * own corridor could ask for the domestic ₹1,00,000 limit on a cross-border
 * transfer.
 */
export function corridorFor(
  sourceCurrency: string,
  destCurrency: string,
): Corridor {
  return sourceCurrency === destCurrency
    ? Corridor.DOMESTIC
    : Corridor.CROSS_BORDER
}

/** Which rail carries a given corridor and handle kind. */
export function railFor(
  corridor: Corridor,
  handleType: BeneficiaryHandleType,
): PaymentRail {
  if (corridor === Corridor.CROSS_BORDER) return PaymentRail.UPI_PAYNOW
  if (handleType === BeneficiaryHandleType.PAYNOW_UPI) {
    return PaymentRail.UPI_PAYNOW
  }
  return PaymentRail.UPI
}

/**
 * Whether a handle kind can be paid over a corridor at all.
 *
 * The UPI↔PayNow linkage is ADDRESS-based: the sender enters the recipient's
 * registered UPI ID and nothing else. There is no cross-border account+IFSC
 * payout on this rail, so accepting one would build a flow the rail cannot
 * execute — discovered only after the user has confirmed and been debited.
 */
export function isHandleSupported(
  corridor: Corridor,
  handleType: BeneficiaryHandleType,
): boolean {
  if (corridor === Corridor.CROSS_BORDER) {
    return handleType === BeneficiaryHandleType.PAYNOW_UPI
  }
  return (
    handleType === BeneficiaryHandleType.UPI_VPA ||
    handleType === BeneficiaryHandleType.ACCOUNT_IFSC
  )
}

/**
 * Whether the corridor supports a COLLECT (pulling money from a payer).
 *
 * Cross-border does not, and this is a property of the linkage rather than a
 * limitation of ours: UPI↔PayNow is payer-initiated only. There is no mechanism
 * to raise a request against an account in the other country, so a "request money
 * from abroad" feature would be a screen that can never succeed.
 */
export function supportsCollect(corridor: Corridor): boolean {
  return corridor === Corridor.DOMESTIC
}

// ── status-check budget ─────────────────────────────────────────────────────
/**
 * When we may next ask the rail about this transaction, and whether we still may.
 *
 * The budget is spent from a counter on the row rather than being enforced by a
 * cron interval, because a cron that runs every minute over a table of stuck
 * transactions will happily re-ask about the same one sixty times an hour. NPCI
 * bounds status checks, and exceeding that bound gets a PSP throttled — turning
 * one stuck transfer into every transfer stuck.
 */
export function nextPollAt(
  checksSoFar: number,
  from: Date = new Date(),
): Date | null {
  if (checksSoFar >= MAX_STATUS_CHECKS) return null
  const delay = STATUS_CHECK_SCHEDULE_MS[checksSoFar]
  if (delay === undefined) return null
  return new Date(from.getTime() + delay)
}

export function hasStatusCheckBudget(checksSoFar: number): boolean {
  return checksSoFar < MAX_STATUS_CHECKS
}

// ── limit windows ───────────────────────────────────────────────────────────
/**
 * The timezone each corridor's day is measured in, as minutes east of UTC.
 *
 * Not a detail. UPI's daily limit resets at midnight IST, and a counter bucketed
 * in UTC would roll over at 05:30 IST — handing every user a window in which two
 * calendar days' worth of limit is spendable inside one Indian day. The
 * cross-border leg is bounded jointly by RBI and MAS, and SGT is the later of the
 * two, so bucketing there in SGT is the conservative choice.
 */
export const CORRIDOR_TZ_OFFSET_MINUTES: Record<CorridorInput, number> = {
  /** IST, UTC+05:30. */
  DOMESTIC: 330,
  /** SGT, UTC+08:00. */
  CROSS_BORDER: 480,
}

/**
 * The calendar bucket a limit counter belongs to.
 *
 * A bucket key rather than a resettable counter, because a "reset if resetAt has
 * passed" step is a race: two concurrent requests both read the stale timestamp,
 * both zero the counter, and both then spend a full day's limit within the same
 * second. A new day is a new ROW, and there is nothing to race on.
 *
 * The YEAR bucket follows the INDIAN FINANCIAL YEAR (1 April – 31 March), because
 * that is the window the LRS ceiling is actually measured over. A calendar-year
 * bucket would reset the LRS allowance three months early.
 */
export function bucketKeyFor(
  window: 'DAY' | 'MONTH' | 'YEAR',
  now: Date,
  tzOffsetMinutes: number,
): string {
  const local = new Date(now.getTime() + tzOffsetMinutes * 60_000)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth() + 1
  const day = local.getUTCDate()

  switch (window) {
    case 'DAY':
      return `${year}-${pad(month)}-${pad(day)}`
    case 'MONTH':
      return `${year}-${pad(month)}`
    case 'YEAR': {
      const fyStart = month >= 4 ? year : year - 1
      return `FY${fyStart}-${fyStart + 1}`
    }
  }
}

/** When the bucket `bucketKeyFor` just returned stops accepting new spend. */
export function bucketResetAt(
  window: 'DAY' | 'MONTH' | 'YEAR',
  now: Date,
  tzOffsetMinutes: number,
): Date {
  const offsetMs = tzOffsetMinutes * 60_000
  const local = new Date(now.getTime() + offsetMs)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth()
  const day = local.getUTCDate()

  let nextLocal: number
  switch (window) {
    case 'DAY':
      nextLocal = Date.UTC(year, month, day + 1)
      break
    case 'MONTH':
      nextLocal = Date.UTC(year, month + 1, 1)
      break
    case 'YEAR':
      // Next 1 April, in local terms.
      nextLocal = month >= 3 ? Date.UTC(year + 1, 3, 1) : Date.UTC(year, 3, 1)
      break
  }
  return new Date(nextLocal - offsetMs)
}

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

// ── collect lifecycle ───────────────────────────────────────────────────────
/**
 *   CREATED  → PENDING | FAILED | REVOKED
 *   PENDING  → APPROVED | DECLINED | EXPIRED | FAILED | REVOKED
 *   APPROVED → FAILED                (the payer said yes; the debit still failed)
 *   the rest are terminal
 *
 * APPROVED → FAILED is the edge people forget. A payer's approval is not a
 * settlement: their bank can still decline for insufficient funds, and a UI that
 * treats "approved" as "received" shows the payee money that never arrives.
 */
const COLLECT_ALLOWED: Record<CollectStatus, CollectStatus[]> = {
  CREATED: [CollectStatus.PENDING, CollectStatus.FAILED, CollectStatus.REVOKED],
  PENDING: [
    CollectStatus.APPROVED,
    CollectStatus.DECLINED,
    CollectStatus.EXPIRED,
    CollectStatus.FAILED,
    CollectStatus.REVOKED,
  ],
  APPROVED: [CollectStatus.FAILED],
  DECLINED: [],
  EXPIRED: [],
  FAILED: [],
  REVOKED: [],
}

export function canCollectTransition(
  from: CollectStatus,
  to: CollectStatus,
): boolean {
  return COLLECT_ALLOWED[from]?.includes(to) ?? false
}

export function isCollectOpen(
  status: CollectStatus,
  expiresAt: Date,
  now = new Date(),
): boolean {
  return (
    (status === CollectStatus.CREATED || status === CollectStatus.PENDING) &&
    expiresAt > now
  )
}

// ── mandate lifecycle ───────────────────────────────────────────────────────
/**
 *   CREATED → PENDING | FAILED
 *   PENDING → ACTIVE | FAILED | EXPIRED          (awaiting the payer's approval)
 *   ACTIVE  → PAUSED | REVOKED | COMPLETED | EXPIRED
 *   PAUSED  → ACTIVE | REVOKED | EXPIRED
 *   REVOKED, COMPLETED, EXPIRED, FAILED → terminal
 *
 * REVOKED is terminal and PAUSED is not, which is the entire user-facing point of
 * having both. A person cancelling a subscription must not be one mis-tap away
 * from it resuming, and a merchant must not be able to read "paused" as "will
 * come back".
 */
const MANDATE_ALLOWED: Record<MandateStatus, MandateStatus[]> = {
  CREATED: [MandateStatus.PENDING, MandateStatus.FAILED],
  PENDING: [MandateStatus.ACTIVE, MandateStatus.FAILED, MandateStatus.EXPIRED],
  ACTIVE: [
    MandateStatus.PAUSED,
    MandateStatus.REVOKED,
    MandateStatus.COMPLETED,
    MandateStatus.EXPIRED,
  ],
  PAUSED: [MandateStatus.ACTIVE, MandateStatus.REVOKED, MandateStatus.EXPIRED],
  REVOKED: [],
  COMPLETED: [],
  EXPIRED: [],
  FAILED: [],
}

export function canMandateTransition(
  from: MandateStatus,
  to: MandateStatus,
): boolean {
  return MANDATE_ALLOWED[from]?.includes(to) ?? false
}

/** Whether a mandate may be debited right now. */
export function isMandateDebitable(
  status: MandateStatus,
  validFrom: Date,
  validUntil: Date,
  now = new Date(),
): boolean {
  return status === MandateStatus.ACTIVE && validFrom <= now && validUntil > now
}

/**
 * The next debit date for a recurrence rule.
 *
 * `AS_PRESENTED` returns null by design: there is no schedule, the merchant
 * presents a debit when one is due. Returning a fabricated date would make the
 * scheduler debit a mandate nobody has claimed against.
 */
export function nextDebitDate(frequency: string, from: Date): Date | null {
  const next = new Date(from.getTime())
  switch (frequency) {
    case 'ONETIME':
    case 'AS_PRESENTED':
      return null
    case 'DAILY':
      next.setUTCDate(next.getUTCDate() + 1)
      return next
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7)
      return next
    case 'FORTNIGHTLY':
      next.setUTCDate(next.getUTCDate() + 14)
      return next
    case 'MONTHLY':
      return addMonths(from, 1)
    case 'BIMONTHLY':
      return addMonths(from, 2)
    case 'QUARTERLY':
      return addMonths(from, 3)
    case 'HALFYEARLY':
      return addMonths(from, 6)
    case 'YEARLY':
      return addMonths(from, 12)
    default:
      return null
  }
}

/**
 * Add months, clamping the day of month.
 *
 * A mandate created on the 31st must debit on the 28th/30th in shorter months,
 * not roll into the next one. JavaScript's `setMonth` overflows silently — 31
 * January plus one month is 3 March — which for a monthly mandate means skipping
 * February's debit entirely and then debiting twice in March.
 */
function addMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear()
  const month = from.getUTCMonth() + months
  const day = from.getUTCDate()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
    ),
  )
}
