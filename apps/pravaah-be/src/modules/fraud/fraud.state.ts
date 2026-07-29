import {
  CASE_HIGH_SEVERITY_SCORE,
  REVIEW_VALUE_FLOOR_MINOR,
  RISK_THRESHOLDS,
} from '@/modules/fraud/fraud.config'

import {
  DeviceStatus,
  FraudCaseStatus,
  FraudSeverity,
  RiskDecision,
  StepUpStatus,
} from 'generated/prisma/client'

/**
 * Pure M6 logic — NO I/O, so every rule is unit-testable and the meaning of a
 * risk decision cannot drift between the engine, the collectors, the analyst
 * console and the modules that call in. The M6 counterpart to M1's
 * `consent.state.ts`, M2's `scoring.state.ts`, M3's `passport.state.ts` and M4's
 * `payments.state.ts`.
 *
 * This file is where the *arithmetic* of a fraud decision lives, and that
 * placement is the point: aggregation and thresholding are the two things most
 * likely to be quietly reimplemented by a second caller, and the two things a
 * regulator or an appealing user will ask to see.
 */

// ── the signal type ─────────────────────────────────────────────────────────
export interface Signal {
  type: string
  /** The signal's contribution at full degree. See `SIGNAL_WEIGHTS`. */
  weight: number
  /** 0..1 degree — how strongly this instance fired. */
  value: number
  /** Human-readable, and shown to the user whose action it decided. */
  reason: string
  /**
   * Bypasses the arithmetic and forces `BLOCK`.
   *
   * Reserved for facts, not inferences: a sanctions hit, a revoked device. "The
   * payee is a known mule" is not a probability to be averaged against a
   * favourable history.
   */
  isHard?: boolean
}

// ── aggregation ─────────────────────────────────────────────────────────────
/**
 * Combine signals into a 0..1 score by NOISY-OR: `risk = 1 − Π(1 − wᵢ·vᵢ)`.
 *
 * Chosen over a weighted sum for three reasons that all bite in practice:
 *
 *  1. **It saturates gracefully.** Many weak signals approach 1.0 without ever
 *     exceeding it, so there is no maximum to hand-tune and no need to clamp a
 *     sum that eight contextual signals pushed past 2.0.
 *  2. **It is monotonic.** Adding a signal can never lower the score. With a
 *     normalised sum (`total / count`), a mild extra signal DILUTES a severe one —
 *     so an attacker could lower their own risk score by adding innocuous noise.
 *  3. **It is explainable.** Each factor is independent, so "which signals drove
 *     this number" has an exact answer, which is what the analyst console shows
 *     and what a DPDP automated-decision request is owed.
 *
 * Each contribution is clamped to [0,1] before multiplying. A negative or >1
 * weight from a mis-tuned collector would otherwise flip the sign of the product
 * and produce a score outside the range every threshold assumes.
 */
export function aggregateRisk(signals: readonly Signal[]): number {
  const product = signals.reduce((acc, signal) => {
    const contribution = clamp01(signal.weight * signal.value)
    return acc * (1 - contribution)
  }, 1)

  // Rounded to four places so a stored score is reproducible from the stored
  // signals. Float noise in the fourteenth decimal is not information, but it
  // does make an assessment impossible to reconcile by hand.
  return Number(clamp01(1 - product).toFixed(4))
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

// ── the decision ladder ─────────────────────────────────────────────────────
export interface LadderInput {
  score: number
  signals: readonly Signal[]
  /** Is this a money/consent/identity action rather than a read? */
  sensitive: boolean
  /** Present for value-bearing actions, in minor units. */
  amountMinor?: bigint
}

/**
 * Map a score plus its context onto one of five decisions.
 *
 * Ordered from most to least restrictive, and the ORDER is the policy: a hard
 * signal wins over any score, a HOLD-band score wins over the structural
 * step-up rule, and the shadow REVIEW band only applies to value-bearing actions.
 *
 * The structural rule — *any* sensitive action from an unbound or brand-new
 * device gets `STEP_UP` regardless of score — exists because that pattern is
 * dangerous even when nothing else about it is. It is also the pattern the
 * arithmetic is worst at: one 0.20 signal scores 0.20 and would otherwise ALLOW,
 * which is exactly the account-takeover sequence walking straight through.
 */
export function decide(input: LadderInput): RiskDecision {
  if (input.signals.some((signal) => signal.isHard)) return RiskDecision.BLOCK

  if (input.score >= RISK_THRESHOLDS.HOLD) return RiskDecision.HOLD

  if (input.score >= RISK_THRESHOLDS.STEP_UP) return RiskDecision.STEP_UP

  if (input.sensitive && hasStructuralDeviceRisk(input.signals)) {
    return RiskDecision.STEP_UP
  }

  if (
    input.score >= RISK_THRESHOLDS.REVIEW &&
    (input.amountMinor ?? 0n) >= REVIEW_VALUE_FLOOR_MINOR
  ) {
    return RiskDecision.REVIEW
  }

  return RiskDecision.ALLOW
}

/** The device shapes that warrant a challenge on their own. */
function hasStructuralDeviceRisk(signals: readonly Signal[]): boolean {
  return signals.some(
    (signal) =>
      signal.type === 'DEVICE_NEW' ||
      signal.type === 'DEVICE_UNBOUND' ||
      signal.type === 'SIM_SUSPECTED_SWAP',
  )
}

/** Decisions that stop the action rather than merely observing it. */
export function isBlocking(decision: RiskDecision): boolean {
  return decision === RiskDecision.HOLD || decision === RiskDecision.BLOCK
}

/** Decisions that must produce an analyst case. */
export function needsCase(decision: RiskDecision): boolean {
  return isBlocking(decision)
}

export function severityFor(
  decision: RiskDecision,
  score: number,
): FraudSeverity {
  if (decision === RiskDecision.BLOCK) return FraudSeverity.CRITICAL
  if (score >= CASE_HIGH_SEVERITY_SCORE) return FraudSeverity.HIGH
  if (decision === RiskDecision.HOLD) return FraudSeverity.MEDIUM
  return FraudSeverity.LOW
}

// ── device lifecycle ────────────────────────────────────────────────────────
/**
 * What may follow what, for a device.
 *
 * `SUSPECTED_SWAP → ACTIVE` is the recovery edge and the interesting one: a
 * device is not killed by a SIM change, it is frozen for high-value actions until
 * the holder re-verifies. Somebody who simply replaced a damaged SIM gets back in
 * with one challenge; an attacker who swapped the SIM to intercept OTPs finds the
 * OTP alone no longer sufficient, because recovery re-anchors the serial too.
 *
 * `REVOKED` is terminal. A revoked device does not come back — the user binds
 * again, producing a NEW row with a new cooling-off window. Reviving the old row
 * would silently restore a device whose history includes a theft report.
 */
export const DEVICE_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
  BINDING: [DeviceStatus.ACTIVE, DeviceStatus.REVOKED],
  ACTIVE: [DeviceStatus.SUSPECTED_SWAP, DeviceStatus.REVOKED],
  SUSPECTED_SWAP: [DeviceStatus.ACTIVE, DeviceStatus.REVOKED],
  REVOKED: [],
}

