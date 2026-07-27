import { CheckStatus, CheckType, KycStatus } from 'generated/prisma/client'

/**
 * Pure KYC decision logic — NO I/O, so every branch is unit-testable in
 * isolation. The orchestrator collects the latest snapshot of each check plus
 * the reconciled name score and hands it here; the returned status is written
 * verbatim to both `KycProfile.overallStatus` and `User.kycStatus`.
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

export function evaluateKyc(e: Evaluation): {
  status: KycStatus
  reason?: string
} {
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
  return { status: KycStatus.VERIFIED }
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
