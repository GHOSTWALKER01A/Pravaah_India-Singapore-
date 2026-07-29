import type {
  ClaimDecidedBy,
  ClaimDecision,
  ClaimDocStatus,
  ClaimStatus,
  InsuranceProductType,
  InsuranceQuoteStatus,
  InsurerNotice,
  MoneyView,
  PolicyStatus,
  PremiumFrequency,
  RiskTier,
} from './vocabulary';

/**
 * The insurance wire shapes.
 *
 * Every one of these is the server's projection verbatim — no field is renamed and
 * none is derived here. That discipline matters more in M5 than anywhere else in the
 * app, because three of these values are things a claimant is later told they were
 * wrong about: the waiting period, the remaining cover, and whether a document needs
 * re-uploading. A client that recomputed any of them could disagree with the
 * adjudication that actually happens.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Product — the marketplace
   ──────────────────────────────────────────────────────────────────────────── */

export interface CoverageBand {
  /** Digit strings, for the slider's own arithmetic. */
  minMinor: string;
  maxMinor: string;
  min: MoneyView;
  max: MoneyView;
}

/**
 * A cover template. Carries NO premium, and that absence is the product's design.
 *
 * Pricing is personal: two applicants pay different amounts for identical cover, so a
 * marketplace price would either be a lie or an average nobody is offered. The
 * premium appears only on a quote, after underwriting.
 */
export interface InsuranceProduct {
  id: string;
  type: InsuranceProductType;
  /** The admin's name for it. */
  name: string;
  /** The canonical label — "Income Protection". Same across every surface. */
  label: string;
  /** One plain sentence on who this is for. */
  tagline: string | null;
  currency: string;
  coverage: CoverageBand;
  termDays: number;
  waitingPeriodDays: number;
  freeLookDays: number;
  /** Plain-language exclusions. Short sentences, not policy wording. */
  exclusions: string[];
  disclaimer: string;
  nonAdviceDisclaimer: string;
  insurerNotice: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   Quote — the reputation moment
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A priced offer. Short-lived, single-use, and the only thing a policy can be bought
 * from.
 *
 * `standardPremium` and `savingPercent` are the whole pitch rendered as two numbers,
 * and they are computed SERVER-SIDE from the two premiums that were actually quoted.
 * Deriving the comparison on the client from a multiplier would round twice and could
 * show a saving of a paisa in the wrong direction on a small premium.
 */
export interface InsuranceQuote {
  id: string;
  status: InsuranceQuoteStatus;
  /** Whether it can still be bought. False once expired or already converted. */
  isBuyable: boolean;
  validUntil: string;

  product: InsuranceProduct;
  coverage: MoneyView;

  premium: MoneyView;
  frequency: PremiumFrequency;
  /** What a standard-risk applicant pays for identical cover. */
  standardPremium: MoneyView;
  /**
   * Positive is a DISCOUNT. Negative is passed through rather than hidden — a
   * SUBSTANDARD applicant paying more than standard should see that honestly, not a
   * blank where a discount would be.
   */
  savingBps: number;
  savingPercent: number;

  riskTier: RiskTier;
  riskTierLabel: string;
  riskTierExplanation: string | null;
  scoreBand: string | null;
  confidence: number | null;
  pricingModelVersion: string;

  waitingPeriodDays: number;
  /**
   * The DATE cover would begin if bought now, or null when the quote is not buyable.
   *
   * A date rather than a day count, because "30 days" is abstract and the question a
   * claimant asks later is "was I covered on the 14th?".
   */
  coverWouldStartFrom: string | null;

  /** Set only on a DECLINE. Plain language, with the route back to eligibility. */
  declineReason: string | null;
  /** Why the price is what it is, in sentences the applicant can contest. */
  explanation: string[];
  exclusions: string[];
  nonAdviceDisclaimer: string;
  insurerNotice: string;
  insurer: InsurerNotice;
}

/* ────────────────────────────────────────────────────────────────────────────
   Policy — the bound contract
   ──────────────────────────────────────────────────────────────────────────── */

export interface Policy {
  id: string;
  policyNumber: string;
  status: PolicyStatus;
  statusLabel: string;
  /** Whether cover is LIVE right now. True in GRACE — a late premium is not a void one. */
  isCovered: boolean;

  product: {
    id: string;
    type: InsuranceProductType;
    name: string;
    label: string;
  };

