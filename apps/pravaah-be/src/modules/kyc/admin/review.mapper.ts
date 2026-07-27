import {
  CheckStatus,
  CheckType,
  Country,
  KycStatus,
  Prisma,
  ReviewDecision,
  ReviewStatus,
} from 'generated/prisma/client'

/**
 * Shapes the raw Prisma `ReviewCase` graph into the flat, admin-safe DTOs the
 * console renders. Two jobs live here so the wire contract is stable and never
 * leaks the encrypted payload or raw PII:
 *   - readable reference codes derived from the row UUIDs (see {@link refCode})
 *   - phone/email masking for the reviewer projection
 */

/** Includes the queue/list projection needs — kept next to its mapper. */
export const CASE_LIST_INCLUDE = {
  kycProfile: { include: { user: true } },
} satisfies Prisma.ReviewCaseInclude

/** Includes the full detail projection needs. */
export const CASE_DETAIL_INCLUDE = {
  assignedAdmin: true,
  kycProfile: { include: { user: true, checks: true } },
} satisfies Prisma.ReviewCaseInclude

type CaseListRow = Prisma.ReviewCaseGetPayload<{
  include: typeof CASE_LIST_INCLUDE
}>
type CaseDetailRow = Prisma.ReviewCaseGetPayload<{
  include: typeof CASE_DETAIL_INCLUDE
}>

export interface AdminCaseListItem {
  id: string // real UUID — used as the route param
  caseCode: string // human-readable, e.g. PVH-C-1A2B-3C4D
  status: ReviewStatus
  country: Country
  userRef: string // the user's Pravaah ID, e.g. PVH-4K7Q-M2XB-9T3F
  userName: string // verified name, else masked contact, else the ref
  reason: string
  slaDueAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminCaseDetail extends AdminCaseListItem {
  claimedBy: string | null // assigned admin email
  decision: ReviewDecision | null
  decisionNotes: string | null
  resolvedAt: string | null
  user: {
    ref: string
    name: string | null
    email: string | null // masked
    phone: string | null // masked
    country: Country
    kycStatus: KycStatus
    suspended: boolean
    createdAt: string
  }
  profile: {
    overallStatus: KycStatus
    verifiedName: string | null
    nameMatchScore: number | null
    riskScore: number | null
    startedAt: string
    completedAt: string | null
  }
  checks: {
    checkType: CheckType
    status: CheckStatus
    provider: string
    confidence: number | null
    attempt: number
    maskedResult: unknown
    updatedAt: string
  }[]
}

/**
 * Deterministic, readable id derived from a row's UUID: `PVH-<type>-XXXX-XXXX`
 * (first 8 hex of the UUID, grouped). Stable and far shorter than the raw
 * 36-char id.
 *
 * Correct for CASES, which are internal workflow artefacts nobody outside the
 * console ever quotes. It is NOT how a user is labelled: a user's identity is
 * their stored `pravaahId`, so the same person reads the same in the app, the
 * console and a partner's records. This stays only as the fallback for a row
 * that somehow reaches the console before the issuer minted one.
 */
export function refCode(prefix: 'U' | 'C', uuid: string): string {
  const hex = uuid.replace(/-/g, '').toUpperCase()
  return `PVH-${prefix}-${hex.slice(0, 4)}-${hex.slice(4, 8)}`
}

/** A user's public identity, degrading to the derived code only if unminted. */
function userRef(user: { id: string; pravaahId: string | null }): string {
  return user.pravaahId ?? refCode('U', user.id)
}

function maskEmail(email: string | null): string | null {
  if (!email) return null
  const [local, domain] = email.split('@')
  if (!domain) return email
  const head = local.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  if (phone.length <= 7) return phone
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`
}

/** Best available human label: verified name → masked email → masked phone → ref. */
function displayName(row: CaseListRow | CaseDetailRow): string {
  const user = row.kycProfile.user
  return (
    row.kycProfile.verifiedName ??
    maskEmail(user.email) ??
    maskPhone(user.phone) ??
    userRef(user)
  )
}

export function toCaseListItem(row: CaseListRow): AdminCaseListItem {
  return {
    id: row.id,
    caseCode: refCode('C', row.id),
    status: row.status,
    country: row.kycProfile.user.primaryCountry,
    userRef: userRef(row.kycProfile.user),
    userName: displayName(row),
    reason: row.reason,
    slaDueAt: row.slaDueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toCaseDetail(row: CaseDetailRow): AdminCaseDetail {
  const user = row.kycProfile.user
  return {
    ...toCaseListItem(row),
    claimedBy: row.assignedAdmin?.email ?? null,
    decision: row.decision,
    decisionNotes: row.decisionNotes,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    user: {
      ref: userRef(user),
      name: row.kycProfile.verifiedName,
      email: maskEmail(user.email),
      phone: maskPhone(user.phone),
      country: user.primaryCountry,
      kycStatus: user.kycStatus,
      suspended: user.isSuspended,
      createdAt: user.createdAt.toISOString(),
    },
    profile: {
      overallStatus: row.kycProfile.overallStatus,
      verifiedName: row.kycProfile.verifiedName,
      nameMatchScore: row.kycProfile.nameMatchScore,
      riskScore: row.kycProfile.riskScore,
      startedAt: row.kycProfile.startedAt.toISOString(),
      completedAt: row.kycProfile.completedAt?.toISOString() ?? null,
    },
    // Sorted by check type then attempt for a stable, readable order.
    checks: [...row.kycProfile.checks]
      .sort((a, b) =>
        a.checkType === b.checkType
          ? a.attempt - b.attempt
          : a.checkType.localeCompare(b.checkType),
      )
      .map((ch) => ({
        checkType: ch.checkType,
        status: ch.status,
        provider: ch.provider,
        confidence: ch.confidence,
        attempt: ch.attempt,
        maskedResult: ch.maskedResult,
        updatedAt: ch.updatedAt.toISOString(),
      })),
  }
}
