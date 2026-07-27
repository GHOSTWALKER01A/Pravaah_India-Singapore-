import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  ScorecardParamsSchema,
  type ScorecardParamsDto,
  type ScoreFeature,
} from '@pravaah/schema'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, type Result } from '@/common/result/result'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { OPTIONAL_FEATURES } from '@/modules/scoring/model-catalog'
import {
  applyTransform,
  bandFor,
  computeConfidence,
  confidenceBand,
  FEATURE_KEYS,
  parseBands,
  probabilityToScore,
  round3,
  sigmoid,
  type BandCutoff,
  type FeatureTransform,
} from '@/modules/scoring/scoring.state'

import type {
  BatchScoreInput,
  ContributionOut,
  CounterfactualInput,
  FeatureVector,
  InferenceProvider,
  PredictInput,
  PredictOutput,
} from '@/modules/scoring/providers/inference.provider'

interface LoadedModel {
  version: string
  params: ScorecardParamsDto
  bands: readonly BandCutoff[]
  /** Feature order as REGISTERED — not as the code happens to list them. */
  order: ScoreFeature[]
  /** Features whose absence is "not applicable" rather than "missing". */
  optional: ReadonlySet<ScoreFeature>
}

/**
 * In-process additive scorecard.
 *
 * ## Why its explanations are exact, not approximate
 *
 * The model is additive on the logit scale:
 *
 *     z = a · ( intercept + Σᵢ wᵢ · tᵢ(xᵢ) ) + b
 *
 * For any additive model, the Shapley value of feature *i* has a closed form —
 * its own centred term — because no interaction terms exist for the other
 * players to share credit for:
 *
 *     φᵢ = a · wᵢ · ( tᵢ(xᵢ) − tᵢ(refᵢ) )
 *
 * and the additivity axiom holds exactly:  z = base_value + Σᵢ φᵢ.
 *
 * So these are not "SHAP-like" numbers from a sampled approximation. They are
 * the Shapley values, computed analytically, and they reconcile to the score to
 * the last decimal. That is what makes the "why this score" panel defensible
 * under DPDP automated-decision transparency without a Python runtime in the
 * request path (M2 §1.1, §15).
 *
 * Contributions are reported in margin space (as XGBoost/TreeSHAP does). Point
 * impact is a separate question — `counterfactual()` answers it by re-running
 * the model, because `score()` is a non-linear squash of `z` and points are NOT
 * additively decomposable.
 */
@Injectable()
export class LocalScorecardProvider implements InferenceProvider {
  readonly name = 'scorecard'

