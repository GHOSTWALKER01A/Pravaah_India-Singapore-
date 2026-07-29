import { RiskTier, ScoreBand } from 'generated/prisma/client'

import type {
  ClaimDocTypeInput,
  InsuranceProductTypeInput,
} from '@pravaah/schema'

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  M5 POLICY — every underwriting and claims literal, in one auditable      │
 * │  place.                                                                   │
 * │                                                                           │
 * │  These are the numbers an insurance regulator, an actuary or a judge will  │
 * │  ask about: "how do you price risk", "when do you decline somebody",      │
 * │  "what stops a forged bill being paid automatically", "how long before a  │
 * │  missed premium voids cover". A multiplier scattered across three         │
 * │  services is a pricing policy nobody can answer for.                      │
 * │                                                                           │
 * │  Nothing here is a tuning knob. Changing a multiplier changes what        │
 * │  somebody pays; changing the tamper threshold changes what gets paid out  │
 * │  without a human ever looking at it.                                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

// ── the pricing model's identity ────────────────────────────────────────────
/**
 * Stamped on every quote, exactly as M2 stamps a model version on every score.
 *
 * A premium is a decision about somebody's money derived from a formula. If the
 * formula changes and old quotes carry no version, then "why was I charged this?"
 * has no answer — the current code would compute a different number and there
 * would be no way to tell whether that is a bug or a repricing.
 */
export const PRICING_MODEL_VERSION = 'uw-1.0.0'

// ── quote lifetime ──────────────────────────────────────────────────────────
/**
 * How long a priced offer stands.
 *
 * Far longer than M4's 90-second FX quote, and for a different reason. An FX
 * quote's window is market exposure measured in seconds; an insurance quote's
 * window is how long an UNDERWRITING DECISION stays valid, and the underlying
 * evidence — a score computed from a month of bank data — does not move in
 * minutes. Thirty minutes is long enough for somebody to read the exclusions,
 * ask a family member, and come back; short enough that a score recomputed
 * overnight cannot be bought against.
 */
export const QUOTE_TTL_MS = 30 * 60 * 1_000

// ── underwriting: band → tier → price ───────────────────────────────────────
/**
 * The band-to-tier map, and the multiplier each tier applies to the product's
 * base rate. `10_000` bps = 1.0×.
 *
 * This table IS the product's differentiator, so it is worth being explicit about
 * what it claims: a person whose consented cash-flow behaviour puts them in
 * EXCELLENT pays 70% of the standard premium for identical cover, and a person in
 * POOR is not sold this cover at all. Both halves matter. Without the discount
 * there is no reason for a good-behaviour customer to bring their data; without
 * the floor the book fills with exactly the risks that made insurers refuse this
 * population in the first place.
 *
 * POOR maps to DECLINE rather than to a very high price, deliberately. A premium
 * high enough to cover a POOR-band risk on income protection would be
 * unaffordable to the person being quoted, so offering it would be a technically
 * available product that functions as a refusal — and takes their money for
 * months before they discover it.
 */
export const BAND_TIER_POLICY: Record<
  ScoreBand,
  { tier: RiskTier; multiplierBps: number }
> = {
  EXCELLENT: { tier: RiskTier.PREFERRED, multiplierBps: 7_000 },
  VERY_GOOD: { tier: RiskTier.PREFERRED, multiplierBps: 8_500 },
  GOOD: { tier: RiskTier.STANDARD, multiplierBps: 10_000 },
  FAIR: { tier: RiskTier.SUBSTANDARD, multiplierBps: 13_000 },
  POOR: { tier: RiskTier.DECLINE, multiplierBps: 0 },
}

/** The tier a STANDARD comparison premium is quoted at. 1.0× the base rate. */
export const STANDARD_MULTIPLIER_BPS = 10_000

/**
 * What a thin file is priced at.
 *
 * A user with no score at all is NOT declined — that would exclude precisely the
 * newly-arrived migrant this product exists for, on their first week in the
 * corridor. They are priced conservatively (1.4×) with a longer waiting period
 * and a lower coverage ceiling, and the quote says so, with a route to a better
 * price once there is history to read.
 */
export const THIN_FILE_POLICY = {
  tier: RiskTier.SUBSTANDARD,
  multiplierBps: 14_000,
  /** Added to the product's own waiting period. */
  extraWaitingDays: 30,
} as const

