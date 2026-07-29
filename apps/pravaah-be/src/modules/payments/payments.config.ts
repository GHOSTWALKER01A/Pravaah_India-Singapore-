import { UPI_LIMITS, type CorridorInput } from '@pravaah/schema'

import { toMinor } from '@/modules/payments/money.util'

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  M4 POLICY — every payment literal, in one auditable place.               │
 * │                                                                           │
 * │  Regulatory caps, fee tables, timeout windows and poll schedules. They are │
 * │  here rather than inline because each one is a NUMBER SOMEBODY CAN BE      │
 * │  ASKED ABOUT: "what is your cross-border cap", "when do you give up on a   │
 * │  transfer", "how much did you charge and why". A limit scattered across    │
 * │  five services is a limit nobody can answer for.                          │
 * │                                                                           │
 * │  Nothing here is a tuning knob. Changing a cap changes what the platform   │
 * │  is permitted to do.                                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

// ── limits ──────────────────────────────────────────────────────────────────
export interface CorridorLimits {
  /** Per-day total value, in minor units of `currency`. */
  dailyValueMinor: bigint
  /** Largest single transaction. */
  perTxnValueMinor: bigint
  /** Per-day transaction COUNT. `0` means uncapped. */
  dailyCount: number
  /**
   * Ceiling on transfers to a beneficiary verified within the last 24 hours.
   *
   * A SLIDING window, not a calendar day — a beneficiary verified at 23:55 must
   * not become unrestricted five minutes later, which is exactly the boundary a
   * calendar-day counter would hand to an attacker.
   */
  newBeneficiary24hMinor: bigint
  /** LRS financial-year ceiling for India-outbound. Absent for domestic. */
  annualMinor?: bigint
  currency: string
}

/**
 * The caps, as the rails publish them.
 *
 * The asymmetry is the whole reason `Corridor` is a stored column rather than
 * something re-derived at each call site: the cross-border daily cap is about one
 * sixtieth of the domestic one. Code that forgot which rail it was on would be
 * wrong by that factor — either blocking legitimate domestic payments or waving
 * through sixty times the permitted cross-border value.
 */
export const LIMIT_POLICY: Record<CorridorInput, CorridorLimits> = {
  DOMESTIC: {
    dailyValueMinor: toMinor(UPI_LIMITS.DOMESTIC.DAILY_VALUE_MINOR),
    perTxnValueMinor: toMinor(UPI_LIMITS.DOMESTIC.PER_TXN_VALUE_MINOR),
    dailyCount: UPI_LIMITS.DOMESTIC.DAILY_COUNT,
    newBeneficiary24hMinor: toMinor(
      UPI_LIMITS.DOMESTIC.NEW_BENEFICIARY_24H_MINOR,
    ),
    currency: UPI_LIMITS.DOMESTIC.CURRENCY,
  },
  CROSS_BORDER: {
    dailyValueMinor: toMinor(UPI_LIMITS.CROSS_BORDER.DAILY_VALUE_MINOR),
    perTxnValueMinor: toMinor(UPI_LIMITS.CROSS_BORDER.PER_TXN_VALUE_MINOR),
    dailyCount: UPI_LIMITS.CROSS_BORDER.DAILY_COUNT,
    newBeneficiary24hMinor: toMinor(
      UPI_LIMITS.CROSS_BORDER.NEW_BENEFICIARY_24H_MINOR,
    ),
    annualMinor: toMinor(UPI_LIMITS.CROSS_BORDER.ANNUAL_LRS_MINOR),
    currency: UPI_LIMITS.CROSS_BORDER.CURRENCY,
  },
}

// ── fees ────────────────────────────────────────────────────────────────────
export interface FeeSchedule {
  bps: number
  fixedMinor: bigint
  minMinor: bigint
  /** `0n` means no ceiling. */
  maxMinor: bigint
}

/**
 * What we charge.
 *
 * Domestic UPI is free in both directions, and that is not generosity — NPCI
 * prohibits a merchant discount rate on UPI P2P and P2M, so a fee here would not
 * be a pricing decision, it would be non-compliance.
 *
 * Cross-border is 0.5% with a floor, because a 0.5% fee on a S$2 transfer is one
 * cent and does not cover the rail's own per-message cost.
 */
export const FEE_POLICY: Record<CorridorInput, FeeSchedule> = {
  DOMESTIC: { bps: 0, fixedMinor: 0n, minMinor: 0n, maxMinor: 0n },
  CROSS_BORDER: {
    bps: 50,
    fixedMinor: 0n,
    /** S$0.50. */
    minMinor: 50n,
    /** S$50.00 — a percentage fee on a large remittance stops being defensible. */
    maxMinor: 5_000n,
  },
}

