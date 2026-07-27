import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../core/base-api-service';
import {
  ActivateResponseSchema,
  AuditResultResponseSchema,
  DriftResponseSchema,
  FairnessReportResponseSchema,
  ModelDetailResponseSchema,
  ModelListResponseSchema,
  ModelRegisterResponseSchema,
  OverrideResponseSchema,
  ScoreAuditResponseSchema,
  ScoreDetailResponseSchema,
  ScoreListResponseSchema,
  type ScoreBand,
} from './scoring.schema';

/** M2 admin console — model registry, fairness gate, score audit, drift. */
class ScoringService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.SCORE.BASE);
  }

  // ── model registry ────────────────────────────────────────────────────────
  async listModels() {
    const res = await this.get(API_ENDPOINTS.SCORE.MODELS);
    return ModelListResponseSchema.parse(res).data;
  }

  async getModel(id: string) {
    const res = await this.get(API_ENDPOINTS.SCORE.MODEL_DETAIL(id));
    return ModelDetailResponseSchema.parse(res).data;
  }

  /**
   * Register a version. Always arrives INACTIVE and UNAUDITED.
   *
   * The body is passed through unvalidated on purpose: the backend's Zod schema is
   * the authority, and its issue list is a far better error message than anything a
   * duplicated client-side schema could produce — which would also silently drift
   * from the server's.
   */
  async registerModel(payload: Record<string, unknown>) {
    const res = await this.post(API_ENDPOINTS.SCORE.MODELS, payload);
    return ModelRegisterResponseSchema.parse(res).data;
  }

  /** Run the bias audit. Writes the report AND sets the gate flag. */
  async auditFairness(id: string, positiveBandMin = 670) {
    const res = await this.post(API_ENDPOINTS.SCORE.MODEL_AUDIT(id), {
      positiveBandMin,
    });
    return AuditResultResponseSchema.parse(res).data;
  }

  async getFairness(id: string) {
    const res = await this.get(API_ENDPOINTS.SCORE.MODEL_FAIRNESS(id));
    return FairnessReportResponseSchema.parse(res).data;
  }

  /** Blocked by the backend unless the fairness audit passed. This is the gate. */
  async activateModel(id: string) {
    const res = await this.post(API_ENDPOINTS.SCORE.MODEL_ACTIVATE(id));
    return ActivateResponseSchema.parse(res).data;
  }

  async rollbackModel(id: string) {
    const res = await this.post(API_ENDPOINTS.SCORE.MODEL_ROLLBACK(id));
    return ActivateResponseSchema.parse(res).data;
  }

  // ── issued scores ─────────────────────────────────────────────────────────
  async listScores(params: {
    status?: string;
    modelVersionId?: string;
    limit?: number;
    offset?: number;
  }) {
    const query = new URLSearchParams();
    if (params.status && params.status !== 'ALL') {
      query.set('status', params.status);
    }
    if (params.modelVersionId) {
      query.set('modelVersionId', params.modelVersionId);
    }
    query.set('limit', String(params.limit ?? 50));
    query.set('offset', String(params.offset ?? 0));

    const res = await this.get(
      `${API_ENDPOINTS.SCORE.SCORES}?${query.toString()}`,
    );
    return ScoreListResponseSchema.parse(res).data;
  }

  async getScore(scoreId: string) {
    const res = await this.get(API_ENDPOINTS.SCORE.SCORE_DETAIL(scoreId));
    return ScoreDetailResponseSchema.parse(res).data;
  }

  async getScoreAudit(scoreId: string) {
    const res = await this.get(API_ENDPOINTS.SCORE.SCORE_AUDIT(scoreId));
    return ScoreAuditResponseSchema.parse(res).data;
  }

  /**
   * Senior-only band override. The acting admin is taken from the JWT server-side,
   * never sent from here — a self-declared actor id would make the attribution
   * trail worthless.
   */
  async overrideScore(scoreId: string, newBand: ScoreBand, reason: string) {
    const res = await this.post(API_ENDPOINTS.SCORE.SCORE_OVERRIDE(scoreId), {
      newBand,
      reason,
    });
    return OverrideResponseSchema.parse(res).data;
  }

  // ── drift ─────────────────────────────────────────────────────────────────
  async getDrift() {
    const res = await this.get(API_ENDPOINTS.SCORE.DRIFT);
    return DriftResponseSchema.parse(res).data;
  }
}

export const scoringService = new ScoringService();
