/**
 * Backend API endpoints (pravaah-be). Paths mirror the NestJS routes:
 * global prefix `api` + URI version `v1`. Base URL comes from the
 * EXPO_PUBLIC_API_URL env var (inlined by Expo at build time).
 */
export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000'
).replace(/\/$/, '');

export const API_ENDPOINTS = {
  AUTH: {
    BASE: 'api/v1/auth',
    SEND_OTP: '/send-otp',
    RESEND_OTP: '/resend-otp',
    VERIFY: '/verify',
    REFRESH: '/refresh',
  },
  // Mirrors KYC_ROUTES in apps/pravaah-be/src/modules/kyc/kyc.route.ts
  KYC: {
    BASE: 'api/v1/kyc',
    START: '/start',
    STATUS: '/status',
    PAN_VERIFY: '/pan/verify',
    AADHAAR_INITIATE: '/aadhaar/okyc/initiate',
    AADHAAR_CALLBACK: '/aadhaar/okyc/callback',
    BANK_PENNY_DROP: '/bank/penny-drop',
    LIVENESS_SESSION: '/liveness/session',
    LIVENESS_VERIFY: '/liveness/verify',
    FACE_MATCH: '/face-match',
    SANCTIONS: '/sanctions/screen',
    PUSH_TOKEN: '/push-token',
    SINGPASS_INITIATE: '/singpass/initiate',
    SINGPASS_CALLBACK: '/singpass/callback',
    SINGPASS_MOCK: (providerRefId: string) =>
      `/singpass/mock/${providerRefId}`,
  },
  // Mirrors CONSENT_ROUTES in apps/pravaah-be/src/modules/consent/consent.route.ts
  CONSENT: {
    BASE: 'api/v1/consent',
    CREATE: '/create',
    LIST: '',
    STATUS: (id: string) => `/${id}/status`,
    REVOKE: (id: string) => `/${id}`,
    REFETCH: (id: string) => `/${id}/refetch`,
  },
  // Mirrors SCORE_ROUTES in apps/pravaah-be/src/modules/scoring/scoring.route.ts
  SCORE: {
    BASE: 'api/v1/score',
    CURRENT: '',
    COMPUTE: '/compute',
    HISTORY: '/history',
    FAIRNESS_CONSENT: '/fairness-consent',
  },
  // Mirrors PASSPORT_ROUTES in apps/pravaah-be/src/modules/passport/passport.route.ts
  PASSPORT: {
    BASE: 'api/v1/passport',
    CURRENT: '',
    ISSUE: '/issue',
    CLAIMS: '/claims',
    CHALLENGE: '/challenge',
    PRESENT: '/present',
    REQUESTS: '/requests',
    REQUEST_DETAIL: (requestId: string) => `/requests/${requestId}`,
    REQUEST_APPROVE: (requestId: string) => `/requests/${requestId}/approve`,
    REQUEST_DECLINE: (requestId: string) => `/requests/${requestId}/decline`,
    HISTORY: '/history',
    /**
     * Peer verification — this holder scanning somebody else's passport code.
     *
     * Under `passport` rather than `verify`: `verify` is the PARTNER surface behind an API
     * key, and a route there taking an end-user JWT would be one guard mistake away from
     * letting anybody name their own audience.
     */
    SCAN: '/scan',
    SCAN_RESULT: (requestId: string) => `/scan/${requestId}`,
    CARD: '/card',
    CARD_NFC_WRITTEN: '/card/nfc-written',
    CARD_LOST: '/card/lost',
    REVOKE: (id: string) => `/credentials/${id}/revoke`,
  },
  // Mirrors PAYMENT_ROUTES in apps/pravaah-be/src/modules/payments/payments.route.ts
  PAYMENTS: {
    BASE: 'api/v1/payments',
    /** Balances, UPI IDs and remaining limits — the whole wallet screen in one call. */
    WALLET: '/wallet',
    /** The ledger-derived statement. What actually happened to the money. */
    STATEMENT: '/wallet/statement',
    LIMITS: '/limits',
    /** A locked, single-use price. Every transfer is submitted against one. */
    QUOTE: '/quote',
    TOPUP: '/topup',
    WITHDRAW: '/withdraw',
    HANDLES: '/upi-handles',
    HANDLE_PRIMARY: (id: string) => `/upi-handles/${id}/primary`,
    HANDLE_DEACTIVATE: (id: string) => `/upi-handles/${id}/deactivate`,
  },
  BENEFICIARIES: {
    BASE: 'api/v1/payments/beneficiaries',
    LIST: '',
    ADD: '',
    /** Resolve a UPI ID to the name its BANK holds. No money moves. */
    RESOLVE: '/resolve',
    /** Mobile number → payable address. A search, so it can return several answers or none. */
    RESOLVE_MOBILE: '/resolve-mobile',
    DETAIL: (id: string) => `/${id}`,
    REVERIFY: (id: string) => `/${id}/reverify`,
    BLOCK: (id: string) => `/${id}/block`,
    UNBLOCK: (id: string) => `/${id}/unblock`,
  },
  TRANSFERS: {
    BASE: 'api/v1/payments/transfers',
    CREATE: '',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    RECEIPT: (id: string) => `/${id}/receipt`,
    RETRY: (id: string) => `/${id}/retry`,
    /**
     * Answer the M6 step-up on a payment parked awaiting confirmation.
     *
     * Its own route rather than a repeat of CREATE: the payment already exists against a
     * quote that has been consumed, so re-creating would send the payer back through pricing
     * at a rate that may have moved — and would burn a second quote.
     */
    CONFIRM_STEP_UP: (id: string) => `/${id}/confirm`,
    /**
     * Re-issue a lapsed confirmation on a held payment.
     *
     * A challenge lives five minutes and the poll reports only live ones, so a user who left
     * the app mid-confirmation came back to a payment stuck in review with no route out. This
     * is user-initiated rather than automatic on purpose: the detail endpoint is POLLED, and
     * re-issuing there would be an SMS every five minutes for merely having the app open.
     */
    REQUEST_STEP_UP: (id: string) => `/${id}/confirm/request`,
    DISPUTE: (id: string) => `/${id}/dispute`,
  },
  COLLECT: {
    BASE: 'api/v1/payments/collect',
    CREATE: '',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    REVOKE: (id: string) => `/${id}/revoke`,
  },
  PAYMENT_QR: {
    BASE: 'api/v1/payments/qr',
    CREATE: '',
    LIST: '',
    SCAN: '/scan',
    PAY: '/pay',
    DEACTIVATE: (id: string) => `/${id}/deactivate`,
  },
  MANDATES: {
    BASE: 'api/v1/payments/mandates',
    CREATE: '',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    ACTION: (id: string) => `/${id}/action`,
    DEBITS: (id: string) => `/${id}/debits`,
  },
  DISPUTES: {
    BASE: 'api/v1/payments/disputes',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    WITHDRAW: (id: string) => `/${id}/withdraw`,
  },
  // Mirrors INSURANCE_ROUTES in apps/pravaah-be/src/modules/insurance/insurance.route.ts
  INSURANCE: {
    BASE: 'api/v1/insurance',
    /** The marketplace. Carries no prices — pricing is personal. */
    PRODUCTS: '/products',
    PRODUCT_DETAIL: (id: string) => `/products/${id}`,
    /** Ask for a price. The reputation moment. */
    QUOTE: '/quote',
    QUOTE_DETAIL: (id: string) => `/quotes/${id}`,
    /** Buy from a PRICED quote. Needs an Idempotency-Key. */
    POLICIES: '/policies',
    POLICY_DETAIL: (id: string) => `/policies/${id}`,
    POLICY_CANCEL: (id: string) => `/policies/${id}/cancel`,
    POLICY_PREMIUMS: (id: string) => `/policies/${id}/premiums`,
    /**
     * Retry the first premium after topping up.
     *
     * Its own route rather than a repeat of the buy call: the policy already exists at
     * the agreed price, and re-buying would send the holder back through underwriting
     * at a price that may have moved. Nobody is repriced for having had an empty
     * wallet on the day they decided to buy cover.
     */
    POLICY_RETRY_PREMIUM: (id: string) => `/policies/${id}/retry-premium`,
  },
  // Mirrors CLAIM_ROUTES in apps/pravaah-be/src/modules/insurance/insurance.route.ts
  CLAIMS: {
    BASE: 'api/v1/insurance/claims',
    FILE: '',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    /** Multipart. OCR and the tamper check run on upload. */
    DOCUMENTS: (id: string) => `/${id}/documents`,
    /**
     * "I'm done uploading" — run the fraud gate and route to review or auto-approve.
     *
     * A separate call from filing, because documents arrive as separate multipart
     * requests: scoring at submission would assess every claim as though it had none.
     */
    FINALISE: (id: string) => `/${id}/finalise`,
    WITHDRAW: (id: string) => `/${id}/withdraw`,
  },
  // Dev-only sandbox mock UPI rail — plays the PAYER's own PSP app, which is the one
  // thing the product deliberately cannot do itself. Refused in production.
  MOCK_UPI: {
    BASE: 'api/v1/mock/upi',
    PENDING: (vpa: string) => `/pending/${encodeURIComponent(vpa)}`,
    COLLECT_RESPOND: (ref: string) => `/collect/${ref}/respond`,
    MANDATE_APPROVE: (ref: string) => `/mandate/${ref}`,
  },
  // Dev-only sandbox AA mock consent screen (no auth).
  MOCK_AA: {
    BASE: 'api/v1/mock/aa',
    DECISION: (providerConsentId: string) => `/${providerConsentId}`,
  },
  /**
   * M6 — the user's own security surface.
   *
   * Mirrors SECURITY_ROUTES in apps/pravaah-be/src/modules/fraud/fraud.route.ts.
   *
   * Most of M6 has no endpoint at all: the risk engine runs INSIDE the calls the other
   * modules already expose, so a transfer is scored by the request that sends it. There
   * is deliberately no "score this for me" route — that would be an oracle an attacker
   * could tune an amount, a device and a payee against until it answered ALLOW.
   *
   * What IS here is the part that builds trust rather than merely applying control:
   * manage my devices, answer a challenge, and see why I was challenged.
   */
  SECURITY: {
    BASE: 'api/v1/security',

    DEVICES: '/devices',
    /** Begin a bind. Returns a CHALLENGE, never a token. */
    DEVICE_BIND: '/devices/bind',
    DEVICE_BIND_CONFIRM: '/devices/bind/confirm',
    /** "This wasn't me." Immediate, and deliberately needs no challenge. */
    DEVICE_REVOKE: (id: string) => `/devices/${id}/revoke`,
    /** Re-verify out of SUSPECTED_SWAP after a legitimate SIM change. */
    DEVICE_RECOVER: (id: string) => `/devices/${id}/recover`,
    DEVICE_RECOVER_REQUEST: (id: string) => `/devices/${id}/recover/request`,
    /** Rotate the binding token, bounding the useful life of a stolen one. */
    DEVICE_REFRESH: (id: string) => `/devices/${id}/refresh`,

    STEP_UP_REQUEST: '/step-up/request',
    STEP_UP_VERIFY: '/step-up/verify',

    /**
     * The app PIN — Pravaah's own knowledge factor, and NOT the UPI PIN.
     *
     * `PIN_STATUS` is a GET and `PIN_SET` a POST on the same path, which is why they are two
     * constants with one value: the app reads which factor to ask for, and enrols, at the
     * same resource. Splitting the paths would have implied two resources.
     *
     * The `_REQUEST` pair issues the challenge that authorises the mutation next to it — a
     * biometric one for a change, an SMS one for a reset. They are separate routes because
     * the factor differs, and that difference is the control rather than an implementation
     * detail: a reset's SMS code must not be redeemable against a change.
     */
    PIN_STATUS: '/pin',
    PIN_SET: '/pin',
    PIN_VERIFY: '/pin/verify',
    PIN_CHANGE: '/pin/change',
    PIN_CHANGE_REQUEST: '/pin/change/request',
    PIN_RESET: '/pin/reset',
    PIN_RESET_REQUEST: '/pin/reset/request',

    /** Record what the OS reports about local authentication. A claim, not proof. */
    BIOMETRIC_ENROL: '/biometric',

    /** My recent decisions and why. The DPDP transparency answer, made tangible. */
    ASSESSMENTS: '/assessments',
    /** Anything of mine under review, with a reference support can quote. */
    HOLDS: '/holds',
  },
  USERS: {
    BASE: 'api/v1/users',
    ME: '/me',
  },
} as const;
