/**
 * Backend API endpoints (pravaah-be). Paths mirror the NestJS routes:
 * global prefix `api` + URI version `v1`.
 */
export const API_ENDPOINTS = {
  // Admin console authenticates against the admin auth routes (gated on the
  // AdminUser table). Mirrors ADMIN_AUTH_ROUTES in pravaah-be kyc.route.ts.
  AUTH: {
    BASE: 'api/v1/admin/auth',
    SEND_OTP: '/send-otp',
    RESEND_OTP: '/resend-otp',
    VERIFY: '/verify',
    REFRESH: '/refresh',
    ME: '/me',
  },
  // Mirrors ADMIN_KYC_ROUTES in apps/pravaah-be/src/modules/kyc/kyc.route.ts
  KYC: {
    BASE: 'api/v1/admin/kyc',
    CASES: '/cases',
    CASE_DETAIL: (id: string) => `/cases/${id}`,
    CASE_CLAIM: (id: string) => `/cases/${id}/claim`,
    CASE_DECISION: (id: string) => `/cases/${id}/decision`,
  },
  // Mirrors ADMIN_CONSENT_ROUTES in apps/pravaah-be/src/modules/consent/consent.route.ts
  CONSENT: {
    BASE: 'api/v1/admin/consent',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    AUDIT: (id: string) => `/${id}/audit`,
  },
  // Mirrors ADMIN_SCORE_ROUTES in apps/pravaah-be/src/modules/scoring/scoring.route.ts
  SCORE: {
    BASE: 'api/v1/admin/score',
    // Model registry + the fairness activation gate
    MODELS: '/models',
    MODEL_DETAIL: (id: string) => `/models/${id}`,
    MODEL_AUDIT: (id: string) => `/models/${id}/audit-fairness`,
    MODEL_FAIRNESS: (id: string) => `/models/${id}/fairness`,
    MODEL_ACTIVATE: (id: string) => `/models/${id}/activate`,
    MODEL_ROLLBACK: (id: string) => `/models/${id}/rollback`,
    // Issued-score oversight
    SCORES: '/scores',
    SCORE_DETAIL: (id: string) => `/scores/${id}`,
    SCORE_AUDIT: (id: string) => `/scores/${id}/audit`,
    SCORE_OVERRIDE: (id: string) => `/scores/${id}/override`,
    DRIFT: '/drift',
  },
  // Mirrors ADMIN_PASSPORT_ROUTES in apps/pravaah-be/src/modules/passport/passport.route.ts
  PASSPORT: {
    BASE: 'api/v1/admin/passport',
    LIST: '',
    STATS: '/stats',
    DETAIL: (id: string) => `/credentials/${id}`,
    AUDIT: (id: string) => `/credentials/${id}/audit`,
    REVOKE: (id: string) => `/credentials/${id}/revoke`,
    SUSPEND: (id: string) => `/credentials/${id}/suspend`,
    RESUME: (id: string) => `/credentials/${id}/resume`,
    // The issuer trust anchor — our analogue of the ICAO PKD.
    KEYS: '/keys',
    KEYS_ROTATE: '/keys/rotate',
    // Registered verifiers (M7 partners).
    PARTNERS: '/partners',
    PARTNER_REVOKE: (id: string) => `/partners/${id}/revoke`,
  },
  // Mirrors ADMIN_PAYMENT_ROUTES in apps/pravaah-be/src/modules/payments/payments.route.ts
  PAYMENTS: {
    BASE: 'api/v1/admin/payments',
    // Oversight
    TRIAL_BALANCE: '/trial-balance',
    LEDGER: '/ledger',
    STATS: '/stats',
    TRANSACTIONS: '/transactions',
    TRANSACTION_DETAIL: (id: string) => `/transactions/${id}`,
    RECONCILIATIONS: '/reconciliations',
    // Operations
    RECHECK: (id: string) => `/transactions/${id}/recheck`,
    RECONCILE_NOW: '/reconcile',
    // Break-glass — ADMIN only, each reasoned and attributed
    RESOLVE_DEEMED: (id: string) => `/transactions/${id}/resolve-deemed`,
    REFUND: (id: string) => `/transactions/${id}/refund`,
    RISK: (id: string) => `/transactions/${id}/risk`,
    // Disputes
    DISPUTES: '/disputes',
    DISPUTE_CLAIM: (id: string) => `/disputes/${id}/claim`,
    DISPUTE_RESOLVE: (id: string) => `/disputes/${id}/resolve`,
    DISPUTES_SLA: '/disputes/sla-breaches',
  },
  // Mirrors ADMIN_INSURANCE_ROUTES in apps/pravaah-be/src/modules/insurance/insurance.route.ts
  INSURANCE: {
    BASE: 'api/v1/admin/insurance',
    // Oversight. `BOOK` carries the loss ratio, read off the LEDGER rather than from
    // application tables — so it reconciles against M4's trial balance.
    STATS: '/stats',
    BOOK: '/book',
    // Adjudication
    CLAIMS: '/claims',
    CLAIM_DETAIL: (id: string) => `/claims/${id}`,
    CLAIM_DECIDE: (id: string) => `/claims/${id}/decide`,
    // Decrypting one document's extraction writes its own audit row naming the admin.
    DOCUMENT_REVEAL: (docId: string) => `/documents/${docId}/reveal`,
    // The estate
    POLICIES: '/policies',
    POLICY_PREMIUMS: (id: string) => `/policies/${id}/premiums`,
    // The catalogue — a new cover needs no deploy.
    PRODUCTS: '/products',
    PRODUCT_DETAIL: (id: string) => `/products/${id}`,
    PRODUCT_ACTIVE: (id: string) => `/products/${id}/active`,
    // Force every lifecycle sweep now: expire quotes, run premium dunning, expire terms,
    // resume stuck money, retry unpaid payouts.
    RUN_LIFECYCLE: '/run-lifecycle',
  },
  // Mirrors ADMIN_FRAUD_ROUTES in apps/pravaah-be/src/modules/fraud/fraud.route.ts
  FRAUD: {
    BASE: 'api/v1/admin/fraud',
    // Oversight. `slaBreached` in this payload counts people whose money has been held past
    // the promised window — the one figure here worth paging on.
    STATS: '/stats',
    // The queue. Severity DESC then SLA ASC, server-side: a newest-first queue starves the
    // user who has been held longest, who is also the likeliest false positive.
    CASES: '/cases',
    CASE_DETAIL: (id: string) => `/cases/${id}`,
    // Atomic claim. Two analysts racing one case is a 409, not a silent overwrite.
    CASE_CLAIM: (id: string) => `/cases/${id}/claim`,
    CASE_NOTE: (id: string) => `/cases/${id}/note`,
    CASE_REQUEST_INFO: (id: string) => `/cases/${id}/request-info`,
    // CLEARED releases the held action and feeds a whitelist signal back; CONFIRMED_FRAUD
    // blocks, lists the artefacts, suspends the account, and flags cross-border for STR.
    CASE_RESOLVE: (id: string) => `/cases/${id}/resolve`,
    // Every assessment, with scores and weights — the arithmetic the user-facing view omits.
    ASSESSMENTS: '/assessments',
    ASSESSMENT_DETAIL: (id: string) => `/assessments/${id}`,
    // Counts only. There is no endpoint returning the entries: `valueHash` is the one value
    // in M6 that could be brute-forced offline.
    LISTS: '/lists',
    LIST_REMOVE: '/lists/remove',
    // One account's whole risk picture in one call — devices, decisions, cases, the graph.
    USER_PROFILE: (userId: string) => `/users/${userId}`,
    USER_SUSPEND: (userId: string) => `/users/${userId}/suspend`,
    // The mule ring around one account, and the async cluster recompute.
    GRAPH_NEIGHBOURHOOD: (userId: string) => `/graph/${userId}`,
    GRAPH_RECOMPUTE: '/graph/recompute',
  },
} as const;
