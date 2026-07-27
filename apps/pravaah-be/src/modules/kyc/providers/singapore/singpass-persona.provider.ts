import { Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, Result } from '@/common/result/result'

import personas from '@/modules/kyc/providers/singapore/personas/personas.json'
import { MyinfoResult, SingaporeKycProvider } from '@/modules/kyc/providers/singapore/singapore-kyc.provider'

export interface Persona {
  uinfin: string
  name: string
  dob: string
  nationality: string
  address: string
  employment?: string
}

/**
 * Simulates the Myinfo consent + retrieval flow using Singpass's OFFICIAL test
 * personas. Personas live in config (not hardcoded in logic) because Singpass
 * refreshes their attributes without notice. The "authorization URL" points at
 * our own mock consent screen where a tester picks a persona — mirroring the
 * Singpass redirect. Swapping in a real Singpass provider is a DI change only.
 *
 * NOTE: the session map is in-memory and therefore single-instance/dev-only.
 * The real provider will carry state in the Singpass authorization code itself.
 */
@Injectable()
export class SingpassPersonaProvider implements SingaporeKycProvider {
  private readonly sessions = new Map<string, string>() // providerRefId -> uinfin
  private readonly personas = personas as Persona[]

  async initiate(
    _userRef: string,
  ): Promise<{ providerRefId: string; authorizationUrl: string }> {
    const providerRefId = randomUUID()
    const base = process.env.API_PUBLIC_URL ?? ''
    return {
      providerRefId,
      authorizationUrl: `${base}/api/v1/kyc/singpass/mock/${providerRefId}`,
    }
  }

  /** Called by the mock consent screen when a tester selects a persona UINFIN. */
  bindPersona(providerRefId: string, uinfin: string): boolean {
    if (!this.personas.some((p) => p.uinfin === uinfin)) return false
    this.sessions.set(providerRefId, uinfin)
    return true
  }

  listPersonas(): Persona[] {
    return this.personas
  }

  async fetch(providerRefId: string): Promise<Result<MyinfoResult>> {
    const uinfin = this.sessions.get(providerRefId)
    if (!uinfin) {
      return Err(
        new KycError(KycErrorCode.PROVIDER_REJECTED, 'No consent given', false),
      )
    }
    const p = this.personas.find((x) => x.uinfin === uinfin)
    if (!p) {
      return Err(
        new KycError(KycErrorCode.PROVIDER_REJECTED, 'Unknown persona', false),
      )
    }
    return Ok({
      uinfin: p.uinfin,
      name: p.name,
      dob: p.dob,
      nationality: p.nationality,
      residentialAddress: p.address,
      employment: p.employment,
    })
  }
}
