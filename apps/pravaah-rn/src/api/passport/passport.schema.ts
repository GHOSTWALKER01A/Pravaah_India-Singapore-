/**
 * M3 · Passport types (mirror pravaah-be). These shapes match the ResponseBuilder `data`
 * bodies from the `/passport` routes.
 */
import type { Country } from '@/api/kyc/kyc.schema';
import type { PartnerType } from '@/api/shares/shares.schema';

export type CredentialStatus = 'ISSUED' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';

export type PresentationChannel = 'QR' | 'NFC' | 'DEEPLINK' | 'API';

export type CardStatus = 'ACTIVE' | 'LOST' | 'REVOKED';

export type ClaimSensitivity = 'LOW' | 'MEDIUM' | 'HIGH';

export type ClaimCategory = 'identity' | 'reputation' | 'provenance';

/**
 * One claim, described for the person deciding whether to share it.
 *
 * `detail` and `whyAsked` exist because "needs `passport_number`" is not a decision anyone
 * can make. They come from the backend rather than the bundle so an app that has not been
 * updated still renders a newer credential's claims as sentences.
 */
export interface ClaimDescriptor {
  claim: string;
  label: string;
  detail: string;
  category: ClaimCategory;
  sensitivity: ClaimSensitivity;
  whyAsked: string;
  /** False when this credential does not carry the claim — greyed out, not hidden. */
  held: boolean;
}

export interface PresentationTemplate {
  id: string;
  label: string;
  purpose: string;
  claims: string[];
}

/** GET /passport/claims */
export interface ClaimCatalogue {
  claims: ClaimDescriptor[];
  templates: PresentationTemplate[];
}

export interface WalletCard {
  cardSerial: string;
  status: CardStatus;
  nfcWritten: boolean;
  verifyUrl: string | null;
}

/** The wallet's view of a live passport. */
export interface ActivePassport {
  state: 'ACTIVE';
  id: string;
  credentialNumber: string;
  status: CredentialStatus;
  subjectDid: string;
  deviceLabel: string | null;
  scoreBand: string | null;
  dataRails: string[];
  passportBound: boolean;
  issuedAt: string;
  expiresAt: string;
  daysRemaining: number;
  issuerKid: string;
  /** The credential itself, for offline presentation and wallet restore. */
  credential: string;
  claims: ClaimDescriptor[];
  card: WalletCard | null;
  presentationCount: number;
  score: { band: string | null; computedAt: string | null; confidence: number | null } | null;
}

/**
 * The states with no live passport. Kept distinct because each is a different user
 * action: NOT_ISSUED is a first issuance, NEEDS_REISSUE follows an expiry or a revocation.
 */
export type PassportState =
  | { state: 'NOT_ISSUED'; message: string }
  | {
      state: 'NEEDS_REISSUE';
      message: string;
      previous?: {
        id: string;
        status: CredentialStatus;
        credentialNumber: string;
        expiresAt: string;
        revokedAt: string | null;
        revokeReason: string | null;
      };
    };

export type WalletResult = ActivePassport | PassportState;

/** Narrowing helper — `state === 'ACTIVE'` is the only presentable case. */
export function isActivePassport(result: WalletResult): result is ActivePassport {
  return result.state === 'ACTIVE';
}

/** POST /passport/issue */
export interface IssuedPassport {
  credentialId: string;
  credentialNumber: string;
  credential: string;
  sdJwt: string;
  disclosures: Record<string, string>;
  subjectDid: string;
  issuedAt: string;
  expiresAt: string;
  passportBound: boolean;
  dataRails: string[];
  /** Anything the request asked for that could not be honoured, in plain language. */
  notes: string[];
}

/** POST /passport/challenge — the exact bytes the device must sign over. */
export interface SigningMaterial {
  sdHash: string;
  disclosedClaims: string[];
  skippedClaims: string[];
  audience: string;
  nonce: string;
}

/**
 * The person on the other end of a PEER check — someone who scanned this holder's code.
 *
 * `name` is the scanner's VERIFIED KYC name or null; it is never anything they typed. A
 * self-declared display name on a consent screen would be a free impersonation primitive:
 * "approve — asked by <the name of someone you trust>".
 *
 * Its presence is also how the wallet knows the asker is a person rather than an
 * institution, which is a materially different decision to make.
 */
export interface PeerRequester {
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  country: Country;
  identityVerified: boolean;
}

/**
 * Where a verifier request is. `CANCELLED` (M7) means the organisation withdrew it — or
 * PRAVAAH suspended the organisation — before the holder answered. It is told apart from
 * `EXPIRED` because "they cancelled" and "you ran out of time" are different things to say.
 */
export type VerifierRequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'CANCELLED';

/**
 * The organisation behind a request, as PRAVAAH vetted it (M7).
 *
 * The anti-phishing half of the consent screen. `domain` is the one an admin verified at
 * approval, not anything the organisation typed into the request; `retentionDays` is the
 * promise the holder's consent receipt will record.
 */
export interface VerifierProfile {
  name: string;
  domain: string | null;
  type: PartnerType;
  trustLevel: 'STANDARD' | 'HIGH';
  country: string | null;
  retentionDays: number;
  /** False once PRAVAAH has suspended the organisation. The request is then not answerable. */
  approved: boolean;
}