export function canDeviceTransition(
  from: DeviceStatus,
  to: DeviceStatus,
): boolean {
  if (from === to) return true
  return DEVICE_TRANSITIONS[from].includes(to)
}

/** Only an ACTIVE device is a bound device. `BINDING` has not passed its challenge. */
export function isDeviceUsable(status: DeviceStatus): boolean {
  return status === DeviceStatus.ACTIVE
}

/**
 * Whether a device may perform a HIGH-VALUE action without a challenge.
 *
 * `SUSPECTED_SWAP` is usable for reading and for small movements but not for
 * large ones — the freeze is scoped to the thing a SIM-swap attacker is after.
 */
export function isDeviceTrustedForValue(
  status: DeviceStatus,
  coolingOffUntil: Date | null,
  now: Date = new Date(),
): boolean {
  if (status !== DeviceStatus.ACTIVE) return false
  if (coolingOffUntil && coolingOffUntil > now) return false
  return true
}

// ── case lifecycle ──────────────────────────────────────────────────────────
/**
 * The analyst workflow's transition graph.
 *
 * `ESCALATED` can still resolve either way — escalation is a request for a more
 * senior decision, not a verdict. `CLEARED` and `CONFIRMED_FRAUD` are terminal:
 * a case that could be reopened and re-decided is a case whose outcome an insider
 * can revise after the money has moved.
 */
export const CASE_TRANSITIONS: Record<FraudCaseStatus, FraudCaseStatus[]> = {
  OPEN: [
    FraudCaseStatus.INVESTIGATING,
    FraudCaseStatus.ESCALATED,
    FraudCaseStatus.CLEARED,
    FraudCaseStatus.CONFIRMED_FRAUD,
  ],
  INVESTIGATING: [
    FraudCaseStatus.INFO_REQUESTED,
    FraudCaseStatus.CLEARED,
    FraudCaseStatus.CONFIRMED_FRAUD,
    FraudCaseStatus.ESCALATED,
  ],
  INFO_REQUESTED: [
    FraudCaseStatus.INVESTIGATING,
    FraudCaseStatus.CLEARED,
    FraudCaseStatus.CONFIRMED_FRAUD,
    FraudCaseStatus.ESCALATED,
  ],
  ESCALATED: [FraudCaseStatus.CLEARED, FraudCaseStatus.CONFIRMED_FRAUD],
  CLEARED: [],
  CONFIRMED_FRAUD: [],
}

export function canCaseTransition(
  from: FraudCaseStatus,
  to: FraudCaseStatus,
): boolean {
  return CASE_TRANSITIONS[from].includes(to)
}

export function isCaseTerminal(status: FraudCaseStatus): boolean {
  return (
    status === FraudCaseStatus.CLEARED ||
    status === FraudCaseStatus.CONFIRMED_FRAUD
  )
}

