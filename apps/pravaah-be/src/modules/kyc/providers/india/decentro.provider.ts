import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import {
  DECENTRO_BANK_PURPOSE,
  DECENTRO_CONSENT_PURPOSE,
  DECENTRO_DOCUMENT_TYPE_PAN,
  DECENTRO_VALIDATION_TYPE_PENNY_DROP,
  DECENTRO_KEY_OKYC_CODE_EXPIRED,
  DECENTRO_KEY_OKYC_SESSION_INCOMPLETE,
  DECENTRO_FIELDS,
  DECENTRO_HEADERS,
  DECENTRO_PATHS,
  DECENTRO_SUCCESS_CODE,
} from '@/config/decentro.config'
import { ENV } from '@/constants/environment.constants'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { httpJson } from '@/common/http/http-client'
import { Err, Ok, Result } from '@/common/result/result'

import {
  BankResult,
  IndiaKycProvider,
  OkycInitiate,
  OkycResult,
  PanResult,
} from '@/modules/kyc/providers/india/india-kyc.provider'

/**
 * LIVE Decentro (v2 KYC) implementation. Every vendor literal lives in
 * `decentro.config.ts`; this class owns only the request shaping, response
 * normalisation and error mapping. Each call passes a stable `reference_id`
 * (derived from the trace id) so Decentro can dedupe our retries.
 */
