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
    MODULE_SECRET: 'DECENTRO_MODULE_SECRET',
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
