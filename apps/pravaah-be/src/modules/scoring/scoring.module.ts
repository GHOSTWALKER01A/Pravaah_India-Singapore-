import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'

import { AdminScoreController } from '@/modules/scoring/admin-score.controller'
import { FastApiInferenceProvider } from '@/modules/scoring/providers/fastapi-inference.provider'
import { InferenceProviderRegistry } from '@/modules/scoring/providers/inference-registry'
import { LocalScorecardProvider } from '@/modules/scoring/providers/local-scorecard.provider'
import { ScoreController } from '@/modules/scoring/score.controller'
import { ExplanationService } from '@/modules/scoring/services/explanation.service'
import { FairnessService } from '@/modules/scoring/services/fairness.service'
import { FeatureAssemblerService } from '@/modules/scoring/services/feature-assembler.service'
import { ModelService } from '@/modules/scoring/services/model.service'
import { ScoreAdminService } from '@/modules/scoring/services/score-admin.service'
import { ScoreLifecycleService } from '@/modules/scoring/services/score-lifecycle.service'
import { ScoringService } from '@/modules/scoring/services/scoring.service'

/**
 * M2 — Reputation Engine (scoring).
 *
 * Reads M1's `FiNormalized` features and turns them into a portable, explainable
 * 300–900 score. NestJS owns orchestration, caching, versioning, persistence and
 * serving; the model itself sits behind two interchangeable runtimes registered
 * with {@link InferenceProviderRegistry} — the same provider-swap shape M0 uses
 * for KYC rails and M1 uses for Account Aggregators:
 *
 *  - LocalScorecardProvider    in-process additive scorecard (default,
 *                              ML_MODE=scorecard). Its contributions are EXACT
 *                              Shapley values, so the score explains itself with
 *                              no Python in the request path.
 *  - FastApiInferenceProvider  external XGBoost + TreeSHAP at ML_BASE_URL
 *                              (`apps/ml`), behind a circuit breaker so a model
 *                              crash never cascades into auth or payments.
 *
 * Which one serves a request is decided by the model version's own `runtime`
 * field, not a global flag: the runtime is a property of the model, and the
 * version that produced a score is stamped on it forever.
 *
 * Nothing downstream of the provider interface knows or cares which answered —
 * except `Score.servedBy`, which records the truth for the audit trail.
 */
@Module({
  imports: [PassportModule],
  controllers: [ScoreController, AdminScoreController],
  providers: [
    // inference rails
    LocalScorecardProvider,
    FastApiInferenceProvider,
    InferenceProviderRegistry,

    // orchestration + explainability
    FeatureAssemblerService,
    ExplanationService,
    ScoringService,

    // model registry + fairness gate
    ModelService,
    FairnessService,

    // admin oversight + schedulers
    ScoreAdminService,
    ScoreLifecycleService,

    JwtStrategy,
  ],
  // M3 mints the score as a Verifiable Credential and M5 prices insurance off
  // it, so both read through ScoringService rather than the Score table.
  exports: [ScoringService, FeatureAssemblerService],
})
export class ScoringModule {}