  private readonly logger: AppLogger
  /** version → parsed params. Model versions are immutable, so this never staleness-bugs. */
  private readonly cache = new Map<string, LoadedModel>()

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: LocalScorecardProvider.name })
  }

  /** Always available: no network, no binary artefact, no Python. */
  isConfigured(): boolean {
    return true
  }

  async predict(input: PredictInput): Promise<Result<PredictOutput>> {
    const loaded = await this.load(input.modelVersion)
    if (!loaded.ok) return loaded
    return Ok(this.run(loaded.value, input.features, input.coverage))
  }

  /**
   * In-process, so a plain loop IS the batch: the model is a handful of arithmetic
   * operations per row and there is no call overhead to amortise. The interface
   * exists for the external runtime's sake, where it collapses N round trips
   * into one.
   */
  async scoreBatch(input: BatchScoreInput): Promise<Result<number[]>> {
    const loaded = await this.load(input.modelVersion)
    if (!loaded.ok) return loaded
    return Ok(
      input.rows.map((row) => this.run(loaded.value, row, 0).score),
    )
  }

  async counterfactual(input: CounterfactualInput): Promise<Result<number>> {
    const loaded = await this.load(input.modelVersion)
    if (!loaded.ok) return loaded
    const intervened: FeatureVector = {
      ...input.features,
      [input.feature]: input.targetValue,
    }
    return Ok(this.run(loaded.value, intervened, input.coverage).score)
  }

  // ── the model itself ──────────────────────────────────────────────────────
  private run(
    model: LoadedModel,
    features: FeatureVector,
    coverage: number,
  ): PredictOutput {
    const { params, order } = model
    const { a, b } = params.calibration

    let margin = a * params.intercept + b
    let baseValue = a * params.intercept + b
    // Only REQUIRED features count as missing: an absent optional feature is
    // not-applicable, and must not widen a salaried user's confidence band for
    // the crime of not running a business.
    let missingRequired = 0
    let requiredCount = 0
    const contributions: ContributionOut[] = []

    for (const key of order) {
      const weight = params.weights[key] ?? 0
      const transform = params.transforms[key] as FeatureTransform | undefined
      const reference = params.reference[key] ?? 0
      if (!transform) continue

      const isOptional = model.optional.has(key)
      if (!isOptional) requiredCount++

      const raw = features[key]
      // Neutral imputation = the reference value, so a missing feature moves the
      // score by exactly zero rather than silently scoring the user as if they
      // had none of it. The gap is charged to confidence instead (§13).
      const isMissing = raw === null || raw === undefined || !Number.isFinite(raw)
      if (isMissing && !isOptional) missingRequired++
      const value = isMissing ? reference : raw

      const t = applyTransform(value, transform)
      const tRef = applyTransform(reference, transform)

      const term = a * weight * t
      const refTerm = a * weight * tRef

      margin += term
      baseValue += refTerm
      // φᵢ = a·wᵢ·(tᵢ(xᵢ) − tᵢ(refᵢ)) — the exact Shapley value of this feature.
      contributions.push({ feature: key, shapValue: term - refTerm })
    }

    const probability = sigmoid(margin)
    const score = probabilityToScore(probability)
    const band = bandFor(score, model.bands)

    const conf = computeConfidence({
      coverage,
      probability,
      missingRequired,
      requiredCount,
    })
    const { low, high } = confidenceBand(score, conf.confidence)

    // Biggest driver first. Ties broken by the registered feature order so the
    // "why" panel is stable across identical recomputes.
    contributions.sort((x, y) => {
      const d = Math.abs(y.shapValue) - Math.abs(x.shapValue)
      return d !== 0 ? d : order.indexOf(x.feature) - order.indexOf(y.feature)
    })

    return {
      score,
      band,
      probability: round3(probability),
      confidence: conf.confidence,
      confidenceParts: {
        coverage: conf.coverage,
        certainty: conf.certainty,
        completeness: conf.completeness,
      },
      bandLow: low,
      bandHigh: high,
      contributions: contributions.map((c) => ({
        feature: c.feature,
        shapValue: Number(c.shapValue.toFixed(6)),
      })),
      baseValue: Number(baseValue.toFixed(6)),
      missingCount: missingRequired,
      modelVersion: model.version,
      servedBy: this.name,
    }
  }

  // ── model loading ─────────────────────────────────────────────────────────
  private async load(version: string): Promise<Result<LoadedModel>> {
    const hit = this.cache.get(version)
    if (hit) return Ok(hit)

    const row = await this.prisma.modelVersion.findUnique({
      where: { version },
    })
    if (!row) {
      return Err(
        new KycError(
          KycErrorCode.INVALID_INPUT,
          `Model version ${version} is not registered`,
        ),
      )
    }
    if (!row.scorecard) {
      return Err(
        new KycError(
          KycErrorCode.STATE_CONFLICT,
          `Model version ${version} has no scorecard parameters — it needs the ${row.runtime} runtime`,
        ),
      )
    }

    // Validate on load, not on use: a malformed registration must fail loudly at
    // the boundary rather than quietly producing a score from partial weights.
    const parsed = ScorecardParamsSchema.safeParse(row.scorecard)
    if (!parsed.success) {
      this.logger.error('[load] Scorecard parameters failed validation', {
        version,
        issues: parsed.error.issues,
      })
      return Err(
        new KycError(
          KycErrorCode.STATE_CONFLICT,
          `Model version ${version} has invalid scorecard parameters`,
        ),
      )
    }

    const declared = this.readSchema(row.featureSchema)
    const model: LoadedModel = {
      version: row.version,
      params: parsed.data,
      bands: parseBands(row.bands),
      order: declared.order,
      optional: declared.optional,
    }
    this.cache.set(version, model)
    this.logger.info('[load] Scorecard model loaded', {
      version,
      features: model.order.length,
    })
    return Ok(model)
  }

  /**
   * Read the REGISTERED feature order and optionality. A score is only
   * reproducible if the vector is assembled in the same order the version was
   * trained with, so the stored schema wins over the current code constant;
   * unknown names are dropped.
   */
  private readSchema(raw: unknown): {
    order: ScoreFeature[]
    optional: ReadonlySet<ScoreFeature>
  } {
    const declared = (
      raw as { features?: { name?: string; optional?: boolean }[] } | null
    )?.features
    if (!Array.isArray(declared) || declared.length === 0) {
      return {
        order: [...FEATURE_KEYS],
        optional: OPTIONAL_FEATURES,
      }
    }
    const known = new Set<string>(FEATURE_KEYS)
    const order: ScoreFeature[] = []
    const optional = new Set<ScoreFeature>()
    for (const f of declared) {
      const name = f?.name
      if (!name || !known.has(name)) continue
      order.push(name as ScoreFeature)
      if (f.optional) optional.add(name as ScoreFeature)
    }
    return { order, optional }
  }
}
