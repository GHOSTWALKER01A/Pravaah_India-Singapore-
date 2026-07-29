/**
 * M4 routes.
 *
 * Grouped by AUDIENCE rather than by entity, and the split is load-bearing: the holder API,
 * the rail's callbacks, the mock rail and the admin console each carry a different guard, and
 * co-locating them is how a guard ends up applied to the wrong half.
 */
export const PAYMENT_ROUTES = {
  BASE: 'payments',

  /** Balances, limits and UPI handles — the wallet screen, in one call. */
  WALLET: 'wallet',
  /** Ledger-derived account statement. What actually happened to the money. */
  STATEMENT: 'wallet/statement',
  /** Corridor caps and how much of each remains today. */
  LIMITS: 'limits',

  /** The user's own UPI addresses. */
  HANDLES: 'upi-handles',
  HANDLE_PRIMARY: 'upi-handles/:id/primary',
  HANDLE_DEACTIVATE: 'upi-handles/:id/deactivate',

  /** A locked, single-use price. Every transfer is submitted against one. */
  QUOTE: 'quote',

  /** Add money (a collect against the user's own account) and withdraw to bank. */
  TOPUP: 'topup',
  WITHDRAW: 'withdraw',
}

export const BENEFICIARY_ROUTES = {
  BASE: 'payments/beneficiaries',
  LIST: '',
  ADD: '',
  /**
   * Resolve a UPI ID to its bank-registered name WITHOUT moving money.
   *
   * Its own route because it must happen before the decision it informs — folded into the
   * transfer call, the name would arrive after the user had already committed.
   */
  RESOLVE: 'resolve',
  /**
   * Resolve a MOBILE NUMBER to payable addresses.
   *
   * Separate from `RESOLVE` because it is a search rather than a lookup: an Indian mobile has no
   * directory entry, so this probes `<number>@<psp>` candidates and can return several answers or
   * none. One route returning either "the name at this address" or "a list of addresses" would make
   * the response shape depend on the input format.
   */
  RESOLVE_MOBILE: 'resolve-mobile',
  DETAIL: ':id',
  REVERIFY: ':id/reverify',
  BLOCK: ':id/block',
  UNBLOCK: ':id/unblock',
  REMOVE: ':id',
}

export const TRANSFER_ROUTES = {
  BASE: 'payments/transfers',
  CREATE: '',
  LIST: '',
  /** The client polls OUR status, never the rail's. */
  DETAIL: ':id',
  RECEIPT: ':id/receipt',
  RETRY: ':id/retry',
  /**
   * Answer the M6 step-up on a transfer parked in `RISK_HELD`.
   *
   * Its own route rather than a repeat of CREATE: the transfer already exists at a priced
   * quote that has been consumed, so re-creating would send the payer back through pricing
   * at a rate that may have moved — and would burn a second quote.
   */
  CONFIRM_STEP_UP: ':id/confirm',
  /**
   * Re-issue a lapsed step-up on a held transfer.
   *
   * ## Why this route has to exist
   *
   * A challenge lives five minutes, and `pendingFor` reports only live ones. So a user who left
   * the app mid-confirmation came back to a transfer sitting in `RISK_HELD` with `stepUp: null`
   * — indistinguishable from an analyst hold, showing "we're reviewing this payment", with no
   * route out and money reserved against nothing. The gap predates the PIN work and the PIN
   * makes it far more likely to be hit: a PIN prompt shows no countdown, so users WILL let it
   * lapse.
   *
   * ## Why user-initiated rather than automatic
   *
   * The obvious fix is for the detail endpoint to re-issue whenever it finds none — and that
   * endpoint is POLLED. On an OTP challenge that is an SMS every five minutes per held transfer,
   * triggered by a client that is merely open. Making it an explicit action means one code per
   * tap, by somebody who asked for it.
   */
  REQUEST_STEP_UP: ':id/confirm/request',
  /** UDIR — raise a dispute against a payment. */
  DISPUTE: ':id/dispute',
}

export const COLLECT_ROUTES = {
  BASE: 'payments/collect',
  CREATE: '',
  LIST: '',
  DETAIL: ':id',
  REVOKE: ':id/revoke',
}

export const QR_ROUTES = {
  BASE: 'payments/qr',
  CREATE: '',
  LIST: '',
  /** Decode a scanned payload. Parsed server-side, so one parser decides who gets paid. */
  SCAN: 'scan',
  PAY: 'pay',
  DEACTIVATE: ':id/deactivate',
}

export const MANDATE_ROUTES = {
  BASE: 'payments/mandates',
  CREATE: '',
  LIST: '',
  DETAIL: ':id',
  /** Pause, resume or revoke. Revocation is terminal. */
  ACTION: ':id/action',
  /** The payee presents a debit against an existing mandate. */
  PRESENT_DEBIT: ':id/debits',
}

export const DISPUTE_ROUTES = {
  BASE: 'payments/disputes',
  LIST: '',
  DETAIL: ':id',
  WITHDRAW: ':id/withdraw',
}

/**
 * Rail callbacks. Unauthenticated by session and verified by HMAC per provider.
 *
 * Deliberately outside the `payments` prefix so no session guard can be inherited onto them:
 * a rail has no JWT, and a webhook route that silently required one would fail every
 * settlement notice with a 401 nobody was watching.
 */
export const PAYMENT_WEBHOOK_ROUTES = {
  BASE: 'webhooks/payments',
  PROVIDER: ':provider',
}

/**
 * The mock rail — the payer's "PSP app", for development and demos.
 *
 * Mounted separately and refused outright in production. These endpoints can approve a
 * collect or a mandate on somebody's behalf, which is exactly the authority a real rail has
 * and exactly what must never be reachable against real money.
 */
export const MOCK_UPI_ROUTES = {
  BASE: 'mock/upi',
  /** The payer's pending requests, as their own app would show them. */
  PENDING: 'pending/:vpa',
  /** Approve or decline a collect, the way a payer's PSP app would. */
  COLLECT_RESPOND: 'collect/:collectRef/respond',
  /** Approve a mandate — the UPI AutoPay authorisation screen. */
  MANDATE_APPROVE: 'mandate/:mandateRef',
  /** Fire a signed rail webhook at ourselves, to exercise the real callback path. */
  FIRE_WEBHOOK: 'fire-webhook',
  /** Force the next simulated outcome, for a scripted demo. */
  SCRIPT: 'script',
}

export const ADMIN_PAYMENT_ROUTES = {
  BASE: 'admin/payments',
  /** Σ of every account balance per currency. Must always be zero. */
  TRIAL_BALANCE: 'trial-balance',
  LEDGER: 'ledger',
  STATS: 'stats',

  TRANSACTIONS: 'transactions',
  TRANSACTION_DETAIL: 'transactions/:id',
  /** Ask the rail again, now. */
  TRANSACTION_RECHECK: 'transactions/:id/recheck',
  /** Resolve one the rail never answered. A human decides; funds are in suspense. */
  TRANSACTION_RESOLVE_DEEMED: 'transactions/:id/resolve-deemed',
  TRANSACTION_REFUND: 'transactions/:id/refund',
  /** Release or block a transaction the risk engine held. */
  TRANSACTION_RISK: 'transactions/:id/risk',

  RECONCILIATIONS: 'reconciliations',
  /** Force a reconciliation sweep. */
  RECONCILE_NOW: 'reconcile',

  DISPUTES: 'disputes',
  DISPUTE_CLAIM: 'disputes/:id/claim',
  DISPUTE_RESOLVE: 'disputes/:id/resolve',
  DISPUTES_SLA: 'disputes/sla-breaches',
}
