/**
 * M7 route constants. Five surfaces, five bases, one per authentication model —
 * the grouping IS the security statement, exactly as M3 keeps `verify` (partner
 * key) apart from `passport` (holder JWT). A route can only pick up the guard of
 * the controller it lives in, so a partner route cannot end up behind a user guard
 * by accident.
 */

/** Server-to-server partner API. Authenticated with a partner API key. */
export const PARTNER_API_ROUTES = {
  BASE: 'partner',
  ME: 'me',
  VERIFICATIONS: 'verifications',
  VERIFICATION: 'verifications/:requestId',
  VERIFICATION_CANCEL: 'verifications/:requestId/cancel',
  VERIFICATION_DECISION: 'verifications/:requestId/decision',
  /** A presentation handed to the partner directly (OpenID4VP direct_post). */
  PRESENTATIONS_VERIFY: 'presentations/verify',
  TEMPLATES: 'templates',
  USAGE: 'usage',
}

/** The partner's web console. Authenticated with a console user's session. */
export const PARTNER_CONSOLE_ROUTES = {
  BASE: 'partner-console',
  ME: 'me',
  PROFILE: 'profile',
  /** Claim catalogue, catalogue templates and predicate operators, for the builder UI. */
  CATALOGUE: 'catalogue',

  WEBHOOK_SECRET_ROTATE: 'webhook/secret/rotate',
  WEBHOOK_TEST: 'webhook/test',
  WEBHOOK_DELIVERIES: 'webhook/deliveries',
  WEBHOOK_REDELIVER: 'webhook/deliveries/:deliveryId/redeliver',

  API_KEYS: 'api-keys',
  API_KEY_REVOKE: 'api-keys/:keyId/revoke',
  API_KEY_ROTATE: 'api-keys/:keyId/rotate',

  VERIFICATIONS: 'verifications',
  VERIFICATION: 'verifications/:requestId',
  VERIFICATION_CANCEL: 'verifications/:requestId/cancel',
  VERIFICATION_DECISION: 'verifications/:requestId/decision',

  TEMPLATES: 'templates',
  TEMPLATE: 'templates/:templateId',

  USAGE: 'usage',
  USAGE_LINE_ITEMS: 'usage/line-items',

  USERS: 'users',
  USER: 'users/:userId',
}

/** Public onboarding. Unauthenticated, throttled. */
export const PARTNER_ONBOARDING_ROUTES = {
  BASE: 'partners',
  APPLY: 'apply',
}

/**
 * The holder's "who has seen my passport". Under `passport/` because it is part of
 * the wallet, on the holder's own guard.
 */
export const HOLDER_SHARES_ROUTES = {
  BASE: 'passport/shares',
  LIST: '',
  BY_REQUEST: 'by-request/:requestId',
  DETAIL: ':receiptId',
  WITHDRAW: ':receiptId/withdraw',
}

/** PRAVAAH admin: partner approvals, policy and oversight. */
export const ADMIN_PARTNER_ROUTES = {
  BASE: 'admin/partners',
  LIST: '',
  OVERVIEW: 'overview',
  DETAIL: ':partnerId',
  APPROVE: ':partnerId/approve',
  REJECT: ':partnerId/reject',
  SUSPEND: ':partnerId/suspend',
  REINSTATE: ':partnerId/reinstate',
  REVOKE: ':partnerId/revoke',
  POLICY: ':partnerId/policy',
  USERS: ':partnerId/users',
  API_KEYS: ':partnerId/api-keys',
  USAGE: ':partnerId/usage',
}

/** PRAVAAH admin: which issuers the platform accepts. */
export const ADMIN_TRUST_REGISTRY_ROUTES = {
  BASE: 'admin/trust-registry',
  LIST: '',
  ENTRY: ':entryId',
}
