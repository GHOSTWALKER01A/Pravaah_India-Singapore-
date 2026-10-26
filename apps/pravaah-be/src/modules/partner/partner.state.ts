import {
  CLAIM_CATALOGUE,
  predicateKey,
  type DisclosableClaim,
  type PredicateSpec,
} from '@pravaah/schema'

import {
  PartnerRole,
  PartnerStatus,
  PartnerUsageKind,
  ScoreBand,
} from 'generated/prisma/client'

/**
 * Pure M7 logic — NO I/O, so every rule is unit-testable and the meaning of a
 * predicate, a billable event or a partner transition cannot drift between the
 * API, the console, the schedulers and the admin surface. The M7 counterpart to
 * `passport.state.ts` and `fraud.state.ts`.
 */

// ── partner lifecycle ───────────────────────────────────────────────────────
/**
 *   PENDING_APPROVAL → ACTIVE | REVOKED   (approve / reject)
 *   ACTIVE           → SUSPENDED | REVOKED
 *   SUSPENDED        → ACTIVE | REVOKED   (reinstate / terminate)
 *   REVOKED          → (terminal)
 *
 * REVOKED is terminal for the same reason a revoked credential is: a partner we
 * terminated has had its keys burnt and its open requests cancelled, and bringing
 * it back would resurrect an audience that holders were told is gone. A returning
 * business re-applies and gets a new audience.
 */
const PARTNER_TRANSITIONS: Record<PartnerStatus, PartnerStatus[]> = {
  PENDING_APPROVAL: [PartnerStatus.ACTIVE, PartnerStatus.REVOKED],
  ACTIVE: [PartnerStatus.SUSPENDED, PartnerStatus.REVOKED],
  SUSPENDED: [PartnerStatus.ACTIVE, PartnerStatus.REVOKED],
  REVOKED: [],
}

export function canPartnerTransition(
  from: PartnerStatus,
  to: PartnerStatus,
): boolean {
  return PARTNER_TRANSITIONS[from]?.includes(to) ?? false
}

// ── console roles ───────────────────────────────────────────────────────────
const ROLE_RANK: Record<PartnerRole, number> = {
  PARTNER_VIEWER: 0,
  PARTNER_ANALYST: 1,
  PARTNER_ADMIN: 2,
}

/** True when `role` is at least `required`. Roles are a strict ladder. */
export function roleAtLeast(role: PartnerRole, required: PartnerRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required]
}

// ── predicates ──────────────────────────────────────────────────────────────
/** Band order, low to high. Must match M2's — see `passport.state.ts` BAND_ORDER. */
const BANDS: readonly ScoreBand[] = [
  ScoreBand.POOR,
  ScoreBand.FAIR,
  ScoreBand.GOOD,
  ScoreBand.VERY_GOOD,
  ScoreBand.EXCELLENT,
]

/** The issuer-minted boolean asserting "band ≥ X". POOR has none: it is always true. */
const AT_LEAST: Partial<Record<ScoreBand, DisclosableClaim>> = {
  FAIR: 'score_at_least_fair',
  GOOD: 'score_at_least_good',
  VERY_GOOD: 'score_at_least_very_good',
  EXCELLENT: 'score_at_least_excellent',
}

/** One condition on one disclosed threshold claim. */
export interface PredicateClause {
  claim: DisclosableClaim
  expect: boolean
}

/**
 * A predicate compiled to the issuer-signed booleans that answer it. Stored on the
 * request as JSON, so it must stay plain data.
 */
export interface CompiledPredicate {
  key: string
  claim: PredicateSpec['claim']
  op: PredicateSpec['op']
  value: PredicateSpec['value']
  /** True iff EVERY clause holds. */
  clauses: PredicateClause[]
}

export class PredicateError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message)
    this.name = 'PredicateError'
  }
}

/**
 * Compile one predicate to threshold clauses.
 *
 * Every ordinal comparison on the band reduces to at most two "at least" booleans:
 *
 *   band ≥ B   ⇔  at_least(B)
 *   band > B   ⇔  at_least(next(B))
 *   band < B   ⇔  ¬at_least(B)
 *   band ≤ B   ⇔  ¬at_least(next(B))
 *   band = B   ⇔  at_least(B) ∧ ¬at_least(next(B))
 *
 * A predicate that is true or false for EVERY holder (`≥ POOR`, `> EXCELLENT`) is
 * refused: it would make the holder disclose a boolean that proves nothing, and a
 * partner writing it has a bug worth telling them about.
 */
