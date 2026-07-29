import type { Signal } from '@/modules/fraud/fraud.state'

import type { RiskDecision, RiskSubjectType } from 'generated/prisma/client'

/**
 * The typed context every caller hands `RiskService`.
 *
 * Deliberately small and FLAT. The alternative — passing the domain object (a
 * `Transaction`, a `Claim`) — would couple M6 to five other modules' row shapes and
 * make the engine's dependency graph point the wrong way: fraud would import
 * payments, which imports fraud. Everything here is a primitive the caller already
 * has in hand at its decision point.
 */
export interface RiskContext {
  userId: string
  subjectType: RiskSubjectType
  /**
   * The thing being assessed.
   *
   * A string, not a uuid, because a LOGIN is scored BEFORE any row exists to point
   * at — its subject is a synthetic key. See `RiskAssessment.subjectId`.
   */
  subjectId: string

  /** `Device.id` (not the client's device uuid) once resolved. */
  deviceRef?: string | null
  /** The client's own device identifier, as sent. Resolved to a `Device` by M6. */
  clientDeviceId?: string | null
  /** Raw IP. Hashed at the /24 or /48 network before it is stored or counted. */
  ipAddress?: string | null
  geoHint?: string | null

  /** Value-bearing actions only, in minor units. */
  amountMinor?: bigint
  currency?: string
  corridor?: string

  /** The payee's handle, for watchlist and graph lookups. Hashed by M6. */
  beneficiaryHandle?: string | null
  /** How long ago the payee was established, in ms. */
  beneficiaryAgeMs?: number | null

  /**
   * Whether this action moves money, grants data access, or changes identity.
   *
   * Drives the structural step-up rule: a sensitive action from an unbound or
   * brand-new device is challenged regardless of score. A read is not.
   */
  sensitive?: boolean

  /**
   * Signals the CALLING module computed from facts only it has.
   *
   * This is how M4's corridor-aware structuring check and M5's waiting-period
   * proximity reach the engine without M6 having to understand either domain. The
   * engine treats them exactly like its own signals — same aggregation, same
   * persistence, same explanation — which is what makes one decision ladder cover
   * payments, claims and logins rather than three that drift apart.
   */
  domainSignals?: Signal[]

  /**
   * Skip collectors that write. Set when re-scoring for a preview.
   *
   * Velocity collection INCREMENTS counters, so scoring the same action twice
   * inflates them. A dry run reads without counting.
   */
  dryRun?: boolean
}

/** What the engine hands back. */
export interface RiskOutcome {
  assessmentId: string
  /** 0..1, from the noisy-OR aggregation. */
  score: number
  decision: RiskDecision
  /** Every signal that fired, with weights, for the caller and the audit trail. */
  signals: Signal[]
  /** Present when a case was opened. */
  caseId?: string
  /**
   * The plain-language reasons, deduplicated and ordered by contribution.
   *
   * Safe to show a user. Separate from `signals` because the signal TYPES are
   * internal vocabulary — telling somebody their payment tripped `MULE_GRAPH`
   * explains nothing and hints at how to evade it.
   */
  reasons: string[]
}

/**
 * The legacy shape M4 and M5 already consume.
 *
 * M6 keeps producing it so the existing call sites in `TransferOrchestratorService`
 * and `ClaimsService` are not rewritten around a new contract — the migration is a
 * delegation, not a refactor of two working modules. `decision` and `assessmentId`
 * are additive, so a caller can act on the richer four-way outcome when ready.
 */
export interface LegacyRiskAssessment {
  value: number
  hold: boolean
  flags: string[]
  reasons: string[]
  decision: RiskDecision
  assessmentId: string
  caseId?: string
}

export function toLegacyAssessment(
  outcome: RiskOutcome,
  holdWhen: (decision: RiskDecision) => boolean,
): LegacyRiskAssessment {
  return {
    value: outcome.score,
    hold: holdWhen(outcome.decision),
    flags: outcome.signals.map((signal) => signal.type),
    reasons: outcome.reasons,
    decision: outcome.decision,
    assessmentId: outcome.assessmentId,
    caseId: outcome.caseId,
  }
}
