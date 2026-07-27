/** Client-side (Next.js) route paths for the admin app. */
export const ROUTES = {
  AUTH: {
    BASE: '/login',
    LOGIN: '/login',
    VERIFY_OTP: '/login/verify',
  },
  DASHBOARD: {
    ROOT: '/dashboard',
    KYC: '/dashboard/kyc',
    KYC_CASE: (id: string) => `/dashboard/kyc/${id}`,
    CONSENT: '/dashboard/consent',
    CONSENT_DETAIL: (id: string) => `/dashboard/consent/${id}`,
    // M2 — model registry (with the fairness gate) and issued-score audit.
    MODELS: '/dashboard/models',
    MODEL_REGISTER: '/dashboard/models/register',
    MODEL_DETAIL: (id: string) => `/dashboard/models/${id}`,
    SCORES: '/dashboard/scores',
    SCORE_DETAIL: (id: string) => `/dashboard/scores/${id}`,
  },
} as const;