// ── step-up lifecycle ───────────────────────────────────────────────────────
export function isStepUpRedeemable(
  status: StepUpStatus,
  expiresAt: Date,
  attempts: number,
  maxAttempts: number,
  now: Date = new Date(),
): boolean {
  if (status !== StepUpStatus.PENDING) return false
  if (expiresAt <= now) return false
  if (attempts >= maxAttempts) return false
  return true
}

// ── PIN strength ────────────────────────────────────────────────────────────
/**
 * Whether a PIN is too guessable to accept.
 *
 * ## Why this is refused at enrolment and nowhere else
 *
 * Once the PIN is a bcrypt hash, nobody — not us, not an auditor — can tell whether it was
 * `123456`. Enrolment is the only moment the plaintext exists, so it is the only moment this
 * check is possible. Skipping it means a population where a meaningful fraction of PINs are
 * `123456` and no way to find out.
 *
 * ## What it actually defends against
 *
 * NOT online guessing — the server-side lockout bounds that to five tries out of a million.
 * It defends against the SHOULDER SURF and the over-the-shoulder guess: somebody who saw the
 * user's hand move, or who knows their birth year. Against that attacker a trivial PIN is a
 * full compromise and a random one is a wasted glance.
 *
 * Kept as a pure predicate here rather than in the service so it is unit-testable without a
 * database, like every other rule in this file.
 */
export function isWeakPin(pin: string): boolean {
  // All one digit: 000000, 111111 …
  if (/^(\d)\1+$/.test(pin)) return true

  // Ascending or descending runs: 123456, 654321, and any rotation like 456789.
  const ascending = pin
    .split('')
    .every((digit, index, all) =>
      index === 0 ? true : Number(digit) === Number(all[index - 1]) + 1,
    )
  const descending = pin
    .split('')
    .every((digit, index, all) =>
      index === 0 ? true : Number(digit) === Number(all[index - 1]) - 1,
    )
  if (ascending || descending) return true

  /**
   * A plausible year, at either end.
   *
   * `199012` and `121990` are both somebody's birth year with two digits of padding, and both
   * are among the first things a person who knows them would try. The range is wide on purpose
   * — a false rejection costs one retype, a false accept costs the factor.
   */
  const YEAR = /(19[3-9]\d|20[0-2]\d)/
  if (YEAR.test(pin.slice(0, 4)) || YEAR.test(pin.slice(-4))) return true

  /**
   * A repeated short pattern: 121212, 123123, 112112.
   *
   * These feel random to the person choosing them and are trivially enumerable — the search
   * space collapses to the length of the repeated unit.
   */
  for (const unit of [1, 2, 3]) {
    if (pin.length % unit !== 0) continue
    const head = pin.slice(0, unit)
    if (head.repeat(pin.length / unit) === pin) return true
  }

  return false
}

// ── velocity bucketing ──────────────────────────────────────────────────────
/**
 * The bucket a moment falls into, for a rolling window.
 *
 * `floor(epochMs / windowMs)` — a TUMBLING window, deliberately, and the
 * imprecision is a considered trade. A true sliding window needs either a
 * timestamped row per event (unbounded growth on the hottest write path in the
 * module) or a read-modify-write on one row (the race M4's `LimitCounter` comment
 * describes: two requests both observe a stale reset time, both zero the counter,
 * both spend a full window). Bucketing makes a new window a NEW ROW, so there is
 * nothing to reset and nothing to race on.
 *
 * The cost is a boundary effect: an attacker who straddles a bucket edge gets up
 * to 2× a window's budget. That is why every dimension in `VELOCITY_CAPS` carries
 * TWO windows — the long one is still counting when the short one rolls over, so
 * the edge is covered rather than open.
 */
export function velocityBucketKey(
  windowMs: number,
  now: Date = new Date(),
): string {
  if (windowMs <= 0) throw new Error('windowMs must be positive')
  return String(Math.floor(now.getTime() / windowMs))
}

export function velocityResetAt(
  windowMs: number,
  now: Date = new Date(),
): Date {
  const bucket = Math.floor(now.getTime() / windowMs)
  return new Date((bucket + 1) * windowMs)
}

/**
 * Scale a breach into a 0..1 degree.
 *
 * At the cap the signal fires at half strength and reaches full strength at twice
 * the cap, so "one over the line" and "six times over" are distinguishable. A
 * boolean would treat them identically and lose the only information that
 * separates a busy afternoon from an active drain.
 */
export function breachDegree(observed: number, cap: number): number {
  if (cap <= 0) return 0
  if (observed <= cap) return 0
  return clamp01((observed - cap) / cap / 2 + 0.5)
}

export function breachDegreeBigInt(observed: bigint, cap: bigint): number {
  if (cap <= 0n) return 0
  if (observed <= cap) return 0
  /**
   * Converted to Number only AFTER the comparison, and only as a RATIO.
   *
   * The ratio of two money amounts is a small, bounded number; the amounts
   * themselves can exceed `Number.MAX_SAFE_INTEGER` in minor units. Dividing
   * first is what keeps this out of M4's forbidden-float territory — the exact
   * comparison that decides whether the signal fires is done in BigInt.
   */
  const excess = observed - cap
  const ratio = Number((excess * 1000n) / cap) / 1000
  return clamp01(ratio / 2 + 0.5)
}
