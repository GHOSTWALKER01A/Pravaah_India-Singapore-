import { ConsentStatus } from 'generated/prisma/client'

/**
 * Pure consent-lifecycle logic — NO I/O, so every branch is unit-testable. The
 * state machine is the trust backbone of M1: it rejects every illegal
 * transition (e.g. a late ACTIVE notification arriving after REVOKED) and gates
 * whether data may be fetched.
 *
 *   PENDING → ACTIVE | REJECTED | FAILED | EXPIRED
 *   ACTIVE  → PAUSED | REVOKED | EXPIRED
 *   PAUSED  → ACTIVE | REVOKED | EXPIRED
 *   (REJECTED | REVOKED | EXPIRED | FAILED are terminal)
 */
const ALLOWED: Record<ConsentStatus, ConsentStatus[]> = {
  PENDING: [
    ConsentStatus.ACTIVE,
    ConsentStatus.REJECTED,
    ConsentStatus.FAILED,
    ConsentStatus.EXPIRED,
  ],
  ACTIVE: [
    ConsentStatus.PAUSED,
    ConsentStatus.REVOKED,
    ConsentStatus.EXPIRED,
  ],
  PAUSED: [
    ConsentStatus.ACTIVE,
    ConsentStatus.REVOKED,
    ConsentStatus.EXPIRED,
  ],
  REJECTED: [],
  REVOKED: [],
  EXPIRED: [],
  FAILED: [],
}

export function canTransition(
  from: ConsentStatus,
  to: ConsentStatus,
): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/** Data may be fetched ONLY when consent is ACTIVE and not past its expiry. */
export function canFetch(
  status: ConsentStatus,
  expiresAt: Date | null,
): boolean {
  return (
    status === ConsentStatus.ACTIVE &&
    (!expiresAt || expiresAt > new Date())
  )
}

/** A status a user can still revoke. */
export function isRevocable(status: ConsentStatus): boolean {
  return status === ConsentStatus.ACTIVE || status === ConsentStatus.PAUSED
}
