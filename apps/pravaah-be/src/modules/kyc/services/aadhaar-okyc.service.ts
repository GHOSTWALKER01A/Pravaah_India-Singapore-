import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { KycErrorCode } from '@/common/errors/kyc.errors'
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
  async initiate(
    userId: string,
  ): Promise<
    | { ok: true; authorizationUrl: string; providerRefId: string }
    | { ok: false; reason: string }
  > {
    const traceId = randomUUID()
    const res = await this.india.initiateOkyc(userId, traceId)
    if (!res.ok) return { ok: false, reason: res.error.message }

    await this.orchestrator.recordCheck(
      userId,
      CheckType.AADHAAR_OKYC,
      this.india.id,
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
    code?: string,
  ): Promise<{
    ok: boolean
    reason?: string
    integration?: boolean
    /** Consent is not finished; the check stays PENDING and is resumable. */
    pending?: boolean
    /** The pasted DigiLocker code was rejected — the user must re-run consent. */
    invalidCode?: boolean
  }> {
    const traceId = randomUUID()
    const res = await this.india.fetchOkyc(providerRefId, traceId, code)

    if (!res.ok) {
      this.logger.warn(`[${this.complete.name}] OKYC fetch failed`, {
        userId,
        providerRefId,
        code: res.error.code,
        retryable: res.error.retryable,
        /**
         * The provider's own body, verbatim.
         *
         * Every OKYC failure so far has been diagnosable only from Decentro's
         * `responseKey`, and none of it was reaching the log — leaving
         * "DigiLocker consent not completed yet" as the sole evidence for four
         * distinct causes. It carries no Aadhaar data: this branch runs only
         * when the fetch FAILED, so the body is an error envelope.
         */
        providerResponse: res.error.cause,
      })

      // Our integration, not the user's Aadhaar — leave the check PENDING as it
      // was so they can resume, rather than failing them for our fault.
      if (res.error.code === KycErrorCode.INTEGRATION_ERROR) {
        return { ok: false, reason: res.error.message, integration: true }
      }

      /**
       * An expired or wrong code. Recoverable by the user, and only by starting
       * a new session — so record NOTHING and hand back the provider's own
       * wording, which already names the fix. Writing a FAILED check here would
       * push the whole profile to ACTION_REQUIRED over a lapsed 40-character
       * string.
       */
      if (res.error.code === KycErrorCode.INVALID_INPUT) {
        return { ok: false, reason: res.error.message, invalidCode: true }
      }

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
      return {
        ok: false,
        reason: res.error.message,
        pending: res.error.retryable,
      }
    }

    await this.orchestrator.recordCheck(
      userId,
      CheckType.AADHAAR_OKYC,
      this.india.id,
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
