import {
  ALWAYS_VISIBLE_CLAIMS,
  CLAIM_CATALOGUE,
  DISCLOSABLE_CLAIMS,
  PRESENTATION_TEMPLATES,
  isDisclosableClaim,
  type DisclosableClaim,
  type PresentationTemplateId,
} from '@pravaah/schema'

import {
  CredentialStatus,
  ScoreBand,
  VerifierRequestStatus,
} from 'generated/prisma/client'

/**
 * Pure M3 logic — NO I/O, so every rule is unit-testable and the credential's
 * meaning cannot drift between the issuer, the verifier, the schedulers, and the
 * admin console. This is the M3 counterpart to M1's `consent.state.ts` and M2's
 * `scoring.state.ts`.
 */

// ── credential lifecycle ────────────────────────────────────────────────────
/**
 *   ISSUED    → SUSPENDED | REVOKED | EXPIRED
 *   SUSPENDED → ISSUED    | REVOKED | EXPIRED     (a hold is reversible)
 *   REVOKED   → (terminal — a revoked credential is never resurrected;
 *                the user re-issues, which mints a NEW credential number)
 *   EXPIRED   → (terminal for this credential; re-consent + recompute + re-issue)
 *
 * REVOKED being terminal is the important one. Un-revoking would mean a
 * credential a verifier already rejected could start passing again, and no
 * verifier caches revocation with that possibility in mind.
 */
const ALLOWED: Record<CredentialStatus, CredentialStatus[]> = {
  ISSUED: [
    CredentialStatus.SUSPENDED,
    CredentialStatus.REVOKED,
    CredentialStatus.EXPIRED,
  ],
  SUSPENDED: [
    CredentialStatus.ISSUED,
    CredentialStatus.REVOKED,
    CredentialStatus.EXPIRED,
  ],
  REVOKED: [],
  EXPIRED: [],
}

export function canTransition(
  from: CredentialStatus,
  to: CredentialStatus,
): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/**
 * Statuses whose status-list bit is SET (i.e. "do not accept").
 *
 * SUSPENDED is in here deliberately. The distinction between a hold and a
 * revocation is ours to manage; to a verifier both must read "do not accept",
 * because fail-closed is the only safe reading while an investigation is open.
 */
export function isStatusListSet(status: CredentialStatus): boolean {
  return (
    status === CredentialStatus.REVOKED || status === CredentialStatus.SUSPENDED
  )
}

/** A credential the holder may present. */
export function isPresentable(
  status: CredentialStatus,
  expiresAt: Date | null,
  now = new Date(),
): boolean {
  return (
    status === CredentialStatus.ISSUED && (!expiresAt || expiresAt > now)
  )
}

/** Whether a verifier request is still answerable. */
export function isRequestOpen(
  status: VerifierRequestStatus,
  expiresAt: Date,
  now = new Date(),
): boolean {
  return status === VerifierRequestStatus.PENDING && expiresAt > now
}

// ── claim assembly ──────────────────────────────────────────────────────────
/**
 * Band ordering, low to high. Used to derive the threshold assertions, so
 * "VERY_GOOD implies GOOD" is computed from one ordered list rather than restated
 * as a chain of comparisons that could disagree with M2's cutoffs.
 */
const BAND_ORDER: readonly ScoreBand[] = [
  ScoreBand.POOR,
  ScoreBand.FAIR,
  ScoreBand.GOOD,
  ScoreBand.VERY_GOOD,
  ScoreBand.EXCELLENT,
]

export function bandRank(band: ScoreBand): number {
  return BAND_ORDER.indexOf(band)
}

export function bandAtLeast(band: ScoreBand, floor: ScoreBand): boolean {
  return bandRank(band) >= bandRank(floor)
}

/**
 * The four threshold claims, keyed to the band they assert.
 *
 * POOR is absent because "at least POOR" is true for every possible score and
 * would prove nothing — a claim that is always true is not a claim, it is noise
 * in the disclosure picker.
 */
