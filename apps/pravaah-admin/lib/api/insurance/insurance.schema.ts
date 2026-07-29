/**
 * M5 wire shapes, as the admin console consumes them.
 *
 * ## These MIRROR the server's projection. They are not designed here.
 *
 * Every interface below was written by reading
 * `apps/pravaah-be/src/modules/insurance/services/insurance-admin.service.ts` and its
 * controller, field by field. An earlier version of this file was written from the domain model
 * instead — which produced a plausible, wrong shape (`remainingCover` on a policy row, a flat
 * `riskScore`, a `holder` object where the server sends a bare string) and a runtime crash on
 * the policies page the first time it rendered.
 *
 * The lesson is in the structure: the server's admin projection is deliberately DIFFERENT from
 * the holder-facing one. It nests `risk`, `decision`, `payout` and `external` because a reviewer
 * reads them as groups, and it omits the derived labels the app needs because a console shows the
 * raw state. Two projections of one entity is the correct design; assuming they match is not.
 *
 * Unions rather than `string` throughout, for the reason `payments.schema.ts` states: a
 * `Record<string, …>` tone map keyed on a widened type means adding a state to the backend leaves
 * this file compiling happily while rendering a raw `SCREAMING_CASE` token on the one screen
 * somebody opens during an incident.
 */

export type InsuranceProductType =
  | 'INCOME_PROTECTION'
  | 'HEALTH_TOPUP'
  | 'TRAVEL_ACCIDENT';

export type PremiumFrequency = 'ONE_TIME' | 'MONTHLY';

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

export type ActorType = 'USER' | 'ADMIN' | 'SYSTEM';

export interface MoneyView {
  minor: string;
  major: string;
  formatted: string;
  currency: string;
}

/**
 * The offset-paginated envelope's payload.
 *
 * `ResponseBuilder.paginatedWithOffset` wraps items in `data` alongside the page metadata, so
 * both the claim queue and the policy list arrive in this shape rather than as a bare `{ items,
 * total }`. Getting that wrong reads `undefined.items` — which is exactly the class of error this
 * file now exists to prevent.
 */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
   The book
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * One currency's underwriting result.
 *
 * `floatBalanceMinor` is a bare SIGNED string, not a `MoneyView`, because the float can be
 * negative and M4's `moneyView` refuses negatives by construction — its money helpers reject them
 * so a debit cannot masquerade as a credit. A loss is a real state, so the server sends the signed
 * minor string and `formatMoney` handles the leading minus.
 *
 * `lossRatioPercent` is `null` when nothing has been earned. NOT zero: a book with no premium has
 * no loss ratio, and `0%` would read as a perfectly performing product that has never sold
 * anything.
 */
export interface BookCurrency {
  currency: string;
  earnedPremium: MoneyView;
  refundedPremium: MoneyView;
  /** Premium the book keeps — earned minus free-look refunds. The ratio's denominator. */
  netEarnedPremium: MoneyView;
  claimsPaid: MoneyView;
  lossRatioBps: number | null;
  lossRatioPercent: number | null;
  floatBalanceMinor: string;
  underwritingResult: 'SURPLUS' | 'DEFICIT';
}

export interface InsuranceBook {
  byCurrency: BookCurrency[];
  /** The server's own note on why there is no cross-currency total. Rendered verbatim. */
  note: string;
}

/** What is actually running. Surfaced so a mock is never mistaken for a licensed insurer. */
export interface ProviderReport {
  insurer: { mode: string; provider: string; live: boolean };
  ocr: { mode: string; provider: string; live: boolean };
  claimsExchange: { provider: string | null; configured: boolean };
}

export interface InsuranceStats {
  products: { active: number };
  policies: Partial<Record<PolicyStatus, number>>;
  quotes: Partial<Record<InsuranceQuoteStatus, number>>;
  claims: Partial<Record<ClaimStatus, number>>;

  /**
   * The conversion funnel — where an underwriting problem shows up FIRST.
   *
   * A rising decline rate means the band floor is excluding a population rather than pricing it,
   * which is exactly the outcome M2's fairness audit exists to catch. Both figures are `null`
   * until there are quotes to divide by.
   */
  funnel: {
    totalQuotes: number;
    priced: number;
    converted: number;
    declined: number;
    declineRatePercent: number | null;
    conversionRatePercent: number | null;
  };

