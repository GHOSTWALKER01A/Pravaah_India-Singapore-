import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import {
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

  async verifyPan(pan: string, traceId: string): Promise<Result<PanResult>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.PAN_VERIFY}`,
        headers: this.headers(),
        data: {
          reference_id: `pan_${traceId}`,
          pan,
          consent: true,
          purpose: 'KYC verification',
        },
      },
      traceId,
    )
    if (!res.ok) return res

    const d = res.value
    const status = d.data?.status ?? d.data?.panStatus
    const isValid =
      d.responseCode === DECENTRO_SUCCESS_CODE &&
      typeof status === 'string' &&
      DECENTRO_FIELDS.PAN_STATUS_VALUES_VALID.includes(status.toUpperCase())

    if (!isValid) {
      return Err(
        new KycError(KycErrorCode.PROVIDER_REJECTED, 'PAN invalid', false, d),
      )
    }
    return Ok({
      valid: true,
      name: d.data?.name ?? d.data?.registeredName ?? '',
    })
  }

  async initiateOkyc(
    _userRef: string,
    traceId: string,
  ): Promise<Result<OkycInitiate>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.DIGILOCKER_INITIATE}`,
        headers: this.headers(),
        data: {
          reference_id: `okyc_${traceId}`,
          redirect_url: `${this.config.getOrThrow<string>(
            ENV.API.PUBLIC_URL,
          )}/api/v1/kyc/aadhaar/okyc/callback`,
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

  async fetchOkyc(
    providerRefId: string,
    traceId: string,
  ): Promise<Result<OkycResult>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.DIGILOCKER_FETCH}`,
        headers: this.headers(),
        data: {
          reference_id: `okycfetch_${traceId}`,
          decentro_txn_id: providerRefId,
          document_type: 'AADHAAR',
        },
      },
      traceId,
    )
    if (!res.ok) return res

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
    const a = d.data
    const last4 = String(a.aadhaarLast4 ?? a.uid ?? '').slice(-4)
    return Ok({
      name: a.name ?? '',
      dob: a.dob ?? '',
      maskedAadhaar: `XXXX XXXX ${last4}`,
      address: a.address,
      photoBase64: a.photo,
    })
  }

  async pennyDrop(
    account: string,
    ifsc: string,
    traceId: string,
  ): Promise<Result<BankResult>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl}${DECENTRO_PATHS.BANK_ACCOUNT_VERIFY}`,
        headers: this.headers(),
        data: {
          reference_id: `bank_${traceId}`,
          account_number: account,
          ifsc,
          consent: true,
          purpose: 'KYC',
        },
      },
      traceId,
    )
    if (!res.ok) return res

    const d = res.value
    if (
      d.responseCode !== DECENTRO_SUCCESS_CODE ||
      d.data?.accountStatus !== DECENTRO_FIELDS.ACCOUNT_STATUS_VALID
    ) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Account not verified',
          false,
          d,
        ),
      )
    }
    return Ok({
      verified: true,
      registeredName: d.data.beneficiaryName ?? d.data.nameAtBank ?? '',
    })
  }
}

/**
 * Loosely-typed Decentro envelope: `{ decentroTxnId, status, responseCode,
 * data }`. Fields are optional because they vary by product/version — the
 * provider guards every access. CONFIRM the concrete shape per endpoint.
 */
interface DecentroEnvelope {
  decentroTxnId?: string
  status?: string
  responseCode?: string
  data?: {
    status?: string
    panStatus?: string
    accountStatus?: string
    name?: string
    registeredName?: string
    beneficiaryName?: string
    nameAtBank?: string
    authorizationUrl?: string
    aadhaarLast4?: string
    uid?: string
    dob?: string
    address?: string
    photo?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}
