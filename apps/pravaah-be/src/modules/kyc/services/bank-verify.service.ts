import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { KycErrorCode } from '@/common/errors/kyc.errors'
import { INDIA_KYC } from '@/modules/kyc/providers/india/india-kyc.provider'
import type { IndiaKycProvider } from '@/modules/kyc/providers/india/india-kyc.provider'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'

import { CheckStatus, CheckType } from 'generated/prisma/client'

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/

@Injectable()
export class BankVerifyService {
  private readonly logger: AppLogger

  constructor(
    @Inject(INDIA_KYC) private readonly india: IndiaKycProvider,
    private readonly orchestrator: KycOrchestratorService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: BankVerifyService.name })
  }

  async verify(
    userId: string,
    account: string,
    ifsc: string,
    cardValidity?: string,
  ): Promise<{ ok: boolean; reason?: string; integration?: boolean }> {
    if (!IFSC_REGEX.test(ifsc)) {
      this.logger.warn(`[${this.verify.name}] Invalid IFSC`, { userId })
      return { ok: false, reason: 'Invalid IFSC' }
    }

    const traceId = randomUUID()
    const res = await this.india.pennyDrop(account, ifsc, traceId)

    if (!res.ok) {
      this.logger.warn(`[${this.verify.name}] Penny-drop failed`, {
        userId,
        traceId,
        code: res.error.code,
        retryable: res.error.retryable,
        reason: res.error.message,
        // The provider's own envelope. Its message is the only thing that
        // distinguishes a wrong header from an unconfigured account, and the
        // 503 the user sees is deliberately generic. Contains no account
        // number — this branch runs only when the call FAILED.
        providerResponse: res.error.cause,
      })

      // Our integration, not their account — never record it against the user.
      // Decentro currently answers `Provider Not Authorized For Company` here,
      // which would otherwise read as "your bank account is not verifiable".
      if (res.error.code === KycErrorCode.INTEGRATION_ERROR) {
        return { ok: false, reason: res.error.message, integration: true }
      }

      await this.orchestrator.recordCheck(
        userId,
        CheckType.BANK_PENNY_DROP,
        this.india.id,
        {
          status: res.error.retryable
            ? CheckStatus.PENDING
            : CheckStatus.FAILED,
          providerRefId: `bank_${traceId}`,
        },
      )
      return { ok: false, reason: res.error.message }
    }

    /**
     * The registered bank name becomes another source for name reconciliation,
     * and card validity is persisted alongside the verified result (in the
     * encrypted blob) for audit / downstream checks.
     *
     * `res.value.provider` wins over the rail's own id: when only the bank step
     * is simulated, the check must say so rather than inherit `decentro` from
     * the two live checks beside it.
     */
    await this.orchestrator.recordCheck(
      userId,
      CheckType.BANK_PENNY_DROP,
      res.value.provider ?? this.india.id,
      {
        status: CheckStatus.PASSED,
        providerRefId: `bank_${traceId}`,
        extractedName: res.value.registeredName,
        raw: { ...res.value, cardValidity },
      },
    )
    return { ok: true }
  }
}