export const THRESHOLD_CLAIMS: ReadonlyArray<{
  claim: DisclosableClaim
  floor: ScoreBand
}> = [
  { claim: 'score_at_least_fair', floor: ScoreBand.FAIR },
  { claim: 'score_at_least_good', floor: ScoreBand.GOOD },
  { claim: 'score_at_least_very_good', floor: ScoreBand.VERY_GOOD },
  { claim: 'score_at_least_excellent', floor: ScoreBand.EXCELLENT },
]

/**
 * Every threshold claim, with its truth value for `band`.
 *
 * ALL FOUR are always returned, including the false ones. Minting only the true
 * assertions would make the NUMBER of digests in `_sd` vary with the band, and an
 * observer counting digests would learn the band without a single disclosure —
 * which would silently defeat the entire selective-disclosure property. This is
 * the reason the function returns a fixed-length list rather than a filter.
 */
export function thresholdClaims(band: ScoreBand): Record<string, boolean> {
  return Object.fromEntries(
    THRESHOLD_CLAIMS.map(({ claim, floor }) => [
      claim,
      bandAtLeast(band, floor),
    ]),
  )
}

/**
 * Identity assurance, expressed for a verifier who knows nothing about Indian or
 * Singaporean KYC rails.
 *
 * A verifier abroad cannot evaluate "Aadhaar OKYC plus penny-drop plus liveness";
 * they can evaluate "government document verified, biometric liveness passed,
 * sanctions screened". So the claim carries the CAPABILITIES that were proven, not
 * the names of the rails that proved them — which also means adding a new rail in
 * M0 does not change what this claim means.
 */
export function kycLevel(checks: {
  governmentDocument: boolean
  liveness: boolean
  faceMatch: boolean
  bankAccount: boolean
  sanctionsScreened: boolean
}): string {
  const proven: string[] = []
  if (checks.governmentDocument) proven.push('GOV_DOC')
  if (checks.liveness) proven.push('LIVENESS')
  if (checks.faceMatch) proven.push('FACE_MATCH')
  if (checks.bankAccount) proven.push('BANK_ACCOUNT')
  if (checks.sanctionsScreened) proven.push('SANCTIONS')
  // A verified user always cleared at least a document check, so an empty list
  // means the caller assembled this from an unverified profile.
  return proven.length ? proven.join('+') : 'NONE'
}

/**
 * Split a name into given/family parts.
 *
 * The last whitespace-separated token is treated as the family name, and
 * everything before it as given names. This is wrong for a meaningful share of
 * Indian names — many people have no family name at all, and South Indian naming
 * often puts the patronymic first — so the rule is stated here in one place, and
 * a single-token name yields an EMPTY family name rather than duplicating the
 * given name into both fields. An empty field is honest; a fabricated surname on a
 * document a landlord will check is not.
 */
export function splitVerifiedName(verifiedName: string | null | undefined): {
  givenName: string
  familyName: string
} {
  const parts = (verifiedName ?? '')
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0)
  if (parts.length === 0) return { givenName: '', familyName: '' }
  if (parts.length === 1) return { givenName: parts[0]!, familyName: '' }
  return {
    givenName: parts.slice(0, -1).join(' '),
    familyName: parts[parts.length - 1]!,
  }
}

/**
 * Which regulated rails the data travelled over.
 *
 * A verifier trusts the score because of the rail behind it, so this is one of the
 * most load-bearing provenance claims. Derived from the user's country rather than
 * hard-coded, and SGFinDex only appears for a user who actually has a Singapore
 * side — claiming a rail we did not use would be the one lie that discredits every
 * other claim in the credential.
 */
export function dataRailsFor(primaryCountry: string): string[] {
  switch (primaryCountry) {
    case 'SINGAPORE':
      return ['SGFinDex']
    case 'BOTH':
      return ['AA-IN', 'SGFinDex']
    default:
      return ['AA-IN']
  }
}

