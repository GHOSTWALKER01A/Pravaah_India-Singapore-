import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { LivenessGesture } from '@pravaah/schema'

import { BIOMETRICS_THRESHOLDS } from '@/config/biometrics.config'

import { BIOMETRICS } from '@/modules/kyc/providers/biometrics/biometrics.provider'
import type { BiometricsProvider } from '@/modules/kyc/providers/biometrics/biometrics.provider'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'

import { CheckStatus, CheckType } from 'generated/prisma/client'

@Injectable()
export class BiometricsService {
  private readonly logger: AppLogger

  constructor(
    @Inject(BIOMETRICS) private readonly bio: BiometricsProvider,
    private readonly orchestrator: KycOrchestratorService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: BiometricsService.name })
  }

  startLiveness(
    userId: string,
  ): Promise<{ sessionId: string; challenge: LivenessGesture[] }> {
    return this.bio.startLiveness(userId)
  }

  async verifyLiveness(
    userId: string,
    sessionId: string,
    selfie: Buffer,
    completedChallenge: LivenessGesture[],
  ): Promise<{ ok: boolean; confidence?: number }> {
    const res = await this.bio.verifyLiveness({
      sessionId,
      selfie,
      completedChallenge,
    })
    if (!res.ok) {
      await this.record(userId, CheckType.LIVENESS, CheckStatus.PENDING)
      return { ok: false }
    }

    // Server decides; the client result is advisory only.
    const pass =
      res.value.live && res.value.confidence >= BIOMETRICS_THRESHOLDS.LIVENESS_MIN
    const status = !res.value.live
      ? CheckStatus.FAILED // spoof → hard fail
      : pass
        ? CheckStatus.PASSED
        : CheckStatus.MANUAL_REVIEW // low confidence → review, not reject

    if (status === CheckStatus.FAILED) {
      this.logger.warn(`[${this.verifyLiveness.name}] Liveness spoof detected`, {
        userId,
        confidence: res.value.confidence,
      })
    }

    await this.record(userId, CheckType.LIVENESS, status, res.value.confidence)
    return { ok: pass, confidence: res.value.confidence }
  }

  async faceMatch(
    userId: string,
    selfie: Buffer,
    idPhoto: Buffer,
  ): Promise<{ ok: boolean; confidence?: number }> {
    const res = await this.bio.faceMatch(selfie, idPhoto)
    if (!res.ok) {
      await this.record(userId, CheckType.FACE_MATCH, CheckStatus.PENDING)
      return { ok: false }
    }

    const status =
      res.value.confidence >= BIOMETRICS_THRESHOLDS.FACE_MATCH_MIN
        ? CheckStatus.PASSED
        : CheckStatus.MANUAL_REVIEW // near-miss (twins/family) → human review

    await this.record(userId, CheckType.FACE_MATCH, status, res.value.confidence)
    return { ok: status === CheckStatus.PASSED, confidence: res.value.confidence }
  }

  private record(
    userId: string,
    type: CheckType,
    status: CheckStatus,
    confidence?: number,
  ): Promise<unknown> {
    return this.orchestrator.recordCheck(userId, type, 'biometrics', {
      status,
      confidence,
    })
  }
}
