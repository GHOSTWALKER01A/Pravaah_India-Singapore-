import { z } from 'zod'

/**
 * M4 · Cross-border money movement enums. Each mirrors a Prisma enum so the RN
 * app, the admin console, and the backend validate against one source of truth.
 *
 * These are not free-form strings anywhere in the product. A corridor or a status
 * that only *mostly* matches the database is how a limit check ends up running
 * against the wrong rail.
 */

/** Which rail's rulebook applies. The caps differ by ~60×, so this is never inferred twice. */
export const CORRIDOR = {
  DOMESTIC: 'DOMESTIC',
  CROSS_BORDER: 'CROSS_BORDER',
} as const

export const CorridorSchema = z.enum([
  CORRIDOR.DOMESTIC,
  CORRIDOR.CROSS_BORDER,
])
export type CorridorInput = z.infer<typeof CorridorSchema>

export const PAYMENT_RAIL = {
  UPI: 'UPI',
  UPI_PAYNOW: 'UPI_PAYNOW',
  INTERNAL: 'INTERNAL',
} as const

export const PaymentRailSchema = z.enum([
  PAYMENT_RAIL.UPI,
  PAYMENT_RAIL.UPI_PAYNOW,
  PAYMENT_RAIL.INTERNAL,
])
export type PaymentRailInput = z.infer<typeof PaymentRailSchema>

export const TXN_TYPE = {
  P2P: 'P2P',
  P2M: 'P2M',
  REMITTANCE: 'REMITTANCE',
  DISBURSAL: 'DISBURSAL',
  REPAYMENT: 'REPAYMENT',
  PREMIUM: 'PREMIUM',
  TOPUP: 'TOPUP',
  WITHDRAWAL: 'WITHDRAWAL',
} as const

export const TxnTypeSchema = z.enum([
  TXN_TYPE.P2P,
  TXN_TYPE.P2M,
  TXN_TYPE.REMITTANCE,
  TXN_TYPE.DISBURSAL,
  TXN_TYPE.REPAYMENT,
  TXN_TYPE.PREMIUM,
  TXN_TYPE.TOPUP,
  TXN_TYPE.WITHDRAWAL,
])
export type TxnTypeInput = z.infer<typeof TxnTypeSchema>

/**
 * The types a client may ask for directly.
 *
 * TOPUP and WITHDRAWAL are excluded because they have their own endpoints with
 * their own guards — a topup's counterparty must be the user's OWN account, and
 * letting it arrive through the generic transfer route would route it past that
 * check.
 */
export const TransferTypeSchema = z.enum([
  TXN_TYPE.P2P,
  TXN_TYPE.P2M,
  TXN_TYPE.REMITTANCE,
  TXN_TYPE.DISBURSAL,
  TXN_TYPE.REPAYMENT,
  TXN_TYPE.PREMIUM,
])
export type TransferTypeInput = z.infer<typeof TransferTypeSchema>

export const TXN_DIRECTION = {
  OUTBOUND: 'OUTBOUND',
  INBOUND: 'INBOUND',
} as const

export const TxnDirectionSchema = z.enum([
  TXN_DIRECTION.OUTBOUND,
  TXN_DIRECTION.INBOUND,
])
export type TxnDirectionInput = z.infer<typeof TxnDirectionSchema>

/**
 * The saga's states.
 *
 *   INITIATED          accepted, nothing validated yet
 *   VALIDATED          limits, beneficiary, quote and name-confirm all cleared
 *   RISK_HELD          scored high; a human or a step-up must release it
 *   AWAITING_APPROVAL  a collect the payer must approve in their own PSP app
 *   RESERVED           the sender's funds are locked in suspense
 *   SUBMITTED          handed to the rail
 *   PENDING            the rail accepted it and is settling
 *   SUCCESS            settlement confirmed; the ledger is closed out
 *   FAILED             the rail rejected it — NOT terminal, see DEEMED below
 *   REVERSED           a pre-settlement failure; the reserve went back
 *   REFUNDED           a post-settlement return of the full amount
 *   PARTIALLY_REFUNDED part of a settled amount was returned
 *   EXPIRED            nobody acted in time (an unanswered collect)
 *   DEEMED             the rail never gave a final answer
 *
 * DEEMED is the one worth reading twice. It is NOT a synonym for FAILED: the
 * funds stay in suspense and a human decides, because "we do not know" released
 * as "failed" is precisely how money gets paid twice.
 */
