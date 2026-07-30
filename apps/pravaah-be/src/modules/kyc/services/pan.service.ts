import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { KycErrorCode } from '@/common/errors/kyc.errors'
import { INDIA_KYC } from '@/modules/kyc/providers/india/india-kyc.provider'
import type { IndiaKycProvider } from '@/modules/kyc/providers/india/india-kyc.provider'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'

import { CheckStatus, CheckType } from 'generated/prisma/client'

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/

@Injectable()
export class PanService {
  private readonly logger: AppLogger

  constructor(
    @Inject(INDIA_KYC) private readonly india: IndiaKycProvider,
    private readonly orchestrator: KycOrchestratorService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PanService.name })
  }

  async verify(
    userId: string,
    pan: string,
  ): Promise<{
    ok: boolean
    reason?: string
    retryable?: boolean
    /** True when the failure is ours (see {@link KycErrorCode.INTEGRATION_ERROR}). */
    integration?: boolean
  }> {
    if (!PAN_REGEX.test(pan)) {
      this.logger.warn(`[${this.verify.name}] Invalid PAN format`, { userId })
      await this.orchestrator.recordCheck(
        userId,
        CheckType.PAN,
        this.india.id,
        {
          status: CheckStatus.FAILED,
        },
      )
      return { ok: false, reason: 'Invalid PAN format' }
    }

    const traceId = randomUUID()
    const res = await this.india.verifyPan(pan, traceId)

    if (!res.ok) {
      this.logger.warn(`[${this.verify.name}] PAN verification failed`, {
        userId,
        traceId,
        code: res.error.code,
        retryable: res.error.retryable,
        reason: res.error.message,
      })

      /**
       * Our integration is broken, not the user's PAN. Record NOTHING — a
       * FAILED check here would both blame the user for a valid document and
       * drag the whole profile to ACTION_REQUIRED. The controller turns this
       * into a 503 so the app says "try again shortly", and the next attempt
       * starts from a clean slate once the integration is fixed.
       */
      if (res.error.code === KycErrorCode.INTEGRATION_ERROR) {
        return { ok: false, reason: res.error.message, integration: true }
      }

      // Transient → keep PENDING so the poller/re-poll can retry; else FAILED.
      await this.orchestrator.recordCheck(
        userId,
        CheckType.PAN,
        this.india.id,
        {
          status: res.error.retryable
            ? CheckStatus.PENDING
            : CheckStatus.FAILED,
          providerRefId: `pan_${traceId}`,
        },
      )
      return {
        ok: false,
        reason: res.error.message,
        retryable: res.error.retryable,
      }
    }

    await this.orchestrator.recordCheck(userId, CheckType.PAN, this.india.id, {
      status: CheckStatus.PASSED,
      providerRefId: `pan_${traceId}`,
      extractedName: res.value.name,
      raw: res.value,
    })
    return { ok: true }
  }
}
