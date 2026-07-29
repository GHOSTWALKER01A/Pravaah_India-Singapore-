import type { Result } from '@/common/result/result'

import type { BeneficiaryHandleType } from 'generated/prisma/client'

/**
 * The rail abstraction.
 *
 * DI tokens per corridor rather than one, because the two corridors are not
 * interchangeable implementations of one thing — they are different rails with
 * different capabilities. The domestic one supports collect and AutoPay; the
 * cross-border linkage is payer-initiated only and supports neither. Expressing that
 * as optional methods on a shared interface (rather than one interface that pretends
 * both can do everything) is what lets `supportsCollect` be a compile-time-visible
 * fact instead of a runtime surprise after the user has been debited.
 *
 * Errors come back inside {@link Result} rather than thrown, because the orchestrator
 * must branch on `retryable` to decide between releasing a reserve and holding it. A
 * thrown exception flattens "the rail said no" and "the rail did not answer" into one
 * control-flow path, and those two must never be treated alike.
 *
 * The error taxonomy is the shared `KycError`, which is transport-agnostic despite the
 * name — it is what `httpJson` already returns, and a parallel payments-only type
 * would mean re-implementing the retry/backoff client to carry it.
 */
export const DOMESTIC_PAYMENT_PROVIDER = Symbol('DOMESTIC_PAYMENT_PROVIDER')
export const CROSS_BORDER_PAYMENT_PROVIDER = Symbol(
  'CROSS_BORDER_PAYMENT_PROVIDER',
)

// ── name resolution ─────────────────────────────────────────────────────────
export interface ResolveHandleInput {
  handle: string
  handleType: BeneficiaryHandleType
  traceId: string
}

export interface ResolveHandleOutput {
  /**
   * The name the payee's bank holds.
   *
   * NPCI requires this be shown to the payer before they authorise. It is the single
   * most effective defence against social-engineering fraud, because the attacker
   * controls the address string but not what the bank calls the account behind it.
   */
  registeredName: string | null
  /** Whether the address exists and can receive money at all. */
  reachable: boolean
  /** Why not, in words a user can act on. */
  reason?: string
  /** The payee's bank, when the rail tells us. Shown alongside the name. */
  bankName?: string
}

// ── payout (push) ───────────────────────────────────────────────────────────
export interface SubmitPayoutInput {
  /**
   * Passed straight through to the rail as ITS idempotency key.
   *
   * The reason a retried submit cannot produce two rail-side payments. Our own
   * database guard stops a duplicate transaction; only this stops a duplicate at the
   * rail when our first request timed out after the rail had accepted it.
   */
  idempotencyKey: string
  transactionId: string
  payeeHandle: string
  payeeHandleType: BeneficiaryHandleType
  payeeName?: string | null
  /** Minor units of `currency` — what the payee receives. */
  amountMinor: bigint
  currency: string
  purposeCode: string
  narration?: string | null
  /** Merchant Category Code, for P2M. */
  mcc?: string | null
  /** The payer's own VPA, when the rail wants it on the message. */
  payerVpa?: string | null
  traceId: string
}

export interface SubmitPayoutOutput {
  /** The provider's own transaction id. */
  railRef: string
  /**
   * The UTR / RRN — the reference a user quotes to their bank, and the only one both
   * PSPs and the payee's bank recognise. Often absent until settlement.
   */
  utr?: string
  /**
   * What the rail says right now. `SUBMITTED` means accepted with no outcome yet;
   * `PENDING` means it is settling. Neither is a success.
   */
  status: 'SUCCESS' | 'PENDING' | 'SUBMITTED'
  railCode?: string
}

// ── status ──────────────────────────────────────────────────────────────────
export interface RailStatusOutput {
  status: 'SUCCESS' | 'FAILED' | 'PENDING'
  railCode?: string
  utr?: string
  /**
   * The amount the rail believes it moved.
   *
   * Compared against ours during reconciliation. A rail that settled a DIFFERENT
   * amount than we asked for is rare and severe, and it is invisible unless the figure
   * is carried back and checked.
   */
  amountMinor?: bigint
  settledAt?: Date
}