/**
 * The confidence gate.
 *
 * M2 reports honest uncertainty on every score. A number derived from six weeks
 * of one bank account is not the same evidence as one derived from eighteen
 * months of three, and pricing them identically is how a book fills with risks it
 * never actually measured. So low confidence adds basis points rather than being
 * ignored — the alternative is a discount funded by a guess.
 */
export const CONFIDENCE_PENALTY_BPS = [
  { below: 0.5, penaltyBps: 3_000 },
  { below: 0.75, penaltyBps: 1_500 },
] as const

/**
 * The usage-based nudge: the span, in basis points, that behaviour can move a
 * premium beyond what the band alone decided.
 *
 * This is the "usage-based" half of usage-based insurance. The band is a summary;
 * these two features are the specific behaviours that predict an income-protection
 * claim — regular income means a stable job, and volatile cash flow means the
 * next bad month is closer. ±1500bps (±15%) is deliberately modest: a
 * behaviour term large enough to overwhelm the band would make the price
 * unexplainable, and an unexplainable premium is one nobody can contest.
 */
export const BEHAVIOUR_NUDGE_SPAN_BPS = 1_500

/**
 * The features the nudge reads, and their direction.
 *
 * Read from M2's SHAP factors, which is what keeps M5's pricing consistent with
 * M2's explanation: the same contribution that told the user "your regular
 * income helped your score" is the one that lowers their premium. Two separate
 * behaviour models would eventually tell the user two different stories about the
 * same month of data.
 *
 * NO PROTECTED ATTRIBUTE APPEARS HERE, and none can: M2 never puts them in the
 * feature vector, so there is no SHAP factor for one to read. The fairness
 * guarantee is inherited by construction, not by this file remembering to be
 * careful.
 */
export const BEHAVIOUR_FEATURES = {
  /** A positive contribution LOWERS the premium. */
  favourable: ['income_regularity', 'balance_retention'],
  /** A positive contribution RAISES it. */
  adverse: ['obligation_ratio', 'bounce_count'],
} as const

/**
 * The floor on the effective multiplier.
 *
 * 0.6× the base rate. Without a floor, a stack of favourable adjustments could
 * price cover below the cost of administering a single claim on it, and the
 * cheapest policies would be the ones that lose the most money.
 */
export const MIN_MULTIPLIER_BPS = 6_000

/** The ceiling. Above 2.0× the honest answer is a decline, not a price. */
export const MAX_MULTIPLIER_BPS = 20_000

/** Extra waiting days a SUBSTANDARD risk carries beyond the product's own. */
export const SUBSTANDARD_EXTRA_WAITING_DAYS = 15

/**
 * The coverage ceiling per tier, as a fraction of the product's maximum in bps.
 *
 * The control the user chooses the input to, and therefore the one that needs a
 * server-side cap. A SUBSTANDARD applicant buying the maximum sum insured is
 * adverse selection expressing itself through the one field the applicant
 * controls — so the cap is applied at quote time, with the reduced ceiling shown
 * rather than the request silently clamped.
 */
export const TIER_COVER_CEILING_BPS: Record<RiskTier, number> = {
  PREFERRED: 10_000,
  STANDARD: 10_000,
  SUBSTANDARD: 5_000,
  DECLINE: 0,
}

// ── premium collection and dunning ──────────────────────────────────────────
/** One monthly premium period. Fixed 30 days, so a period key is deterministic. */
export const PREMIUM_PERIOD_DAYS = 30

/**
 * How long a policyholder has after a missed premium before cover ends.
 *
 * Seven days, and the existence of this window is a consumer-protection decision
 * rather than a technical one. A daily-wage earner's premium fails because their
 * wallet was empty on the due date, not because they abandoned the policy —
 * voiding cover that day would mean the people most likely to need a claim are
 * the ones most likely to be uninsured when they do.
 *
 * During GRACE the cover is still LIVE. That is the point of the state, and it is
 * a real cost the book carries: a claim during grace pays out on a premium that
 * has not arrived.
 */
export const GRACE_PERIOD_DAYS = 7

/** Collection attempts per period before the policy is left to lapse. */
export const MAX_PREMIUM_ATTEMPTS = 4

