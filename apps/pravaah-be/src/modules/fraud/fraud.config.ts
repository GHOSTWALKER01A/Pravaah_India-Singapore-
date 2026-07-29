/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  M6 POLICY — every risk literal, in one auditable place.                  │
 * │                                                                           │
 * │  Signal weights, decision thresholds, velocity caps, cooling-off windows   │
 * │  and challenge limits. They are here rather than inline because each one   │
 * │  is a NUMBER SOMEBODY CAN BE ASKED ABOUT: "why was my payment held",       │
 * │  "what does your system consider suspicious", "how did you arrive at       │
 * │  0.87". A weight scattered across five collectors is a decision nobody     │
 * │  can answer for.                                                          │
 * │                                                                           │
 * │  Nothing here is an env var, and that is deliberate. A fraud threshold is  │
 * │  not configuration — it decides whose money gets stopped, and it must not  │
 * │  be changeable by editing a file on a server. Same rule M4 applies to      │
 * │  payment limits and M5 to pricing multipliers.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * The weight set's version, stamped onto every `RiskAssessment`.
 *
 * Bump it whenever a weight or threshold below changes. Without it, a score from
 * before a re-tune cannot be compared with one from after, and an appeal months
 * later cannot be argued against the rules that actually applied at the time.
 */
export const RISK_MODEL_VERSION = 'risk-1.0.0'

// ── the decision ladder ─────────────────────────────────────────────────────
/**
 * The four bands.
 *
 * Ordered cheapest-and-most-certain first. The gaps between them are not
 * arbitrary — each band is a different KIND of answer:
 *
 *  - **HOLD (≥ 0.85).** High confidence something is wrong. The action freezes
 *    and a human decides. Deliberately not an auto-block: a false positive here
 *    costs a legitimate user minutes, not their money.
 *  - **STEP_UP (≥ 0.55).** Medium risk. We do not block — we raise the COST of
 *    the attack by demanding a factor a remote attacker without the handset
 *    usually cannot produce. The highest-leverage control in the whole module.
 *  - **REVIEW (≥ 0.30, high value only).** Let it through — friction here would
 *    hurt good users for little gain — but sample it for post-hoc analysis.
 *  - **ALLOW (< 0.30).** The overwhelming majority, and it must be frictionless.
 */
export const RISK_THRESHOLDS = {
  HOLD: 0.85,
  STEP_UP: 0.55,
  REVIEW: 0.3,
} as const

/**
 * Severity of the case a `HOLD` opens.
 *
 * A `BLOCK` is always CRITICAL. Above this score a HOLD is HIGH rather than
 * MEDIUM, which is what decides queue order — and therefore which held user
 * waits longest.
 */
export const CASE_HIGH_SEVERITY_SCORE = 0.92

/** How long an analyst has before a case breaches SLA. Held money is urgent. */
export const CASE_SLA_MS = 4 * 60 * 60 * 1_000

/**
 * The value above which a merely-elevated score earns a shadow REVIEW.
 *
 * ₹50,000 in minor units. Below it, a 0.3–0.55 score is not worth sampling; the
 * band exists to watch large movements that are individually unremarkable.
 */
export const REVIEW_VALUE_FLOOR_MINOR = 50_000_00n

// ── signal weights ──────────────────────────────────────────────────────────
/**
 * What each signal contributes.
 *
 * These are combined by NOISY-OR (`1 − Π(1 − wᵢ·vᵢ)`), not by addition, and that
 * changes how to read them. A weight is the probability-like contribution of that
 * signal ALONE at full degree: `SIM_SUSPECTED_SWAP` at 0.60 means a confirmed SIM
 * swap on its own lands in STEP_UP territory, and needs one more corroborating
 * signal to reach HOLD. Addition would have required hand-tuning a maximum and
 * would let five weak signals sum past any threshold; noisy-OR saturates toward
 * 1.0 on its own and stays monotonic, so adding a signal can never LOWER a score.
 *
 * Calibration intent, stated so it can be argued with:
 *  - 0.55–0.60 — one signal that is nearly sufficient on its own.
 *  - 0.35–0.50 — a strong signal that should not act alone.
 *  - 0.20–0.30 — real but ambiguous; needs company.
 *  - ≤ 0.15 — contextual colour. Never decisive, and that is the point.
 */