export function compilePredicate(spec: PredicateSpec): CompiledPredicate {
  const key = predicateKey(spec)
  const index = BANDS.indexOf(spec.value)
  if (index < 0) throw new PredicateError(`Unknown band "${spec.value}"`, key)

  const atLeast = (i: number): DisclosableClaim | undefined => {
    const band = BANDS[i]
    return band ? AT_LEAST[band] : undefined
  }
  const trivial = (why: string): never => {
    throw new PredicateError(
      `Predicate ${key} is ${why} for every holder and cannot be asked`,
      key,
    )
  }

  let clauses: PredicateClause[]
  switch (spec.op) {
    case 'GTE': {
      const claim = atLeast(index)
      if (!claim) trivial('true')
      clauses = [{ claim: claim!, expect: true }]
      break
    }
    case 'GT': {
      const claim = atLeast(index + 1)
      if (!claim) trivial('false')
      clauses = [{ claim: claim!, expect: true }]
      break
    }
    case 'LT': {
      const claim = atLeast(index)
      if (!claim) trivial('false')
      clauses = [{ claim: claim!, expect: false }]
      break
    }
    case 'LTE': {
      const claim = atLeast(index + 1)
      if (!claim) trivial('true')
      clauses = [{ claim: claim!, expect: false }]
      break
    }
    case 'EQ': {
      clauses = []
      const floor = atLeast(index)
      const ceiling = atLeast(index + 1)
      if (floor) clauses.push({ claim: floor, expect: true })
      if (ceiling) clauses.push({ claim: ceiling, expect: false })
      break
    }
    default:
      throw new PredicateError(`Unsupported operator "${String(spec.op)}"`, key)
  }

  return { key, claim: spec.claim, op: spec.op, value: spec.value, clauses }
}

/** Compile a list, de-duplicated by key so a repeated predicate is asked once. */
export function compilePredicates(
  specs: readonly PredicateSpec[],
): CompiledPredicate[] {
  const byKey = new Map<string, CompiledPredicate>()
  for (const spec of specs) {
    const compiled = compilePredicate(spec)
    byKey.set(compiled.key, compiled)
  }
  return [...byKey.values()]
}

/** The threshold claims a set of predicates needs the holder to disclose. */
export function predicateClaims(
  compiled: readonly CompiledPredicate[],
): DisclosableClaim[] {
  return [
    ...new Set(
      compiled.flatMap((p) => p.clauses.map((clause) => clause.claim)),
    ),
  ]
}

/**
 * Evaluate predicates against VERIFIED disclosed claims.
 *
 * Returns `null` — never `false` — for a predicate whose claims the holder did not
 * disclose. "Did not answer" and "answered no" are different facts; a partner
 * reading a withheld `score_at_least_good` as false would decline an applicant who
 * is actually excellent and simply chose not to say. M3's `unsatisfiedClaims`
 * draws the same line for raw claims.
 */
export function evaluatePredicates(
  compiled: readonly CompiledPredicate[],
  claims: Readonly<Record<string, unknown>>,
): Record<string, boolean | null> {
  const result: Record<string, boolean | null> = {}
  for (const predicate of compiled) {
    let answer: boolean | null = true
    for (const clause of predicate.clauses) {
      const value = claims[clause.claim]
      if (typeof value !== 'boolean') {
        answer = null
        break
      }
      if (value !== clause.expect) answer = false
    }
    result[predicate.key] = answer
  }
  return result
}

/** Parse the `predicates` JSON column back into compiled predicates, defensively. */
export function readCompiledPredicates(json: unknown): CompiledPredicate[] {
  if (!Array.isArray(json)) return []
  return json.filter(
    (p): p is CompiledPredicate =>
      !!p &&
      typeof p === 'object' &&
      typeof (p as CompiledPredicate).key === 'string' &&
      Array.isArray((p as CompiledPredicate).clauses),
  )
}

/**
 * Predicate keys a disclosure fully ANSWERS (true or false) — what the consent
 * receipt records as shared. A predicate whose claims were withheld was not shared.
 */
export function answeredPredicateKeys(
  compiled: readonly CompiledPredicate[],
  disclosedClaims: readonly string[],
): string[] {
  const disclosed = new Set(disclosedClaims)
  return compiled
    .filter((p) => p.clauses.every((clause) => disclosed.has(clause.claim)))
    .map((p) => p.key)
}

