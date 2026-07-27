import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { httpJson } from '@/common/http/http-client'
import { Err, Ok, Result } from '@/common/result/result'

import {
  SETU_AA_DEFAULTS,
  SETU_AA_HEADERS,
  SETU_AA_PATHS,
  setuWebviewUrl,
} from '@/modules/consent/providers/aa/setu-aa.config'
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

interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * Setu AA (LIVE). Auth verified live: OAuth token at `uat.setu.co/api/v2/auth/
 * token` ({clientID, secret} → data.token), then `Authorization: Bearer` +
 * `x-product-instance-id` on FIU calls. Uses Setu's decrypted-fetch
 * (`format: json`) so we never hand-roll ReBIT crypto.
 *
 * The FIU base URL is account-specific (Bridge "Step 2") — set SETU_AA_BASE_URL.
 * Literals live in `setu-aa.config.ts`. Selected when AA_MODE ∈ {setu, live}.
 */
@Injectable()
export class SetuAaProvider implements AccountAggregatorProvider {
  readonly name = 'setu'
  private readonly log = new Logger(SetuAaProvider.name)
  private token: CachedToken | null = null

  private get base(): string {
    return process.env.SETU_AA_BASE_URL ?? SETU_AA_DEFAULTS.BASE_URL
  }
  private get tokenUrl(): string {
    return process.env.SETU_AA_TOKEN_URL ?? SETU_AA_DEFAULTS.TOKEN_URL
  }
  private get clientId(): string {
    return process.env.SETU_AA_CLIENT_ID ?? ''
  }
  private get clientSecret(): string {
    // The provisioned env names the secret SETU_AA_SECRET_KEY; accept the
    // conventional SETU_AA_CLIENT_SECRET too.
    return (
      process.env.SETU_AA_SECRET_KEY ??
      process.env.SETU_AA_CLIENT_SECRET ??
      ''
    )
  }
  private get productId(): string {
    return process.env.SETU_AA_PRODUCT_ID ?? ''
  }