export const SIGNAL_WEIGHTS = {
  // ── device layer (T1, T2, T9, T14) ──
  /** No bound device on a sensitive request. */
  DEVICE_UNBOUND: 0.35,
  /** A device inside its cooling-off window. */
  DEVICE_NEW: 0.2,
  /** SIM serial no longer matches, or the telco flagged a re-issue. */
  SIM_SUSPECTED_SWAP: 0.6,
  /** No SIM anchor was ever captured, so swap detection is blind here. */
  SIM_UNVERIFIABLE: 0.15,
  /** Root / jailbreak / emulator, from the app's attestation. */
  DEVICE_INTEGRITY: 0.45,
  /** The client did not run an integrity check at all. */
  DEVICE_INTEGRITY_UNKNOWN: 0.1,

  // ── velocity layer (T8, T3, T11) ──
  VELOCITY_COUNT: 0.3,
  VELOCITY_VALUE: 0.4,
  NEW_BENEFICIARY_DRAIN: 0.45,
  LOGIN_STUFFING: 0.5,
  CONSENT_VELOCITY: 0.25,
  /** Repeated failed step-ups. Somebody is guessing. */
  STEP_UP_FAILURES: 0.4,

  // ── behaviour layer (T7, T8, T10) ──
  AMOUNT_ANOMALY: 0.25,
  ODD_HOUR: 0.1,
  GEO_IMPOSSIBLE: 0.5,
  GEO_NEW_COUNTRY: 0.2,

  // ── graph layer (T4, T5) ──
  MULE_GRAPH: 0.55,
  SHARED_DEVICE_CLUSTER: 0.4,

  // ── list layer (T5, T7) — WATCH only; the rest are hard ──
  WATCHLIST_WATCH: 0.35,

  // ── domain signals contributed by the calling module ──
  /** M4: cross-border to a payee added inside the window. */
  NEW_BENEFICIARY: 0.4,
  NEW_BENEFICIARY_DOMESTIC: 0.1,
  REVOKED_DEVICE: 0.6,
  REPEATED_FAILURES: 0.25,
  LARGE_CROSS_BORDER: 0.15,
  POSSIBLE_STRUCTURING: 0.3,
  NEW_ACCOUNT_CROSS_BORDER: 0.3,
  OPEN_UNAUTHORISED_DISPUTE: 0.2,
  VELOCITY_HOURLY: 0.35,
  /** M5 claim signals. */
  CLAIM_TAMPER: 0.55,
  CLAIM_AMOUNT_MISMATCH: 0.3,
  CLAIM_VELOCITY: 0.3,
  IMMEDIATELY_AFTER_WAITING_PERIOD: 0.35,
  FULL_COVER_CLAIM: 0.25,
  NEW_POLICY: 0.2,
  PRIOR_REJECTED_CLAIM: 0.15,
  NO_DOCUMENTS: 0.2,
} as const

export type SignalType = keyof typeof SIGNAL_WEIGHTS | 'WATCHLIST_HIT'

// ── device binding ──────────────────────────────────────────────────────────
/**
 * How long a freshly bound device faces extra scrutiny on high-value actions.
 *
 * 24 hours, and the window is what makes binding cheap without making it useless.
 * The threat is not a new device; it is a new device that immediately drains an
 * account. So we let anyone bind with one challenge, then make the first day
 * expensive for anything large. An attacker who phished an OTP and bound their own
 * handset hits this wall on the first big transfer.
 */
export const DEVICE_COOLING_OFF_MS = 24 * 60 * 60 * 1_000

/** Bind challenges a device may fail before it is locked out. */
export const MAX_BIND_ATTEMPTS = 5

/**
 * How long a binding token is good for before it must be rotated.
 *
 * Rotation is why a stolen token has a bounded useful life rather than an
 * account's. Seven days is short enough to matter and long enough that an
 * occasional user is not re-challenged on every visit.
 */
export const BINDING_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * The most devices one account may hold ACTIVE at once.
 *
 * A cap, because "one attacker operating twelve handsets on one account" and
 * "a person with a phone, a tablet and a spare" look identical until you count.
 * Binding a further device forces the oldest to be revoked explicitly, so the
 * user sees it happen.
 */
export const MAX_ACTIVE_DEVICES = 5

