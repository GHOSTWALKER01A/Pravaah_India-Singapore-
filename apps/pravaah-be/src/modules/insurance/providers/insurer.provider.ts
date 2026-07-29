import type { Result } from '@/common/result/result'

/**
 * The insurer rail.
 *
 * M5's provider-swap seam, the same shape M0 uses for KYC rails, M1 for Account
 * Aggregators and M4 for payment rails. Everything above this interface — pricing,
 * the policy lifecycle, the claims state machine, the ledger — is ours and stays
 * ours. What sits behind it is the regulated entity that actually carries the risk.
 *
 * ## What is honestly ours and what is not
 *
 * Pravaah is not, and in a 12-day build cannot be, an IRDAI-licensed insurer or
 * intermediary. So the split is drawn explicitly:
 *
 *  - **OURS, and real:** the underwriting decision (priced off M2), the policy
 *    lifecycle, the waiting-period and coverage controls, the claims workflow with
 *    OCR and a fraud gate, and the money — premiums and payouts post to the live
 *    double-entry ledger M4 built.
 *  - **THEIRS, and mocked today:** binding the contract and carrying the risk.
 *    {@link MockInsurerProvider} answers deterministically. Production is Acko,
 *    Digit or a sponsor insurer behind this same interface, reached under a
 *    corporate-agent or Insurance Marketing Firm arrangement.
 *
 * Stating that boundary is not a disclaimer bolted on for a demo — it is what makes
 * the architecture credible. An insurer's integration team can read this interface
 * and see exactly which four calls they would have to answer.
 *
 * ## Why binding is allowed to fail without blocking activation
 *
 * `bindPolicy` returns a `Result`, and `PolicyService` activates the policy even
 * when it errors, leaving `insurerPolicyRef` null for a later sweep. That looks
 * wrong and is deliberate: the premium has already SETTLED on the ledger by that
 * point. Refusing to activate would leave a policyholder who has paid, holding no
 * cover, because a third party's API was down — and the reconciliation of a
 * missing reference is a problem for our operations team, not for somebody who
 * bought income protection this morning.
 */
export const INSURER = Symbol('INSURER')

export interface BindPolicyInput {
  /** `INCOME_PROTECTION` | `HEALTH_TOPUP` | `TRAVEL_ACCIDENT`. */
  productType: string
  coverageMinor: bigint
  currency: string
  /**
   * The holder, as the INSURER may know them.
   *
   * Our `pravaahId` (`PVH-XXXX-XXXX-XXXX`), never the internal UUID and never a
   * name or a document number. A real insurer needs the holder's identity for
   * underwriting, but that exchange belongs in a data-sharing agreement with a
   * lawful basis — not smuggled through a policy-binding call.
   */
  holderRef: string
  policyNumber: string
  termDays: number
  waitingPeriodDays: number
  premiumMinor: bigint
  /** The risk tier we priced at, so a real insurer can accept or re-rate it. */
  riskTier: string
}

export interface SubmitClaimInput {
  insurerPolicyRef: string
  claimNumber: string
  amountMinor: bigint
  currency: string
  /** ISO-8601. The date the waiting-period guard was evaluated against. */
  incidentDate: string
  description: string
}

/**
 * A normalised insurer-side claim status.
 *
 * Normalised rather than passed through verbatim, for the reason M4 normalises
 * rail codes: every insurer names these differently, and a claims state machine
 * that branched on vendor strings would need editing for each new partner.
 */
export type InsurerClaimStatus =
  'RECEIVED' | 'IN_ASSESSMENT' | 'APPROVED' | 'REJECTED' | 'SETTLED' | 'UNKNOWN'

export interface InsurerProvider {
  /** A stable name, persisted on the policy so a webhook routes back correctly. */
  readonly name: string

  /** Whether this provider has the credentials it needs to be selected. */
  isConfigured(): boolean

  /** Bind the contract at the insurer. Failure leaves `insurerPolicyRef` null. */
  bindPolicy(
    input: BindPolicyInput,
  ): Promise<Result<{ insurerPolicyRef: string }>>

  /**
   * Notify the insurer of a claim.
   *
   * A NOTIFICATION, not a request for permission. Our own adjudication decides
   * whether the claimant is paid, because a claims workflow that blocked on a
   * third party would leave somebody with a hospital bill waiting on an
   * integration. When a real insurer carries the risk, their adjudication becomes
   * authoritative and arrives through {@link verifyWebhook}.
   */
  submitClaim(
    input: SubmitClaimInput,
  ): Promise<Result<{ insurerClaimRef: string; status: InsurerClaimStatus }>>

  getClaimStatus(
    insurerClaimRef: string,
  ): Promise<Result<{ status: InsurerClaimStatus }>>

  /**
   * Verify a callback's HMAC over the RAW BYTES.
   *
   * Raw bytes, never a re-serialised object: `JSON.stringify(req.body)` reorders
   * keys and drops whitespace, so it verifies a different message than the one
   * that was signed. That check fails on every legitimate webhook and gets
   * "fixed" by deleting it.
   */
  verifyWebhook(headers: Record<string, unknown>, rawBody: string): boolean

  /** Parse a verified callback into something the claims service can act on. */
  parseWebhook(body: unknown): InsurerWebhookEvent | null
}

/** A verified, parsed insurer callback. */
export interface InsurerWebhookEvent {
  /** Replay-dedupe key, unique per provider. */
  eventId: string
  kind: 'CLAIM_STATUS' | 'POLICY_STATUS'
  insurerClaimRef?: string | null
  insurerPolicyRef?: string | null
  status: InsurerClaimStatus
  /** The insurer's own approved amount, when they adjudicate. Minor units. */
  approvedMinor?: bigint | null
  reason?: string | null
}
