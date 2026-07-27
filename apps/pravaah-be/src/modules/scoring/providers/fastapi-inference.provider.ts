import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { ScoreFeature } from '@pravaah/schema'
import { randomUUID } from 'crypto'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { httpJson } from '@/common/http/http-client'
import { Err, Ok, type Result } from '@/common/result/result'

import { OPTIONAL_FEATURES } from '@/modules/scoring/model-catalog'
import {
  computeConfidence,
  confidenceBand,
  round3,
} from '@/modules/scoring/scoring.state'

import type {
  BatchScoreInput,
  CounterfactualInput,
  InferenceProvider,
  PredictInput,
  PredictOutput,
} from '@/modules/scoring/providers/inference.provider'

/** Wire shape of `POST /predict` on apps/ml. Snake_case is the Python contract. */
interface MlPredictResponse {
  score: number
  band: string
  probability: number
  confidence: number
  base_value: number
  missing_count: number
  model_version: string
  factors: Array<{ feature: string; shap_value: number; direction: string }>
}

interface MlCounterfactualResponse {
  score: number
}

/** Wire shape of `POST /score-batch`. Scores only — the audit needs nothing else. */
interface MlScoreBatchResponse {
  scores: number[]
  bands: string[]
  probabilities: number[]
  missing_counts: number[]
  model_version: string
}

const REQUEST_TIMEOUT_MS = 8_000
/** Upper bound on a batch call, however many rows. Past this something is wrong. */
const BATCH_TIMEOUT_CEILING_MS = 60_000
/** Consecutive failures before the breaker opens. */
const FAILURE_THRESHOLD = 5
/** How long the breaker stays open before letting one request probe again. */
const OPEN_MS = 30_000

/**
 * External inference service (`apps/ml`): XGBoost + TreeSHAP + the fairness math.
 *
 * Wrapped in a circuit breaker because the whole point of isolating the model in
 * its own process is that a model crash must not cascade (M2 §1.6). Once the
 * breaker is open, every call fails fast with a RETRYABLE error — the scoring
 * orchestrator then serves the last cached score and the scheduler retries,
 * instead of every request paying an 8-second timeout.
 *
 * Never exposed to the client: the base URL is an internal address only NestJS
 * can reach (M2 §15).
 */
@Injectable()
export class FastApiInferenceProvider implements InferenceProvider {
  readonly name = 'fastapi'

