/**
 * The M5 wire vocabulary.
 *
 * Mirrors the Prisma enums the insurance API sends. Kept as unions rather than
 * `string`, for the reason the payments vocabulary states: a `Record<string, …>`
 * lookup keyed on a widened type means adding a state to the backend leaves this app
 * compiling happily while rendering a raw `SCREAMING_CASE` token on a policy card.
 * Keyed on the union, the same change is a build failure here first.
 */

export type InsuranceProductType =
  | 'INCOME_PROTECTION'
  | 'HEALTH_TOPUP'
  | 'TRAVEL_ACCIDENT';

export type PremiumFrequency = 'ONE_TIME' | 'MONTHLY';

/**
 * The underwriting verdict.
 *
 * `DECLINE` arrives on a 200 with a reason, not as an error — the server records a
 * declined quote deliberately so the app can show WHY and what would change it.
 */
export type RiskTier = 'PREFERRED' | 'STANDARD' | 'SUBSTANDARD' | 'DECLINE';

export type InsuranceQuoteStatus =
  | 'DRAFT'
  | 'PRICED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CONVERTED';

export type PolicyStatus =
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'GRACE'
  | 'LAPSED'
  | 'CANCELLED'
  | 'EXPIRED';

export type ClaimStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'INFO_REQUESTED'
  | 'APPROVED'
  | 'PAID'
  | 'REJECTED'
  | 'WITHDRAWN';

export type ClaimDocStatus =
  | 'UPLOADED'
  | 'OCR_DONE'
  | 'VERIFIED'
  | 'SUSPECT'
  | 'REJECTED';

export type ClaimDecision = 'APPROVE' | 'REJECT' | 'REQUEST_INFO';

/** Who decided a claim. `SYSTEM` is an auto-approval on a small, clean claim. */
export type ClaimDecidedBy = 'USER' | 'ADMIN' | 'SYSTEM';

export type ClaimDocType =
  | 'MEDICAL_BILL'
  | 'DISCHARGE_SUMMARY'
  | 'POLICE_FIR'
  | 'BOARDING_PASS'
  | 'PAYSLIP'
  | 'OTHER';

/**
 * An amount, in every representation the client might need.
 *
 * Re-declared here rather than imported from the payments vocabulary, and
 * deliberately: an insurance screen must be readable without the payments module
 * loaded, and the shape is a wire contract rather than shared behaviour. It is
 * structurally identical, so a value crosses between the two without a conversion.
 */
export interface MoneyView {
  /** Integer minor units, as a digit string. The only value safe to compute on. */
  minor: string;
  major: string;
  formatted: string;
  currency: string;
}

/** What the module is actually running. Surfaced so a mock is never mistaken for live. */
export interface InsurerNotice {
  mode: string;
  provider: string;
  /** False for the demonstration insurer. The app says so, in words. */
  live: boolean;
}
