/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SINGPASS MYINFO v4 — non-secret literals.                                 │
 * │                                                                            │
 * │  Endpoints, keys and purpose id come from env (see ENV.SINGPASS); this     │
 * │  file holds only the request-shaping constants. CONFIRM every value        │
 * │  against the Singpass Myinfo v4 developer docs / your onboarded app        │
 * │  (the exact scope attribute names, signing/encryption algs, and the DPoP   │
 * │  requirement differ between the sandbox and production tenants).           │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** OAuth/OIDC + crypto algorithms. CONFIRM against your app registration. */
export const SINGPASS_ALGS = {
  /** Client assertion + DPoP proof signature. */
  SIGNING: 'ES256',
  /** JWE key-management alg used to encrypt the Person response to us. */
  ENC_ALG: 'ECDH-ES+A256KW',
  /** JWE content-encryption alg. */
  ENC_ENC: 'A256GCM',
} as const

/**
 * Myinfo attributes requested (OAuth `scope`). CONFIRM the exact attribute
 * names available to your app; unavailable attributes cause the authorize call
 * to fail. This default set is enough to satisfy the M0 MyinfoResult mapping.
 */
export const SINGPASS_DEFAULT_SCOPES = [
  'uinfin',
  'name',
  'dob',
  'nationality',
  'regadd',
  'occupation',
] as const

export const SINGPASS_RESPONSE_TYPE = 'code'
export const SINGPASS_GRANT_TYPE = 'authorization_code'
export const SINGPASS_CLIENT_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Client assertion lifetime (seconds). */
export const SINGPASS_ASSERTION_TTL_SECONDS = 120
