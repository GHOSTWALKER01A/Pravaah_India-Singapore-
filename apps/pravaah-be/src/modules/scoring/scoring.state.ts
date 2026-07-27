import {
  SCORE_FEATURES,
  type ScoreFeature,
} from '@pravaah/schema'

import { ScoreBand, ScoreStatus } from 'generated/prisma/client'

/**
 * Pure scoring logic — NO I/O, so every branch is unit-testable and the numbers
 * are reproducible off a feature vector alone. This is the M2 counterpart to
 * M1's `consent.state.ts`: the lifecycle rules, the score↔band mapping, and the
 * confidence band all live here so the API, the schedulers, and the admin
 * console can never disagree about what a score means.
 */

/** The 300..900 range every Pravaah score lives in. */
export const SCORE_MIN = 300
export const SCORE_MAX = 900
export const SCORE_SPAN = SCORE_MAX - SCORE_MIN

/** Ordered feature vector. Re-exported so services need one import. */
export const FEATURE_KEYS: readonly ScoreFeature[] = SCORE_FEATURES

export interface BandCutoff {
  min: number
  max: number
  band: ScoreBand
}

/**
 * Default band cutoffs (M2 §7). These travel with the M3 credential — a foreign
 * lender reading "GOOD" needs the cutoffs to interpret it, so they are stored
 * per model version rather than hard-coded at the edges.
 */
export const DEFAULT_BANDS: readonly BandCutoff[] = [
  { min: 300, max: 579, band: ScoreBand.POOR },
  { min: 580, max: 669, band: ScoreBand.FAIR },
  { min: 670, max: 739, band: ScoreBand.GOOD },
  { min: 740, max: 799, band: ScoreBand.VERY_GOOD },
  { min: 800, max: 900, band: ScoreBand.EXCELLENT },
]

// ── score lifecycle (M2 §4) ─────────────────────────────────────────────────
/**
 *   INSUFFICIENT_DATA → PENDING                (enough data + compute asked)
 *   PENDING           → COMPUTED | FAILED | INSUFFICIENT_DATA
 *   FAILED            → PENDING                (retry)
 *   COMPUTED          → EXPIRED | PENDING | OVERRIDDEN
 *   EXPIRED           → PENDING                (re-consent + recompute)
 *   OVERRIDDEN        → EXPIRED | PENDING      (an override is not a dead end)
 */
const ALLOWED: Record<ScoreStatus, ScoreStatus[]> = {
  INSUFFICIENT_DATA: [ScoreStatus.PENDING],
  PENDING: [
    ScoreStatus.COMPUTED,
    ScoreStatus.FAILED,
    ScoreStatus.INSUFFICIENT_DATA,
  ],
  FAILED: [ScoreStatus.PENDING],
  COMPUTED: [
    ScoreStatus.EXPIRED,
    ScoreStatus.PENDING,
    ScoreStatus.OVERRIDDEN,
  ],
  EXPIRED: [ScoreStatus.PENDING],
  OVERRIDDEN: [ScoreStatus.EXPIRED, ScoreStatus.PENDING],
}

export function canTransition(from: ScoreStatus, to: ScoreStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/** A status the user may be shown as a real, usable score. */
export function isServable(status: ScoreStatus): boolean {
  return status === ScoreStatus.COMPUTED || status === ScoreStatus.OVERRIDDEN
}

/** Fresh = servable AND not past the consent's data-life. */
export function isFresh(
  status: ScoreStatus,
  expiresAt: Date | null,
  now = new Date(),
): boolean {
  return isServable(status) && (!expiresAt || expiresAt > now)
}

// ── score ↔ band ────────────────────────────────────────────────────────────
export function clampScore(value: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(value)))
}

/** Map a calibrated P(good) to the 300..900 scale. Monotonic by construction. */
export function probabilityToScore(p: number): number {
  return clampScore(SCORE_MIN + SCORE_SPAN * Math.max(0, Math.min(1, p)))
}

export function bandFor(
  score: number,
  cutoffs: readonly BandCutoff[] = DEFAULT_BANDS,
): ScoreBand {
  const hit = cutoffs.find((c) => score >= c.min && score <= c.max)
  if (hit) return hit.band
  // Out-of-range can only mean a mis-registered cutoff table; fail conservative
  // rather than flattering the user.
  return score > (cutoffs.at(-1)?.max ?? SCORE_MAX)
    ? (cutoffs.at(-1)?.band ?? ScoreBand.EXCELLENT)
    : ScoreBand.POOR
}

/** Parse a model version's stored `bands` JSON, falling back to the defaults. */
export function parseBands(raw: unknown): readonly BandCutoff[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_BANDS
  const parsed = raw.filter(
    (b): b is BandCutoff =>
      !!b &&
      typeof (b as BandCutoff).min === 'number' &&
      typeof (b as BandCutoff).max === 'number' &&
      typeof (b as BandCutoff).band === 'string' &&
      (b as BandCutoff).band in ScoreBand,
  )
  return parsed.length ? parsed : DEFAULT_BANDS
}

