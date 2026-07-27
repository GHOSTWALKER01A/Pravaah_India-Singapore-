/**
 * Backend API endpoints (pravaah-be). Paths mirror the NestJS routes:
 * global prefix `api` + URI version `v1`.
 */
export const API_ENDPOINTS = {
  // Admin console authenticates against the admin auth routes (gated on the
  // AdminUser table). Mirrors ADMIN_AUTH_ROUTES in pravaah-be kyc.route.ts.
  AUTH: {
    BASE: 'api/v1/admin/auth',
    SEND_OTP: '/send-otp',
    RESEND_OTP: '/resend-otp',
    VERIFY: '/verify',
    REFRESH: '/refresh',
    ME: '/me',
  },
  // Mirrors ADMIN_KYC_ROUTES in apps/pravaah-be/src/modules/kyc/kyc.route.ts
  KYC: {
    BASE: 'api/v1/admin/kyc',
    CASES: '/cases',
    CASE_DETAIL: (id: string) => `/cases/${id}`,
    CASE_CLAIM: (id: string) => `/cases/${id}/claim`,
    CASE_DECISION: (id: string) => `/cases/${id}/decision`,
  },
  // Mirrors ADMIN_CONSENT_ROUTES in apps/pravaah-be/src/modules/consent/consent.route.ts
  CONSENT: {
    BASE: 'api/v1/admin/consent',
    LIST: '',
    DETAIL: (id: string) => `/${id}`,
    AUDIT: (id: string) => `/${id}/audit`,
  },
  // Mirrors ADMIN_SCORE_ROUTES in apps/pravaah-be/src/modules/scoring/scoring.route.ts
  SCORE: {
    BASE: 'api/v1/admin/score',
    // Model registry + the fairness activation gate
    MODELS: '/models',
    MODEL_DETAIL: (id: string) => `/models/${id}`,
    MODEL_AUDIT: (id: string) => `/models/${id}/audit-fairness`,
    MODEL_FAIRNESS: (id: string) => `/models/${id}/fairness`,
    MODEL_ACTIVATE: (id: string) => `/models/${id}/activate`,
    MODEL_ROLLBACK: (id: string) => `/models/${id}/rollback`,
    // Issued-score oversight
    SCORES: '/scores',
    SCORE_DETAIL: (id: string) => `/scores/${id}`,
    SCORE_AUDIT: (id: string) => `/scores/${id}/audit`,
    SCORE_OVERRIDE: (id: string) => `/scores/${id}/override`,
    DRIFT: '/drift',
  },
} as const;