@Injectable()
export class DecentroProvider implements IndiaKycProvider {
  readonly id = 'decentro'

  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DecentroProvider.name })
  }

  private get baseUrl(): string {
    return this.config.getOrThrow<string>(ENV.DECENTRO.BASE_URL)
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      [DECENTRO_HEADERS.CLIENT_ID]: this.config.getOrThrow<string>(
        ENV.DECENTRO.CLIENT_ID,
      ),
      [DECENTRO_HEADERS.CLIENT_SECRET]: this.config.getOrThrow<string>(
        ENV.DECENTRO.CLIENT_SECRET,
      ),
      [DECENTRO_HEADERS.MODULE_SECRET]: this.config.getOrThrow<string>(
        ENV.DECENTRO.MODULE_SECRET,
      ),
    }
  }

  /**
   * PAN goes through the **v1** public-registry route, whose contract differs
   * from every other call here in three ways that all fail the request outright
   * if "corrected" to the v2 style: `consent` is the STRING `'Y'` (a boolean is
   * refused with `error_invalid_consent`), the purpose field is
   * `consent_purpose`, and the verdict comes back at the TOP level in
   * `kycResult` rather than under `data`.
   */
  async verifyPan(pan: string, traceId: string): Promise<Result<PanResult>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.PAN_VERIFY}`,
        headers: this.headers(),
        data: {
          reference_id: `pan_${traceId}`,
          consent: 'Y',
          consent_purpose: DECENTRO_CONSENT_PURPOSE,
          document_type: DECENTRO_DOCUMENT_TYPE_PAN,
          id_number: pan,
        },
      },
      traceId,
    )
    if (!res.ok) return res

    const d = res.value
    const result = d.kycResult ?? d.data
    const status = result?.idStatus ?? result?.status ?? result?.panStatus

    // A body that carries no verdict at all is an integration fault dressed as
    // HTTP 200 — report it as such rather than as a rejected PAN.
    if (d.responseCode !== DECENTRO_SUCCESS_CODE || !status) {
      return Err(
        new KycError(
          KycErrorCode.INTEGRATION_ERROR,
          typeof d.message === 'string' ? d.message : 'PAN check unavailable',
          false,
          d,
        ),
      )
    }

    if (
      !DECENTRO_FIELDS.PAN_STATUS_VALUES_VALID.includes(status.toUpperCase())
    ) {
      return Err(
        new KycError(KycErrorCode.PROVIDER_REJECTED, 'PAN invalid', false, d),
      )
    }
    return Ok({
      valid: true,
      name: result?.name ?? result?.registeredName ?? '',
    })
  }

  /**
   * `redirect_url` is OPTIONAL and deliberately omitted unless we have an
   * https one. Decentro's edge answers a bare HTML **403** — no JSON, no
   * responseKey — for any `http://` redirect, which is every local run
   * (`http://localhost:8000`, a LAN IP). That surfaced as an unexplainable
   * "Provider rejected request" on the Aadhaar step.
   *
   * Omitting it costs us nothing: our flow never relies on the redirect. The
   * app opens `authorizationUrl`, the user consents, then returns and taps to
   * finish, and {@link AadhaarOkycService.complete} fetches by `providerRefId`.
   * With an https `API_PUBLIC_URL` (staging/production) the auto-redirect comes
   * back automatically.
   */
  async initiateOkyc(
    _userRef: string,
    traceId: string,
  ): Promise<Result<OkycInitiate>> {
    const publicUrl = this.config.get<string>(ENV.API.PUBLIC_URL) ?? ''
    const redirectUrl = publicUrl.startsWith('https://')
      ? `${publicUrl}/api/v1/kyc/aadhaar/okyc/callback`
      : undefined
    if (!redirectUrl) {
      this.logger.info(
        `[${this.initiateOkyc.name}] No https API_PUBLIC_URL — omitting redirect_url`,
        { traceId },
      )
    }

    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.DIGILOCKER_INITIATE}`,
        headers: this.headers(),
        data: {
          reference_id: `okyc_${traceId}`,
          // Both are mandatory — omitting either is refused with
          // `error_empty_consent` / `error_empty_purpose` before a session is
          // ever created. This is the v2 envelope, so `consent` is a boolean.
          consent: true,
          consent_purpose: DECENTRO_CONSENT_PURPOSE,
          ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
        },
      },
      traceId,
    )
    if (!res.ok) return res

    const d = res.value
    if (d.responseCode !== DECENTRO_SUCCESS_CODE || !d.data?.authorizationUrl) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'DigiLocker init failed',
          true,
          d,
        ),
      )
    }
    return Ok({
      providerRefId: d.decentroTxnId ?? `okyc_${traceId}`,
      authorizationUrl: d.data.authorizationUrl,
    })
  }

  /**
   * Post-consent Aadhaar fetch. The session is identified by
   * `initial_decentro_transaction_id` — NOT `decentro_txn_id`, which the older
   * `fetch_documents` route wanted; that route falls through to the generic
   * public-registry validator on this account and answers "Invalid Identity
   * Document" for everything.
   *
   * **This is TWO calls, and the first one is not optional.** The DigiLocker
   * authorisation code must be exchanged at
   * {@link DECENTRO_PATHS.DIGILOCKER_EXCHANGE_CODE} before the session can be
   * read from. Skip it and every DigiLocker endpoint rejects the session with
   * `error_invalid_transaction_id` — byte-identical to the answer for a session
   * that never existed, and for one the user abandoned. That single overloaded
   * error cost a long investigation: a real consent, a real code on screen, and
   * a session the provider swore it had never heard of.
   *
   * Both calls carry the same `initial_decentro_transaction_id`; only the
   * exchange carries the code, under the name `digilocker_code`.
   */
  async fetchOkyc(
    providerRefId: string,
    traceId: string,
    code?: string,
  ): Promise<Result<OkycResult>> {
    /** Decentro's "that session id means nothing to me" answer. */
    const unknownSession = (e: KycError) =>
      (e.cause as { responseKey?: unknown } | undefined)?.responseKey ===
      DECENTRO_KEY_OKYC_SESSION_INCOMPLETE

    if (code) {
      const exchanged = await httpJson<DecentroEnvelope>(
        {
          method: 'POST',
          url: `${this.baseUrl}${DECENTRO_PATHS.DIGILOCKER_EXCHANGE_CODE}`,
          headers: this.headers(),
          data: {
            reference_id: `okyccode_${traceId}`,
            initial_decentro_transaction_id: providerRefId,
            digilocker_code: code,
            consent: true,
            consent_purpose: DECENTRO_CONSENT_PURPOSE,
          },
        },
        traceId,
      )

      if (!exchanged.ok) {
        const key = (
          exchanged.error.cause as { responseKey?: unknown } | undefined
        )?.responseKey

        /**
         * A lapsed code is the user's to recover from, and only by starting a
         * new session — the old one dies with its code. Reported as
         * INVALID_INPUT so the caller says that plainly instead of recording a
         * failed Aadhaar against someone who did nothing wrong.
         */
        if (key === DECENTRO_KEY_OKYC_CODE_EXPIRED) {
          return Err(
            new KycError(
              KycErrorCode.INVALID_INPUT,
              'That DigiLocker code has expired. Start a new DigiLocker session and use the code it gives you.',
              false,
              exchanged.error.cause,
            ),
          )
        }
        if (unknownSession(exchanged.error)) {
          return Err(
            new KycError(
              KycErrorCode.TIMEOUT,
              'DigiLocker consent not completed yet',
              true,
              exchanged.error.cause,
            ),
          )
        }
        return exchanged
      }
    }

    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.DIGILOCKER_FETCH}`,
        headers: this.headers(),
        data: {
          reference_id: `okycfetch_${traceId}`,
          initial_decentro_transaction_id: providerRefId,
          consent: true,
          consent_purpose: DECENTRO_CONSENT_PURPOSE,
        },
      },
      traceId,
    )

    if (!res.ok) {
      /**
       * "Session not valid/expired" is also how Decentro answers a user who has
       * not finished DigiLocker yet. It arrives as an HTTP 400, so `httpJson`
       * has already labelled it a broken integration — reclassify it as
       * retryable so the check stays PENDING and the user can resume, exactly
       * as the dev provider behaves for un-approved consent.
       */
      if (unknownSession(res.error)) {
        return Err(
          new KycError(
            KycErrorCode.TIMEOUT,
            'DigiLocker consent not completed yet',
            true,
            res.error.cause,
          ),
        )
      }
      return res
    }

    const d = res.value
    if (d.responseCode !== DECENTRO_SUCCESS_CODE || !d.data) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'OKYC fetch failed',
          true,
          d,
        ),
      )
    }
    // The eaadhaar success payload could not be captured without a consented
    // session, so every field is read through aliases and defaults rather than
    // assumed. Prune these once a real consent has been observed.
    const a = d.data
    const last4 = String(
      a.aadhaarLast4 ?? a.maskedAadhaarNumber ?? a.uid ?? '',
    ).slice(-4)
    return Ok({
      name: a.name ?? '',
      dob: a.dob ?? a.dateOfBirth ?? '',
      maskedAadhaar: `XXXX XXXX ${last4}`,
      address: a.address,
      photoBase64: a.photo ?? a.photoBase64,
    })
  }

  /**
   * Penny drop. This one is NOT a KYC-module call, which is the whole reason it
   * never worked:
   *
   *   - It lives in **Core Banking**, so it needs that module secret. The KYC
   *     secret earns `error_unauthorized_module`.
   *   - It needs a fourth header, `provider_secret`, naming the bank rail.
   *     Omitting it returns `E00039 Provider Not Authorized For Company`, which
   *     reads like an account entitlement problem and is really a missing
   *     header — that misreading is why this was written off as unfixable.
   *     It must be the secret for the bank holding the commission-debit
   *     account: Decentro resolves that account per (company, provider), so
   *     the wrong rail answers "you have not configured account details for
   *     the commission debits" even when the account plainly exists.
   *   - The account goes in a nested `beneficiary_details`, and the narration
   *     field is `purpose_message` (5–255 chars), not `purpose`.
   *
   * The verdict is at the TOP level here (`accountStatus`, `beneficiaryName`),
   * not under `data`.
   */
  async pennyDrop(
    account: string,
    ifsc: string,
    traceId: string,
  ): Promise<Result<BankResult>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.BANK_ACCOUNT_VERIFY}`,
        headers: this.bankHeaders(),
        data: {
          reference_id: `bank_${traceId}`,
          purpose_message: DECENTRO_BANK_PURPOSE,
          validation_type: DECENTRO_VALIDATION_TYPE_PENNY_DROP,
          beneficiary_details: { account_number: account, ifsc },
        },
      },
      traceId,
    )
    if (!res.ok) return res

    const d = res.value
    const result = d.data ?? d
    const status = (text(result.accountStatus) ?? '').toUpperCase()

    if (status !== DECENTRO_FIELDS.ACCOUNT_STATUS_VALID) {
      /**
       * `Inconclusive` means the bank did not answer, not that the account is
       * bad — retryable, so the check waits rather than failing the user for a
       * rail that was merely slow.
       */
      const inconclusive = status === 'INCONCLUSIVE' || status === ''
      return Err(
        new KycError(
          inconclusive ? KycErrorCode.TIMEOUT : KycErrorCode.PROVIDER_REJECTED,
          inconclusive
            ? 'The bank did not confirm the account in time'
            : 'Account not verified',
          inconclusive,
          d,
        ),
      )
    }
    return Ok({
      verified: true,
      registeredName:
        text(result.beneficiaryName) ?? text(result.nameAtBank) ?? '',
    })
  }

  /**
   * Core Banking auth. Falls back to the KYC module secret only so a partially
   * configured environment fails at the provider with a readable message
   * instead of throwing on startup.
   */
  private bankHeaders(): Record<string, string> {
    const providerSecret =
      this.config.get<string>(ENV.DECENTRO.BANK_PROVIDER_SECRET) ??
      this.config.get<string>(ENV.DECENTRO.BANK_PROVIDER_SECRET_YBL)
    return {
      ...this.headers(),
      [DECENTRO_HEADERS.MODULE_SECRET]:
        this.config.get<string>(ENV.DECENTRO.CORE_BANKING_MODULE_SECRET) ??
        this.config.getOrThrow<string>(ENV.DECENTRO.MODULE_SECRET),
      ...(providerSecret
        ? { [DECENTRO_HEADERS.PROVIDER_SECRET]: providerSecret }
        : {}),
    }
  }
}

/**
 * A field read off a loosely-typed envelope, only when it really is a string.
 * Coercing with `String()` would turn a nested object into the literal
 * "[object Object]" and hand that on as somebody's registered bank name.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Loosely-typed Decentro envelope covering BOTH generations: v2 nests the
 * payload under `data`, v1 puts it at the top level in `kycResult`. Fields are
 * optional because they vary by product/version — the provider guards every
 * access and each call site knows which shape it expects.
 */
interface DecentroPayload {
  status?: string
  idStatus?: string
  panStatus?: string
  accountStatus?: string
  name?: string
  registeredName?: string
  beneficiaryName?: string
  nameAtBank?: string
  authorizationUrl?: string
  aadhaarLast4?: string
  maskedAadhaarNumber?: string
  uid?: string
  dob?: string
  dateOfBirth?: string
  address?: string
  photo?: string
  photoBase64?: string
  [key: string]: unknown
}

interface DecentroEnvelope {
  decentroTxnId?: string
  status?: string
  responseCode?: string
  responseKey?: string
  message?: unknown
  /** v2 payload. */
  data?: DecentroPayload
  /** v1 payload (public-registry validate). */
  kycResult?: DecentroPayload
  [key: string]: unknown
}