  /** True when the minimum credentials to attempt a call are present. */
  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.productId)
  }

  /** Fetch (and cache) an OAuth bearer token from Setu. */
  private async getToken(): Promise<Result<string>> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return Ok(this.token.token)
    }
    const res = await httpJson<{
      data?: { token?: string; expiresIn?: number }
      token?: string
      expiresIn?: number
    }>(
      {
        method: 'POST',
        url: this.tokenUrl,
        headers: { 'content-type': 'application/json' },
        data: { clientID: this.clientId, secret: this.clientSecret },
      },
      randomUUID(),
    )
    if (!res.ok) return res
    const token = res.value.data?.token ?? res.value.token
    const expiresIn = res.value.data?.expiresIn ?? res.value.expiresIn ?? 1800
    if (!token) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Setu token exchange returned no token',
          false,
          res.value,
        ),
      )
    }
    this.token = { token, expiresAt: Date.now() + expiresIn * 1000 }
    this.log.log(`Setu AA token acquired (expires in ${expiresIn}s)`)
    return Ok(token)
  }

  private async authHeaders(): Promise<Result<Record<string, string>>> {
    const t = await this.getToken()
    if (!t.ok) return t
    return Ok({
      'content-type': 'application/json',
      authorization: `Bearer ${t.value}`,
      [SETU_AA_HEADERS.PRODUCT_INSTANCE_ID]: this.productId,
    })
  }

  async createConsent(
    i: CreateConsentInput,
  ): Promise<Result<CreateConsentOutput>> {
    const h = await this.authHeaders()
    if (!h.ok) return h
    const body = {
      consentDuration: {
        unit: i.dataLife.unit === 'INF' ? 'YEAR' : i.dataLife.unit,
        value: String(i.dataLife.unit === 'INF' ? 99 : i.dataLife.value),
      },
      consentMode: i.consentMode,
      fetchType: i.fetchType,
      ...(i.frequency
        ? { Frequency: { unit: i.frequency.unit, value: i.frequency.value } }
        : {}),
      fiTypes: i.fiTypes,
      Purpose: { code: i.purposeCode, text: i.purpose, refUri: '', category: { type: 'string' } },
      vua: i.vua,
      dataRange: { from: i.dataRange.from, to: i.dataRange.to },
      context: [],
      additionalParams: {},
      redirectUrl: i.redirectUrl,
    }
    const res = await httpJson<{
      id?: string
      status?: string
      url?: string
    }>(
      {
        method: 'POST',
        url: `${this.base}${SETU_AA_PATHS.CONSENTS}`,
        headers: h.value,
        data: body,
      },
      randomUUID(),
    )
    if (!res.ok) return res
    const d = res.value
    if (!d.id) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Consent create failed',
          false,
          d,
        ),
      )
    }
    return Ok({
      providerConsentId: d.id,
      status: d.status ?? 'PENDING',
      approvalUrl: d.url ?? setuWebviewUrl(this.base, d.id),
    })
  }

  async getConsent(id: string): Promise<Result<ConsentStatusOutput>> {
    const h = await this.authHeaders()
    if (!h.ok) return h
    const res = await httpJson<{
      status: string
      ConsentArtefact?: string
      signedConsent?: string
      consentArtefactJws?: string
    }>(
      {
        method: 'GET',
        url: `${this.base}${SETU_AA_PATHS.CONSENT_BY_ID(id)}`,
        headers: h.value,
      },
      randomUUID(),
    )
    if (!res.ok) return res
    return Ok({
      status: res.value.status,
      signedArtefact:
        res.value.ConsentArtefact ??
        res.value.signedConsent ??
        res.value.consentArtefactJws,
    })
  }

  async revokeConsent(id: string): Promise<Result<void>> {
    const h = await this.authHeaders()
    if (!h.ok) return h
    const res = await httpJson<unknown>(
      {
        method: 'POST',
        url: `${this.base}${SETU_AA_PATHS.CONSENT_REVOKE(id)}`,
        headers: h.value,
      },
      randomUUID(),
    )
    return res.ok ? Ok(undefined) : res
  }

  async createSession(
    i: CreateSessionInput,
  ): Promise<Result<CreateSessionOutput>> {
    const h = await this.authHeaders()
    if (!h.ok) return h
    const res = await httpJson<{ id?: string; status?: string }>(
      {
        method: 'POST',
        url: `${this.base}${SETU_AA_PATHS.SESSIONS}`,
        headers: h.value,
        data: {
          consentId: i.providerConsentId,
          dataRange: i.dataRange,
          format: i.format,
        },
      },
      randomUUID(),
    )
    if (!res.ok) return res
    if (!res.value.id) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Session create failed',
          false,
          res.value,
        ),
      )
    }
    return Ok({
      providerSessionId: res.value.id,
      status: res.value.status ?? 'PENDING',
    })
  }

  async fetch(sessionId: string): Promise<Result<FetchOutput>> {
    const h = await this.authHeaders()
    if (!h.ok) return h
    const res = await httpJson<{
      status: FetchOutput['status']
      fips?: SetuFip[]
      fipTotal?: number
      fipCompleted?: number
    }>(
      {
        method: 'GET',
        url: `${this.base}${SETU_AA_PATHS.SESSION_BY_ID(sessionId)}`,
        headers: h.value,
      },
      randomUUID(),
    )
    if (!res.ok) return res
    const d = res.value

    // Setu shape: fips[].accounts[].data.account — one FipPayload per account.
    const fips: FipPayload[] = []
    for (const fip of d.fips ?? []) {
      const fipId = fip.fipID ?? fip.fipId ?? 'UNKNOWN'
      for (const acc of fip.accounts ?? []) {
        const account = acc.data?.account ?? acc.data
        fips.push({
          fipId,
          fiType: this.inferFiType(account, acc),
          decryptedJson: acc.data ?? account,
        })
      }
    }
    return Ok({
      status: d.status,
      fips,
      fipTotal: d.fipTotal,
      fipCompleted: d.fipCompleted,
    })
  }

  /** Map a Setu account block to our FiType enum (best-effort). */
  private inferFiType(account: unknown, acc: SetuAccount): string {
    const type = (
      (account as { type?: string })?.type ??
      acc.FIType ??
      acc.fiType ??
      'DEPOSIT'
    ).toUpperCase()
    switch (type) {
      case 'TERM_DEPOSIT':
      case 'TERM-DEPOSIT':
        return 'TERM_DEPOSIT'
      case 'RECURRING_DEPOSIT':
        return 'RECURRING_DEPOSIT'
      case 'MUTUAL_FUNDS':
      case 'MUTUALFUND':
        return 'MUTUAL_FUNDS'
      case 'EQUITIES':
        return 'EQUITIES'
      case 'GSTR':
        return 'GSTR'
      default:
        return 'DEPOSIT'
    }
  }

  verifyNotificationSignature(
    headers: Record<string, string>,
    rawBody: string,
  ): boolean {
    const sig = headers['x-jws-signature']
    if (!sig) return false
    return verifyArtefactSignature(
      sig.includes('..')
        ? sig.replace('..', `.${Buffer.from(rawBody).toString('base64url')}.`)
        : sig,
      process.env.SETU_AA_PUBLIC_KEY,
    )
  }
}

interface SetuAccount {
  data?: { account?: unknown }
  FIType?: string
  fiType?: string
}
interface SetuFip {
  fipID?: string
  fipId?: string
  accounts?: SetuAccount[]
}