  /** Counts an operator must ACT on. `pendingPayouts` is the one that matters most. */
  attention: {
    pendingPayouts: number;
    policiesAwaitingInsurerBinding: number;
    suspectDocuments: number;
    claimsAwaitingReview: number;
  };

  providers: ProviderReport;
}

/* ────────────────────────────────────────────────────────────────────────────
   Claims — the reviewer's projection
   ──────────────────────────────────────────────────────────────────────────── */

export interface AdminClaimDocument {
  id: string;
  docType: string;
  status: ClaimDocStatus;
  /** 0..1 forgery likelihood. Visible to an ADMIN, never to the claimant. */
  tamperScore: number | null;
  ocrConfidence: number | null;
  extractedAmount: MoneyView | null;
  /** Whether there is an encrypted extraction to reveal. The reveal is a logged act. */
  hasExtraction: boolean;
  uploadedAt: string;
}

/**
 * A claim, as a reviewer sees it. The SAME shape in the queue and on the detail page.
 *
 * The server builds both from one `describeClaimForReviewer`, and the detail page adds two
 * fields on top. That is why there is one interface here with an extension rather than two —
 * a queue row and a detail row that could drift would eventually disagree about a fraud score.
 */
export interface AdminClaim {
  id: string;
  claimNumber: string;
  status: ClaimStatus;
  type: string;

  amountClaimed: MoneyView;
  amountApproved: MoneyView | null;

  incidentDate: string;
  description: string;
  submittedAt: string;

  /**
   * The M6 fraud signals, nested.
   *
   * A reviewer cannot decide without them; a claimant given them has a list of what to avoid
   * next time. `score` is `null` until the claim has been through the gate — which is not the
   * same as a score of zero.
   */
  risk: { score: number | null; flags: string[] };

  /** The holder by PUBLIC id. An admin console has no need for the UUID. */
  holder: { pravaahId: string | null; country: string };

  policy: {
    id: string;
    policyNumber: string;
    status: PolicyStatus;
    product: string;
    productType: string;
    coverage: MoneyView;
    claimedToDate: MoneyView;
    /** Present HERE (computed by the server for the reviewer), unlike on a policy row. */
    remainingCover: MoneyView;
    startAt: string | null;
    endAt: string | null;
    waitingPeriodEndsAt: string | null;
  };

  documents: AdminClaimDocument[];

  decision: {
    decision: ClaimDecision | null;
    reason: string | null;
    byType: ActorType | null;
    reviewer: { id: string; email: string; role: string } | null;
    decidedAt: string | null;
  };

  payout: {
    transactionId: string | null;
    paidAt: string | null;
    /**
     * Approved but unpaid — the state that must never go unnoticed.
     *
     * A claimant has been told their claim is approved and the money has not arrived. There is
     * no error in any log; only this flag and the retry sweep.
     */
    pending: boolean;
  };

  external: { insurerClaimRef: string | null; hcxRequestId: string | null };
}

/** The detail page's two extras. */
export interface AdminClaimDetail extends AdminClaim {
  /**
   * The policy's pricing provenance.
   *
   * On the adjudication screen because a claim on a policy priced from a thin file with a
   * 60-day waiting period is a different picture from one on an EXCELLENT-band policy, and a
   * reviewer should not have to open three screens to see which they are looking at.
   */
  underwriting: {
    riskTier: RiskTier;
    scoreBand: string | null;
    confidence: number | null;
    multiplierBps: number;
    pricingModelVersion: string;
    waitingPeriodDays: number;
  };
  claimHistory: { otherClaimsByHolder: number };
}

/**
 * What a decision returns.
 *
 * Deliberately NOT the full claim: the server answers with the outcome and whether the payout
 * settled, because those are the two facts the console has to act on. `payoutPending` true means
 * the claim is APPROVED and the money has not moved — the claim stays approved and the sweep
 * retries it, since there is no APPROVED → REJECTED edge to walk it back with.
 */
export interface ClaimDecisionResult {
  id: string;
  claimNumber: string;
  status: ClaimStatus;
  amountApprovedMinor: string | null;
  payoutTransactionId: string | null;
  payoutPending: boolean;
}

/** The decrypted extraction. Fetching it writes an audit row naming the admin. */
export interface RevealedDocument {
  id: string;
  docType: string;
  status: ClaimDocStatus;
  tamperScore: number | null;
  ocrConfidence: number | null;
  /** `unknown` on the wire — the server sends whatever the OCR provider extracted. */
  fields: unknown;
}

