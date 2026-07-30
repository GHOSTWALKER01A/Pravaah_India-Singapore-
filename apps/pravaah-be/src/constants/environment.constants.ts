export const ENV = {
  NODE_ENV: 'NODE_ENV',
  PORT: 'PORT',
  SUPABASE: {
    URL: 'SUPABASE_URL',
    // New Supabase API keys (2024+). PUBLISHABLE replaces the anon key;
    // SECRET replaces the service_role key.
    PUBLISHABLE_KEY: 'SUPABASE_PUBLISHABLE_KEY',
    SECRET_KEY: 'SUPABASE_SECRET_KEY',
    JWKS_URL: 'SUPABASE_JWKS_URL',
    // Legacy key names — kept as fallbacks for older configs.
    KEY: 'SUPABASE_KEY',
    SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY',
    JWT_SECRET: 'SUPABASE_JWT_SECRET',
    // Supabase Auth "Send SMS Hook" secret (standardwebhooks `v1,whsec_...`).
    // Supabase calls our backend to deliver the phone OTP through our own
    // channel (MSG91 SMS) instead of its built-in sender.
    SMS_HOOK_SECRET: 'SUPABASE_SMS_HOOK_SECRET',
  },
  DATABASE: {
    URL: 'DATABASE_URL',
  },
  // Redis/Valkey cache (ioredis). Provide CACHE_URL, or the discrete fields.
  CACHE: {
    URL: 'CACHE_URL',
    HOST: 'CACHE_HOST',
    PORT: 'CACHE_PORT',
    PASSWORD: 'CACHE_PASSWORD',
    DB: 'CACHE_DB',
    TLS_ENABLED: 'CACHE_TLS_ENABLED',
  },
  WEB: {
    APP_URL: 'WEB_APP_URL',
  },
  // Public base URL of this API — used to build provider redirect/callback URLs.
  API: {
    PUBLIC_URL: 'API_PUBLIC_URL',
  },
  // Decentro (India KYC rail — LIVE sandbox). All literals confirmable in one
  // place; see src/config/decentro.config.ts.
  DECENTRO: {
    BASE_URL: 'DECENTRO_BASE_URL',
    CLIENT_ID: 'DECENTRO_CLIENT_ID',
    CLIENT_SECRET: 'DECENTRO_CLIENT_SECRET',
    /** "KYC & Onboarding" module — PAN and DigiLocker. */
    MODULE_SECRET: 'DECENTRO_MODULE_SECRET',
    /**
     * Bank account validation lives in Core Banking, NOT in KYC, and needs its
     * own module secret plus a provider secret. Sending the KYC secret gets
     * `error_unauthorized_module`; sending no provider secret gets
     * `E00039 Provider Not Authorized For Company` — which reads like an
     * account entitlement problem and is really a missing header.
     */
    CORE_BANKING_MODULE_SECRET: 'DECENTRO_CORE_BANKING_MODULE_SECRET',
    /**
     * Decentro is multi-bank and issues ONE PROVIDER SECRET PER BANK partner
     * (`yesb`, `icic`, `dbss`, `idfb`). This must be the secret for the bank
     * holding the commission-debit account, because Decentro resolves that
     * account per (company, provider): authenticate on a rail where no
     * commission account exists and it reports "You have not configured
     * account details for the commission debits" — which reads like nothing is
     * set up anywhere, when the account may simply be on a different bank.
     */
    BANK_PROVIDER_SECRET: 'DECENTRO_BANK_PROVIDER_SECRET',
    /** Pre-dates the generic key above; still read so existing envs work. */
    BANK_PROVIDER_SECRET_YBL: 'DECENTRO_YBL_PROVIDER_SECRET',
  },
  // Field-level encryption of raw provider payloads (AES-256-GCM).
  CRYPTO: {
    FIELD_ENCRYPTION_KEY: 'FIELD_ENCRYPTION_KEY',
  },
  // HMAC secret for verifying inbound provider webhooks.
  WEBHOOK: {
    HMAC_SECRET: 'WEBHOOK_HMAC_SECRET',
  },
  // SMS delivery (MSG91, like oscode) — legacy hook path, unused by Twilio auth.
  MSG91: {
    AUTH_KEY: 'MSG91_AUTH_KEY',
    SENDER_ID: 'MSG91_SENDER_ID',
    OTP_TEMPLATE_ID: 'MSG91_OTP_TEMPLATE_ID',
    // Flow template for the KYC decision SMS (a `status` variable). Optional —
    // the decision SMS self-disables when this is absent.
    DECISION_TEMPLATE_ID: 'MSG91_DECISION_TEMPLATE_ID',
  },
  // Transactional email over SMTP (nodemailer). Used for KYC decision emails.
  // The EmailService self-disables when HOST/USER/PASSWORD are absent.
  SMTP: {
    HOST: 'SMTP_HOST',
    PORT: 'SMTP_PORT',
    USER: 'SMTP_USER',
    PASSWORD: 'SMTP_PASSWORD',
    FROM: 'SMTP_FROM', // e.g. "Pravaah <no-reply@pravaah.in>"
    SECURE: 'SMTP_SECURE', // 'true' for port 465, else STARTTLS
  },
  // Expo push (mobile). Access token is OPTIONAL — it enables Expo's enhanced
  // push security when set; the push endpoint works without it.
  EXPO: {
    ACCESS_TOKEN: 'EXPO_ACCESS_TOKEN',
  },
  // Twilio Verify — sends AND checks the phone OTP (self-contained provider).
  TWILIO: {
    ACCOUNT_SID: 'TWILIO_ACCOUNT_SID',
    AUTH_TOKEN: 'TWILIO_AUTH_TOKEN',
    VERIFY_SERVICE_SID: 'TWILIO_VERIFY_SERVICE_SID',
  },
  // DEV-ONLY OTP bypass: when BYPASS_PHONE is set, that number skips Twilio
  // entirely — no SMS is sent and the OTP check passes iff the code equals
  // BYPASS_OTP. Lets us test the full login (user AND admin) offline / without
  // real SMS. Leave BYPASS_PHONE unset in any real environment.
  AUTH_DEV: {
    BYPASS_PHONE: 'AUTH_DEV_BYPASS_PHONE',
    BYPASS_OTP: 'AUTH_DEV_BYPASS_OTP',
  },
  // Secret used to sign our own session JWTs (HS256) after Twilio verifies the
  // OTP. Must be a long random string; the JwtStrategy verifies with it.
  JWT: {
    SECRET: 'AUTH_JWT_SECRET',
  },
  // M1 — Account Aggregator (Consent & Data Aggregation). AA_MODE flips the DI:
  // 'sandbox' (mock, build now) | 'live' (Setu). Literals confirmable in one
  // place; see src/modules/consent/providers/aa/setu-aa.config.ts.
  AA: {
    MODE: 'AA_MODE', // sandbox (default) | setu | finvu | live (Setu→Finvu fallback)
    HANDLE: 'AA_HANDLE', // VUA handle suffix, e.g. "onemoney"
    APP_DEEPLINK: 'APP_DEEPLINK', // RN app scheme, e.g. "parvaahrn://"
    PUBLIC_KEY: 'AA_PUBLIC_KEY', // AA public key for artefact signature verify
    SANDBOX_PARTIAL: 'AA_SANDBOX_PARTIAL', // 'true' to simulate PARTIAL coverage
    // Setu (Bridge). Verified live: token exchange at TOKEN_URL then Bearer +
    // product-instance-id. BASE_URL is account-specific (Bridge "Step 2").
    SETU: {
      TOKEN_URL: 'SETU_AA_TOKEN_URL', // default https://uat.setu.co/api/v2/auth/token
      BASE_URL: 'SETU_AA_BASE_URL', // FIU API base (set from your Bridge dashboard)
      CLIENT_ID: 'SETU_AA_CLIENT_ID',
      SECRET_KEY: 'SETU_AA_SECRET_KEY', // (a.k.a. client secret)
      PRODUCT_ID: 'SETU_AA_PRODUCT_ID', // → x-product-instance-id
      PUBLIC_KEY: 'SETU_AA_PUBLIC_KEY', // verifies Setu's JWS notifications
    },
    // Finvu (Finfactor · Finsense) — fallback. Needs Sahamati onboarding + a
    // registered JWS signing keypair. See finvu-aa.config.ts.
    FINVU: {
      BASE_URL: 'FINVU_BASE_URL',
      API_KEY: 'FINVU_API_KEY', // client_api_key header
      JWS_PRIVATE_KEY: 'FINVU_JWS_PRIVATE_KEY', // detached-JWS request signing
      FIU_ID: 'FINVU_FIU_ID',
    },
  },
  // M3 — The Passport (Verifiable Credential layer). These two values ARE the
  // credential's identity, not tuning knobs: ISSUER_DOMAIN is baked into every
  // SD-JWT as `did:web:<domain>` and is what a foreign verifier resolves to find
  // our public keys. Changing it invalidates every credential already issued.
  // See src/modules/passport/passport.config.ts.
  PASSPORT: {
    // Bare host, no scheme, no port (a colon in a did:web is a path separator).
    // Defaults to API_PUBLIC_URL's hostname, then to "pravaah.app".
    ISSUER_DOMAIN: 'PASSPORT_ISSUER_DOMAIN',
    // Where verifiers FETCH from (JWKS, status lists, card links). May differ
    // from ISSUER_DOMAIN during a demo — e.g. an ngrok tunnel.
    PUBLIC_URL: 'PASSPORT_PUBLIC_URL',
    // Credential validity ceiling in days. The real expiry is min(this, the
    // consent's data life), so this only ever shortens a credential's life.
    MAX_VALIDITY_DAYS: 'PASSPORT_MAX_VALIDITY_DAYS',
  },
  // M4 — Cross-border money movement (UPI ↔ PayNow · ledger · idempotency).
  // Non-secret policy literals (caps, fees, poll schedules) live in
  // src/modules/payments/payments.config.ts, NOT here: a daily limit is not
  // configuration, it is what the platform is permitted to do, and it should not
  // be changeable by editing an env file on a server.
  PAYMENTS: {
    // Domestic UPI provider: 'sim' (default — the full-fidelity simulator) |
    // 'decentro' (live sandbox). The cross-border leg has no live option: the
    // UPI↔PayNow linkage is a BANK rail (DBS Singapore / Liquid Group), not an
    // API anyone can sign up for, so it is always simulated and the production
    // path is a PSP/bank partnership.
    UPI_PROVIDER: 'PAYMENTS_UPI_PROVIDER',
    // Our PSP handle suffix — the `@pravaah` in `ravi@pravaah`.
    VPA_SUFFIX: 'PAYMENTS_VPA_SUFFIX',
    // HMAC key for dynamic (amount-bearing) QR codes. A dynamic QR IS a payment
    // instruction, so an unsigned one can be edited in transit. Falls back to
    // FIELD_ENCRYPTION_KEY so a dev environment is never silently unsigned.
    QR_SIGNING_SECRET: 'PAYMENTS_QR_SIGNING_SECRET',
    // Live FX mid-rates. When absent, FALLBACK_MID_RATES in payments.config.ts
    // is used and every quote is stamped `rateSource: "static"` — an honest
    // label, so a receipt never implies a market rate we did not fetch.
    FX_API_URL: 'PAYMENTS_FX_API_URL',
    FX_API_KEY: 'PAYMENTS_FX_API_KEY',
    // Per-provider webhook signing secrets, resolved as
    // `PAYMENTS_WEBHOOK_SECRET_<PROVIDER>` (upper-cased).
    WEBHOOK_SECRET_PREFIX: 'PAYMENTS_WEBHOOK_SECRET_',
    // Simulator behaviour. These exist so the NASTY cases are demonstrable on
    // demand rather than only in production: a forced failure, a slow
    // settlement, and the money-losing "late SUCCESS after we timed out".
    SIM: {
      // Percent (0–100) of submissions the rail rejects outright.
      FAIL_PERCENT: 'PAYMENTS_SIM_FAIL_PERCENT',
      // Percent that never answer at all — these become DEEMED.
      TIMEOUT_PERCENT: 'PAYMENTS_SIM_TIMEOUT_PERCENT',
      // Milliseconds a PENDING transfer takes to settle.
      SETTLE_DELAY_MS: 'PAYMENTS_SIM_SETTLE_DELAY_MS',
      // Force the next submission down a specific path, for a scripted demo:
      // 'success' | 'pending' | 'fail' | 'timeout' | 'late-success'.
      FORCE_OUTCOME: 'PAYMENTS_SIM_FORCE_OUTCOME',
    },
  },
  // M5 — Micro-insurance (usage-based cover · reputation-priced · claims).
  // The UNDERWRITING literals — band multipliers, the confidence gate, waiting
  // periods, the auto-approve ceiling, the tamper threshold — are deliberately
  // NOT here. They live in src/modules/insurance/insurance.config.ts, because a
  // pricing multiplier is not configuration: it decides what a policyholder
  // pays, and it must not be changeable by editing an env file on a server. What
  // remains here is credentials and provider selection.
  INSURANCE: {
    // Which insurer carries the risk: 'mock' (default — the demonstration
    // insurer) | 'acko' | 'digit'. Any non-mock value is REFUSED at startup
    // until a real InsurerProvider exists, rather than silently downgraded —
    // an operator who selected a live insurer and got mock policy references
    // would discover it when a policyholder claimed.
    MODE: 'INSURER_MODE',
    // HMAC secret for verifying insurer status callbacks. Signed over the RAW
    // request body. Falls back to a development value with a loud warning, so
    // the signed-webhook path is always exercised.
    WEBHOOK_SECRET: 'INSURER_WEBHOOK_SECRET',
    // Document extraction: 'dev' (default — deterministic, CI-safe, and the way
    // the forged-document demo is triggered) | 'gvision' | 'textract'.
    OCR_MODE: 'OCR_MODE',
    GOOGLE_VISION_KEY: 'GOOGLE_VISION_KEY',
    AWS_TEXTRACT_REGION: 'AWS_TEXTRACT_REGION',
    // HCX (Health Claims Exchange) — ROADMAP. Unset by default, and that is what
    // makes MockHcxProvider report itself unconfigured: the health-claim
    // exchange leg is then SKIPPED visibly rather than answering with a
    // fabricated request id on a real claim. Joining HCX needs participant
    // onboarding and a registered JWS key, neither of which is code.
    HCX: {
      BASE_URL: 'HCX_BASE_URL',
      PARTICIPANT_CODE: 'HCX_PARTICIPANT_CODE',
      PRIVATE_KEY: 'HCX_PRIVATE_KEY',
    },
    // ABDM / ABHA health identity — ROADMAP. `Policy.abhaRef` is a column so the
    // linkage is designed in; nothing in the build depends on it.
    ABDM: {
      CLIENT_ID: 'ABDM_CLIENT_ID',
      CLIENT_SECRET: 'ABDM_CLIENT_SECRET',
    },
  },
  // M6 — Fraud & Risk (the cross-cutting shield).
  //
  // The RISK literals — signal weights, decision thresholds, velocity caps,
  // cooling-off windows — are deliberately NOT here. They live in
  // src/modules/fraud/fraud.config.ts, because a fraud threshold is not
  // configuration: it decides whose money gets stopped, and it must not be
  // changeable by editing an env file on a server. Same rule M4 applies to
  // payment limits and M5 to pricing multipliers. What remains here is secrets,
  // provider selection, and the demo triggers.
  FRAUD: {
    // Keyed-hash secret for every cross-user identifier M6 stores (the mule
    // graph's edges, watchlist entries, login-attempt identifiers). Falls back
    // to FIELD_ENCRYPTION_KEY so no environment is ever accidentally unsalted,
    // but it deserves its own value: rotating this key orphans every EntityLink
    // and ListEntry ever written, because the new hash of a listed VPA will not
    // match the old one and a sanctions list silently stops matching. Rotating
    // it is a data migration, not a config change. See risk-hash.util.ts.
    HASH_KEY: 'RISK_HASH_KEY',
    // Which telco answers SIM-swap questions: 'dev' (default — deterministic and
    // CI-safe) | a carrier/aggregator name. Any non-dev value is REFUSED at
    // startup until a real TelcoProvider exists, rather than silently
    // downgraded: an operator who selected a live carrier and got the dev stub
    // would believe SIM-swap detection was corroborated when it was not.
    TELCO_MODE: 'TELCO_MODE',
    // HMAC secret for verifying telco SIM-change callbacks, signed over the RAW
    // request body. A callback that can flip a device into SUSPECTED_SWAP is an
    // authenticated endpoint by any reasonable reading — an unauthenticated one
    // lets anybody freeze anybody's payments.
    TELCO_WEBHOOK_SECRET: 'TELCO_WEBHOOK_SECRET',
    // DEMO TRIGGER: set to a device's stored simSerialHash (or the literal '*')
    // and DevTelcoProvider reports a SIM re-issue, driving the full
    // SUSPECTED_SWAP → cooling-off → step-up path live. Exists so the nastiest
    // case in the module is demonstrable on demand rather than only in
    // production — the same reasoning as PAYMENTS_SIM_FORCE_OUTCOME.
    SIM_SWAP_HASH: 'FRAUD_SIM_SWAP_HASH',
    // DEV-ONLY: echo generated step-up OTPs in the issue response. Lets the
    // step-up path be exercised without an SMS channel. Refused when
    // NODE_ENV=production, because an API that returns its own OTP is not a
    // second factor at all.
    ECHO_STEP_UP_OTP: 'FRAUD_ECHO_STEP_UP_OTP',
  },
  // Singpass Myinfo v4 (Singapore KYC rail — production/UAT). Only wired when
  // RealSingpassProvider replaces the persona provider. See
  // src/config/singpass.config.ts for non-secret literals (endpoints/scopes).
  SINGPASS: {
    CLIENT_ID: 'SINGPASS_CLIENT_ID',
    REDIRECT_URI: 'SINGPASS_REDIRECT_URI',
    AUTHORIZE_URL: 'SINGPASS_AUTHORIZE_URL',
    TOKEN_URL: 'SINGPASS_TOKEN_URL',
    PERSON_URL: 'SINGPASS_PERSON_URL',
    JWKS_URL: 'SINGPASS_JWKS_URL', // Singpass public JWKS (verifies the data JWS)
    SIG_PRIVATE_JWK: 'SINGPASS_SIG_PRIVATE_JWK', // base64 JWK (ES256) — client assertion + DPoP
    ENC_PRIVATE_JWK: 'SINGPASS_ENC_PRIVATE_JWK', // base64 JWK — decrypts the Person JWE
    SIG_KID: 'SINGPASS_SIG_KID', // key id published in your client JWKS
    SCOPES: 'SINGPASS_SCOPES', // space-separated Myinfo attributes (optional override)
    PURPOSE_ID: 'SINGPASS_PURPOSE_ID',
  },
} as const