/**
 * GST on the fee, in basis points (18%).
 *
 * Applied only when the fee is denominated in INR. Indian GST is a tax on a
 * supply made in India, so charging it on an SGD-denominated fee to a
 * Singapore-resident sender would be inventing a tax liability — and the
 * hard-coded alternative (always charge it) is the version that quietly does so.
 * A production deployment replaces this with the place-of-supply rules its tax
 * advisers sign off; the structure is what matters, and the tax has its own
 * ledger leg either way.
 */
export const GST_BPS = 1_800

export function gstApplies(feeCurrency: string): boolean {
  return feeCurrency === 'INR'
}

// ── FX ──────────────────────────────────────────────────────────────────────
/** Our spread over mid-market, in basis points. Visible on every quote. */
export const FX_SPREAD_BPS: Record<CorridorInput, number> = {
  DOMESTIC: 0,
  CROSS_BORDER: 50,
}

/**
 * Fallback mid-rates, as decimal strings keyed `SOURCE_DEST`.
 *
 * Used when no live FX feed is configured. Strings rather than numbers so they
 * are parsed by {@link rateE8FromString} and never touch a float — a "temporary"
 * `61.4` literal is exactly how a float re-enters a module that forbids them.
 */
export const FALLBACK_MID_RATES: Record<string, string> = {
  SGD_INR: '65.40',
  INR_SGD: '0.01529052',
  INR_INR: '1',
  SGD_SGD: '1',
}

// ── the rail's timing rules ─────────────────────────────────────────────────
/**
 * When we are allowed to ask the rail "what happened?", in milliseconds after
 * submission.
 *
 * NPCI bounds status checks, and the bound is not advisory — a PSP that polls
 * aggressively gets throttled off the rail, which turns one stuck transfer into
 * every transfer stuck. The first check waits 90 seconds because a UPI payment
 * that is going to settle has almost always settled by then, so an earlier check
 * spends a scarce query on an answer of "still pending".
 *
 * The list length IS the check budget: three entries, three checks, then DEEMED.
 */
export const STATUS_CHECK_SCHEDULE_MS = [90_000, 300_000, 1_800_000] as const

export const MAX_STATUS_CHECKS = STATUS_CHECK_SCHEDULE_MS.length

/**
 * How long a transaction may stay unresolved before it becomes DEEMED.
 *
 * At this point the saga stops guessing and hands the row to a human. The
 * alternative — auto-failing it — is how money gets paid twice: we refund the
 * sender, the rail settles an hour later, and the beneficiary keeps a payment
 * nobody has funded.
 */
export const DEEMED_AFTER_MS = 2 * 60 * 60 * 1_000

/** A submitted transfer we have not even heard back from. */
export const SUBMIT_TIMEOUT_MS = 30_000

// ── idempotency ─────────────────────────────────────────────────────────────
/** How long a key is honoured for replay. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000

/**
 * When an IN_PROGRESS lock is considered abandoned.
 *
 * A process that dies mid-request leaves its key locked; without a reclaim window
 * that user could never retry that operation again. Longer than any request we
 * would tolerate, so a live request is never stolen from itself.
 */
export const IDEMPOTENCY_STALE_LOCK_MS = 120_000

// ── mandates ────────────────────────────────────────────────────────────────
/**
 * NPCI requires a pre-debit notification at least 24 hours before an AutoPay
 * debit. The scheduler refuses to execute a debit without one, so this is an
 * enforced precondition rather than a courtesy notification.
 */
export const MANDATE_PREDEBIT_NOTICE_MS = 24 * 60 * 60 * 1_000

/** Failed executions to retry before pausing the mandate. */
export const MANDATE_MAX_EXECUTION_ATTEMPTS = 3

// ── disputes ────────────────────────────────────────────────────────────────
/** UDIR obliges a PSP to answer inside a bounded window, not "eventually". */
export const DISPUTE_SLA_MS = 24 * 60 * 60 * 1_000

/** How long after a payment a customer may still dispute it (RBI: 30 days+). */
export const DISPUTE_WINDOW_MS = 45 * 24 * 60 * 60 * 1_000