export const TXN_STATUS = {
  INITIATED: 'INITIATED',
  VALIDATED: 'VALIDATED',
  RISK_HELD: 'RISK_HELD',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  RESERVED: 'RESERVED',
  SUBMITTED: 'SUBMITTED',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  EXPIRED: 'EXPIRED',
  DEEMED: 'DEEMED',
} as const

export const TxnStatusSchema = z.enum([
  TXN_STATUS.INITIATED,
  TXN_STATUS.VALIDATED,
  TXN_STATUS.RISK_HELD,
  TXN_STATUS.AWAITING_APPROVAL,
  TXN_STATUS.RESERVED,
  TXN_STATUS.SUBMITTED,
  TXN_STATUS.PENDING,
  TXN_STATUS.SUCCESS,
  TXN_STATUS.FAILED,
  TXN_STATUS.REVERSED,
  TXN_STATUS.REFUNDED,
  TXN_STATUS.PARTIALLY_REFUNDED,
  TXN_STATUS.EXPIRED,
  TXN_STATUS.DEEMED,
])
export type TxnStatusInput = z.infer<typeof TxnStatusSchema>

export const LEDGER_DIRECTION = { DEBIT: 'DEBIT', CREDIT: 'CREDIT' } as const

export const LedgerDirectionSchema = z.enum([
  LEDGER_DIRECTION.DEBIT,
  LEDGER_DIRECTION.CREDIT,
])
export type LedgerDirectionInput = z.infer<typeof LedgerDirectionSchema>

export const ACCOUNT_TYPE = {
  USER_WALLET: 'USER_WALLET',
  PLATFORM_NOSTRO: 'PLATFORM_NOSTRO',
  PLATFORM_FEE: 'PLATFORM_FEE',
  FX_POSITION: 'FX_POSITION',
  SUSPENSE: 'SUSPENSE',
  EXTERNAL: 'EXTERNAL',
  RECEIVABLE: 'RECEIVABLE',
} as const

export const AccountTypeSchema = z.enum([
  ACCOUNT_TYPE.USER_WALLET,
  ACCOUNT_TYPE.PLATFORM_NOSTRO,
  ACCOUNT_TYPE.PLATFORM_FEE,
  ACCOUNT_TYPE.FX_POSITION,
  ACCOUNT_TYPE.SUSPENSE,
  ACCOUNT_TYPE.EXTERNAL,
  ACCOUNT_TYPE.RECEIVABLE,
])
export type AccountTypeInput = z.infer<typeof AccountTypeSchema>

/**
 * Which leg of the saga posted a ledger entry.
 *
 * This is the vocabulary that makes an append-only ledger readable during an incident. A single
 * netted "amount" per payment would answer nothing; `RESERVE`, `FEE`, `FX_OUT`, `FX_IN` and
 * `PAYOUT` as separate timestamped facts are how you reconstruct what actually happened, and both
 * the statement screen and the admin console render these names verbatim.
 *
 * `RECOVERY` is the one worth reading twice: it books a receivable when a payment we had already
 * refunded turns out to have settled at the rail. It is how a late settlement becomes a tracked
 * debt rather than a broken trial balance.
 */
export const LEDGER_LEG = {
  RESERVE: 'RESERVE',
  FEE: 'FEE',
  TAX: 'TAX',
  FX_OUT: 'FX_OUT',
  FX_IN: 'FX_IN',
  PAYOUT: 'PAYOUT',
  REVERSE: 'REVERSE',
  REFUND: 'REFUND',
  TOPUP: 'TOPUP',
  WITHDRAW: 'WITHDRAW',
  RECOVERY: 'RECOVERY',
  ADJUSTMENT: 'ADJUSTMENT',
} as const

export const LedgerLegSchema = z.enum([
  LEDGER_LEG.RESERVE,
  LEDGER_LEG.FEE,
  LEDGER_LEG.TAX,
  LEDGER_LEG.FX_OUT,
  LEDGER_LEG.FX_IN,
  LEDGER_LEG.PAYOUT,
  LEDGER_LEG.REVERSE,
  LEDGER_LEG.REFUND,
  LEDGER_LEG.TOPUP,
  LEDGER_LEG.WITHDRAW,
  LEDGER_LEG.RECOVERY,
  LEDGER_LEG.ADJUSTMENT,
])
export type LedgerLegInput = z.infer<typeof LedgerLegSchema>

export const BENEFICIARY_STATUS = {
  UNVERIFIED: 'UNVERIFIED',
  VERIFIED: 'VERIFIED',
  INVALID: 'INVALID',
  BLOCKED: 'BLOCKED',
} as const

