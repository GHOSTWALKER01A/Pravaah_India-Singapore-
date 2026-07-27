/**
 * M2 · Reputation score types (mirror pravaah-be). These shapes match the
 * ResponseBuilder `data` bodies from `GET /score` and `POST /score/compute`.
 */

export type ScoreBand = 'POOR' | 'FAIR' | 'GOOD' | 'VERY_GOOD' | 'EXCELLENT';

export type FactorDirection = 'POSITIVE' | 'NEGATIVE';

/** One driver behind the score, in plain language. */
export interface ScoreFactor {
  feature: string;
  label: string;
  direction: FactorDirection;
  /** Signed contribution in the model's margin space. Shown as a bar, not a number. */
  contribution: number;
  plainText: string;
  rank: number;
}

/** One actionable improvement, with a re-computed point gain. */
export interface ScoreImprovement {
  feature: string;
  label: string;
  currentValue: number;
  targetValue: number;
  estimatedGain: number;
  plainText: string;
  rank: number;
}

export interface ScoreBandCutoff {
  min: number;
  max: number;
  band: ScoreBand;
}

/** The model version that produced a score — travels with it to M3. */
export interface ScoreModel {
  name: string;
  version: string;
  runtime: string;
  bands: ScoreBandCutoff[];
}

/** A computed, servable score. */
export interface ComputedScore {
  state: 'COMPUTED';
  id: string;
  value: number | null;
  band: ScoreBand | null;
  confidence: number;
  confidenceLabel: string;
  /** The visible ± interval. Wider when the data is thin. */
  bandLow: number | null;
  bandHigh: number | null;
  coverage: number | null;
  coverageLabel: string | null;
  missingCount: number;
  computedAt: string | null;
  expiresAt: string | null;
  isOverridden: boolean;
  override: { band: ScoreBand; reason: string; at: string } | null;
  model: ScoreModel;
  factors: ScoreFactor[];
  improvements: ScoreImprovement[];
}

/**
 * The honest non-score states. Each one is a different user action, which is why
 * they are distinct rather than a single null: NO_CONSENT routes to M1,
 * INSUFFICIENT_DATA asks for more accounts, EXPIRED asks for re-consent.
 */
export type ScoreState =
  | { state: 'NO_CONSENT'; message: string }
  | {
      state: 'INSUFFICIENT_DATA';
      message: string;
      scoreId?: string;
      monthsCovered: number;
      coverage: number;
    }
  | { state: 'PENDING'; scoreId: string; message: string }
  | {
      state: 'EXPIRED';
      scoreId: string;
      expiredAt: string | null;
      message: string;
    }
  | { state: 'FAILED'; scoreId: string; message: string };

export type ScoreResult = ComputedScore | ScoreState;

/** GET /score/history → one row per computed score. */
export interface ScoreHistoryEntry {
  id: string;
  value: number | null;
  band: ScoreBand | null;
  confidence: number | null;
  status: string;
  computedAt: string | null;
  modelVersion: string;
}

/** GET /score/fairness-consent → what we hold, never the values themselves. */
export interface FairnessConsentStatus {
  consentGiven: boolean;
  consentedAt: string | null;
  attributesHeld: string[];
  purpose: string;
}

/** POST /score/fairness-consent body. */
export interface FairnessConsentRequest {
  consentGiven: boolean;
  gender?: 'female' | 'male' | 'other' | 'prefer_not_to_say';
  ageBand?: '18-25' | '26-35' | '36-45' | '46-60' | '60+';
  /** ISO 3166-1 alpha-2. */
  nationality?: string;
}

/** Narrowing helper — `state === 'COMPUTED'` is the only servable case. */
export function isComputedScore(result: ScoreResult): result is ComputedScore {
  return result.state === 'COMPUTED';
}
