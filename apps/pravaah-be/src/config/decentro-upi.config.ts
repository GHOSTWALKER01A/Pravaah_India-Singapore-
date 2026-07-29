/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  DECENTRO · UPI PAYMENTS — every vendor literal for the DOMESTIC rail.     │
 * │                                                                           │
 * │  Production-SHAPED (Decentro v2 payments module, staging host              │
 * │  `in.staging.decentro.tech`). CONFIRM each path, header and field against  │
 * │  your dashboard's API reference at https://docs.decentro.tech and edit     │
 * │  ONLY this file — the provider, the error mapping, the saga and the        │
 * │  reconciler all stay unchanged.                                           │
 * │                                                                           │
 * │  Kept separate from `decentro.config.ts` (the KYC module) on purpose: the  │
 * │  two are different Decentro products with independent module secrets, and  │
 * │  a shared constants file would invite the KYC secret being sent to a       │
 * │  payments endpoint — which fails as a 401 that looks exactly like a rail   │
 * │  outage.                                                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** Decentro's success responseCode. CONFIRM. */
export const DECENTRO_UPI_SUCCESS_CODE = 'S00000'

/** Endpoint paths, relative to DECENTRO_BASE_URL. CONFIRM each. */
export const DECENTRO_UPI_PATHS = {
  /** Validate a VPA and get the bank-registered name. */
  VPA_VALIDATE: '/v2/payments/vpa/validate',
  /** Raise a collect request against a payer's VPA. */
  COLLECT: '/v2/payments/upi/collection',
  /** Push money to a VPA or an account+IFSC. */
  PAYOUT: '/v2/payments/payout',
  /** Outcome of a payout or a collect. */
  TRANSACTION_STATUS: '/v2/payments/transaction/status',
  /** Return a settled payment. */
  REFUND: '/v2/payments/refund',
  /** UPI AutoPay: create, and present a debit against, an e-mandate. */
  MANDATE_CREATE: '/v2/payments/upi/mandate',
  MANDATE_EXECUTE: '/v2/payments/upi/mandate/execute',
  MANDATE_REVOKE: '/v2/payments/upi/mandate/revoke',
  /** Penny-drop name check for an account+IFSC beneficiary. */
  ACCOUNT_VERIFY: '/v2/banking/account_verification',
} as const

/** Auth header names. CONFIRM casing and spelling. */
export const DECENTRO_UPI_HEADERS = {
  CLIENT_ID: 'client_id',
  CLIENT_SECRET: 'client_secret',
  MODULE_SECRET: 'module_secret',
  /**
   * Decentro's own idempotency header.
   *
   * The reason a retried submit cannot produce two rail-side payments. Our database
   * guard stops a duplicate transaction row; only this stops a duplicate AT THE RAIL
   * when our first request timed out after Decentro had already accepted it. CONFIRM
   * the exact header name — sending it under the wrong one fails open and silently.
   */
  IDEMPOTENCY: 'x-idempotency-key',
} as const

/**
 * Values Decentro uses for a transfer's status. CONFIRM.
 *
 * Anything NOT listed here is treated as unknown, and unknown maps to DEEMED rather
 * than FAILED — see `classifyRailCode`. That default is what stops a vendor adding a
 * status string from causing us to refund senders whose payments settled.
 */
export const DECENTRO_UPI_STATUS = {
  SUCCESS: ['SUCCESS', 'COMPLETED', 'SETTLED'],
  FAILED: ['FAILURE', 'FAILED', 'REJECTED', 'DECLINED'],
  PENDING: ['PENDING', 'IN_PROGRESS', 'INITIATED', 'PROCESSING'],
} as const

/** Transfer types Decentro's payout endpoint accepts. CONFIRM. */
export const DECENTRO_TRANSFER_TYPE = {
  UPI: 'UPI',
  IMPS: 'IMPS',
  NEFT: 'NEFT',
} as const

/** Header carrying the webhook signature. CONFIRM. */
export const DECENTRO_WEBHOOK_SIGNATURE_HEADER = 'x-decentro-signature'