// ── refund ──────────────────────────────────────────────────────────────────
export interface RefundInput {
  idempotencyKey: string
  originalRailRef: string
  amountMinor: bigint
  currency: string
  reason: string
  traceId: string
}

export interface RefundOutput {
  railRef: string
  status: 'SUCCESS' | 'PENDING' | 'SUBMITTED'
}

// ── collect (pull) ──────────────────────────────────────────────────────────
export interface CollectInput {
  idempotencyKey: string
  collectRequestId: string
  payerHandle: string
  payeeVpa: string
  payeeName: string
  amountMinor: bigint
  currency: string
  purposeCode: string
  narration?: string | null
  expiresAt: Date
  traceId: string
}

export interface CollectOutput {
  railRef: string
  status: 'CREATED' | 'PENDING'
}

// ── mandate (UPI AutoPay) ───────────────────────────────────────────────────
export interface CreateMandateInput {
  idempotencyKey: string
  mandateId: string
  mandateRef: string
  payerVpa: string
  payeeHandle: string
  payeeName: string
  maxAmountMinor: bigint
  currency: string
  frequency: string
  amountRule: string
  validFrom: Date
  validUntil: Date
  purposeCode: string
  narration?: string | null
  traceId: string
}

export interface CreateMandateOutput {
  railRef: string
  /** The UPI Mandate Number. Absent until the payer approves. */
  umn?: string
  status: 'CREATED' | 'PENDING'
  /** Where to send the payer to authorise it. */
  approvalUrl?: string
}

export interface ExecuteMandateInput {
  idempotencyKey: string
  mandateRailRef: string
  umn?: string | null
  executionId: string
  amountMinor: bigint
  currency: string
  narration?: string | null
  traceId: string
}

// ── webhooks ────────────────────────────────────────────────────────────────
/**
 * A rail event, normalised.
 *
 * Every provider's webhook shape collapses to this before anything downstream sees
 * it, so the settlement logic is written once. A handler that branched on the
 * provider's raw body would need the whole state machine duplicated per vendor.
 */
export interface RailWebhookEvent {
  /** The provider's event id. The replay-dedupe key. */
  eventId: string
  kind: 'payment' | 'refund' | 'collect' | 'mandate'
  railRef?: string
  utr?: string
  status: 'SUCCESS' | 'FAILED' | 'PENDING'
  railCode?: string
  amountMinor?: bigint
  currency?: string
  /** For collect/mandate events, the rail's reference for that object. */
  objectRef?: string
}

export interface PaymentProvider {
  readonly name: string

  /**
   * Whether this provider has the credentials it needs.
   *
   * Checked at wiring time so a provider missing its secrets is never silently
   * selected — a live provider that 401s on every call looks exactly like a rail
   * outage, and the operator spends the incident debugging the wrong thing.
   */
  isConfigured(): boolean

  resolveHandle(input: ResolveHandleInput): Promise<Result<ResolveHandleOutput>>
  submitPayout(input: SubmitPayoutInput): Promise<Result<SubmitPayoutOutput>>
  status(railRef: string, traceId: string): Promise<Result<RailStatusOutput>>
  refund(input: RefundInput): Promise<Result<RefundOutput>>

  /** Domestic only — the cross-border linkage is payer-initiated. */
  createCollect?(input: CollectInput): Promise<Result<CollectOutput>>
  /** Domestic only — there is no cross-border AutoPay. */
  createMandate?(
    input: CreateMandateInput,
  ): Promise<Result<CreateMandateOutput>>
  executeMandate?(
    input: ExecuteMandateInput,
  ): Promise<Result<SubmitPayoutOutput>>
  revokeMandate?(railRef: string, traceId: string): Promise<Result<void>>

  verifyWebhook(headers: Record<string, unknown>, rawBody: string): boolean
  parseWebhook(body: unknown): RailWebhookEvent | null
}