export const BeneficiaryStatusSchema = z.enum([
  BENEFICIARY_STATUS.UNVERIFIED,
  BENEFICIARY_STATUS.VERIFIED,
  BENEFICIARY_STATUS.INVALID,
  BENEFICIARY_STATUS.BLOCKED,
])
export type BeneficiaryStatusInput = z.infer<typeof BeneficiaryStatusSchema>

export const BENEFICIARY_HANDLE_TYPE = {
  UPI_VPA: 'UPI_VPA',
  ACCOUNT_IFSC: 'ACCOUNT_IFSC',
  PAYNOW_UPI: 'PAYNOW_UPI',
} as const

export const BeneficiaryHandleTypeSchema = z.enum([
  BENEFICIARY_HANDLE_TYPE.UPI_VPA,
  BENEFICIARY_HANDLE_TYPE.ACCOUNT_IFSC,
  BENEFICIARY_HANDLE_TYPE.PAYNOW_UPI,
])
export type BeneficiaryHandleTypeInput = z.infer<
  typeof BeneficiaryHandleTypeSchema
>

export const COLLECT_STATUS = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  REVOKED: 'REVOKED',
} as const

export const CollectStatusSchema = z.enum([
  COLLECT_STATUS.CREATED,
  COLLECT_STATUS.PENDING,
  COLLECT_STATUS.APPROVED,
  COLLECT_STATUS.DECLINED,
  COLLECT_STATUS.EXPIRED,
  COLLECT_STATUS.FAILED,
  COLLECT_STATUS.REVOKED,
])
export type CollectStatusInput = z.infer<typeof CollectStatusSchema>

export const MANDATE_STATUS = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  REVOKED: 'REVOKED',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
} as const

export const MandateStatusSchema = z.enum([
  MANDATE_STATUS.CREATED,
  MANDATE_STATUS.PENDING,
  MANDATE_STATUS.ACTIVE,
  MANDATE_STATUS.PAUSED,
  MANDATE_STATUS.REVOKED,
  MANDATE_STATUS.COMPLETED,
  MANDATE_STATUS.EXPIRED,
  MANDATE_STATUS.FAILED,
])
export type MandateStatusInput = z.infer<typeof MandateStatusSchema>

/** UPI AutoPay recurrence rules, exactly as NPCI defines them. */
export const MANDATE_FREQUENCY = {
  ONETIME: 'ONETIME',
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  FORTNIGHTLY: 'FORTNIGHTLY',
  MONTHLY: 'MONTHLY',
  BIMONTHLY: 'BIMONTHLY',
  QUARTERLY: 'QUARTERLY',
  HALFYEARLY: 'HALFYEARLY',
  YEARLY: 'YEARLY',
  AS_PRESENTED: 'AS_PRESENTED',
} as const

export const MandateFrequencySchema = z.enum([
  MANDATE_FREQUENCY.ONETIME,
  MANDATE_FREQUENCY.DAILY,
  MANDATE_FREQUENCY.WEEKLY,
  MANDATE_FREQUENCY.FORTNIGHTLY,
  MANDATE_FREQUENCY.MONTHLY,
  MANDATE_FREQUENCY.BIMONTHLY,
  MANDATE_FREQUENCY.QUARTERLY,
  MANDATE_FREQUENCY.HALFYEARLY,
  MANDATE_FREQUENCY.YEARLY,
  MANDATE_FREQUENCY.AS_PRESENTED,
])
export type MandateFrequencyInput = z.infer<typeof MandateFrequencySchema>

export const MANDATE_AMOUNT_RULE = { EXACT: 'EXACT', MAX: 'MAX' } as const

export const MandateAmountRuleSchema = z.enum([
  MANDATE_AMOUNT_RULE.EXACT,
  MANDATE_AMOUNT_RULE.MAX,
])
export type MandateAmountRuleInput = z.infer<typeof MandateAmountRuleSchema>