// ── confidence ──────────────────────────────────────────────────────────────
/** Widest half-width a confidence band is allowed to reach, in points. */
const MAX_BAND_HALF_WIDTH = 80
const MIN_BAND_HALF_WIDTH = 8

/**
 * Turn confidence into the visible ± band. A thin file gets a wide band and the
 * user is TOLD so — the alternative (a crisp number from two months of data) is
 * the dishonesty M2 exists to avoid.
 */
export function confidenceBand(
  value: number,
  confidence: number,
): { low: number; high: number; halfWidth: number } {
  const c = Math.max(0, Math.min(1, confidence))
  const halfWidth = Math.max(
    MIN_BAND_HALF_WIDTH,
    Math.round(MAX_BAND_HALF_WIDTH * (1 - c)),
  )
  return {
    low: clampScore(value - halfWidth),
    high: clampScore(value + halfWidth),
    halfWidth,
  }
}

/**
 * Confidence = data coverage × model certainty × feature completeness (M2 §7).
 *
 * Each term answers a different question, and all three are returned so the UI
 * and the admin audit can see WHICH one is dragging confidence down:
 *  - `coverage`     — how much of the expected data the AA actually delivered (M1)
 *  - `certainty`    — how far from a coin-flip the model's own call was
 *  - `completeness` — what share of the REQUIRED features survived imputation
 *
 * Completeness is measured over required features only. An absent OPTIONAL
 * feature is "not applicable", not "missing": a salaried user has no GST filings
 * to share, and charging them a wider confidence band for not running a business
 * would be a penalty for the wrong thing. We cannot distinguish "has no GSTIN"
 * from "has one and didn't share it" from the features alone, so treating absence
 * as not-applicable is the only honest reading.
 */
export function computeConfidence(args: {
  coverage: number
  probability: number
  /** Required features that had to be neutrally imputed. */
  missingRequired: number
  /** How many features the model treats as required. */
  requiredCount: number
}): {
  confidence: number
  coverage: number
  certainty: number
  completeness: number
} {
  const coverage = Math.max(0, Math.min(1, args.coverage))
  const modelCertainty = Math.abs(args.probability - 0.5) * 2
  // Bounded to [0.5, 1] so a borderline call widens the band without ever
  // collapsing confidence to zero on its own.
  const certainty = 0.5 + 0.5 * modelCertainty
  const completeness =
    args.requiredCount > 0
      ? Math.max(0, 1 - args.missingRequired / args.requiredCount)
      : 0
  return {
    confidence: round3(coverage * certainty * completeness),
    coverage: round3(coverage),
    certainty: round3(certainty),
    completeness: round3(completeness),
  }
}

// ── thin-file gate ──────────────────────────────────────────────────────────
/** Minimum months of history before we are willing to publish a number at all. */
export const MIN_MONTHS_COVERED = 2

/**
 * The honest-refusal gate. Below this we return INSUFFICIENT_DATA rather than a
 * score, because an imputed vector would produce a confident-looking number
 * built almost entirely out of population averages.
 */
export function hasEnoughData(
  features: Readonly<Partial<Record<ScoreFeature, number | null>>>,
): boolean {
  const months = features.months_covered ?? 0
  const inflow = features.monthly_inflow ?? 0
  const turnover = features.gst_turnover ?? 0
  // A GST-only business file is a legitimate route in: verified filings are as
  // real an income record as a salary credit.
  const hasBankHistory = months >= MIN_MONTHS_COVERED && inflow > 0
  const hasBusinessHistory =
    turnover > 0 && (features.gst_filing_consistency ?? 0) > 0
  return hasBankHistory || hasBusinessHistory
}

// ── feature transforms (the scorecard runtime's normalising layer) ───────────
export type FeatureTransform =
  | { kind: 'logScale'; scale: number; cap: number }
  | { kind: 'clamp'; lo: number; hi: number }
  | { kind: 'inverse'; worst: number }

/**
 * Map a raw feature to a 0..1 "goodness". Monotone by construction in every
 * branch, which is what lets us claim the score can't be gamed by pushing a
 * feature in the direction the model rewards — the direction IS the intent.
 */
export function applyTransform(
  raw: number,
  transform: FeatureTransform,
): number {
  switch (transform.kind) {
    case 'logScale': {
      // Diminishing returns on money: the step from ₹0 to ₹1L matters far more
      // than ₹20L to ₹21L. Saturates at `cap`.
      const denom = Math.log1p(transform.cap / transform.scale)
      if (denom <= 0) return 0
      return clamp01(Math.log1p(Math.max(0, raw) / transform.scale) / denom)
    }
    case 'clamp': {
      const span = transform.hi - transform.lo
      if (span <= 0) return 0
      return clamp01((raw - transform.lo) / span)
    }
    case 'inverse':
      // Penalty features (obligation load, bounces): lower is better.
      return clamp01(1 - Math.max(0, raw) / transform.worst)
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

export function round3(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0
}
