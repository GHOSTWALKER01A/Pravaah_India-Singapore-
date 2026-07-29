/** Client-side (Next.js) route paths for the admin app. */
export const ROUTES = {
  AUTH: {
    BASE: '/login',
    LOGIN: '/login',
    VERIFY_OTP: '/login/verify',
  },
  DASHBOARD: {
    ROOT: '/dashboard',
    KYC: '/dashboard/kyc',
    KYC_CASE: (id: string) => `/dashboard/kyc/${id}`,
    CONSENT: '/dashboard/consent',
    CONSENT_DETAIL: (id: string) => `/dashboard/consent/${id}`,
    // M2 — model registry (with the fairness gate) and issued-score audit.
    MODELS: '/dashboard/models',
    MODEL_REGISTER: '/dashboard/models/register',
    MODEL_DETAIL: (id: string) => `/dashboard/models/${id}`,
    SCORES: '/dashboard/scores',
    SCORE_DETAIL: (id: string) => `/dashboard/scores/${id}`,
    // M3 — credential oversight, the issuer trust anchor, and registered verifiers.
    // Three entries because they answer three different questions: "is this person's
    // passport live?", "can the world still verify what we signed?", and "who is allowed
    // to ask our users for claims?".
    PASSPORTS: '/dashboard/passports',
    PASSPORT_DETAIL: (id: string) => `/dashboard/passports/${id}`,
    ISSUER_KEYS: '/dashboard/issuer-keys',
    VERIFIERS: '/dashboard/verifiers',
    /**
     * M4 — money movement. Four entries because they answer four different questions:
     * "does the ledger balance?", "what is stuck and needs a human?", "did the rail agree
     * with us?", and "what has a customer complained about?".
     */
    PAYMENTS: '/dashboard/payments',
    PAYMENT_DETAIL: (id: string) => `/dashboard/payments/${id}`,
    RECONCILIATION: '/dashboard/payments/reconciliation',
    PAYMENT_DISPUTES: '/dashboard/payments/disputes',
    /**
     * M5 — micro-insurance. Four entries because they answer four different questions:
     * "is the book making or losing money?", "which claims need a human right now?",
     * "what cover is in force?", and "what are we selling?".
     *
     * The BOOK leads rather than the claim queue, and that ordering mirrors the payments
     * section for the same reason: the loss ratio is the only figure here that can be an
     * ALARM rather than a metric. A book paying out more than it earns is not a queue to
     * work through, it is a pricing decision to revisit.
     */
    INSURANCE: '/dashboard/insurance',
    INSURANCE_CLAIMS: '/dashboard/insurance/claims',
    INSURANCE_CLAIM_DETAIL: (id: string) => `/dashboard/insurance/claims/${id}`,
    INSURANCE_POLICIES: '/dashboard/insurance/policies',
    INSURANCE_PRODUCTS: '/dashboard/insurance/products',
    /**
     * M6 — fraud and risk. Four entries because they answer four different questions:
     * "who is waiting on me right now?", "what is the model doing?", "what is this one
     * account?", and "who have we listed?".
     *
     * The CASE QUEUE leads, and that ordering is different in kind from the other groups'.
     * Elsewhere the lead entry is the one whose number can be an alarm. Here every row in the
     * lead queue is a PERSON WHOSE MONEY IS STOPPED, so the queue is not a dashboard to
     * glance at — it is the work, and it is the only screen in the console with a clock
     * running against it.
     */
    FRAUD: '/dashboard/fraud',
    FRAUD_CASE_DETAIL: (id: string) => `/dashboard/fraud/${id}`,
    FRAUD_ASSESSMENTS: '/dashboard/fraud/assessments',
    /**
     * One decision in full.
     *
     * Needed as its own route because most assessments have NO case: an `ALLOW`, a `STEP_UP`
     * or a sampled `REVIEW` never opens one. The case detail covers everything that was held;
     * this is the only way to inspect the far more numerous decisions that were not.
     */
    FRAUD_ASSESSMENT_DETAIL: (id: string) =>
      `/dashboard/fraud/assessments/${id}`,
    FRAUD_LISTS: '/dashboard/fraud/lists',
    /**
     * One account's risk picture, reachable from a case, an assessment, or a payment.
     *
     * Under `fraud/users` rather than beside the KYC review queue, deliberately: this view
     * answers "should this account be allowed to act", which is a fraud question, and the KYC
     * screens answer "is this person who they say they are". The two are decided by different
     * roles against different evidence.
     */
    FRAUD_USER: (userId: string) => `/dashboard/fraud/users/${userId}`,
  },
} as const;
