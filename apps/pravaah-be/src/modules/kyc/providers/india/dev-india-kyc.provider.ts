import { Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, Result } from '@/common/result/result'
import { ENV } from '@/constants/environment.constants'

import {
  BankResult,
  IndiaKycProvider,
  OkycInitiate,
  OkycResult,
  PanResult,
} from '@/modules/kyc/providers/india/india-kyc.provider'

type ConsentState = 'PENDING' | 'APPROVED' | 'DENIED'

/**
 * HONEST dev implementation of the India rail. PAN and penny-drop can't be
 * verified without Decentro, so they pass for well-formed input (format is
 * validated in the services). Aadhaar OKYC, however, is NOT auto-passed: it
 * drives a real server-rendered DigiLocker consent page (see
 * {@link MockDigilockerController}) and only returns data once the user has
 * explicitly APPROVED consent — mirroring the real DigiLocker redirect. Set
 * `KYC_INDIA_PROVIDER=live` to use the real {@link DecentroProvider} instead.
 */
@Injectable()
export class DevIndiaKycProvider implements IndiaKycProvider {
  /**
   * Deliberately NOT 'decentro'. Every check this provider records is labelled
   * as simulated, so a reviewer reading the case — or an auditor reading the
   * log a year later — can tell it apart from a real one.
   */
  readonly id = 'dev-india'

  // Matches the seeded India persona so a demo user reconciles to a clean name.
  private readonly demoName = 'Arjun Sharma'
  // Consent state per OKYC reference, updated by the mock consent page.
  private readonly consent = new Map<string, ConsentState>()

  /** Called by the consent page when the user approves/denies. */
  markConsent(ref: string, approved: boolean): boolean {
    if (!this.consent.has(ref)) return false
    this.consent.set(ref, approved ? 'APPROVED' : 'DENIED')
    return true
  }

  consentState(ref: string): ConsentState | undefined {
    return this.consent.get(ref)
  }

  async verifyPan(_pan: string, _traceId: string): Promise<Result<PanResult>> {
    return Ok({ valid: true, name: this.demoName })
  }

  async initiateOkyc(
    _userRef: string,
    traceId: string,
  ): Promise<Result<OkycInitiate>> {
    const ref = `okyc_${traceId}`
    this.consent.set(ref, 'PENDING')
    const base = process.env[ENV.API.PUBLIC_URL] ?? 'http://localhost:8000'
    return Ok({
      providerRefId: ref,
      authorizationUrl: `${base}/api/v1/kyc/aadhaar/mock-consent?ref=${ref}`,
    })
  }

  async fetchOkyc(
    providerRefId: string,
    _traceId: string,
    // The mock consent page has no access code to copy, so the real rail's
    // pasted code is accepted and ignored rather than made mandatory here.
    _code?: string,
  ): Promise<Result<OkycResult>> {
    const state = this.consent.get(providerRefId)

    if (state === 'DENIED') {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'DigiLocker consent was declined',
          false,
        ),
      )
    }
    if (state !== 'APPROVED') {
      // PENDING or unknown → the user hasn't finished consent yet. Retryable so
      // the flow can be resumed once they complete the DigiLocker page.
      return Err(
        new KycError(
          KycErrorCode.TIMEOUT,
          'DigiLocker consent not completed yet',
          true,
        ),
      )
    }

    return Ok({
      name: this.demoName,
      dob: '1990-01-01',
      maskedAadhaar: `XXXX XXXX ${randomUUID().replace(/\D/g, '').slice(0, 4).padEnd(4, '0')}`,
      address: '221B, MG Road, Bengaluru, Karnataka 560001',
    })
  }

  async pennyDrop(
    _account: string,
    _ifsc: string,
    _traceId: string,
  ): Promise<Result<BankResult>> {
    return Ok({ verified: true, registeredName: this.demoName })
  }
}
