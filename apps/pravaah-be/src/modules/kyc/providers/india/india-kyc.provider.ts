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
}

export interface IndiaKycProvider {
  verifyPan(pan: string, traceId: string): Promise<Result<PanResult>>
  initiateOkyc(userRef: string, traceId: string): Promise<Result<OkycInitiate>>
  fetchOkyc(providerRefId: string, traceId: string): Promise<Result<OkycResult>>
  pennyDrop(
    account: string,
    ifsc: string,
    traceId: string,
  ): Promise<Result<BankResult>>
}
