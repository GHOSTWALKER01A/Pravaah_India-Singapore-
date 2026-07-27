import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { FastApiInferenceProvider } from '@/modules/scoring/providers/fastapi-inference.provider'
import type { InferenceProvider } from '@/modules/scoring/providers/inference.provider'
import { LocalScorecardProvider } from '@/modules/scoring/providers/local-scorecard.provider'

export type MlMode = 'scorecard' | 'fastapi' | 'auto'

/**
 * Routes inference to the runtime a model version declares.
 *
 * The registry is keyed on `ModelVersion.runtime`, not on a global switch,
 * because the runtime is a property OF THE MODEL: a gradient-boosted version
 * cannot be served by the additive scorecard and vice versa. `ML_MODE` only
 * decides what happens when the declared runtime is unreachable:
 *
 *  - `scorecard` (default) — serve everything in-process. `apps/ml` not needed.
 *  - `fastapi`             — a fastapi version MUST be served by the ML service;
 *                            if it is down the compute FAILS and retries. Correct
 *                            for production: silently answering with a different
 *                            model than the one stamped on the score would break
 *                            reproducibility and the audit trail.
 *  - `auto`                — demo convenience. Falls back to the scorecard when
 *                            the ML service is unreachable, and the substitution
 *                            is recorded on `Score.servedBy` so the audit still
 *                            tells the truth about who answered.
 */
@Injectable()
export class InferenceProviderRegistry {
  private readonly logger: AppLogger
  private readonly byNameMap: Record<string, InferenceProvider>

  constructor(
    private readonly config: ConfigService,
    private readonly scorecard: LocalScorecardProvider,
    private readonly fastapi: FastApiInferenceProvider,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: InferenceProviderRegistry.name })
    this.byNameMap = { scorecard, fastapi }
  }

  mode(): MlMode {
    return (this.config.get<string>('ML_MODE') as MlMode) ?? 'scorecard'
  }

  /** The provider a model version's declared runtime maps to. */
  byRuntime(runtime: string): InferenceProvider {
    const provider = this.byNameMap[runtime]
    if (!provider) {
      this.logger.warn('[byRuntime] Unknown runtime, using the scorecard', {
        runtime,
      })
      return this.scorecard
    }
    if (provider.isConfigured()) return provider

    // Declared runtime is unusable. In `auto` we degrade loudly; otherwise the
    // caller gets the unconfigured provider and a truthful failure.
    if (this.mode() === 'auto' && runtime !== 'scorecard') {
      this.logger.warn(
        '[byRuntime] Declared runtime unavailable — degrading to the scorecard',
        { runtime },
      )
      return this.scorecard
    }
    return provider
  }

  all(): InferenceProvider[] {
    return [this.scorecard, this.fastapi]
  }
}