// ── risk ────────────────────────────────────────────────────────────────────
export const RISK_POLICY = {
  /** At or above this score the transaction is held for a human or a step-up. */
  HOLD_THRESHOLD: 0.7,
  /** Transactions in the last hour before velocity looks abnormal. */
  VELOCITY_HOURLY_COUNT: 10,
  /** A beneficiary verified this recently is "new" for risk purposes. */
  NEW_BENEFICIARY_MS: 24 * 60 * 60 * 1_000,
  /** A device first seen this recently has not earned a large transfer yet. */
  NEW_DEVICE_MS: 60 * 60 * 1_000,
  /** Cross-border value above which risk always takes a closer look. */
  CROSS_BORDER_ATTENTION_MINOR: 50_000n,
} as const

// ── the platform's own accounts ─────────────────────────────────────────────
/**
 * The owner key for platform-owned ledger accounts.
 *
 * The empty string, matching `LedgerAccount.ownerId`'s default — NOT null. A
 * nullable owner would make the unique constraint on
 * `(ownerType, ownerId, type, currency)` toothless, because Postgres treats NULLs
 * as distinct, and a second SUSPENSE(INR) account is how reserved money settles
 * out of a different bucket than it went into.
 */
export const PLATFORM_OWNER = ''

export const OWNER_TYPE = {
  USER: 'USER',
  PLATFORM: 'PLATFORM',
  EXTERNAL: 'EXTERNAL',
} as const

/**
 * The tolerance on the trial balance: exactly zero, in every currency.
 *
 * Not a threshold to tune. Double-entry either holds or it does not, and a
 * "small acceptable drift" is just an unexplained loss with a budget.
 */
export const TRIAL_BALANCE_TOLERANCE_MINOR = 0n

// ── VPA ─────────────────────────────────────────────────────────────────────
/** Our own PSP handle suffix — the `@pravaah` in `ravi@pravaah`. */
export const DEFAULT_VPA_SUFFIX = 'pravaah'

/**
 * PSP handles probed when resolving an Indian MOBILE NUMBER to a VPA.
 *
 * India has no public directory mapping a mobile number to a VPA. What it has is a near-universal
 * convention: a PSP registers `<mobile>@<its-handle>` for its users. So resolving a number means
 * probing candidates, and this is the list.
 *
 * These are the real, widely-deployed PSP handles behind the major apps, ordered by Indian UPI market
 * share so the common case resolves on the first or second probe. Each entry past the first costs a
 * live rail round trip against a rate-limited API, so `MOBILE_VPA_PROBE_LIMIT` caps how many are
 * actually tried — probing twenty handles to find one person would make a single tap cost twenty
 * calls, which is precisely the pattern a PSP throttles.
 *
 * A miss here does NOT mean the person is unreachable. It means they are not registered at
 * `<number>@<one of these>`, and they may still be perfectly payable at a VPA they chose themselves.
 * The distinction is load-bearing in the copy the user sees.
 */
export const MOBILE_VPA_PSP_SUFFIXES = [
  'ybl', // PhonePe
  'okhdfcbank', // Google Pay
  'paytm', // Paytm
  'apl', // Amazon Pay
  'ibl', // PhonePe (secondary)
  'axl', // Axis-backed apps
] as const

/**
 * How many candidates to probe, including our own suffix.
 *
 * Six is the balance point: our own handle plus the five largest PSPs covers the overwhelming
 * majority of Indian UPI users, and six sequential calls is a latency a user will wait through when
 * the alternative is typing a VPA they do not know.
 */
export const MOBILE_VPA_PROBE_LIMIT = 6

/**
 * VPA local parts we will not allocate.
 *
 * A user holding `support@pravaah` or `refund@pravaah` can impersonate us to
 * every other user of the handle, and the fraud that follows is indistinguishable
 * from an official request. Cheap to reserve, impossible to unwind later.
 */
export const RESERVED_VPA_LOCALPARTS = new Set([
  'admin',
  'support',
  'help',
  'pravaah',
  'official',
  'refund',
  'refunds',
  'payment',
  'payments',
  'noreply',
  'no-reply',
  'security',
  'kyc',
  'verify',
  'billing',
  'root',
  'test',
])

// ── retention ───────────────────────────────────────────────────────────────
/**
 * How long rail event payloads are kept.
 *
 * Long, on purpose: a chargeback can arrive months later and is argued from the
 * exact bytes the rail sent. RBI requires payment records for far longer than a
 * hackathon needs, and the encrypted blob is the only primary evidence we hold.
 */
export const RAIL_EVENT_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000

/** Unmatched rail events are replayed this many times before escalation. */
export const RAIL_EVENT_MAX_REPLAY_ATTEMPTS = 20
