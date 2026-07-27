export const CONSENT_ROUTES = {
  BASE: 'consent',
  CREATE: 'create',
  LIST: '',
  STATUS: ':id/status',
  REVOKE: ':id',
  REFETCH: ':id/refetch',
}

export const AA_WEBHOOK_ROUTES = {
  BASE: 'webhooks/aa',
}

export const ADMIN_CONSENT_ROUTES = {
  BASE: 'admin/consent',
  LIST: '',
  // Distinct top-level path so it never collides with the `:id` param route.
  DETAIL: ':id',
  AUDIT: ':id/audit',
}

// Dev-only mock AA consent screen (no auth). Mirrors the real AA approval UX.
export const MOCK_AA_ROUTES = {
  BASE: 'mock/aa',
  SCREEN: ':providerConsentId',
  DECISION: ':providerConsentId',
}