// ── step-up ─────────────────────────────────────────────────────────────────
export const STEP_UP = {
  /** A challenge's life. Long enough to read an SMS, short enough to be useless if captured. */
  TTL_MS: 5 * 60 * 1_000,
  MAX_ATTEMPTS: 3,
  /** Digits in a generated OTP. Six, matching every other OTP the user sees. */
  OTP_LENGTH: 6,
  /**
   * Failed challenges inside the window before the user's step-ups are frozen and
   * a case opens. Without this, the attempt cap merely means "three guesses per
   * challenge, unlimited challenges".
   */
  FAIL_LOCKOUT_COUNT: 5,
  FAIL_LOCKOUT_WINDOW_MS: 30 * 60 * 1_000,
} as const

// ── the transaction PIN ─────────────────────────────────────────────────────
export const PIN_POLICY = {
  /**
   * Digits. Six, matching UPI's own 6-digit option and every OTP the user already sees.
   *
   * Four would be ten thousand candidates; six is a million. Neither is safe against offline
   * attack, which is why the hash is bcrypt and the counter is server-side — but a million
   * makes a shoulder-surfed partial observation far less useful.
   */
  LENGTH: 6,

  /**
   * bcrypt cost factor.
   *
   * 12 is roughly 250ms on server hardware. That is deliberately slow: a six-digit PIN has a
   * million candidates, so a fast hash makes a stolen database equivalent to stolen PINs. The
   * work factor is the ONLY thing standing between the two.
   *
   * Not higher, because this runs inline on the payment path and the user is waiting. 12 buys
   * ~4 hashes/second/core against an attacker while costing one user a quarter second.
   */
  BCRYPT_ROUNDS: 12,

  /**
   * Wrong PINs before a lockout.
   *
   * Five, not three. Three is the card-PIN convention and it is tuned for a physical card
   * where the attacker holds the only copy; here a lockout costs a legitimate user access to
   * their own money and the reset path has a 24-hour cooling-off attached. Five wrong guesses
   * out of a million candidates is not a meaningful attack, and it is a lot more forgiving of
   * a mistyped digit on a phone.
   */
  MAX_ATTEMPTS: 5,

  /**
   * How long a locked PIN stays locked.
   *
   * Fifteen minutes rather than "until reset", because the overwhelmingly common cause is a
   * user mistyping five times, not an attack — and forcing a reset (with its cooling-off) on
   * that person would punish clumsiness with a day of payment friction. A genuine attacker
   * gains nothing from waiting fifteen minutes for five more guesses.
   */
  LOCKOUT_MS: 15 * 60_000,

  /**
   * Value below which a transfer needs no PIN.
   *
   * ₹500 in minor units, and the number is not arbitrary: it is NPCI's own **UPI Lite**
   * threshold, where they concluded PIN friction on small payments was not worth its cost and
   * built an on-device wallet with no PIN at all below it.
   *
   * Borrowing that line means Pravaah's everyday small payments feel like UPI Lite while
   * anything material carries the factor. The risk ladder can still demand a PIN BELOW this
   * threshold when signals warrant — the exemption is on the amount, not on the risk.
   */
  EXEMPT_BELOW_MINOR: 500_00n,
} as const

// ── velocity windows and caps ───────────────────────────────────────────────
export interface VelocityCap {
  /** Window length in ms. Also the bucket size. */
  windowMs: number
  /** The window's label, stored on the counter row. */
  label: string
  /** Actions before the count signal fires. */
  count: number
  /** Cumulative value before the value signal fires. `0n` disables the check. */
  valueMinor: bigint
}

/**
 * Rolling caps per dimension.
 *
 * Two windows per dimension on purpose. A short one (10 minutes) catches the
 * rapid drain that follows a takeover, where the attacker is racing detection. A
 * long one (1 day) catches the patient version that stays under every short-window
 * cap. Either alone is straightforwardly evadable by adjusting pace.
 *
 * These are SIGNAL thresholds, not limits. M4's `LimitService` owns the hard caps
 * and refuses transactions outright; breaching one of these contributes a weighted
 * signal that the ladder may or may not act on. Conflating the two would mean
 * either a fraud signal that blocks money by itself, or a regulatory limit that a
 * favourable risk score could argue away.
 */
