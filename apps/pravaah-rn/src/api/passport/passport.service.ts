import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import {
  ApprovalResult,
  ClaimCatalogue,
  IssuedPassport,
  PassportCardPayload,
  PeerCheckResult,
  PeerScanOutcome,
  PendingRequestSummary,
  PresentationResult,
  ShareRecord,
  SigningMaterial,
  VerifierRequestDetail,
  WalletResult,
} from './passport.schema';

import type { HolderPublicJwk } from '@/features/passport/holder-key';

/**
 * M3 passport API. Mirrors the ScoreService shape — a thin, typed wrapper over the shared
 * api-client, with the bearer token, refresh, and `{ data }` unwrap handled centrally.
 *
 * Note what is absent: nothing here signs. Every call that needs a proof of possession
 * takes a `kbJwt` the caller obtained from `holder-key`, because the private key lives in
 * the device keystore and this layer must never be able to reach it.
 */
class PassportService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.PASSPORT.BASE);
  }

  /** The passport, or the state explaining its absence. Safe to poll. */
  wallet(): Promise<WalletResult> {
    return this.get<WalletResult>(API_ENDPOINTS.PASSPORT.CURRENT);
  }

  /**
   * Mint the credential against this device's public key.
   *
   * `bindPassportNumber` is opt-in: a domestic holder should not carry a cross-border
   * identity binding they never asked for, and the number is a HIGH-sensitivity claim.
   */
  issue(request: {
    holderPublicJwk: HolderPublicJwk;
    deviceLabel?: string;
    bindPassportNumber?: boolean;
  }): Promise<IssuedPassport> {
    return this.post<IssuedPassport>(API_ENDPOINTS.PASSPORT.ISSUE, request);
  }

  /**
   * The claim catalogue and the request templates.
   *
   * Fetched rather than bundled so an app that has not been updated still renders a newer
   * credential's claims with real labels instead of raw snake_case keys.
   */
  claims(): Promise<ClaimCatalogue> {
    return this.get<ClaimCatalogue>(API_ENDPOINTS.PASSPORT.CLAIMS);
  }

  /** Requests waiting on the holder. Drives the wallet's inbox. */
  pendingRequests(): Promise<PendingRequestSummary[]> {
    return this.get<PendingRequestSummary[]>(API_ENDPOINTS.PASSPORT.REQUESTS);
  }

  /** Everything the consent-to-disclose screen needs: who is asking, for what, and why. */
  request(requestId: string): Promise<VerifierRequestDetail> {
    return this.get<VerifierRequestDetail>(
      API_ENDPOINTS.PASSPORT.REQUEST_DETAIL(requestId),
    );
  }

  /**
   * Approve a request with the claims the holder ticked.
   *
   * `kbJwt` is signed on device against the request's own nonce and audience, so the holder
   * can never be induced to sign over a challenge of somebody else's choosing.
   */
  approve(
    requestId: string,
    request: { credentialId: string; revealClaims: string[]; kbJwt: string },
  ): Promise<ApprovalResult> {
    return this.post<ApprovalResult>(
      API_ENDPOINTS.PASSPORT.REQUEST_APPROVE(requestId),
      request,
    );
  }

  decline(requestId: string, reason?: string): Promise<{ requestId: string; status: string }> {
    return this.post<{ requestId: string; status: string }>(
      API_ENDPOINTS.PASSPORT.REQUEST_DECLINE(requestId),
      reason ? { reason } : {},
    );
  }

  /**
   * Ask for the exact bytes to sign.
   *
   * The verifier's `audience` and `nonce` go UP with the request and come back unchanged —
   * the server does not mint them, because a nonce is only a replay defence if the party
   * checking it chose it.
   */
  signingMaterial(request: {
    credentialId: string;
    audience: string;
    nonce: string;
    revealClaims: string[];
  }): Promise<SigningMaterial> {
    return this.post<SigningMaterial>(
      API_ENDPOINTS.PASSPORT.CHALLENGE,
      request,
    );
  }

  /** Build a presentation directly, when the verifier's nonce is already in hand. */
  present(request: {
    credentialId: string;
    revealClaims: string[];
    verifier: string;
    nonce: string;
    channel?: 'QR' | 'NFC' | 'DEEPLINK' | 'API';
    kbJwt: string;
  }): Promise<PresentationResult> {
    return this.post<PresentationResult>(API_ENDPOINTS.PASSPORT.PRESENT, request);
  }

  // ── peer verification: this holder checking somebody else ─────────────────
  /**
   * Hand over whatever the camera read.
   *
   * The payload is parsed SERVER-SIDE, exactly as the payments scanner parses server-side
   * and for the same reason: whoever printed the code chose every byte of it, and two
   * parsers that disagree about a malformed one are two different answers to "whose
   * passport is this".
   *
   * A `NOT_PASSPORT` outcome is a normal answer rather than a throw, so the scan screen
   * can fall through to the payments reader without treating a UPI code as a failure.
   */
  scan(payload: string, ttlSeconds?: number): Promise<PeerScanOutcome> {
    return this.post<PeerScanOutcome>(API_ENDPOINTS.PASSPORT.SCAN, {
      payload,
      ...(ttlSeconds ? { ttlSeconds } : {}),
    });
  }

  /** Poll for the holder's answer. Safe to call on a timer; idempotent once approved. */
  scanResult(requestId: string): Promise<PeerCheckResult> {
    return this.get<PeerCheckResult>(
      API_ENDPOINTS.PASSPORT.SCAN_RESULT(requestId),
    );
  }

  /** Withdraw the request, so the other person stops being asked. */
  cancelScan(requestId: string): Promise<{ status: string }> {
    return this.delete<{ status: string }>(
      API_ENDPOINTS.PASSPORT.SCAN_RESULT(requestId),
    );
  }

  /** Share history — the transparency half of selective disclosure. */
  history(limit = 50): Promise<ShareRecord[]> {
    return this.get<ShareRecord[]>(
      `${API_ENDPOINTS.PASSPORT.HISTORY}?limit=${limit}`,
    );
  }

  // ── the physical card ─────────────────────────────────────────────────────
  card(): Promise<PassportCardPayload | null> {
    return this.get<PassportCardPayload | null>(API_ENDPOINTS.PASSPORT.CARD);
  }

  /** Issue or re-point the card. Idempotent — a refreshed score keeps the same plastic. */
  issueCard(): Promise<PassportCardPayload> {
    return this.post<PassportCardPayload>(API_ENDPOINTS.PASSPORT.CARD);
  }

  markCardWritten(): Promise<{ nfcWritten: boolean }> {
    return this.post<{ nfcWritten: boolean }>(
      API_ENDPOINTS.PASSPORT.CARD_NFC_WRITTEN,
    );
  }

  /**
   * Report the card lost. Disables the card AND revokes the credential — a lost card
   * usually means a lost wallet, and the phone may have gone with it.
   */
  reportCardLost(): Promise<{
    status: string;
    credentialRevoked: boolean;
    message: string;
  }> {
    return this.post<{ status: string; credentialRevoked: boolean; message: string }>(
      API_ENDPOINTS.PASSPORT.CARD_LOST,
    );
  }

  /**
   * The holder kills their own passport. Terminal — a new one must be issued.
   *
   * No reason parameter: the shared api-client's DELETE carries no body, and a signature
   * that accepted a reason it silently discarded would be worse than not offering one.
   * The server records `user_revoked`, which is the only reason that matters here.
   */
  revoke(credentialId: string): Promise<{ status: string }> {
    return this.delete<{ status: string }>(
      API_ENDPOINTS.PASSPORT.REVOKE(credentialId),
    );
  }
}

export const passportService = new PassportService();
