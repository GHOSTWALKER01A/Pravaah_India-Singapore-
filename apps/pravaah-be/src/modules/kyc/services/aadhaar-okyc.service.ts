import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { INDIA_KYC } from '@/modules/kyc/providers/india/india-kyc.provider'
import type { IndiaKycProvider } from '@/modules/kyc/providers/india/india-kyc.provider'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'

import { CheckStatus, CheckType } from 'generated/prisma/client'

@Injectable()
export class AadhaarOkycService {
  private readonly logger: AppLogger

  constructor(
    @Inject(INDIA_KYC) private readonly india: IndiaKycProvider,
    private readonly orchestrator: KycOrchestratorService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AadhaarOkycService.name })
  }

  /** Step 1 — get the DigiLocker URL; persist the providerRefId to correlate the callback. */
  async initiate(userId: string): Promise<
    | { ok: true; authorizationUrl: string; providerRefId: string }
    | { ok: false; reason: string }
  > {
    const traceId = randomUUID()
    const res = await this.india.initiateOkyc(userId, traceId)
    if (!res.ok) return { ok: false, reason: res.error.message }

    await this.orchestrator.recordCheck(
      userId,
      CheckType.AADHAAR_OKYC,
      'decentro',
      { status: CheckStatus.PENDING, providerRefId: res.value.providerRefId },
    )
    return {
      ok: true,
      authorizationUrl: res.value.authorizationUrl,
      providerRefId: res.value.providerRefId,
    }
  }

  /** Step 2 — called by the callback/webhook once the user finishes DigiLocker. */
  async complete(
    userId: string,
    providerRefId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const traceId = randomUUID()
    const res = await this.india.fetchOkyc(providerRefId, traceId)

    if (!res.ok) {
      this.logger.warn(`[${this.complete.name}] OKYC fetch failed`, {
        userId,
        providerRefId,
        retryable: res.error.retryable,
      })
      await this.orchestrator.recordCheck(
        userId,
        CheckType.AADHAAR_OKYC,
        'decentro',
        {
          status: res.error.retryable
            ? CheckStatus.PENDING
            : CheckStatus.FAILED,
          providerRefId,
        },
      )
      return { ok: false, reason: res.error.message }
    }

    await this.orchestrator.recordCheck(
      userId,
      CheckType.AADHAAR_OKYC,
      'decentro',
      {
        status: CheckStatus.PASSED,
        providerRefId,
        extractedName: res.value.name,
        raw: res.value,
      },
    )
    return { ok: true }
  }
}
