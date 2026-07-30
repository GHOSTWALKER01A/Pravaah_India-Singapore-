import type { Result } from '@/common/result/result'

/**
 * India KYC rail. Bound to {@link DecentroProvider} (LIVE) today; the KYC
 * business logic depends only on this interface, so a vendor swap is a one-line
 * change in {@link KycModule}.
 */
export const INDIA_KYC = Symbol('INDIA_KYC')

export interface PanResult {
  valid: boolean
  name: string
}
export interface OkycInitiate {
  providerRefId: string
  authorizationUrl: string
}
export interface OkycResult {
  name: string
  dob: string
  maskedAadhaar: string
  address?: string
  photoBase64?: string
}
export interface BankResult {
  verified: boolean
  registeredName: string
  /**
   * Who actually performed the check, when that differs from the rail's own
   * {@link IndiaKycProvider.id} — the bank step can be simulated while PAN and
   * DigiLocker stay live. Recorded so a passed check never claims a penny drop
   * that never happened.
   */
  provider?: string
}

export interface IndiaKycProvider {
  /**
   * Identifies this implementation on every check it records. Not cosmetic:
   * `KycCheck.provider` is what the reviewer console and the audit log show,
   * and it was hardcoded to `'decentro'` even when the mock had run — so a
   * simulated result was indistinguishable from a real one after the fact.
   */
  readonly id: string

  verifyPan(pan: string, traceId: string): Promise<Result<PanResult>>
  initiateOkyc(userRef: string, traceId: string): Promise<Result<OkycInitiate>>
  /**
   * @param code Optional DigiLocker access code pasted by the user. Only
   * present when the session ran without a redirect URL — see
   * {@link OkycCallbackSchema}.
   */
  fetchOkyc(
    providerRefId: string,
    traceId: string,
    code?: string,
  ): Promise<Result<OkycResult>>
  pennyDrop(
    account: string,
    ifsc: string,
    traceId: string,
  ): Promise<Result<BankResult>>
}
