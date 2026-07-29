export const PASSPORT_ROUTES = {
  BASE: 'passport',
  /** The wallet view: current credential, status, share history. */
  CURRENT: '',
  ISSUE: 'issue',
  /** Claim catalogue for the consent-to-disclose picker. */
  CLAIMS: 'claims',
  /** A nonce for a self-initiated (offline / self-check) presentation. */
  CHALLENGE: 'challenge',
  /** Direct presentation, when the holder already has the verifier's nonce. */
  PRESENT: 'present',
  /** Pending verifier requests raised by a card tap or QR scan. */
  REQUESTS: 'requests',
  REQUEST_DETAIL: 'requests/:requestId',
  REQUEST_APPROVE: 'requests/:requestId/approve',
  REQUEST_DECLINE: 'requests/:requestId/decline',
  /** Every presentation ever made — the transparency the user controls. */
  HISTORY: 'history',
  /**
   * Peer verification — one holder scanning another's passport code.
   *
   * Under `passport` rather than under `verify`, and that placement is the security
   * statement: `verify` is the PARTNER surface, guarded by an API key, and a route there
   * that accepted an end-user JWT instead would be one guard mistake away from letting
   * anybody name their own audience. These are holder routes, on the holder's guard.
   */
  SCAN: 'scan',
  SCAN_RESULT: 'scan/:requestId',
  /** Physical companion card: payload, artwork, NFC write, lost report. */
  CARD: 'card',
  CARD_NFC_WRITTEN: 'card/nfc-written',
  CARD_LOST: 'card/lost',
  /** Holder-initiated revocation. Distinct top-level path, never a bare `:id`. */
  REVOKE: 'credentials/:id/revoke',
}

/**
 * Public + partner surface. Deliberately NOT under the `passport` prefix: these
 * routes are the trust anchor a stranger's verifier fetches, and grouping them
 * with the holder's authenticated API would invite a guard being applied to the
 * wrong half.
 */
export const VERIFY_ROUTES = {
  BASE: 'verify',
  /** Verify a presentation handed over directly (API / offline relay). */
  PRESENTATION: '',
  /** Open a request the holder will approve in their wallet. */
  REQUEST: 'request',
  /** Poll for the holder's answer. */
  REQUEST_RESULT: 'request/:requestId',
  /** A scanned/tapped card reference resolves to a verifier request here. */
  CARD: 'card/:cardRef',
  /** Machine-readable description of what this issuer is and how to verify it. */
  METADATA: 'metadata',
  /** Presentation templates, so a partner can request by name. */
  TEMPLATES: 'templates',
}

/**
 * Well-known documents. Mounted at the app root (no `api/v1` prefix) because
 * `did:web` resolution is defined against the bare domain — a DID document at
 * `/api/v1/.well-known/did.json` is a DID nobody can resolve.
 */
export const WELL_KNOWN_ROUTES = {
  DID: '.well-known/did.json',
  JWKS: '.well-known/jwks.json',
  /** SD-JWT VC type metadata, discoverable from the `vct` claim. */
  VCT: '.well-known/vct/financial-reputation-passport',
}

export const STATUS_LIST_ROUTES = {
  BASE: 'status',
  LIST: ':listId',
}

export const ADMIN_PASSPORT_ROUTES = {
  BASE: 'admin/passport',
  LIST: '',
  DETAIL: 'credentials/:id',
  AUDIT: 'credentials/:id/audit',
  REVOKE: 'credentials/:id/revoke',
  SUSPEND: 'credentials/:id/suspend',
  RESUME: 'credentials/:id/resume',
  /** Issuer key registry + rotation. */
  KEYS: 'keys',
  KEYS_ROTATE: 'keys/rotate',
  /** Registered verifiers (M7 partners). */
  PARTNERS: 'partners',
  PARTNER_REVOKE: 'partners/:id/revoke',
  /** Operational overview: issued/revoked counts, presentation volume. */
  STATS: 'stats',
}
