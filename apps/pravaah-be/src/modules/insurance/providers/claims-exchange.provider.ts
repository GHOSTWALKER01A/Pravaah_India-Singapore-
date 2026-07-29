import type { Result } from '@/common/result/result'

/**
 * HCX — the Health Claims Exchange. ROADMAP, behind an interface that exists now.
 *
 * HCX is India's open protocol for health-claim interoperability: a hospital, a
 * payer and a beneficiary exchange FHIR-shaped claim documents over a common rail
 * instead of through each insurer's private portal. For a health top-up product it
 * is the difference between a claim the policyholder has to chase and one the
 * hospital files on their behalf at discharge.
 *
 * ## Why this file exists before the integration does
 *
 * It would be easy to leave HCX out and mention it on a slide. Writing the
 * interface now changes two things that matter:
 *
 *  1. **The claims service is already shaped for it.** `Claim.hcxRequestId` and
 *     `Policy.abhaRef` are columns, not future migrations, and the health branch
 *     of the claims flow already calls through a port rather than assuming we
 *     adjudicate everything ourselves.
 *  2. **It is honest about what is missing.** Joining HCX requires participant
 *     onboarding, a registered signing key and a real payer relationship. A
 *     `MockHcxProvider` that satisfies this contract makes the gap a CREDENTIAL
 *     gap rather than an architectural one — which is a claim an integration
 *     engineer can check by reading this file.
 *
 * ABDM / ABHA sits alongside it and is treated the same way: `abhaRef` is on the
 * policy so a health identity can be linked, and nothing in the build depends on
 * it. Neither is invoked for INCOME_PROTECTION or TRAVEL_ACCIDENT, which are not
 * health claims and have no business on a health rail.
 */
export const CLAIMS_EXCHANGE = Symbol('CLAIMS_EXCHANGE')

export interface CreateExchangeClaimInput {
  /** ABDM health identity, when the policy has one linked. */
  abhaRef?: string | null
  /** Our claim number, so a reply can be matched back without our internal ids. */
  claimNumber: string
  amountMinor: bigint
  currency: string
  /** The treating facility's HCX participant code. */
  providerId: string
  incidentDate: string
}

export type ExchangeClaimStatus =
  'SUBMITTED' | 'IN_ADJUDICATION' | 'APPROVED' | 'REJECTED' | 'UNKNOWN'

export interface ClaimsExchangeProvider {
  readonly name: string

  /**
   * Whether the exchange is actually reachable.
   *
   * Read by `ClaimsService` BEFORE it attempts a submission, so an unconfigured
   * exchange is skipped silently rather than logged as an error on every health
   * claim. The claim still proceeds through our own adjudication — the exchange is
   * an accelerant, never a dependency.
   */
  isConfigured(): boolean

  createClaim(
    input: CreateExchangeClaimInput,
  ): Promise<Result<{ hcxRequestId: string; status: ExchangeClaimStatus }>>

  status(
    hcxRequestId: string,
  ): Promise<Result<{ status: ExchangeClaimStatus; approvedMinor?: bigint }>>
}