  coverage: MoneyView;
  /**
   * Cover LEFT, not cover bought.
   *
   * The aggregate limit a second claim is actually assessed against. A wallet showing
   * only the sum insured would let somebody plan a claim against money already paid.
   */
  remainingCover: MoneyView;
  claimedToDate: MoneyView;

  premium: MoneyView;
  frequency: PremiumFrequency;
  nextPremiumDueAt: string | null;

  startAt: string | null;
  endAt: string | null;
  waitingPeriodEndsAt: string | null;
  /** Days until cover is fully live, or `0`. The thing new policyholders misread. */
  waitingPeriodDaysRemaining: number;
  isInWaitingPeriod: boolean;

  freeLookEndsAt: string | null;
  canCancelForFullRefund: boolean;
  graceEndsAt: string | null;

  insurerPolicyRef: string | null;
  /** The premium settled but the insurer has not acknowledged the binding yet. */
  insurerBindPending: boolean;

  exclusions: string[];
  nonAdviceDisclaimer: string;
  insurerNotice: string;
  createdAt: string;
}

/** One premium period, and what happened to it. */
export interface PremiumPayment {
  id: string;
  amount: MoneyView;
  /** PENDING | PAID | FAILED | REFUNDED. */
  status: string;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  failureReason: string | null;
  attempt: number;
  refunded: MoneyView | null;
  transactionId: string | null;
}

/**
 * What a purchase attempt returned.
 *
 * `collected: false` is the ORDINARY case for this product, not an error: a
 * daily-wage earner's wallet is often short on the day they decide to buy cover. The
 * policy exists at the agreed price, `PENDING_PAYMENT`, and the shortfall says how
 * much to add.
 */
export interface BuyPolicyResult {
  collected: boolean;
  policy: Policy;
  message: string;
  shortfall?: MoneyView | null;
}

export interface CancelPolicyResult {
  policy: Policy;
  refunded: boolean;
  refundAmount: MoneyView | null;
  message: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   Claim
   ──────────────────────────────────────────────────────────────────────────── */

export interface ClaimDocument {
  id: string;
  docType: string;
  status: ClaimDocStatus;
  /**
   * A prompt, not a score.
   *
   * The tamper score itself is deliberately not on the wire: publishing it would tell
   * somebody exactly how altered a document has to be before it passes.
   */
  needsBetterCopy: boolean;
  extractedAmount: MoneyView | null;
  uploadedAt: string;
}

export interface Claim {
  id: string;
  claimNumber: string;
  policyId: string;
  type: InsuranceProductType;
  status: ClaimStatus;
  statusLabel: string;
  /** Whether to stop polling. `APPROVED` is NOT final — the payout has not landed. */
  isFinal: boolean;

  amountClaimed: MoneyView;
  amountApproved: MoneyView | null;

  incidentDate: string;
  description: string;

  decision: ClaimDecision | null;
  decisionReason: string | null;
  /** `SYSTEM` for an auto-approval. A claimant is entitled to know which it was. */
  decidedBy: ClaimDecidedBy | null;
  decidedAt: string | null;
  paidAt: string | null;
  /** Links the payout to its M4 transaction, so the receipt is reachable. */
  payoutTransactionId: string | null;

  documents: ClaimDocument[];
  submittedAt: string;
}

/** What the fraud gate decided when the claimant finished uploading. */
export interface FinaliseClaimResult {
  claim: Claim;
  /** True when the claim settled without a human — small, clean, low-risk. */
  autoApproved: boolean;
  message: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   Requests
   ──────────────────────────────────────────────────────────────────────────── */

export interface QuoteRequest {
  productId: string;
  /** Integer minor units, as a digit string. */
  coverageMinor: string;
}

export interface BuyPolicyRequest {
  quoteId: string;
  /**
   * The premium the user saw, as printed on the button they pressed.
   *
   * A cross-check, not an instruction: the server never charges this number, it
   * refuses to proceed when the quote disagrees. That matters more here than on a
   * transfer, because this is a figure the holder will be debited every month.
   */
  expectedPremiumMinor: string;
  /** Must be `true`. There is no default, on purpose. */
  acceptedDisclaimer: true;
  deviceId?: string;
}

export interface SubmitClaimRequest {
  policyId: string;
  amountClaimedMinor: string;
  /** ISO-8601. The date the waiting-period guard is evaluated against. */
  incidentDate: string;
  description: string;
}