  private readonly logger: AppLogger
  private failures = 0
  private openUntil = 0

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FastApiInferenceProvider.name })
  }

  isConfigured(): boolean {
    return !!this.baseUrl()
  }

  async predict(input: PredictInput): Promise<Result<PredictOutput>> {
    const guard = this.guard()
    if (!guard.ok) return guard

    const res = await httpJson<MlPredictResponse>(
      {
        method: 'POST',
        url: `${this.baseUrl()}/predict`,
        data: {
          features: input.features,
          coverage: input.coverage,
          model_version: input.modelVersion,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      randomUUID(),
    )
    if (!res.ok) return this.recordFailure(res)
    this.recordSuccess()

    return Ok(this.toPredictOutput(res.value, input))
  }

  /**
   * One HTTP call for the whole cohort.
   *
   * The timeout scales with the batch because this legitimately does more work
   * than a single predict — though far less than N of them: measured, 2000 rows
   * take ~0.2 s server-side versus ~46 s scored one at a time.
   */
  async scoreBatch(input: BatchScoreInput): Promise<Result<number[]>> {
    const guard = this.guard()
    if (!guard.ok) return guard
    if (input.rows.length === 0) return Ok([])

    const res = await httpJson<MlScoreBatchResponse>(
      {
        method: 'POST',
        url: `${this.baseUrl()}/score-batch`,
        data: { rows: input.rows, model_version: input.modelVersion },
        timeout: Math.min(
          BATCH_TIMEOUT_CEILING_MS,
          REQUEST_TIMEOUT_MS + input.rows.length * 10,
        ),
      },
      randomUUID(),
    )
    if (!res.ok) return this.recordFailure(res)
    this.recordSuccess()

    const scores = res.value.scores ?? []
    if (scores.length !== input.rows.length) {
      // A short array would silently misalign every score with its subject's
      // protected attributes, which would corrupt the fairness audit rather than
      // fail it. Refuse instead.
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          `Batch score length mismatch: sent ${input.rows.length} rows, got ${scores.length} scores`,
        ),
      )
    }
    return Ok(scores)
  }

  async counterfactual(input: CounterfactualInput): Promise<Result<number>> {
    const guard = this.guard()
    if (!guard.ok) return guard

    const res = await httpJson<MlCounterfactualResponse>(
      {
        method: 'POST',
        url: `${this.baseUrl()}/counterfactual`,
        data: {
          features: input.features,
          coverage: input.coverage,
          model_version: input.modelVersion,
          feature: input.feature,
          target_value: input.targetValue,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      randomUUID(),
    )
    if (!res.ok) return this.recordFailure(res)
    this.recordSuccess()
    return Ok(res.value.score)
  }

  // ── translation ───────────────────────────────────────────────────────────
  /**
   * The service already returns a confidence, but the band half-width is
   * recomputed here from the SAME pure helper the scorecard runtime uses. Two
   * runtimes disagreeing about how wide "±" is would be a worse bug than either
   * being slightly off, so the presentation layer stays single-sourced.
   */
  private toPredictOutput(
    body: MlPredictResponse,
    input: PredictInput,
  ): PredictOutput {
    const known = new Set<string>(Object.keys(input.features))
    const contributions = (body.factors ?? [])
      .filter((f) => known.has(f.feature))
      .map((f) => ({
        feature: f.feature as ScoreFeature,
        shapValue: Number(f.shap_value),
      }))
      .sort((x, y) => Math.abs(y.shapValue) - Math.abs(x.shapValue))

    // `missing_count` from the service already excludes not-applicable optional
    // features, so it is the required-missing count and the denominator is the
    // required feature count.
    const requiredCount = Math.max(
      1,
      Object.keys(input.features).length - OPTIONAL_FEATURES.size,
    )
    const parts = computeConfidence({
      coverage: input.coverage,
      probability: body.probability,
      missingRequired: body.missing_count ?? 0,
      requiredCount,
    })
    // Trust the service's own confidence when it sent one — it saw the model's
    // internals — but keep our decomposition for the explanation.
    const confidence = Number.isFinite(body.confidence)
      ? round3(body.confidence)
      : parts.confidence
    const { low, high } = confidenceBand(body.score, confidence)

    return {
      score: body.score,
      band: body.band,
      probability: round3(body.probability),
      confidence,
      confidenceParts: {
        coverage: parts.coverage,
        certainty: parts.certainty,
        completeness: parts.completeness,
      },
      bandLow: low,
      bandHigh: high,
      contributions,
      baseValue: Number(body.base_value ?? 0),
      missingCount: body.missing_count ?? 0,
      modelVersion: body.model_version ?? input.modelVersion,
      servedBy: this.name,
    }
  }

  // ── circuit breaker ───────────────────────────────────────────────────────
  private guard(): Result<void> {
    if (!this.isConfigured()) {
      return Err(
        new KycError(
          KycErrorCode.INVALID_INPUT,
          'ML_BASE_URL is not configured',
        ),
      )
    }
    if (Date.now() < this.openUntil) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_DOWN,
          'Inference circuit open — serving the last cached score',
          true,
        ),
      )
    }
    return Ok(undefined)
  }

  private recordFailure(res: { ok: false; error: KycError }): Result<never> {
    // Only transient failures count toward opening the breaker. A 409 model
    // version mismatch is a deterministic rejection — tripping the breaker on it
    // would take the service down over a config mistake.
    if (res.error.retryable && ++this.failures >= FAILURE_THRESHOLD) {
      this.openUntil = Date.now() + OPEN_MS
      this.failures = 0
      this.logger.error('[recordFailure] Inference circuit OPENED', {
        openForMs: OPEN_MS,
      })
    }
    return res
  }

  private recordSuccess(): void {
    if (this.failures > 0 || this.openUntil > 0) {
      this.logger.info('[recordSuccess] Inference healthy again')
    }
    this.failures = 0
    this.openUntil = 0
  }

  private baseUrl(): string | undefined {
    return this.config.get<string>('ML_BASE_URL')?.replace(/\/$/, '')
  }
}
