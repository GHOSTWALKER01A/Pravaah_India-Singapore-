/**
 * Backend API endpoints (pravaah-be). Paths mirror the NestJS routes:
 * global prefix `api` + URI version `v1`. Base URL comes from the
 * EXPO_PUBLIC_API_URL env var (inlined by Expo at build time).
 */
export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000'
).replace(/\/$/, '');

export const API_ENDPOINTS = {
  AUTH: {
    BASE: 'api/v1/auth',
    SEND_OTP: '/send-otp',
    RESEND_OTP: '/resend-otp',
    VERIFY: '/verify',
    REFRESH: '/refresh',
  },
  // Mirrors KYC_ROUTES in apps/pravaah-be/src/modules/kyc/kyc.route.ts
  KYC: {
    BASE: 'api/v1/kyc',
    START: '/start',
    STATUS: '/status',
    PAN_VERIFY: '/pan/verify',
    AADHAAR_INITIATE: '/aadhaar/okyc/initiate',
    AADHAAR_CALLBACK: '/aadhaar/okyc/callback',
    BANK_PENNY_DROP: '/bank/penny-drop',
    LIVENESS_SESSION: '/liveness/session',
    LIVENESS_VERIFY: '/liveness/verify',
    FACE_MATCH: '/face-match',
    SANCTIONS: '/sanctions/screen',
    PUSH_TOKEN: '/push-token',
    SINGPASS_INITIATE: '/singpass/initiate',
    SINGPASS_CALLBACK: '/singpass/callback',
    SINGPASS_MOCK: (providerRefId: string) =>
      `/singpass/mock/${providerRefId}`,
  },
  // Mirrors CONSENT_ROUTES in apps/pravaah-be/src/modules/consent/consent.route.ts
  CONSENT: {
    BASE: 'api/v1/consent',
    CREATE: '/create',
    LIST: '',
    STATUS: (id: string) => `/${id}/status`,
    REVOKE: (id: string) => `/${id}`,
    REFETCH: (id: string) => `/${id}/refetch`,
  },
  // Mirrors SCORE_ROUTES in apps/pravaah-be/src/modules/scoring/scoring.route.ts
  SCORE: {
    BASE: 'api/v1/score',
    CURRENT: '',
    COMPUTE: '/compute',
    HISTORY: '/history',
    FAIRNESS_CONSENT: '/fairness-consent',
  },
  // Dev-only sandbox AA mock consent screen (no auth).
  MOCK_AA: {
    BASE: 'api/v1/mock/aa',
    DECISION: (providerConsentId: string) => `/${providerConsentId}`,
  },
  USERS: {
    BASE: 'api/v1/users',
    ME: '/me',
  },
} as const;
