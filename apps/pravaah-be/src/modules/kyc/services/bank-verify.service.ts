import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

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
  ): Promise<{ ok: boolean; reason?: string }> {
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
        retryable: res.error.retryable,
      })
      await this.orchestrator.recordCheck(
        userId,
        CheckType.BANK_PENNY_DROP,
        'decentro',
        {
          status: res.error.retryable
            ? CheckStatus.PENDING
            : CheckStatus.FAILED,
          providerRefId: `bank_${traceId}`,
        },
      )
      return { ok: false, reason: res.error.message }
    }

    // The registered bank name becomes another source for name reconciliation.
    // Card validity is persisted alongside the verified result (in the
    // encrypted blob) for audit / downstream checks.
    await this.orchestrator.recordCheck(
      userId,
      CheckType.BANK_PENNY_DROP,
      'decentro',
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
