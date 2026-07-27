/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SETU AA — single source of truth for every vendor-specific literal.       │
 * │                                                                            │
 * │  Verified live (2026-07): auth is an OAuth token exchange at               │
 * │  `uat.setu.co/api/v2/auth/token` ({clientID, secret} → data.token), then   │
 * │  Bearer + x-product-instance-id on every FIU call. The FIU BASE URL is     │
 * │  account-specific — Setu shows it in your Bridge product "Step 2". The     │
 * │  public-docs default is `https://fiu-sandbox.setu.co`; override via        │
 * │  SETU_AA_BASE_URL. Endpoint paths/bodies below match Setu's AA API         │
 * │  (create consent → webview url → ACTIVE → /sessions → GET /sessions/:id    │
 * │  decrypted). CONFIRM at https://docs.setu.co/data/account-aggregator.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export const SETU_AA_DEFAULTS = {
  // OAuth token endpoint (Setu Bridge, Keycloak-backed). Sandbox default.
  TOKEN_URL: 'https://uat.setu.co/api/v2/auth/token',
  // FIU API base. Account-specific — override with SETU_AA_BASE_URL.
  BASE_URL: 'https://fiu-sandbox.setu.co',
} as const

/** Endpoint paths (relative to the FIU base URL). CONFIRM each. */
export const SETU_AA_PATHS = {
  CONSENTS: '/consents',
  CONSENT_BY_ID: (id: string) => `/consents/${id}?expanded=true`,
  CONSENT_REVOKE: (id: string) => `/v2/consents/${id}/revoke`,
  SESSIONS: '/sessions',
  SESSION_BY_ID: (id: string) => `/sessions/${id}`,
} as const

/** Headers Setu expects on FIU requests (bearer + product instance). */
export const SETU_AA_HEADERS = {
  PRODUCT_INSTANCE_ID: 'x-product-instance-id',
} as const

/** Build the consent-approval webview URL when the API doesn't return `url`. */
export const setuWebviewUrl = (base: string, consentRequestId: string): string =>
  `${base}/consents/webview/${consentRequestId}`
