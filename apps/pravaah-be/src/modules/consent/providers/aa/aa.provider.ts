import type { Result } from '@/common/result/result'

/**
 * Account Aggregator rail (M1). Every consent/data operation hides behind this
 * interface; concrete providers (Sandbox / Setu / Finvu) are resolved per
 * consent by {@link AaProviderRegistry}. The consent lifecycle, crypto,
 * normalisation, and data-life logic depend only on this contract.
 */
export interface CreateConsentInput {
  vua: string
  purpose: string
  purposeCode: string
  consentMode: 'VIEW' | 'STORE' | 'QUERY' | 'STREAM'
  fetchType: 'ONETIME' | 'PERIODIC'
  frequency?: { unit: 'DAY' | 'MONTH'; value: number }
  fiTypes: string[]
  dataRange: { from: string; to: string }
  dataLife: { unit: 'MONTH' | 'YEAR' | 'INF'; value: number }
  consentExpiry: string // ISO
  redirectUrl: string
}

export interface CreateConsentOutput {
  providerConsentId: string
  status: string
  approvalUrl: string
}

export interface ConsentStatusOutput {
  status: string
  signedArtefact?: string
}

export interface CreateSessionInput {
  providerConsentId: string
  dataRange: { from: string; to: string }
  format: 'json' | 'xml'
}

export interface CreateSessionOutput {
  providerSessionId: string
  status: string
  /** Present only for self-decrypt providers (field-encrypted before storage). */
  keyMaterialPrivate?: string
}

/** One FIP's slice of a data session. */
export interface FipPayload {
  fipId: string
  fiType: string
  /** Present when the provider decrypts for us (Setu decrypted-fetch / sandbox). */
  decryptedJson?: unknown
  /** Present only when we must self-decrypt (ReBIT ECDH). */
  encrypted?: string
  keyMaterial?: unknown
}

export interface FetchOutput {
  status: 'PENDING' | 'PARTIAL' | 'COMPLETED'
  fips: FipPayload[]
  fipTotal?: number
  fipCompleted?: number
}

export interface AccountAggregatorProvider {
  /** Stable id persisted on `Consent.aaProvider` for per-consent routing. */
  readonly name: string
  /** True when the credentials needed to attempt a live call are present. */
  isConfigured?(): boolean
  createConsent(i: CreateConsentInput): Promise<Result<CreateConsentOutput>>
  getConsent(providerConsentId: string): Promise<Result<ConsentStatusOutput>>
  revokeConsent(providerConsentId: string): Promise<Result<void>>
  createSession(i: CreateSessionInput): Promise<Result<CreateSessionOutput>>
  fetch(providerSessionId: string): Promise<Result<FetchOutput>>
  /** Verify the AA's detached-JWS signature on an inbound notification. */
  verifyNotificationSignature(
    headers: Record<string, string>,
    rawBody: string,
  ): boolean
}
