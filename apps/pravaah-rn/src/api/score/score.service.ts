import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import {
  FairnessConsentRequest,
  FairnessConsentStatus,
  ScoreHistoryEntry,
  ScoreResult,
} from './score.schema';

/**
 * M2 reputation API. Mirrors the ConsentService shape: a thin, typed wrapper over
 * the shared api-client (bearer + refresh + `{ data }` unwrap handled centrally).
 */
class ScoreService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.SCORE.BASE);
  }

  /**
   * The current score, or the state explaining its absence. Never computes — safe
   * to poll while a compute is PENDING.
   */
  current(): Promise<ScoreResult> {
    return this.get<ScoreResult>(API_ENDPOINTS.SCORE.CURRENT);
  }

  /** (Re)compute — e.g. after linking more accounts through M1. */
  compute(): Promise<ScoreResult> {
    return this.post<ScoreResult>(API_ENDPOINTS.SCORE.COMPUTE);
  }

  /** How the score has moved, and under which model version. */
  history(limit = 12): Promise<ScoreHistoryEntry[]> {
    return this.get<ScoreHistoryEntry[]>(
      `${API_ENDPOINTS.SCORE.HISTORY}?limit=${limit}`,
    );
  }

  /**
   * The SEPARATE consent for audit-only protected attributes. Deliberately not
   * bundled into the M1 data-share consent: "share my bank data" and "record my
   * gender so you can prove the model is fair" are different asks, and bundling
   * them would make neither a real choice.
   */
  fairnessConsent(): Promise<FairnessConsentStatus> {
    return this.get<FairnessConsentStatus>(
      API_ENDPOINTS.SCORE.FAIRNESS_CONSENT,
    );
  }

  setFairnessConsent(
    request: FairnessConsentRequest,
  ): Promise<{ consentGiven: boolean }> {
    return this.post<{ consentGiven: boolean }>(
      API_ENDPOINTS.SCORE.FAIRNESS_CONSENT,
      request,
    );
  }
}

export const scoreService = new ScoreService();
