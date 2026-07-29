import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type { Claim, FinaliseClaimResult, SubmitClaimRequest } from '../schemas';
import { toQuery } from '@/api/payments/services/query';

/** A document ready to upload, as `expo-image-picker` / the camera hands it over. */
export interface ClaimUpload {
  /** A local `file://` URI. */
  uri: string;
  /** e.g. `image/jpeg`, `application/pdf`, `application/json`. */
  mimeType: string;
  fileName: string;
}

/**
 * Claims: file, evidence, finalise, track.
 *
 * ## Why filing and finalising are two calls
 *
 * A claim is created first, documents are attached to it one multipart request at a
 * time, and only then does the fraud gate run. Folding it into one submission would
 * mean either uploading every photograph in a single request — which fails wholesale
 * when one of them times out on a patchy connection — or scoring every claim as though
 * it had no documents at all. The claimant this product serves is on a phone in a
 * hospital corridor; the flow has to survive a dropped upload without losing the claim.
 */
class ClaimsService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.CLAIMS.BASE);
  }

  /**
   * File a claim.
   *
   * Every coverage guard runs server-side before a row exists — the policy must be
   * live, the incident must fall after the waiting period and inside the term, and the
   * amount must fit the REMAINING cover. A 400 from here carries the reason in plain
   * words and should be shown verbatim rather than replaced with a generic message: the
   * server's wording is the one that explains a waiting period to somebody who has just
   * discovered it.
   */
  file(request: SubmitClaimRequest): Promise<Claim> {
    return this.post<Claim>(API_ENDPOINTS.CLAIMS.FILE, request);
  }

  claims(
    params: {
      status?: string;
      policyId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ items: Claim[]; total: number }> {
    return this.get<{ items: Claim[]; total: number }>(
      `${API_ENDPOINTS.CLAIMS.LIST}${toQuery(params)}`,
    );
  }

  claim(id: string): Promise<Claim> {
    return this.get<Claim>(API_ENDPOINTS.CLAIMS.DETAIL(id));
  }

  /**
   * Attach one document. OCR and the tamper check run on upload.
   *
   * The `uri`/`type`/`name` object is React Native's own multipart shape — RN's
   * `FormData` accepts it where the web would need a `Blob`, and reading the file into
   * a base64 string first (the obvious cross-platform alternative) would hold an entire
   * photograph in JS memory and inflate it by a third on the wire.
   */
  addDocument(
    claimId: string,
    docType: string,
    file: ClaimUpload,
  ): Promise<Claim> {
    const form = new FormData();
    form.append('docType', docType);
    form.append('document', {
      uri: file.uri,
      type: file.mimeType,
      name: file.fileName,
      // RN's FormData part is not a web `Blob`; the cast is the documented shape.
    } as unknown as Blob);

    return this.postForm<Claim>(
      API_ENDPOINTS.CLAIMS.DOCUMENTS(claimId),
      form,
    );
  }

  /**
   * Finish the submission — run the fraud gate.
   *
   * `autoApproved` in the result means the claim settled without a human: small, low
   * risk, no tampered document, every document verified. Anything else routes to a
   * reviewer, and the claimant is told which happened.
   */
  finalise(claimId: string): Promise<FinaliseClaimResult> {
    return this.post<FinaliseClaimResult>(
      API_ENDPOINTS.CLAIMS.FINALISE(claimId),
      {},
    );
  }

  /** Withdraw. Available while SUBMITTED or INFO_REQUESTED only. */
  withdraw(claimId: string, reason?: string): Promise<Claim> {
    return this.post<Claim>(
      API_ENDPOINTS.CLAIMS.WITHDRAW(claimId),
      reason ? { reason } : {},
    );
  }
}

export const claimsService = new ClaimsService();