/* ────────────────────────────────────────────────────────────────────────────
   Policies
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A policy row.
 *
 * Note what is NOT here, because assuming otherwise is what crashed this page once:
 * there is no `remainingCover` (the server sends `claimedToDate`, and the remainder is the
 * caller's subtraction), no `statusLabel`, and no `graceEndsAt`. `holder` and `product` are bare
 * strings, not objects.
 */
export interface AdminPolicyRow {
  id: string;
  policyNumber: string;
  status: PolicyStatus;
  /** The holder's public Pravaah ID, as a bare string. */
  holder: string | null;
  /** The product NAME, as a bare string. `productType` is the enum. */
  product: string;
  productType: string;
  coverage: MoneyView;
  premium: MoneyView;
  frequency: PremiumFrequency;
  underwriting: {
    riskTier: RiskTier;
    scoreBand: string | null;
    confidence: number | null;
  };
  claimCount: number;
  claimedToDate: MoneyView;
  startAt: string | null;
  endAt: string | null;
  nextPremiumDueAt: string | null;
  insurerPolicyRef: string | null;
  insurerBindPending: boolean;
  createdAt: string;
}

export interface AdminPremiumRow {
  id: string;
  amount: MoneyView;
  /** PENDING | PAID | FAILED | REFUNDED. */
  status: string;
  periodStart: string;
  periodEnd: string;
  attempt: number;
  failureReason: string | null;
  transactionId: string | null;
  refunded: MoneyView;
  paidAt: string | null;
}

/** Premium history arrives WITH its policy number, not as a bare array. */
export interface AdminPremiumHistory {
  policyNumber: string;
  items: AdminPremiumRow[];
}

/* ────────────────────────────────────────────────────────────────────────────
   Products
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A catalogue entry.
 *
 * The raw Prisma row with the two BigInt columns stringified and a `MoneyView` added for each —
 * exactly what the controller sends. `exclusions` is `unknown` because the column is `Json`; the
 * page narrows it rather than trusting a type the database does not enforce.
 */
export interface AdminProduct {
  id: string;
  type: InsuranceProductType;
  name: string;
  tagline: string | null;
  currency: string;
  /** Annual base rate in basis points OF COVERAGE. A quote multiplies it by the risk tier. */
  baseRateBps: number;
  minCoverMinor: string;
  maxCoverMinor: string;
  minCover: MoneyView;
  maxCover: MoneyView;
  termDays: number;
  waitingPeriodDays: number;
  freeLookDays: number;
  exclusions: unknown;
  disclaimer: string;
  isActive: boolean;
  createdAt: string;
}

/** `setProductActive` answers with the flag alone, not the whole product. */
export interface ProductActiveResult {
  id: string;
  isActive: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
   Requests
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * An adjudication.
 *
 * No `adminId`: the acting admin comes from the authenticated session, never from the body.
 * `reason` is mandatory on every branch INCLUDING an approval — an approval nobody has to justify
 * is the shape of internal fraud, and a rejection with no stated ground is one the claimant
 * cannot appeal.
 */
export interface ClaimDecisionRequest {
  decision: ClaimDecision;
  reason: string;
  /** Approve less than claimed. Capped server-side at the claim and the remaining cover. */
  approveMinor?: string;
}

export interface UpsertProductRequest {
  type: InsuranceProductType;
  name: string;
  tagline?: string;
  currency: string;
  baseRateBps: number;
  minCoverMinor: string;
  maxCoverMinor: string;
  termDays: number;
  waitingPeriodDays: number;
  freeLookDays: number;
  exclusions: string[];
  disclaimer: string;
  isActive: boolean;
}

/**
 * What a forced lifecycle sweep did.
 *
 * `dunning` is a nested object rather than a count, because premium collection has three distinct
 * outcomes an operator needs separated: attempted, collected, and lapsed. A single number would
 * hide the one that matters — a lapse is somebody losing cover.
 */
export interface LifecycleResult {
  quotesExpired: number;
  dunning: { attempted: number; collected: number; lapsed: number };
  policiesExpired: number;
  resumedTransactions: number;
  payoutsRetried: number;
  insurerBindingsCompleted: number;
  infoRequestsClosed: number;
}
