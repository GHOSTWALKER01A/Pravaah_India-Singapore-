/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  DECENTRO — single source of truth for every vendor-specific literal.      │
 * │                                                                            │
 * │  VERIFIED against the live staging host `in.staging.decentro.tech` on      │
 * │  2026-07-30 with the Pravaah account's KYC & Onboarding module secret.     │
 * │  The provider, error mapping, retries and state handling depend only on    │
 * │  this file — a vendor/version change is an edit HERE, nowhere else.        │
 * │                                                                            │
 * │  Decentro mixes TWO envelope generations and the KYC rail needs both:      │
 * │    v1 (`/kyc/...`)     → verdict at the TOP level (`kycResult`, `kycStatus`)│
 * │                          and `consent` is a STRING ("Y").                  │
 * │    v2 (`/v2/kyc/...`)  → verdict under `data`, `consent` is a BOOLEAN.     │
 * │  Do NOT "tidy" PAN onto /v2: `/v2/kyc/public_registry/validate` answers    │
 * │  `error_invalid_document_type` for EVERY document type on this account,    │
 * │  and `/v2/kyc/pan` does not exist (404). Both surface to the user as       │
 * │  "the income-tax database did not recognise that PAN".                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** Decentro's success responseCode (shared by both envelope generations). */
export const DECENTRO_SUCCESS_CODE = 'S00000'

/**
 * Endpoint paths (relative to DECENTRO_BASE_URL).
 *
 * PAN_VERIFY is the **v1** public-registry route on purpose — see the header.
 * BANK_ACCOUNT_VERIFY is the only banking path that resolves, but this account
 * answers `E00039 Provider Not Authorized For Company`; penny-drop stays blocked
 * until Decentro enables the provider, and no code change fixes that.
 */
export const DECENTRO_PATHS = {
  PAN_VERIFY: '/kyc/public_registry/validate',
  DIGILOCKER_INITIATE: '/v2/kyc/digilocker/initiate_session',
  /**
   * Exchanges the DigiLocker authorisation code for an access token bound to
   * the session. MANDATORY and easy to miss: until it succeeds, the session is
   * not consented as far as every other DigiLocker endpoint is concerned, and
   * they all reject it with `error_invalid_transaction_id` — the same answer
   * they give for a session that never existed.
   *
   * Note the `/code` suffix. `/v2/kyc/digilocker/access_token` without it is a
   * different endpoint that authenticates with an OTP instead.
   */
  DIGILOCKER_EXCHANGE_CODE: '/v2/kyc/digilocker/access_token/code',
  DIGILOCKER_FETCH: '/v2/kyc/digilocker/eaadhaar',
  BANK_ACCOUNT_VERIFY: '/core_banking/money_transfer/validate_account',
} as const

/**
 * Decentro validates the consent purpose as a 20–50 character string and
 * rejects the whole request outside that band (`error_long_purpose_length` /
 * `error_empty_purpose`). Keep any edit inside it.
 */
export const DECENTRO_CONSENT_PURPOSE = 'Customer KYC identity check'

/** `document_type` for the public-registry validate call. */
export const DECENTRO_DOCUMENT_TYPE_PAN = 'PAN'

/**
 * PAN_VERIFY's own timeout budget, deliberately far above the 15s default.
 *
 * This route proxies the income-tax department's registry, so its tail latency
 * belongs to that database rather than to Decentro — the edge answers an
 * unauthenticated probe in ~450ms while a validate call can stall well past 15s.
 * The default budget turned that stall into `TIMEOUT / "Provider timeout"` on a
 * PAN that was never actually checked.
 *
 * Paired with `maxRetries: 0` at the call site on purpose. Retrying a slow
 * government lookup does not make it faster, and the old 3-attempt ladder cost
 * the user ~47s (15s + 0.6s + 15s + 1.2s + 15s) before reporting failure —
 * longer than simply waiting once. A single 30s attempt fails sooner in the
 * worst case and succeeds in the window that previously timed out. The check is
 * left PENDING and retryable, so a genuine blip is recovered by the next
 * attempt rather than by hammering the registry inside one request.
 */
export const DECENTRO_PAN_TIMEOUT_MS = 30_000

/**
 * `responseKey` every DigiLocker endpoint returns for a session it will not
 * act on. It arrives as an HTTP 400, which would otherwise be classified as a
 * broken integration — it is neither that nor a rejected Aadhaar, just "not
 * usable yet", so the check stays retryable.
 *
 * It is NOT diagnostic. A session that never existed, one the user has not
 * consented on, and one whose code has not been exchanged all produce this
 * exact key — which is what made the missing exchange step so hard to see.
 */
export const DECENTRO_KEY_OKYC_SESSION_INCOMPLETE =
  'error_invalid_transaction_id'

/**
 * The DigiLocker authorisation code is single-use and short-lived. Once it
 * lapses the session cannot be revived either, so the user has to start a new
 * one — this must reach them as instructions, never as a failed Aadhaar.
 */
export const DECENTRO_KEY_OKYC_CODE_EXPIRED = 'error_invalid_auth_code'

/** Auth header names Decentro expects. CONFIRM casing/spelling. */
export const DECENTRO_HEADERS = {
  CLIENT_ID: 'client_id',
  CLIENT_SECRET: 'client_secret',
  MODULE_SECRET: 'module_secret',
  /** Core Banking only — the bank rail behind account validation. */
  PROVIDER_SECRET: 'provider_secret',
} as const

/**
 * `validation_type` for account validation. `pennydrop` credits ₹1 by IMPS and
 * reads the name the bank returns; `penniless` asks without moving money.
 * Penny drop is chosen because the ₹1 credit is what proves the account can
 * actually RECEIVE — a penniless check can pass for an account that cannot.
 */
export const DECENTRO_VALIDATION_TYPE_PENNY_DROP = 'pennydrop'

/**
 * `purpose_message` must be 5–255 characters; outside that the whole request is
 * refused before the account is ever looked at.
 */
export const DECENTRO_BANK_PURPOSE = 'Account verification for KYC'

/**
 * Response field VALUES we branch on. Decentro has varied these across
 * versions, so we tolerate several aliases per field.
 *
 * PAN: v1 returns `kycResult.idStatus: "VALID"` alongside `responseKey:
 * "success_pan"`.
 *
 * BANK: `accountStatus` is documented as `Valid` / `Invalid` / `nre_account` /
 * `Inconclusive` — mixed case, so every comparison here upper-cases first.
 * `Inconclusive` deliberately does NOT pass: the bank did not confirm the
 * account, and treating "we could not tell" as verified is how money reaches
 * an account nobody checked.
 */
export const DECENTRO_FIELDS: {
  PAN_STATUS_VALUES_VALID: readonly string[]
  ACCOUNT_STATUS_VALID: string
} = {
  PAN_STATUS_VALUES_VALID: ['VALID', 'ACTIVE'],
  ACCOUNT_STATUS_VALID: 'VALID',
}
