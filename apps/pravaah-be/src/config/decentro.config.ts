/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  DECENTRO — single source of truth for every vendor-specific literal.      │
 * │                                                                            │
 * │  These paths / header names / response fields / status codes are          │
 * │  production-SHAPED (Decentro v2 KYC module, staging host                   │
 * │  `in.staging.decentro.tech`). CONFIRM the exact values against your        │
 * │  dashboard's API reference at https://docs.decentro.tech and edit ONLY     │
 * │  this file — the provider, error mapping, retries and state handling all   │
 * │  stay unchanged.                                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** Decentro's success responseCode. CONFIRM. */
export const DECENTRO_SUCCESS_CODE = 'S00000'

/** Endpoint paths (relative to DECENTRO_BASE_URL). CONFIRM each. */
export const DECENTRO_PATHS = {
  PAN_VERIFY: '/v2/kyc/pan',
  DIGILOCKER_INITIATE: '/v2/kyc/digilocker/initiate_session',
  DIGILOCKER_FETCH: '/v2/kyc/digilocker/fetch_documents',
  BANK_ACCOUNT_VERIFY: '/v2/banking/account_verification',
} as const

/** Auth header names Decentro expects. CONFIRM casing/spelling. */
export const DECENTRO_HEADERS = {
  CLIENT_ID: 'client_id',
  CLIENT_SECRET: 'client_secret',
  MODULE_SECRET: 'module_secret',
} as const

/**
 * Response field names we read out of `data`. Decentro has varied these across
 * versions, so we tolerate several aliases per field. CONFIRM and prune to the
 * ones your account actually returns.
 */
export const DECENTRO_FIELDS: {
  PAN_STATUS_VALUES_VALID: readonly string[]
  ACCOUNT_STATUS_VALID: string
} = {
  PAN_STATUS_VALUES_VALID: ['VALID', 'ACTIVE'],
  ACCOUNT_STATUS_VALID: 'VALID',
}