// ── scope ───────────────────────────────────────────────────────────────────
/** Human labels for a claim list, for error messages and receipts. */
export function claimLabels(claims: readonly string[]): string[] {
  return claims.map(
    (claim) => CLAIM_CATALOGUE[claim as DisclosableClaim]?.label ?? claim,
  )
}

// ── metering ────────────────────────────────────────────────────────────────
/**
 * Which usage kinds are billable. Decided HERE, per kind, never by a caller — so
 * "what did we charge for?" has one answer in code, and the answer is: a
 * verification that succeeded. A failed, declined, expired or cancelled request
 * costs the partner nothing.
 */
const BILLABLE: ReadonlySet<PartnerUsageKind> = new Set([
  PartnerUsageKind.VERIFIED,
  PartnerUsageKind.DIRECT_VERIFIED,
])

export function isBillable(kind: PartnerUsageKind): boolean {
  return BILLABLE.has(kind)
}

/** Billing period `YYYY-MM`, in UTC. One definition, so an invoice never straddles. */
export function billingPeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7)
}

/** The `count` periods ending at `period`, newest first. */
export function recentPeriods(period: string, count: number): string[] {
  const [year, month] = period.split('-').map(Number) as [number, number]
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1))
    out.push(billingPeriod(d))
  }
  return out
}

// ── webhooks ────────────────────────────────────────────────────────────────
const WEBHOOK_BASE_DELAY_MS = 30_000
const WEBHOOK_MAX_DELAY_MS = 6 * 60 * 60_000

/**
 * Exponential backoff with jitter: 30s, 1m, 2m, 4m … capped at 6h.
 *
 * `jitter` (0..1) is injected rather than drawn here so the schedule is testable.
 * Jitter matters: a partner outage that ends at once would otherwise be met by
 * every queued delivery retrying in the same second.
 */
export function webhookBackoffMs(attempt: number, jitter = 0.5): number {
  const exponential = WEBHOOK_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(WEBHOOK_MAX_DELAY_MS, exponential)
  const spread = 0.8 + 0.4 * Math.min(1, Math.max(0, jitter))
  return Math.round(capped * spread)
}

// ── result projection & redaction ───────────────────────────────────────────
export type RedactionReason = 'CONSENT_WITHDRAWN' | 'RETENTION_ELAPSED'

/**
 * Strip the claim VALUES out of a cached verifier result, keeping the verdict.
 *
 * Applied on consent withdrawal and when retention elapses. The partner keeps the
 * fact that it verified somebody and what the checks concluded (it needs that for
 * its own audit), and loses the disclosed data — which is the purpose limitation
 * the holder's consent receipt promised.
 */
export function redactResult(
  result: unknown,
  reason: RedactionReason,
  at: Date = new Date(),
): Record<string, unknown> {
  const base =
    result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {}
  const disclosedNames =
    base.claims && typeof base.claims === 'object'
      ? Object.keys(base.claims)
      : []
  return {
    ...base,
    claims: {},
    claimLabels: {},
    redacted: true,
    redactedAt: at.toISOString(),
    redactionReason: reason,
    // Names only, so the partner can still reconcile WHAT it had to delete.
    redactedClaimNames: disclosedNames,
  }
}

export function isRedacted(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    (result as { redacted?: unknown }).redacted === true
  )
}

/**
 * The partner's view of a cached M3 result.
 *
 * Re-filters claims to the partner's CURRENT scope — defence in depth on top of
 * M3's request-time check, so a scope narrowed after a request was answered stops
 * exposing the dropped claims on the next read — and attaches predicate answers.
 */
export function projectResultForPartner(
  result: unknown,
  compiled: readonly CompiledPredicate[],
  scope: readonly string[],
): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const base = result as Record<string, unknown>
  const rawClaims =
    base.claims && typeof base.claims === 'object'
      ? (base.claims as Record<string, unknown>)
      : {}

  const allowed = new Set(scope)
  const claims: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(rawClaims)) {
    // `score_scale` is model metadata, not a claim about the holder.
    if (name === 'score_scale' || allowed.has(name)) claims[name] = value
  }

  const labels =
    base.claimLabels && typeof base.claimLabels === 'object'
      ? Object.fromEntries(
          Object.entries(base.claimLabels as Record<string, unknown>).filter(
            ([name]) => name in claims,
          ),
        )
      : {}

  return {
    ...base,
    claims,
    claimLabels: labels,
    // Evaluated from the FILTERED claims, so a predicate over a claim that has since
    // left the partner's scope reads as unanswered rather than leaking its boolean.
    predicates: evaluatePredicates(compiled, claims),
  }
}
