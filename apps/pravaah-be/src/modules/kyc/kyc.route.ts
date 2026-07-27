export const KYC_ROUTES = {
  BASE: 'kyc',
  START: 'start',
  STATUS: 'status',
  PAN_VERIFY: 'pan/verify',
  OKYC_INITIATE: 'aadhaar/okyc/initiate',
  OKYC_CALLBACK: 'aadhaar/okyc/callback',
  // Dev-only DigiLocker consent simulation page (opened in the browser). Live
  // Decentro hosts its own consent screen, so this is never hit in live mode.
  OKYC_MOCK_CONSENT: 'aadhaar/mock-consent',
  BANK_PENNY_DROP: 'bank/penny-drop',
  SINGPASS_INITIATE: 'singpass/initiate',
  SINGPASS_CALLBACK: 'singpass/callback',
  SINGPASS_MOCK: 'singpass/mock/:providerRefId',
  LIVENESS_SESSION: 'liveness/session',
  LIVENESS_VERIFY: 'liveness/verify',
  FACE_MATCH: 'face-match',
  SANCTIONS_SCREEN: 'sanctions/screen',
  PUSH_TOKEN: 'push-token',
}

export const ADMIN_AUTH_ROUTES = {
  BASE: 'admin/auth',
  SEND_OTP: 'send-otp',
  RESEND_OTP: 'resend-otp',
  VERIFY_OTP: 'verify',
  REFRESH_TOKEN: 'refresh',
  ME: 'me',
}

export const ADMIN_KYC_ROUTES = {
  BASE: 'admin/kyc',
  CASES: 'cases',
  // Distinct top-level path (NOT under cases/) so it never collides with the
  // `cases/:id` param route during matching.
  STREAM: 'stream',
  CASE_DETAIL: 'cases/:id',
  CASE_CLAIM: 'cases/:id/claim',
  CASE_DECISION: 'cases/:id/decision',
}

export const KYC_WEBHOOK_ROUTES = {
  BASE: 'webhooks/kyc',
  PROVIDER: ':provider',
}
