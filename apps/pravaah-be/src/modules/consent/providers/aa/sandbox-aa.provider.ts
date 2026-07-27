import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { Ok, Result } from '@/common/result/result'

import { dummyDepositStatement } from '@/modules/consent/providers/aa/fixtures/deposit-statement'
import { dummyGstr } from '@/modules/consent/providers/aa/fixtures/gstr'
import type {
  AccountAggregatorProvider,
  ConsentStatusOutput,
  CreateConsentInput,
  CreateConsentOutput,
  CreateSessionInput,
  CreateSessionOutput,
  FetchOutput,
} from '@/modules/consent/providers/aa/aa.provider'

/**
 * Faithful mock of the AA sandbox: returns DUMMY FI data (as the real sandbox
 * mandates). Lets us build & demo the full consent + data pipeline before Setu
 * credentials clear. Going live is a one-line DI swap — no lifecycle change.
 *
 * State is in-memory (single-instance demo). The mock consent screen
 * (`/mock/aa/:id`) drives `approve()` / `reject()` to move a consent forward.
 */
@Injectable()
export class SandboxAaProvider implements AccountAggregatorProvider {
  readonly name = 'sandbox'
  isConfigured(): boolean {
    return true
  }
  private readonly log = new Logger(SandboxAaProvider.name)
  private readonly consents = new Map<string, { status: string }>()
  private readonly sessions = new Map<
    string,
    { consentId: string; status: string }
  >()

  async createConsent(
    i: CreateConsentInput,
  ): Promise<Result<CreateConsentOutput>> {
    const id = randomUUID()
    this.consents.set(id, { status: 'PENDING' })
    const base = process.env.API_PUBLIC_URL ?? 'http://localhost:8000'
    this.log.log(`[sandbox] consent created ${id} for ${i.vua}`)
    // approvalUrl points at our own mock consent screen (approve/reject/link).
    return Ok({
      providerConsentId: id,
      status: 'PENDING',
      approvalUrl: `${base}/api/v1/mock/aa/${id}`,
    })
  }

  /** Called by the mock consent screen. */
  approve(id: string): void {
    this.consents.set(id, { status: 'ACTIVE' })
  }
  reject(id: string): void {
    this.consents.set(id, { status: 'REJECTED' })
  }

  async getConsent(id: string): Promise<Result<ConsentStatusOutput>> {
    return Ok({
      status: this.consents.get(id)?.status ?? 'FAILED',
      signedArtefact: 'mock.jws.artefact',
    })
  }

  async revokeConsent(id: string): Promise<Result<void>> {
    this.consents.set(id, { status: 'REVOKED' })
    return Ok(undefined)
  }

  async createSession(
    i: CreateSessionInput,
  ): Promise<Result<CreateSessionOutput>> {
    const id = randomUUID()
    this.sessions.set(id, {
      consentId: i.providerConsentId,
      status: 'COMPLETED',
    })
    return Ok({ providerSessionId: id, status: 'PENDING' })
  }

  async fetch(_sessionId: string): Promise<Result<FetchOutput>> {
    // Pre-decrypted dummy data across two FIPs. Set AA_SANDBOX_PARTIAL=true to
    // drop the GST FIP and exercise the PARTIAL-coverage path.
    const partial = process.env.AA_SANDBOX_PARTIAL === 'true'
    const fips = [
      {
        fipId: 'FIP-HDFC',
        fiType: 'DEPOSIT',
        decryptedJson: dummyDepositStatement,
      },
      ...(partial
        ? []
        : [{ fipId: 'FIP-GST', fiType: 'GSTR', decryptedJson: dummyGstr }]),
    ]
    return Ok({
      status: partial ? 'PARTIAL' : 'COMPLETED',
      fipTotal: 2,
      fipCompleted: fips.length,
      fips,
    })
  }

  verifyNotificationSignature(): boolean {
    return true
  }
}
