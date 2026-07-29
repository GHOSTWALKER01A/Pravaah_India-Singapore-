import { z } from 'zod'

/**
 * M5 · Micro-insurance enums. Each mirrors a Prisma enum so the RN app, the
 * admin console and the backend validate against one source of truth — the same
 * arrangement M0–M4 use.
 *
 * One naming decision is deliberate and worth stating: the quote status enum is
 * `InsuranceQuoteStatus`, not `QuoteStatus`. M4 already owns `FxQuote`, and an
 * unqualified "quote" means a locked FX price everywhere else in this codebase.
 * A shared name would eventually have someone import the wrong one and validate
 * an insurance offer against a currency price.
 */

// ── products ────────────────────────────────────────────────────────────────
/**
 * The three covers.
 *
 * `INCOME_PROTECTION` is the core product — a migrant worker's wage-loss buffer,
 * the cover nobody sells them today. The others exist because a platform that
 * can price exactly one product has not demonstrated it is a platform.
 */
export const INSURANCE_PRODUCT_TYPE = {
  INCOME_PROTECTION: 'INCOME_PROTECTION',
  HEALTH_TOPUP: 'HEALTH_TOPUP',
  TRAVEL_ACCIDENT: 'TRAVEL_ACCIDENT',
} as const

export const InsuranceProductTypeSchema = z.enum([
  INSURANCE_PRODUCT_TYPE.INCOME_PROTECTION,
  INSURANCE_PRODUCT_TYPE.HEALTH_TOPUP,
  INSURANCE_PRODUCT_TYPE.TRAVEL_ACCIDENT,
])
export type InsuranceProductTypeInput = z.infer<
  typeof InsuranceProductTypeSchema
>

/** How a product's cover is described to the person deciding whether to buy it. */
export const PRODUCT_COPY: Record<
  InsuranceProductTypeInput,
  { label: string; who: string; policyPrefix: string }
> = {
  INCOME_PROTECTION: {
    label: 'Income Protection',
    who: 'For daily-wage and gig workers — a buffer for the weeks you cannot work.',
    policyPrefix: 'INC',
  },
  HEALTH_TOPUP: {
    label: 'Health Top-up',
    who: 'Sits on top of any base health cover you already have, including ESIC or a state scheme.',
    policyPrefix: 'HLT',
  },
  TRAVEL_ACCIDENT: {
    label: 'Travel & Accident',
    who: 'For the corridor trip itself — travel mishaps and personal accident.',
    policyPrefix: 'TRV',
  },
}

export const PREMIUM_FREQUENCY = {
  ONE_TIME: 'ONE_TIME',
  MONTHLY: 'MONTHLY',
} as const

export const PremiumFrequencySchema = z.enum([
  PREMIUM_FREQUENCY.ONE_TIME,
  PREMIUM_FREQUENCY.MONTHLY,
])
export type PremiumFrequencyInput = z.infer<typeof PremiumFrequencySchema>

// ── underwriting ────────────────────────────────────────────────────────────
/**
 * The underwriting verdict.
 *
 * `DECLINE` is a TIER, not an error. A decline carries a reason and a route back
 * to eligibility, so it is recorded as a quote the user can be shown and coached
 * from — a 4xx would leave them with nothing to act on, which for this
 * population is indistinguishable from the refusal they already get everywhere
 * else.
 */
export const RISK_TIER = {
  PREFERRED: 'PREFERRED',
  STANDARD: 'STANDARD',
  SUBSTANDARD: 'SUBSTANDARD',
  DECLINE: 'DECLINE',
} as const

export const RiskTierSchema = z.enum([
  RISK_TIER.PREFERRED,
  RISK_TIER.STANDARD,
  RISK_TIER.SUBSTANDARD,
  RISK_TIER.DECLINE,
])
export type RiskTierInput = z.infer<typeof RiskTierSchema>

/** What each tier means, in words a policyholder can act on. */
export const RISK_TIER_COPY: Record<
  RiskTierInput,
  { label: string; explanation: string }
> = {
  PREFERRED: {
    label: 'Preferred',
    explanation:
      'Your Pravaah reputation puts you in our best price band — you pay less than a standard applicant for the same cover.',
  },
  STANDARD: {
    label: 'Standard',
    explanation: 'You are priced at our standard rate for this cover.',
  },
  SUBSTANDARD: {
    label: 'Higher risk',
    explanation:
      'Your premium is higher and your waiting period is longer, because there is not yet enough consistent history to price you better. Improving your score changes both.',
  },
  DECLINE: {
    label: 'Not available yet',
    explanation:
      'This cover is not open to you at the moment. Improving your Pravaah score unlocks it.',
  },
}

// ── lifecycles ──────────────────────────────────────────────────────────────
export const INSURANCE_QUOTE_STATUS = {
  DRAFT: 'DRAFT',
  PRICED: 'PRICED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  CONVERTED: 'CONVERTED',
} as const

export const InsuranceQuoteStatusSchema = z.enum([
  INSURANCE_QUOTE_STATUS.DRAFT,
  INSURANCE_QUOTE_STATUS.PRICED,
  INSURANCE_QUOTE_STATUS.DECLINED,
  INSURANCE_QUOTE_STATUS.EXPIRED,
  INSURANCE_QUOTE_STATUS.CONVERTED,
])
export type InsuranceQuoteStatusInput = z.infer<
  typeof InsuranceQuoteStatusSchema
>

export const POLICY_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  ACTIVE: 'ACTIVE',
  GRACE: 'GRACE',
  LAPSED: 'LAPSED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const

