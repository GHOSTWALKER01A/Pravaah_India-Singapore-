export const SCORE_ROUTES = {
  BASE: 'score',
  CURRENT: '',
  COMPUTE: 'compute',
  HISTORY: 'history',
  // Explicit, separate consent for the audit-only protected attributes.
  FAIRNESS_CONSENT: 'fairness-consent',
}

export const ADMIN_SCORE_ROUTES = {
  BASE: 'admin/score',
  // Model registry
  MODELS: 'models',
  MODEL_DETAIL: 'models/:id',
  MODEL_AUDIT_FAIRNESS: 'models/:id/audit-fairness',
  MODEL_FAIRNESS: 'models/:id/fairness',
  MODEL_ACTIVATE: 'models/:id/activate',
  MODEL_ROLLBACK: 'models/:id/rollback',
  // Score oversight. Distinct top-level paths so they never collide with the
  // `models/:id` param routes during matching.
  SCORES: 'scores',
  SCORE_DETAIL: 'scores/:scoreId',
  SCORE_AUDIT: 'scores/:scoreId/audit',
  SCORE_OVERRIDE: 'scores/:scoreId/override',
  DRIFT: 'drift',
}