// ── claims ──────────────────────────────────────────────────────────────────
/**
 * The auto-approve ceiling, in minor units, per currency.
 *
 * ₹500 / S$10. Small, on purpose. Auto-approval exists so a genuine small claim
 * is settled in seconds instead of days — which for this user is the difference
 * between the product working and the product being a form they filled in. It is
 * NOT a throughput optimisation, and every additional rupee of ceiling is a
 * rupee that can be taken without a human looking, so the ceiling stays at the
 * value where the fraud loss is smaller than the review cost.
 */
export const AUTO_APPROVE_CEILING_MINOR: Record<string, bigint> = {
  INR: 50_000n,
  SGD: 1_000n,
}

/**
 * The claim risk score at or above which a human MUST decide.
 *
 * Deliberately lower than M4's 0.7 hold threshold. A held payment inconveniences
 * somebody for an hour; an auto-approved fraudulent claim is money gone, and the
 * asymmetry belongs in the threshold rather than in a hope that the signals are
 * good.
 */
export const CLAIM_AUTO_APPROVE_RISK_CEILING = 0.3

/**
 * Forgery likelihood at or above which a document is SUSPECT.
 *
 * A SUSPECT document is a HARD gate: the claim cannot auto-approve, full stop, no
 * matter how small or how low-risk. It is not added to a score that other
 * favourable signals could outweigh, because a forged document is not a
 * probabilistic concern — it is evidence that the claim itself is a fabrication,
 * and a system that could average it away would eventually pay one.
 */
export const TAMPER_BLOCK_THRESHOLD = 0.8

/**
 * OCR confidence below which a document is not auto-verified.
 *
 * A blurry photograph is not a forgery, so it stays UPLOADED with a prompt to
 * retake rather than being marked SUSPECT. Conflating the two would accuse
 * somebody with a cracked phone camera of fraud.
 */
export const OCR_CONFIDENCE_FLOOR = 0.6

/**
 * How far below the claimed amount an extracted amount may sit before it is a
 * mismatch signal, in basis points.
 *
 * 500bps (5%) of tolerance, because a bill total and a claimed amount legitimately
 * differ by a rounding, a co-pay or a line item the claimant excluded. A claim for
 * materially more than the document supports is a different matter and goes to the
 * risk score.
 */
export const AMOUNT_MISMATCH_TOLERANCE_BPS = 500

/**
 * How long a claimant has after an incident to file.
 *
 * Ninety days. Generous, and it has to be: this user may be in a hospital, in
 * another country, or without the phone they installed the app on. An
 * insurer-convenient 30-day window would reject exactly the severe claims the
 * cover exists for.
 */
export const CLAIM_FILING_WINDOW_DAYS = 90

/**
 * How long an INFO_REQUESTED claim waits for the claimant before it is closed.
 *
 * Closed, not rejected — the claim can be re-filed. A claim left open forever is
 * an unbounded liability on the book, and one auto-REJECTED for silence is a
 * decision made against somebody who may never have received the request.
 */
export const INFO_REQUEST_TTL_DAYS = 21

/**
 * The documents a claim must carry before it can be adjudicated at all.
 *
 * The SERVER's list — `EXPECTED_CLAIM_DOCS` in the schema package is the client's
 * guidance for what to ask for. A claim short of these is not rejected; it is
 * held at SUBMITTED with a clear list of what is missing, because a rejection for
 * a missing payslip is a rejection the claimant can fix in ten minutes and should
 * never have received.
 */
export const REQUIRED_CLAIM_DOCS: Record<
  InsuranceProductTypeInput,
  ClaimDocTypeInput[]
> = {
  /** Proof the income actually stopped. Without it there is nothing to protect. */
  INCOME_PROTECTION: ['PAYSLIP'],
  HEALTH_TOPUP: ['MEDICAL_BILL'],
  /** A third-party record of the event, which a self-reported account is not. */
  TRAVEL_ACCIDENT: ['POLICE_FIR'],
}

/** Ceiling on a single uploaded document. Matches the KYC document limit. */
export const MAX_CLAIM_DOC_BYTES = 5 * 1024 * 1024

/** Documents per claim. High enough for a real hospital episode, bounded. */
export const MAX_CLAIM_DOCS = 10

