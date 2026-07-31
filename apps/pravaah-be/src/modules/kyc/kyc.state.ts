import {
  CheckStatus,
  CheckType,
  KycStatus,
  ReviewDecision,
} from 'generated/prisma/client'

/**
 * Pure KYC decision logic — NO I/O, so every branch is unit-testable in
 * isolation. The orchestrator collects the latest snapshot of each check plus
 * the reconciled name score and hands it here.
 *
 * ── The machine cannot grant VERIFIED ──
 * `evaluateKyc` is the MACHINE's verdict, and its best possible outcome is
 * IN_REVIEW: every automated check passing means there is nothing left for the
 * system to object to, not that the identity is accepted. VERIFIED and REJECTED
 * are human decisions, recorded on the `ReviewCase`, and folded back in by
 * {@link applyReviewDecision}. The composed result is what gets written to both
 * `KycProfile.overallStatus` and `User.kycStatus`.
 *
 * Keeping those two steps separate is what makes an approval survive: the
 * orchestrator re-derives status on every check and on every status read, so a
 * function that could only ever answer "IN_REVIEW" for a fully-checked profile
 * would silently un-verify anyone an admin had just approved.
 */
export interface CheckSnapshot {
  type: CheckType
  status: CheckStatus
}

export interface Evaluation {
  requiredForCountry: CheckType[]
  checks: CheckSnapshot[]
  nameMatchScore: number | null
  sanctionsHit: boolean
  threshold: number
}

export interface KycDecision {
  status: KycStatus
  reason?: string
  /**
   * True when every required check passed AND the names across sources agree —
   * i.e. the only thing between this holder and VERIFIED is a person saying so.
   *
   * Distinguished from the other two IN_REVIEW outcomes (a check the provider
   * itself flagged, a name that did not reconcile) because the reviewer console
   * shows this string and "Pending admin approval" is a different job from
   * "these two documents spell the name differently".
   */
  machineCleared?: boolean
}

/** The reason carried by a case that is waiting only on a human. */
export const REVIEW_PENDING_REASON =
  'Every check cleared — pending admin approval'

export function evaluateKyc(e: Evaluation): KycDecision {
  // Sanctions/PEP is an unconditional hard stop.
  if (e.sanctionsHit) {
    return { status: KycStatus.REJECTED, reason: 'Sanctions/PEP hit' }
  }

  const byType = new Map(e.checks.map((c) => [c.type, c.status]))
  const missing = e.requiredForCountry.filter((t) => !byType.has(t))
  const failed = e.requiredForCountry.filter(
    (t) => byType.get(t) === CheckStatus.FAILED,
  )
  const review = e.requiredForCountry.filter(
    (t) => byType.get(t) === CheckStatus.MANUAL_REVIEW,
  )
  const pending = e.requiredForCountry.filter(
    (t) =>
      byType.get(t) === CheckStatus.PENDING ||
      byType.get(t) === CheckStatus.EXPIRED,
  )

  if (failed.length) {
    return {
      status: KycStatus.ACTION_REQUIRED,
      reason: `Failed: ${failed.join(',')}`,
    }
  }
  if (missing.length || pending.length) {
    return {
      status: KycStatus.IN_PROGRESS,
      reason: `Awaiting: ${[...missing, ...pending].join(',')}`,
    }
  }
  if (review.length) {
    return {
      status: KycStatus.IN_REVIEW,
      reason: `Review: ${review.join(',')}`,
    }
  }
  // Every required check passed — the name across sources must still agree.
  if (e.nameMatchScore === null || e.nameMatchScore < e.threshold) {
    return {
      status: KycStatus.IN_REVIEW,
      reason: `Name match ${e.nameMatchScore} < ${e.threshold}`,
    }
  }
  // Nothing automated is left to object to. A person decides from here.
  return {
    status: KycStatus.IN_REVIEW,
    reason: REVIEW_PENDING_REASON,
    machineCleared: true,
  }
}

/**
 * A human decision already on file for this profile.
 *
 * `stale` is the whole subtlety. An admin approves the check set they were
 * LOOKING AT; a check recorded afterwards (a re-run penny drop, a second
 * liveness attempt) is evidence they never saw, so their approval no longer
 * covers the profile and the case has to go back to them. Without this, a
 * verified holder could quietly re-run a check with a different name and keep
 * the VERIFIED status the reviewer granted for the old one.
 */
export interface RecordedReview {
  decision: ReviewDecision | null
  stale: boolean
}

/**
 * Fold a recorded human decision into the machine's verdict.
 *
 * The machine keeps the veto: if a required check is now failing, missing or
 * pending, that status wins over any decision on file — an approval is not a
 * standing exemption from the checks themselves. Only when the machine has
 * narrowed things down to "a person must decide" does the person's answer apply.
 */
export function applyReviewDecision(
  machine: KycDecision,
  review: RecordedReview | null,
): KycDecision {
  if (machine.status !== KycStatus.IN_REVIEW) return machine
  if (!review?.decision || review.stale) return machine

  switch (review.decision) {
    case ReviewDecision.APPROVED:
      return { status: KycStatus.VERIFIED, reason: 'Approved by a reviewer' }
    case ReviewDecision.REJECTED:
      return { status: KycStatus.REJECTED, reason: 'Declined by a reviewer' }
    case ReviewDecision.INFO_REQUESTED:
      return {
        status: KycStatus.ACTION_REQUIRED,
        reason: 'A reviewer asked for more information',
      }
  }
}

/** Which checks each destination requires. `BOTH` runs both rails. */
export const REQUIRED_CHECKS: Record<'INDIA' | 'SINGAPORE' | 'BOTH', CheckType[]> =
  {
    INDIA: [
      CheckType.PAN,
      CheckType.AADHAAR_OKYC,
      CheckType.BANK_PENNY_DROP,
      CheckType.LIVENESS,
      CheckType.FACE_MATCH,
      CheckType.SANCTIONS_PEP,
    ],
    SINGAPORE: [
      CheckType.SINGPASS_MYINFO,
      CheckType.LIVENESS,
      CheckType.FACE_MATCH,
      CheckType.SANCTIONS_PEP,
    ],
    BOTH: [
      CheckType.PAN,
      CheckType.AADHAAR_OKYC,
      CheckType.BANK_PENNY_DROP,
      CheckType.SINGPASS_MYINFO,
      CheckType.LIVENESS,
      CheckType.FACE_MATCH,
      CheckType.SANCTIONS_PEP,
    ],
  }

export const NAME_MATCH_THRESHOLD = 0.85
