/**
 * M5 routes.
 *
 * Grouped by AUDIENCE rather than by entity, exactly as M4's are, and the split is
 * load-bearing for the same reason: the holder API, the insurer's callbacks, the mock
 * insurer and the admin console each carry a different guard, and co-locating them is
 * how a guard ends up applied to the wrong half.
 */
export const INSURANCE_ROUTES = {
  BASE: 'insurance',

  /** The marketplace. No prices — pricing is personal and arrives at the quote. */
  PRODUCTS: 'products',
  PRODUCT_DETAIL: 'products/:id',

  /** Ask for a price. The reputation moment. */
  QUOTE: 'quote',
  QUOTE_DETAIL: 'quotes/:id',

  /** Buy from a PRICED quote. Requires an Idempotency-Key. */
  POLICIES: 'policies',
  POLICY_DETAIL: 'policies/:id',
  /** Free-look or anytime cancellation. */
  POLICY_CANCEL: 'policies/:id/cancel',
  /** The premium ledger for one policy — what was collected, and when. */
  POLICY_PREMIUMS: 'policies/:id/premiums',
  /**
   * Retry a first premium after topping up the wallet.
   *
   * Its own route rather than a repeat of the buy call: the policy already exists at
   * the quoted price, so re-buying would send the holder back through underwriting at
   * a price that may have moved.
   */
  POLICY_RETRY_PREMIUM: 'policies/:id/retry-premium',
}

export const CLAIM_ROUTES = {
  BASE: 'insurance/claims',

  FILE: '',
  LIST: '',
  DETAIL: ':id',
  /** Attach a document. Multipart; OCR runs on upload. */
  DOCUMENTS: ':id/documents',
  /**
   * "I'm done uploading" — run the fraud gate and route to review or auto-approve.
   *
   * A separate call from filing because documents arrive as separate multipart
   * requests. Scoring at submission would assess every claim as though it had none.
   */
  FINALISE: ':id/finalise',
  WITHDRAW: ':id/withdraw',
}

/**
 * Insurer callbacks. Unauthenticated by session, verified by per-provider HMAC over
 * the raw bytes.
 *
 * Deliberately outside the `insurance` prefix so no session guard can be inherited onto
 * them: an insurer has no JWT, and a webhook route that silently required one would
 * fail every claim adjudication with a 401 nobody was watching.
 */
export const INSURANCE_WEBHOOK_ROUTES = {
  BASE: 'webhooks/insurance',
  PROVIDER: ':provider',
}

/**
 * The mock insurer's own surface, for development and demos.
 *
 * Mounted separately and refused outright in production. These endpoints can move a
 * claim's status — exactly the authority a real insurer has, and exactly what must never
 * be reachable against real policies.
 */
export const MOCK_INSURER_ROUTES = {
  BASE: 'mock/insurer',
  /** Fire a correctly signed callback at ourselves, exercising the real path. */
  FIRE_WEBHOOK: 'fire-webhook',
  /** Sign a body without sending it, so a client can replay it by hand. */
  SIGN: 'sign',
}

export const ADMIN_INSURANCE_ROUTES = {
  BASE: 'admin/insurance',

  /** Portfolio counts, the conversion funnel, and the operational alarms. */
  STATS: 'stats',
  /** Loss ratio and the underwriting position, read off the ledger. */
  BOOK: 'book',

  PRODUCTS: 'products',
  PRODUCT_DETAIL: 'products/:id',
  PRODUCT_ACTIVE: 'products/:id/active',

  /** Oldest first — a newest-first queue starves the longest-waiting claimant. */
  CLAIMS: 'claims',
  CLAIM_DETAIL: 'claims/:id',
  CLAIM_DECIDE: 'claims/:id/decide',
  /** Decrypt one document's extraction. Writes its own audit row. */
  CLAIM_DOCUMENT_REVEAL: 'documents/:docId/reveal',

  POLICIES: 'policies',
  POLICY_PREMIUMS: 'policies/:id/premiums',

  /** Force every lifecycle sweep to run now. */
  RUN_LIFECYCLE: 'run-lifecycle',
}