// ── the claim risk hook (M6 seam) ───────────────────────────────────────────
/**
 * The claim fraud signals and what each contributes.
 *
 * Every one is a pattern from real micro-insurance fraud rather than a generic
 * anomaly heuristic — the same discipline `PaymentRiskService` applies to
 * transfers:
 *
 *  - **A claim in the first days after the waiting period ends.** The single
 *    strongest signal in short-tail micro-insurance: somebody who already knew
 *    about the loss waited out the clock.
 *  - **A claim for the entire sum insured.** Genuine losses are rarely exactly
 *    the policy maximum.
 *  - **Velocity across policies.** One person claiming on three covers in a month
 *    is a pattern; one claim is a bad month.
 *  - **A document amount below the claim.** The claimant is asking for more than
 *    their own evidence supports.
 *  - **A brand-new policy.** Cover bought days ago, claimed immediately.
 *  - **A prior rejected claim on the same policy.** Not disqualifying — people
 *    are wrongly rejected — but it belongs in the reviewer's view.
 */
export const CLAIM_RISK_POLICY = {
  /** Days after `waitingPeriodEndsAt` that count as "immediately after". */
  POST_WAITING_WINDOW_DAYS: 7,
  POST_WAITING_WEIGHT: 0.3,

  /** A claim at or above this fraction of cover, in bps. 9500 = 95%. */
  FULL_COVER_BPS: 9_500,
  FULL_COVER_WEIGHT: 0.15,

  VELOCITY_WINDOW_DAYS: 30,
  VELOCITY_CLAIM_COUNT: 2,
  VELOCITY_WEIGHT: 0.25,

  AMOUNT_MISMATCH_WEIGHT: 0.25,

  /** A policy younger than this, claimed on, is worth a look. */
  NEW_POLICY_DAYS: 14,
  NEW_POLICY_WEIGHT: 0.2,

  PRIOR_REJECTION_WEIGHT: 0.15,

  /** No documents at all, on a product that requires them. */
  NO_DOCUMENTS_WEIGHT: 0.2,

  /**
   * A tamper hit does not add a weight — it forces review outright.
   *
   * Recorded here as a constant so the reader sees the asymmetry rather than
   * wondering where the tamper weight went.
   */
  TAMPER_FORCES_REVIEW: true,
} as const

// ── the ledger ──────────────────────────────────────────────────────────────
/**
 * Purpose codes for the two M5 money movements.
 *
 * `INSURANCE_PREMIUM` already exists in M4's `PURPOSE_CODES`; the payout reuses
 * it rather than inventing a code M4's validator does not know, and the direction
 * plus `TxnType` are what distinguish the two legs.
 */
export const INSURANCE_PURPOSE_CODE = 'INSURANCE_PREMIUM'

/** Narration on the wallet statement line. UPI caps this at 50 characters. */
export const PREMIUM_NARRATION = 'Pravaah insurance premium'
export const CLAIM_PAYOUT_NARRATION = 'Pravaah insurance claim payout'
export const PREMIUM_REFUND_NARRATION = 'Pravaah premium refund'

/**
 * The counterparty handle recorded on an M5 transaction.
 *
 * A real address is required on the column, and this is honest about what it is:
 * the money moves between a holder's wallet and the platform's own insurance
 * float, so the counterparty IS Pravaah's book. Inventing a bank handle here
 * would make an internal ledger move look like a rail payment on the user's
 * statement.
 */
export const INSURANCE_BOOK_HANDLE = 'insurance@pravaah'
export const INSURANCE_BOOK_NAME = 'Pravaah Insurance'

// ── lifecycle sweeps ────────────────────────────────────────────────────────
/** Rows a single cron pass will touch. Bounded so one sweep cannot run for ever. */
export const LIFECYCLE_BATCH_SIZE = 200

/**
 * How long a premium or payout transaction may sit mid-saga before the
 * lifecycle sweep resumes it.
 *
 * These are INTERNAL ledger moves with no rail involved, so anything unfinished
 * is a crash between the reserve and the settle — which leaves real money parked
 * in suspense. Two minutes is far longer than the operation takes and short
 * enough that a policyholder's premium is not stuck for an afternoon.
 */
export const STUCK_TRANSACTION_MS = 2 * 60 * 1_000
