import { Injectable, Logger } from '@nestjs/common'
import { createSign, randomUUID } from 'crypto'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { httpJson } from '@/common/http/http-client'
import { Err, Ok, Result } from '@/common/result/result'

import { FINVU_DEFAULTS, FINVU_HEADERS, FINVU_PATHS } from '@/modules/consent/providers/aa/finvu-aa.config'
import { generateKeyMaterial } from '@/modules/consent/providers/aa/aa-crypto.util'
import { verifyArtefactSignature } from '@/modules/consent/providers/aa/artefact.util'
import type {
  AccountAggregatorProvider,
  ConsentStatusOutput,
  CreateConsentInput,
  CreateConsentOutput,
  CreateSessionInput,
  CreateSessionOutput,
  FetchOutput,
  FipPayload,
} from '@/modules/consent/providers/aa/aa.provider'

/**
 * Finvu (Finfactor · Finsense) AA — the drop-in FALLBACK for Setu. Implements
 * the same {@link AccountAggregatorProvider} contract, so switching is routing,
 * not a rewrite. Auth = `client_api_key` header + detached-JWS body signature.
 * Finvu hands back ENCRYPTED FI (ReBIT ECDH); we send ephemeral key material in
 * the FI request and self-decrypt via aa-crypto.util (DataSessionService).
 *
 * Selected when AA_MODE ∈ {finvu, live-fallback}. Needs FINVU_* env + Sahamati
 * onboarding to run live — see finvu-aa.config.ts.
 */
@Injectable()
export class FinvuAaProvider implements AccountAggregatorProvider {
  readonly name = 'finvu'
  private readonly log = new Logger(FinvuAaProvider.name)

  private get base(): string {
    return process.env.FINVU_BASE_URL ?? FINVU_DEFAULTS.BASE_URL
  }
  private get apiKey(): string {
    return process.env.FINVU_API_KEY ?? ''
  }
  private get signingKey(): string {
    return (process.env.FINVU_JWS_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')
  }
  private get aaHandle(): string {
    return process.env.AA_HANDLE ?? 'finvu'
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.signingKey)
  }

