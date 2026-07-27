import type { Result } from '@/common/result/result'

/**
 * Singapore KYC rail (Myinfo). Bound to {@link SingpassPersonaProvider} today
 * (official test personas behind a mock consent screen); swapping in a real
 * Singpass provider later is a DI change, not a rewrite.
 */
export const SG_KYC = Symbol('SG_KYC')

export interface MyinfoResult {
  uinfin: string
  name: string
  dob: string
  nationality: string
  residentialAddress: string
  employment?: string
}

export interface SingaporeKycProvider {
  initiate(
    userRef: string,
  ): Promise<{ providerRefId: string; authorizationUrl: string }>
  fetch(providerRefId: string): Promise<Result<MyinfoResult>>
}
