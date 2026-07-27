import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { ScoreFeature } from '@pravaah/schema'
import { createHash } from 'crypto'

import { decryptField } from '@/common/crypto/field-crypto.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { FiType } from 'generated/prisma/client'

import type { FeatureVector } from '@/modules/scoring/providers/inference.provider'
import {
  FEATURE_KEYS,
  hasEnoughData,
  round3,
} from '@/modules/scoring/scoring.state'

export interface AssembledFeatures {
  features: FeatureVector
  /** 0..1 data completeness from M1. Feeds confidence, never the score. */
  coverage: number
  /** sha256 over the ORDERED vector — cache key + reproducibility receipt. */
  inputsHash: string
  hasEnoughData: boolean
  missingCount: number
  /** Months of history behind the vector — used by the thin-file message. */
  monthsCovered: number
  /**
   * Share of inflow that arrived in the first/last month of the data window.
   * Not a model input: an anti-gaming FLAG (M2 §12) surfaced for review.
   */
  boundarySpikeRatio: number | null
}

/** Deposit-family FI types all normalise to the same bank-statement features. */
const DEPOSIT_TYPES: readonly FiType[] = [
  FiType.DEPOSIT,
  FiType.TERM_DEPOSIT,
  FiType.RECURRING_DEPOSIT,
]

interface DepositFeatures {
  totalInflow?: number | null
  avgBalance?: number | null
  balanceRetention?: number | null
  obligationRatio?: number | null
  incomeRegularity?: number | null
  monthsCovered?: number | null
  bounceCount?: number | null
  boundarySpikeRatio?: number | null
  txnCount?: number | null
}

interface GstFeatures {
  annualTurnover?: number | null
  filingConsistency?: number | null
}

/**
 * Turns M1's consented, normalised, encrypted `FiNormalized` rows into the exact
 * ordered vector the active model expects.
 *
 * This is the only place raw-ish financial features are decrypted, and nothing
 * here is persisted: the `Score` row stores the HASH of this vector, never the
 * vector itself (M2 §15). Two computes over identical consented data produce an
 * identical hash, which is what makes caching safe and the score reproducible.
 */
@Injectable()
export class FeatureAssemblerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FeatureAssemblerService.name })
  }

  async assemble(
    userId: string,
    consentId: string,
    order: readonly ScoreFeature[] = FEATURE_KEYS,
  ): Promise<AssembledFeatures> {
    const rows = await this.prisma.fiNormalized.findMany({
      where: { userId, consentId },
    })
    return this.assembleFrom(
      rows.map((r) => ({
        fiType: r.fiType,
        normalizedJson: r.normalizedJson,
        coverageScore: r.coverageScore,
      })),
      order,
      { userId, consentId },
    )
  }

  /**
   * Assemble from already-loaded rows. Split out so the fairness audit can batch
   * one query across thousands of users instead of N round trips per model audit.
   */
  assembleFrom(
    rows: Array<{
      fiType: FiType
      normalizedJson: string
      coverageScore: number | null
    }>,
    order: readonly ScoreFeature[] = FEATURE_KEYS,
    trace?: { userId: string; consentId: string },
  ): AssembledFeatures {
    const decoded = rows.flatMap((r) => {
      const data = this.decode(r.normalizedJson, r.fiType, trace)
      return data
        ? [{ fiType: r.fiType, data, coverage: r.coverageScore ?? 0 }]
        : []
    })

    const dep = (decoded.find((d) => DEPOSIT_TYPES.includes(d.fiType))?.data ??
      {}) as DepositFeatures
    const gst = (decoded.find((d) => d.fiType === FiType.GSTR)?.data ??
      {}) as GstFeatures

    // `null` is deliberate and load-bearing: it means "the consented data did not
    // contain this", which the provider imputes neutrally AND charges to
    // confidence. Defaulting to 0 here would silently score a user as if they
    // had zero income rather than as unknown.
    const all: Record<ScoreFeature, number | null> = {
      // Normalised to a MONTHLY rate. M1 stores the window total, but a raw sum
      // over a variable-length data range is not comparable between users and
      // double-counts `months_covered` — the same salary over six months would
      // look like a third of the income it does over eighteen. See the note on
      // `SCORE_FEATURES`.
      monthly_inflow: this.perMonth(dep.totalInflow, dep.monthsCovered),
      income_regularity: this.num(dep.incomeRegularity),
      avg_balance: this.num(dep.avgBalance),
      balance_retention: this.num(dep.balanceRetention),
      obligation_ratio: this.num(dep.obligationRatio),
      months_covered: this.num(dep.monthsCovered),
      // A bank statement with no bounce markers genuinely means zero bounces —
      // this is the one feature where absence IS information.
      bounce_count: decoded.length ? (this.num(dep.bounceCount) ?? 0) : null,
      gst_turnover: this.num(gst.annualTurnover),
      gst_filing_consistency: this.num(gst.filingConsistency),
    }

    // Project onto the REGISTERED order so the hash matches what the model
    // version was trained against.
    const features = {} as FeatureVector
    for (const key of order) features[key] = all[key] ?? null

    const missingCount = order.filter((k) => features[k] === null).length

    // Mean per-source coverage. Sources are weighted equally: a complete bank
    // statement with no GST data is genuinely a partial picture of a business
    // owner, and the confidence band should say so.
    const coverage = decoded.length
      ? decoded.reduce((s, d) => s + d.coverage, 0) / decoded.length
      : 0

    const inputsHash = this.hash(features, order)

    return {
      features,
      coverage: round3(coverage),
      inputsHash,
      hasEnoughData: hasEnoughData(features),
      missingCount,
      monthsCovered: this.num(dep.monthsCovered) ?? 0,
      boundarySpikeRatio: this.num(dep.boundarySpikeRatio),
    }
  }

  /**
   * Hash the ORDERED (key, value) pairs — not `JSON.stringify(object)`, whose
   * key order is an implementation detail. A stable hash is the entire basis of
   * the idempotent cache and of "this score is reproducible".
   */
  private hash(
    features: FeatureVector,
    order: readonly ScoreFeature[],
  ): string {
    const canonical = order
      .map((k) => {
        const v = features[k]
        // Fixed precision so float formatting drift can never invalidate a cache
        // entry (0.1 + 0.2 must not produce a different hash than 0.30000000001).
        return `${k}=${v === null ? 'null' : v.toFixed(4)}`
      })
      .join('|')
    return createHash('sha256').update(canonical).digest('hex')
  }

  /**
   * A single corrupt/undecryptable row must not sink the whole compute — it is
   * dropped, which lowers coverage and widens the band. That is the honest
   * outcome, and it matches how M1 treats an undecryptable FIP payload.
   */
  private decode(
    blob: string,
    fiType: FiType,
    trace?: { userId: string; consentId: string },
  ): Record<string, unknown> | null {
    try {
      return JSON.parse(decryptField(blob)) as Record<string, unknown>
    } catch (err) {
      this.logger.error('[decode] Normalised FI row undecryptable — skipping', {
        ...trace,
        fiType,
        err,
      })
      return null
    }
  }

  private num(v: unknown): number | null {
    if (v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  /** A window total divided by the months it spans. Null if either is unknown. */
  private perMonth(total: unknown, months: unknown): number | null {
    const t = this.num(total)
    const m = this.num(months)
    if (t === null || m === null || m <= 0) return null
    return Number((t / m).toFixed(2))
  }
}