  /** Detached JWS (RS256, b64:false) over the request body. */
  private sign(body: string): string {
    if (!this.signingKey) return ''
    try {
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', b64: false, crit: ['b64'] }),
      ).toString('base64url')
      const signer = createSign('RSA-SHA256')
      signer.update(`${header}.${body}`)
      signer.end()
      return `${header}..${signer.sign(this.signingKey).toString('base64url')}`
    } catch (e) {
      this.log.error('Finvu JWS signing failed', e as Error)
      return ''
    }
  }

  private headers(body: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      [FINVU_HEADERS.API_KEY]: this.apiKey,
      [FINVU_HEADERS.JWS_SIGNATURE]: this.sign(body),
    }
  }

  private guard(): Result<void> {
    return this.isConfigured()
      ? Ok(undefined)
      : Err(
          new KycError(
            KycErrorCode.PROVIDER_DOWN,
            'Finvu is not configured (FINVU_API_KEY / FINVU_JWS_PRIVATE_KEY)',
            false,
          ),
        )
  }

  async createConsent(
    i: CreateConsentInput,
  ): Promise<Result<CreateConsentOutput>> {
    const g = this.guard()
    if (!g.ok) return g
    const body = JSON.stringify({
      ver: '1.1.2',
      timestamp: new Date().toISOString(),
      txnid: randomUUID(),
      ConsentDetail: {
        consentStart: new Date().toISOString(),
        consentExpiry: i.consentExpiry,
        Customer: { id: i.vua },
        FIDataRange: { from: i.dataRange.from, to: i.dataRange.to },
        consentMode: i.consentMode,
        fetchType: i.fetchType,
        consentTypes: ['TRANSACTIONS', 'PROFILE', 'SUMMARY'],
        fiTypes: i.fiTypes,
        DataConsumer: { id: process.env.FINVU_FIU_ID ?? '' },
        Purpose: {
          code: i.purposeCode,
          refUri: 'https://api.rebit.org.in/aa/purpose/101.xml',
          text: i.purpose,
          Category: { type: 'string' },
        },
        DataLife: { unit: i.dataLife.unit, value: i.dataLife.value },
        Frequency: i.frequency
          ? { unit: i.frequency.unit, value: i.frequency.value }
          : { unit: 'MONTH', value: 1 },
      },
    })
    const res = await httpJson<{
      ConsentHandle?: string
      consentHandle?: string
      redirectUrl?: string
      url?: string
    }>(
      {
        method: 'POST',
        url: `${this.base}${FINVU_PATHS.CONSENT_REQUEST}`,
        headers: this.headers(body),
        data: JSON.parse(body),
      },
      randomUUID(),
    )
    if (!res.ok) return res
    const handle = res.value.ConsentHandle ?? res.value.consentHandle
    if (!handle) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Finvu consent request failed',
          false,
          res.value,
        ),
      )
    }
    return Ok({
      providerConsentId: handle,
      status: 'PENDING',
      approvalUrl:
        res.value.redirectUrl ??
        res.value.url ??
        `https://webvwr.finvu.in/consent/${handle}`,
    })
  }

  async getConsent(id: string): Promise<Result<ConsentStatusOutput>> {
    const g = this.guard()
    if (!g.ok) return g
    const res = await httpJson<{
      ConsentStatus?: { status?: string; id?: string }
      status?: string
      signedConsent?: string
    }>(
      {
        method: 'GET',
        url: `${this.base}${FINVU_PATHS.CONSENT_STATUS(id)}`,
        headers: this.headers(''),
      },
      randomUUID(),
    )
    if (!res.ok) return res
    return Ok({
      status: res.value.ConsentStatus?.status ?? res.value.status ?? 'PENDING',
      signedArtefact: res.value.signedConsent,
    })
  }

  async revokeConsent(id: string): Promise<Result<void>> {
    const g = this.guard()
    if (!g.ok) return g
    const body = JSON.stringify({
      ver: '1.1.2',
      timestamp: new Date().toISOString(),
      txnid: randomUUID(),
      consentId: id,
    })
    const res = await httpJson<unknown>(
      {
        method: 'POST',
        url: `${this.base}${FINVU_PATHS.CONSENT_REVOKE}`,
        headers: this.headers(body),
        data: JSON.parse(body),
      },
      randomUUID(),
    )
    return res.ok ? Ok(undefined) : res
  }

  async createSession(
    i: CreateSessionInput,
  ): Promise<Result<CreateSessionOutput>> {
    const g = this.guard()
    if (!g.ok) return g
    // Generate ephemeral ECDH key material; Finvu encrypts FI to our public key.
    const km = generateKeyMaterial()
    const body = JSON.stringify({
      ver: '1.1.2',
      timestamp: new Date().toISOString(),
      txnid: randomUUID(),
      FIDataRange: i.dataRange,
      Consent: { id: i.providerConsentId },
      KeyMaterial: {
        cryptoAlg: 'ECDH',
        curve: 'Curve25519',
        params: '',
        DHPublicKey: {
          expiry: new Date(Date.now() + 3600_000).toISOString(),
          Parameters: '',
          KeyValue: km.publicKey,
        },
        Nonce: km.nonce,
      },
    })
    const res = await httpJson<{
      sessionId?: string
      sessionStatus?: string
    }>(
      {
        method: 'POST',
        url: `${this.base}${FINVU_PATHS.FI_REQUEST}`,
        headers: this.headers(body),
        data: JSON.parse(body),
      },
      randomUUID(),
    )
    if (!res.ok) return res
    if (!res.value.sessionId) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Finvu FI request failed',
          false,
          res.value,
        ),
      )
    }
    return Ok({
      providerSessionId: res.value.sessionId,
      status: res.value.sessionStatus ?? 'PENDING',
      // Stored field-encrypted; DataSessionService.selfDecrypt uses it later.
      keyMaterialPrivate: JSON.stringify(km),
    })
  }

  async fetch(sessionId: string): Promise<Result<FetchOutput>> {
    const g = this.guard()
    if (!g.ok) return g
    const res = await httpJson<{
      FI?: FinvuFi[]
      status?: FetchOutput['status']
    }>(
      {
        method: 'GET',
        url: `${this.base}${FINVU_PATHS.FI_FETCH(sessionId)}`,
        headers: this.headers(''),
      },
      randomUUID(),
    )
    if (!res.ok) return res
    const fips: FipPayload[] = []
    for (const fi of res.value.FI ?? []) {
      for (const d of fi.data ?? []) {
        fips.push({
          fipId: fi.fipID ?? 'UNKNOWN',
          fiType: (fi.FIType ?? 'DEPOSIT').toUpperCase(),
          encrypted: d.encryptedFI,
          keyMaterial: fi.KeyMaterial,
        })
      }
    }
    return Ok({
      status: res.value.status ?? 'COMPLETED',
      fips,
      fipTotal: res.value.FI?.length,
      fipCompleted: res.value.FI?.length,
    })
  }

  verifyNotificationSignature(
    headers: Record<string, string>,
    rawBody: string,
  ): boolean {
    // Verify Finvu's detached JWS against FINVU_PUBLIC_KEY when configured;
    // without a key we cannot verify, so defer to the HMAC guard (return true).
    const sig = headers[FINVU_HEADERS.JWS_SIGNATURE]
    if (!sig) return false
    if (!process.env.FINVU_PUBLIC_KEY) return true
    return verifyArtefactSignature(
      sig.includes('..')
        ? sig.replace('..', `.${Buffer.from(rawBody).toString('base64url')}.`)
        : sig,
      process.env.FINVU_PUBLIC_KEY,
    )
  }
}

interface FinvuFi {
  fipID?: string
  FIType?: string
  KeyMaterial?: unknown
  data?: { encryptedFI?: string }[]
}
