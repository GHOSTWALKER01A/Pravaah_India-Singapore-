import { createHash } from 'crypto'

import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'
import { Ok, type Result } from '@/common/result/result'

import type {
  ClaimsExchangeProvider,
  CreateExchangeClaimInput,
  ExchangeClaimStatus,
} from '@/modules/insurance/providers/claims-exchange.provider'

/**
 * A stand-in for HCX that satisfies the contract without pretending to be it.
 *
 * `isConfigured()` returns FALSE unless `HCX_BASE_URL` is set, and that is the
 * whole design of this file. The claims service checks it before submitting, so on
 * a default deployment the health-claim exchange leg is SKIPPED — visibly, in one
 * log line — rather than appearing to succeed against a rail nobody has joined.
 *
 * The alternative shape, a mock that always answers `Ok`, would put a fabricated
 * `hcxRequestId` on real claims and make the admin console show a health claim as
 * "filed on HCX" when no such filing exists. That is a worse outcome than the
 * feature being absent, because it is not detectable from the outside.
 *
 * ## What joining HCX actually needs
 *
 * Participant onboarding with the HCX registry, a registered JWS signing keypair,
 * a payer relationship, and FHIR-shaped claim bundles. None of it is code we can
 * write unilaterally. What this interface guarantees is that when those exist, the
 * change is a new `HcxProvider` in the registry — `ClaimsService` already calls
 * through the port, and `Claim.hcxRequestId` is already a column.
 */
@Injectable()
export class MockHcxProvider implements ClaimsExchangeProvider {
  readonly name = 'mock-hcx'

  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockHcxProvider.name })
  }

  /**
   * False by default, and deliberately so — see the class comment.
   *
   * Setting `HCX_BASE_URL` turns the mock ON for a demo of the health-claim path.
   * It does not make the mock a real exchange, which is why the claim's audit entry
   * records the provider name alongside the request id.
   */
  isConfigured(): boolean {
    return Boolean(this.config.get<string>(ENV.INSURANCE.HCX.BASE_URL))
  }

  createClaim(
    input: CreateExchangeClaimInput,
  ): Promise<Result<{ hcxRequestId: string; status: ExchangeClaimStatus }>> {
    // Derived from our claim number, so a retried submission returns the same
    // request id rather than filing a second claim on the exchange.
    const hcxRequestId = `HCX-${createHash('sha256')
      .update(input.claimNumber)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase()}`

    this.logger.info(
      `[${this.createClaim.name}] Health claim recorded against the HCX stand-in`,
      {
        claimNumber: input.claimNumber,
        hcxRequestId,
        // Whether an ABHA was linked, never the identifier itself: an ABHA number
        // is a health identifier and does not belong in a log line.
        abhaLinked: Boolean(input.abhaRef),
      },
    )

    /**
     * `SUBMITTED`, never `APPROVED`.
     *
     * A stand-in must not invent an adjudication. Our own claims workflow decides
     * whether the claimant is paid; the exchange's verdict would arrive later, from
     * a payer, and inventing one here would show a health claim approved by an
     * insurer that was never asked.
     */
    return Promise.resolve(Ok({ hcxRequestId, status: 'SUBMITTED' as const }))
  }

  status(
    hcxRequestId: string,
  ): Promise<Result<{ status: ExchangeClaimStatus; approvedMinor?: bigint }>> {
    // Logged rather than ignored, so a poll against the stand-in is as visible as
    // one against a real exchange would be.
    this.logger.debug(
      `[${this.status.name}] Polled the HCX stand-in — it never adjudicates`,
      { hcxRequestId },
    )
    return Promise.resolve(Ok({ status: 'IN_ADJUDICATION' as const }))
  }
}