export const VELOCITY_CAPS: Record<string, VelocityCap[]> = {
  TXN_COUNT: [
    { windowMs: 10 * 60_000, label: '10m', count: 5, valueMinor: 0n },
    { windowMs: 24 * 60 * 60_000, label: '1d', count: 30, valueMinor: 0n },
  ],
  TXN_VALUE: [
    { windowMs: 10 * 60_000, label: '10m', count: 0, valueMinor: 200_000_00n },
    {
      windowMs: 24 * 60 * 60_000,
      label: '1d',
      count: 0,
      valueMinor: 1_000_000_00n,
    },
  ],
  NEW_BENEFICIARY: [
    { windowMs: 60 * 60_000, label: '1h', count: 3, valueMinor: 0n },
    { windowMs: 24 * 60 * 60_000, label: '1d', count: 8, valueMinor: 0n },
  ],
  CONSENT: [
    { windowMs: 60 * 60_000, label: '1h', count: 5, valueMinor: 0n },
    { windowMs: 24 * 60 * 60_000, label: '1d', count: 15, valueMinor: 0n },
  ],
  STEP_UP_FAIL: [
    { windowMs: 30 * 60_000, label: '30m', count: 5, valueMinor: 0n },
  ],
}

/**
 * Credential-stuffing thresholds, per 10 minutes.
 *
 * Split by subject because the two attacks look nothing alike. A handful of fails
 * on ONE identifier is a person who forgot their password; the same count from one
 * IP across many identifiers is a bot. So the per-identifier threshold is low and
 * soft, and the per-IP one is high and — past `IP_HARD_FAILS` — hard, because at
 * forty misses in ten minutes from one network there is no innocent reading.
 */
export const AUTH_VELOCITY = {
  WINDOW_MS: 10 * 60_000,
  IDENTIFIER_FAILS: 5,
  IP_FAILS: 15,
  IP_HARD_FAILS: 40,
} as const

// ── behaviour ───────────────────────────────────────────────────────────────
export const BEHAVIOUR = {
  /** Prior transactions needed before a baseline means anything. */
  MIN_HISTORY: 5,
  /** How many recent transactions form the baseline. */
  HISTORY_WINDOW: 50,
  /** Z-score above which an amount is anomalous for THIS user. */
  AMOUNT_Z_THRESHOLD: 3,
  /** Z-score treated as maximally anomalous, for scaling the signal's degree. */
  AMOUNT_Z_SATURATION: 6,
  /**
   * The window in which two different countries are physically impossible.
   *
   * India↔Singapore is a ~5.5 hour flight, so 60 minutes is comfortably
   * infeasible and does not flag a genuine traveller who lands and pays. Kept
   * conservative on purpose: a false GEO_IMPOSSIBLE on a real traveller is
   * exactly the friction a cross-border product cannot afford.
   */
  IMPOSSIBLE_TRAVEL_MS: 60 * 60_000,
  /** Local hours (in the user's inferred zone) treated as unusual. */
  ODD_HOUR_START: 1,
  ODD_HOUR_END: 4,
  /** Distinct prior events needed before "a new country" is meaningful. */
  MIN_GEO_HISTORY: 3,
} as const

// ── mule graph ──────────────────────────────────────────────────────────────
export const GRAPH = {
  /** Cached node score below which the graph contributes nothing. */
  MULE_SCORE_FLOOR: 0.5,
  /** Cluster size at which a component is treated as a probable ring. */
  SUSPICIOUS_CLUSTER_SIZE: 4,
  /** Distinct users on one device before it looks like a farm. */
  SHARED_DEVICE_USERS: 3,
  /** Node degree treated as maximal, for scaling. */
  DEGREE_SATURATION: 12,
  /** How often the async recompute runs. Expensive, and staleness is acceptable. */
  RECOMPUTE_CRON: '0 */15 * * * *',
  /** Edges walked per recompute pass, so one job cannot run unbounded. */
  RECOMPUTE_EDGE_LIMIT: 20_000,
} as const

// ── retention ───────────────────────────────────────────────────────────────
/**
 * How long risk artefacts are kept.
 *
 * Long, because a fraud dispute is argued months later from the signals that fired
 * at the time, and because DPDP requires that an automated decision be
 * explainable to its subject — which is impossible once the reasons are deleted.
 * Purging is what the expiry sweep does, not a cascade delete on the user.
 */
export const ASSESSMENT_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000

/** Resolved velocity buckets older than this are swept. They have no further use. */
export const VELOCITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

/** Auth attempts kept for stuffing forensics. */
export const AUTH_ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000
