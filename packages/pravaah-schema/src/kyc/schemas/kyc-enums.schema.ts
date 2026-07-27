import { z } from 'zod'

/** Destination(s) a user is onboarding for. Mirrors the Prisma `Country` enum. */
export const KYC_COUNTRY = {
  INDIA: 'INDIA',
  SINGAPORE: 'SINGAPORE',
  BOTH: 'BOTH',
} as const

export const CountrySchema = z.enum([
  KYC_COUNTRY.INDIA,
  KYC_COUNTRY.SINGAPORE,
  KYC_COUNTRY.BOTH,
])
export type Country = z.infer<typeof CountrySchema>

/** Admin review decision. Mirrors the Prisma `ReviewDecision` enum. */
export const REVIEW_DECISION = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  INFO_REQUESTED: 'INFO_REQUESTED',
} as const

export const ReviewDecisionSchema = z.enum([
  REVIEW_DECISION.APPROVED,
  REVIEW_DECISION.REJECTED,
  REVIEW_DECISION.INFO_REQUESTED,
])
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionSchema>