export const MANDATE_EXECUTION_STATUS = {
  SCHEDULED: 'SCHEDULED',
  NOTIFIED: 'NOTIFIED',
  DEBITED: 'DEBITED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const

export const MandateExecutionStatusSchema = z.enum([
  MANDATE_EXECUTION_STATUS.SCHEDULED,
  MANDATE_EXECUTION_STATUS.NOTIFIED,
  MANDATE_EXECUTION_STATUS.DEBITED,
  MANDATE_EXECUTION_STATUS.FAILED,
  MANDATE_EXECUTION_STATUS.SKIPPED,
])
export type MandateExecutionStatusInput = z.infer<
  typeof MandateExecutionStatusSchema
>

/** UDIR — the dispute categories a customer would actually describe. */
export const DISPUTE_KIND = {
  NOT_CREDITED: 'NOT_CREDITED',
  DUPLICATE_DEBIT: 'DUPLICATE_DEBIT',
  WRONG_BENEFICIARY: 'WRONG_BENEFICIARY',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  UNAUTHORISED: 'UNAUTHORISED',
  CHARGEBACK: 'CHARGEBACK',
} as const

export const DisputeKindSchema = z.enum([
  DISPUTE_KIND.NOT_CREDITED,
  DISPUTE_KIND.DUPLICATE_DEBIT,
  DISPUTE_KIND.WRONG_BENEFICIARY,
  DISPUTE_KIND.AMOUNT_MISMATCH,
  DISPUTE_KIND.UNAUTHORISED,
  DISPUTE_KIND.CHARGEBACK,
])
export type DisputeKindInput = z.infer<typeof DisputeKindSchema>

export const DISPUTE_STATUS = {
  OPEN: 'OPEN',
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLVED_CREDITED: 'RESOLVED_CREDITED',
  RESOLVED_REJECTED: 'RESOLVED_REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const

export const DisputeStatusSchema = z.enum([
  DISPUTE_STATUS.OPEN,
  DISPUTE_STATUS.UNDER_REVIEW,
  DISPUTE_STATUS.RESOLVED_CREDITED,
  DISPUTE_STATUS.RESOLVED_REJECTED,
  DISPUTE_STATUS.WITHDRAWN,
])
export type DisputeStatusInput = z.infer<typeof DisputeStatusSchema>

export const QR_KIND = { STATIC: 'STATIC', DYNAMIC: 'DYNAMIC' } as const

export const QrKindSchema = z.enum([QR_KIND.STATIC, QR_KIND.DYNAMIC])
export type QrKindInput = z.infer<typeof QrKindSchema>

export const REVERSAL_KIND = {
  RESERVE_RELEASE: 'RESERVE_RELEASE',
  REFUND: 'REFUND',
  PARTIAL_REFUND: 'PARTIAL_REFUND',
  CHARGEBACK: 'CHARGEBACK',
} as const

export const ReversalKindSchema = z.enum([
  REVERSAL_KIND.RESERVE_RELEASE,
  REVERSAL_KIND.REFUND,
  REVERSAL_KIND.PARTIAL_REFUND,
  REVERSAL_KIND.CHARGEBACK,
])
export type ReversalKindInput = z.infer<typeof ReversalKindSchema>

export const RECON_STATUS = {
  MATCHED: 'MATCHED',
  MISMATCH: 'MISMATCH',
  RESOLVED: 'RESOLVED',
  ESCALATED: 'ESCALATED',
} as const

export const ReconStatusSchema = z.enum([
  RECON_STATUS.MATCHED,
  RECON_STATUS.MISMATCH,
  RECON_STATUS.RESOLVED,
  RECON_STATUS.ESCALATED,
])
export type ReconStatusInput = z.infer<typeof ReconStatusSchema>

export const UPI_HANDLE_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  DEACTIVATED: 'DEACTIVATED',
  BLOCKED: 'BLOCKED',
} as const

export const UpiHandleStatusSchema = z.enum([
  UPI_HANDLE_STATUS.PENDING,
  UPI_HANDLE_STATUS.ACTIVE,
  UPI_HANDLE_STATUS.DEACTIVATED,
  UPI_HANDLE_STATUS.BLOCKED,
])
export type UpiHandleStatusInput = z.infer<typeof UpiHandleStatusSchema>

export const LIMIT_WINDOW = {
  DAY: 'DAY',
  MONTH: 'MONTH',
  YEAR: 'YEAR',
  ROLLING_24H: 'ROLLING_24H',
} as const

export const LimitWindowSchema = z.enum([
  LIMIT_WINDOW.DAY,
  LIMIT_WINDOW.MONTH,
  LIMIT_WINDOW.YEAR,
  LIMIT_WINDOW.ROLLING_24H,
])
export type LimitWindowInput = z.infer<typeof LimitWindowSchema>

export const LIMIT_SCOPE = { VALUE: 'VALUE', COUNT: 'COUNT' } as const

export const LimitScopeSchema = z.enum([LIMIT_SCOPE.VALUE, LIMIT_SCOPE.COUNT])
export type LimitScopeInput = z.infer<typeof LimitScopeSchema>
