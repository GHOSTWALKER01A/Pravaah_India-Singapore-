/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  FINVU (Finfactor · Finsense) AA — vendor literals in one place.           │
 * │                                                                            │
 * │  Doc: https://docs.finfactor.in/finsense                                   │
 * │  Auth per doc: `client_api_key` header on every call + `x-jws-signature`   │
 * │  (detached JWS of the body). Going live needs Sahamati participant         │
 * │  registration + Finvu UAT access + a registered JWS signing keypair —      │
 * │  set FINVU_* env vars. Endpoint paths follow the ReBIT/Sahamati FIU spec;  │
 * │  CONFIRM exact literals against your Finvu Finsense console before live.   │
 * │                                                                            │
 * │  Finvu returns ENCRYPTED FI (ReBIT ECDH) — we self-decrypt via             │
 * │  aa-crypto.util using the ephemeral key material we send in the FI request.│
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export const FINVU_DEFAULTS = {
  // FIU sandbox base — CONFIRM against your Finsense console.
  BASE_URL: 'https://finsense.finvu.in/ConnectHub/FI',
} as const

/** Endpoint paths (relative to the base URL). CONFIRM each. */
export const FINVU_PATHS = {
  CONSENT_REQUEST: '/consentRequestPlus',
  CONSENT_STATUS: (handleOrId: string) => `/consentStatus/${handleOrId}`,
  CONSENT_REVOKE: '/consentRevoke',
  FI_REQUEST: '/fiRequest',
  FI_FETCH: (sessionId: string) => `/fiFetch/${sessionId}`,
} as const

export const FINVU_HEADERS = {
  API_KEY: 'client_api_key',
  JWS_SIGNATURE: 'x-jws-signature',
} as const