export const PolicyStatusSchema = z.enum([
  POLICY_STATUS.PENDING_PAYMENT,
  POLICY_STATUS.ACTIVE,
  POLICY_STATUS.GRACE,
  POLICY_STATUS.LAPSED,
  POLICY_STATUS.CANCELLED,
  POLICY_STATUS.EXPIRED,
])
export type PolicyStatusInput = z.infer<typeof PolicyStatusSchema>

export const CLAIM_STATUS = {
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  INFO_REQUESTED: 'INFO_REQUESTED',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const

export const ClaimStatusSchema = z.enum([
  CLAIM_STATUS.SUBMITTED,
  CLAIM_STATUS.UNDER_REVIEW,
  CLAIM_STATUS.INFO_REQUESTED,
  CLAIM_STATUS.APPROVED,
  CLAIM_STATUS.PAID,
  CLAIM_STATUS.REJECTED,
  CLAIM_STATUS.WITHDRAWN,
])
export type ClaimStatusInput = z.infer<typeof ClaimStatusSchema>

export const CLAIM_DOC_STATUS = {
  UPLOADED: 'UPLOADED',
  OCR_DONE: 'OCR_DONE',
  VERIFIED: 'VERIFIED',
  SUSPECT: 'SUSPECT',
  REJECTED: 'REJECTED',
} as const

export const ClaimDocStatusSchema = z.enum([
  CLAIM_DOC_STATUS.UPLOADED,
  CLAIM_DOC_STATUS.OCR_DONE,
  CLAIM_DOC_STATUS.VERIFIED,
  CLAIM_DOC_STATUS.SUSPECT,
  CLAIM_DOC_STATUS.REJECTED,
])
export type ClaimDocStatusInput = z.infer<typeof ClaimDocStatusSchema>

export const CLAIM_DECISION = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  REQUEST_INFO: 'REQUEST_INFO',
} as const

export const ClaimDecisionSchema = z.enum([
  CLAIM_DECISION.APPROVE,
  CLAIM_DECISION.REJECT,
  CLAIM_DECISION.REQUEST_INFO,
])
export type ClaimDecisionInput = z.infer<typeof ClaimDecisionSchema>

// ── claim documents ─────────────────────────────────────────────────────────
/**
 * The document kinds a claim can carry, and which product each supports.
 *
 * An enumerated list rather than free text, because the OCR provider's
 * extraction is keyed on the document kind: a "medical bill" parser applied to a
 * boarding pass returns confident nonsense, and a claim decided on confident
 * nonsense is worse than one with no documents at all.
 */
export const CLAIM_DOC_TYPE = {
  MEDICAL_BILL: 'MEDICAL_BILL',
  DISCHARGE_SUMMARY: 'DISCHARGE_SUMMARY',
  POLICE_FIR: 'POLICE_FIR',
  BOARDING_PASS: 'BOARDING_PASS',
  PAYSLIP: 'PAYSLIP',
  /** Employer letter, bank statement, anything a reviewer asked for by name. */
  OTHER: 'OTHER',
} as const

export const ClaimDocTypeSchema = z.enum([
  CLAIM_DOC_TYPE.MEDICAL_BILL,
  CLAIM_DOC_TYPE.DISCHARGE_SUMMARY,
  CLAIM_DOC_TYPE.POLICE_FIR,
  CLAIM_DOC_TYPE.BOARDING_PASS,
  CLAIM_DOC_TYPE.PAYSLIP,
  CLAIM_DOC_TYPE.OTHER,
])
export type ClaimDocTypeInput = z.infer<typeof ClaimDocTypeSchema>

/**
 * Which documents a claim on each product is expected to carry.
 *
 * Shared with the clients so the upload screen can ask for the right things
 * up-front. The SERVER still decides whether a claim has enough evidence — a
 * client-side list is guidance, `REQUIRED_CLAIM_DOCS` in the backend's
 * `insurance.config.ts` is the control.
 */
export const EXPECTED_CLAIM_DOCS: Record<
  InsuranceProductTypeInput,
  ClaimDocTypeInput[]
> = {
  INCOME_PROTECTION: ['PAYSLIP', 'MEDICAL_BILL', 'OTHER'],
  HEALTH_TOPUP: ['MEDICAL_BILL', 'DISCHARGE_SUMMARY'],
  TRAVEL_ACCIDENT: ['POLICE_FIR', 'BOARDING_PASS', 'MEDICAL_BILL'],
}

// ── the non-advice stance ───────────────────────────────────────────────────
/**
 * The disclaimer every priced surface must carry, verbatim.
 *
 * Exported from the SCHEMA package rather than written into each screen so there
 * is exactly one wording, and so a screen that forgot it is a missing import
 * rather than a missing paragraph nobody notices. A product priced off somebody's
 * financial behaviour, sold to a population with little insurance literacy, has
 * to say plainly that it is not advice — and that the insurer's policy wording,
 * not our app, governs what is actually covered.
 */
export const INSURANCE_NON_ADVICE_DISCLAIMER =
  'Pravaah provides information, not medical or financial advice. Cover, exclusions, waiting periods and claim decisions are governed by the insurer’s policy wording. Your premium is calculated from the financial data you consented to share; it is not a judgement about you as a person.'

/**
 * What the demo build is, said out loud.
 *
 * Carried in the API response so the RN app and the admin console cannot present
 * a mock insurer as a real one. Removing this string is a deliberate act at the
 * moment a licensed insurer is actually behind the interface — which is exactly
 * when it should be.
 */
export const INSURANCE_MOCK_INSURER_NOTICE =
  'This cover is bound against a demonstration insurer. Production requires an IRDAI-regulated insurer partner and a corporate-agent or Insurance Marketing Firm arrangement; the premium and payout legs shown here run on Pravaah’s live ledger.'
