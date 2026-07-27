import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { SG_KYC } from '@/modules/kyc/providers/singapore/singapore-kyc.provider'
import type { SingaporeKycProvider } from '@/modules/kyc/providers/singapore/singapore-kyc.provider'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'

import { CheckStatus, CheckType } from 'generated/prisma/client'

@Injectable()
export class SingpassService {
  private readonly logger: AppLogger

  constructor(
    @Inject(SG_KYC) private readonly sg: SingaporeKycProvider,
    private readonly orchestrator: KycOrchestratorService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: SingpassService.name })
  }

  async initiate(
    userId: string,
  ): Promise<{ authorizationUrl: string; providerRefId: string }> {
    const { providerRefId, authorizationUrl } = await this.sg.initiate(userId)
    await this.orchestrator.recordCheck(
      userId,
      CheckType.SINGPASS_MYINFO,
      'singpass',
      { status: CheckStatus.PENDING, providerRefId },
    )
    return { authorizationUrl, providerRefId }
  }

  async complete(
    userId: string,
    providerRefId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const res = await this.sg.fetch(providerRefId)
    if (!res.ok) {
      this.logger.warn(`[${this.complete.name}] Myinfo fetch failed`, {
        userId,
        providerRefId,
      })
      await this.orchestrator.recordCheck(
        userId,
        CheckType.SINGPASS_MYINFO,
        'singpass',
        { status: CheckStatus.FAILED, providerRefId },
      )
      return { ok: false, reason: res.error.message }
    }

    await this.orchestrator.recordCheck(
      userId,
      CheckType.SINGPASS_MYINFO,
      'singpass',
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