/** A verifier's request, as the consent-to-disclose screen needs it. */
export interface VerifierRequestDetail {
  requestId: string;
  status: VerifierRequestStatus;
  open: boolean;
  verifier: string;
  verifierCountry: string | null;
  /** Present only on a peer check. Null when an institution is asking. */
  requester: PeerRequester | null;
  /**
   * Present only when a registered organisation is asking. Optional because a backend
   * older than M7 does not send it — the screen then falls back to `verifier`.
   */
  verifierProfile?: VerifierProfile | null;
  purpose: string;
  template: string | null;
  channel: PresentationChannel;
  expiresAt: string;
  nonce: string;
  audience: string;
  credentialId: string | null;
  credentialNumber: string | null;
  claims: ClaimDescriptor[];
  allDeclinable: boolean;
}

export interface PendingRequestSummary {
  requestId: string;
  verifier: string;
  /** True when a person scanned the holder's code, rather than a registered partner. */
  isPeer: boolean;
  peerVerified: boolean;
  peerCountry: Country | null;
  purpose: string;
  claimCount: number;
  channel: PresentationChannel;
  expiresAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   Peer verification — this holder scanning somebody else's passport
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * What `POST /passport/scan` made of the scanned string.
 *
 * `NOT_PASSPORT` is a successful answer, not a failure: the scanner is a general-purpose
 * camera that also reads payment codes, and the caller branches on this rather than on a
 * thrown error. An unrecognised Pravaah reference also comes back as `NOT_PASSPORT`, so
 * the reference space cannot be walked to learn which codes exist.
 *
 * Note what a `PASSPORT` result does NOT contain: anything at all about the holder. Not a
 * name, not a confirmation the code belonged to anyone in particular. Everything the
 * scanner eventually learns arrives through {@link PeerCheckResult}, after approval.
 */
export type PeerScanOutcome =
  | { kind: 'NOT_PASSPORT' }
  | {
      kind: 'PASSPORT';
      requestId: string;
      status: 'PENDING';
      expiresAt: string;
      /** What was asked for. Fixed by the server — the scanner does not choose. */
      requestedClaims: string[];
      purpose: string;
      /** True when this rejoined a request already open with the same holder. */
      resumed: boolean;
    };

/** The verifier-facing verdict, as the scanner receives it once the holder approves. */
export interface PeerCheckVerdict {
  valid: boolean;
  issuer?: string;
  issuingAuthority: string;
  credentialNumber?: string;
  expiresAt?: string;
  /** The proof of possession checked out — the credential belongs to that device. */
  holderVerified: boolean;
  replayProtected: boolean;
  /** ONLY the claims the holder ticked. */
  claims: Record<string, unknown>;
  /** Asked for and deliberately not sent. Shown, never inferred as "false". */
  withheldClaims: string[];
  claimLabels: Record<string, string>;
  verifiedAt: string;
}

/** GET /passport/scan/:requestId */
export type PeerCheckResult =
  | { requestId: string; status: 'PENDING'; message: string }
  | { requestId: string; status: 'DECLINED'; message: string }
  | { requestId: string; status: 'EXPIRED'; message: string }
  | { requestId: string; status: 'CONSUMED'; result: PeerCheckVerdict };

/** POST /passport/requests/:id/approve */
export interface ApprovalResult {
  requestId: string;
  status: string;
  disclosedClaims: string[];
  withheldClaims: string[];
  skippedClaims: string[];
  verifier: string;
}

/** POST /passport/present */
export interface PresentationResult {
  presentation: string;
  disclosedClaims: string[];
  skippedClaims: string[];
  verification: {
    valid: boolean;
    code?: string;
    reason?: string;
    holderVerified: boolean;
    replayProtected: boolean;
  };
}

/** One row of the share history — who saw what, and when. */
export interface ShareRecord {
  id: string;
  verifier: string;
  /** True when a PERSON did the checking rather than a registered partner. */
  isPeer: boolean;
  verifierCountry: string | null;
  credentialNumber: string;
  channel: PresentationChannel;
  presentedAt: string;
  valid: boolean;
  holderVerified: boolean;
  failureReason: string | null;
  disclosedClaims: { claim: string; label: string }[];
}

/** GET/POST /passport/card */
export interface PassportCardPayload {
  cardSerial: string;
  status: CardStatus;
  nfcWritten: boolean;
  issuedAt: string;
  lastVerifiedAt: string | null;
  verifyUrl: string | null;
  nfcPayload: string | null;
  /** Server-rendered so the wallet, the console, and the printer draw one symbol. */
  qrSvg: string | null;
  /**
   * What the card FACE prints. Null once the card is reported lost, because it then points at
   * no credential. Sent by the server rather than derived from `cardSerial`: stripping the
   * `CARD-` prefix looks right and breaks on a replacement card, whose serial carries an
   * `-R…` suffix the credential number never had.
   */
  credentialNumber: string | null;
  expiresAt: string | null;
  mrz: { line1: string; line2: string; line3: string };
  artwork: {
    palette: Record<string, string>;
    bandAccent: string;
    band: string | null;
    dimensionsMm: { width: number; height: number; cornerRadius: number };
    title: string;
    issuer: string;
  };
}