// ── disclosure policy ───────────────────────────────────────────────────────
/**
 * Filter a requested claim list to those this credential can actually disclose.
 *
 * Returns the unknown names too, so a verifier gets told "you asked for
 * `annual_income`, which this credential does not carry" instead of receiving a
 * silently shorter list and reading the absence as a refusal by the holder.
 */
export function partitionRequestedClaims(requested: readonly string[]): {
  known: DisclosableClaim[]
  unknown: string[]
} {
  const known: DisclosableClaim[] = []
  const unknown: string[] = []
  // De-duplicated: a verifier listing a claim twice must not make the wallet
  // render it twice or the log count it twice.
  for (const claim of new Set(requested)) {
    if (isDisclosableClaim(claim)) known.push(claim)
    else unknown.push(claim)
  }
  return { known, unknown }
}

/**
 * Requested claims a verifier is NOT approved to ask for.
 *
 * Fails closed by construction: an empty scope makes every claim "outside", so a
 * partner that was never given a scope can request nothing — rather than an empty
 * list being read as "unrestricted", which is the classic default-allow bug.
 */
export function claimsOutsideScope(
  requested: readonly string[],
  scope: readonly string[],
): string[] {
  const allowed = new Set(scope)
  return [...new Set(requested)].filter((claim) => !allowed.has(claim))
}

/** Resolve a template id to its claims + purpose sentence. */
export function resolveTemplate(id: PresentationTemplateId): {
  claims: DisclosableClaim[]
  purpose: string
  label: string
} {
  const template = PRESENTATION_TEMPLATES[id]
  return {
    claims: [...template.claims],
    purpose: template.purpose,
    label: template.label,
  }
}

/**
 * Which requested claims the holder did NOT disclose.
 *
 * Reported explicitly because the alternative is dangerous: a verifier reading a
 * missing `score_at_least_good` as `false` would decline an applicant who is
 * actually excellent and simply chose not to answer. "Absent" and "false" are
 * different facts and the API must never conflate them.
 */
export function unsatisfiedClaims(
  required: readonly string[],
  disclosed: Readonly<Record<string, unknown>>,
): string[] {
  return required.filter((claim) => !(claim in disclosed))
}

/**
 * Guard against a wallet asking to reveal a claim this credential never minted
 * (an older credential presented after the catalogue grew, say). Returns the
 * subset that actually exists, plus what was dropped.
 */
export function selectableClaims(
  requested: readonly string[],
  available: readonly string[],
): { selected: string[]; missing: string[] } {
  const have = new Set(available)
  const selected: string[] = []
  const missing: string[] = []
  for (const claim of new Set(requested)) {
    if (have.has(claim)) selected.push(claim)
    else missing.push(claim)
  }
  return { selected, missing }
}

/** Every claim key a credential of the current version carries. */
export const ALL_CLAIM_KEYS: readonly string[] = [
  ...ALWAYS_VISIBLE_CLAIMS,
  ...DISCLOSABLE_CLAIMS,
]

/**
 * Wallet-facing description of one claim, including whether this credential holds
 * it. The `held` flag is what lets the picker grey out a claim rather than hide it
 * — "your passport does not carry a passport number" is actionable, a missing row
 * is just confusing.
 */
export function describeCredentialClaims(availableKeys: readonly string[]): Array<{
  claim: DisclosableClaim
  label: string
  detail: string
  category: string
  sensitivity: string
  whyAsked: string
  held: boolean
}> {
  const have = new Set(availableKeys)
  return DISCLOSABLE_CLAIMS.map((claim) => {
    const descriptor = CLAIM_CATALOGUE[claim]
    return {
      claim,
      label: descriptor.label,
      detail: descriptor.detail,
      category: descriptor.category,
      sensitivity: descriptor.sensitivity,
      whyAsked: descriptor.whyAsked,
      held: have.has(claim),
    }
  })
}
