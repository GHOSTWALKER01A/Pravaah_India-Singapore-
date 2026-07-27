import { API_ENDPOINTS } from '@/constants/api.constants';

import { apiClient } from '@/api/core/api-client';
import { BaseApiService } from '@/api/core/base-api-service';

import {
  ConsentStatusResult,
  ConsentSummary,
  CreateConsentData,
  CreateConsentRequest,
} from './consent.schema';

/**
 * M1 consent API. Mirrors the KycService shape: a thin, typed wrapper over the
 * shared api-client (bearer + refresh + `{ data }` unwrap handled centrally).
 */
class ConsentService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.CONSENT.BASE);
  }

  /** Create (or resume) an AA consent. Returns the AA approval URL to open. */
  create(request: CreateConsentRequest): Promise<CreateConsentData> {
    return this.post<CreateConsentData>(API_ENDPOINTS.CONSENT.CREATE, request);
  }

  /** All of this user's consents — the Consent Dashboard. */
  list(): Promise<ConsentSummary[]> {
    return this.get<ConsentSummary[]>(API_ENDPOINTS.CONSENT.LIST);
  }

  /** One consent's live status + data-session coverage. */
  status(id: string): Promise<ConsentStatusResult> {
    return this.get<ConsentStatusResult>(API_ENDPOINTS.CONSENT.STATUS(id));
  }

  /** Revoke a consent — propagates to the AA and purges all fetched data. */
  revoke(id: string): Promise<{ ok: true }> {
    return this.delete<{ ok: true }>(API_ENDPOINTS.CONSENT.REVOKE(id));
  }

  /** Re-fetch (e.g. after linking more accounts on a PARTIAL consent). */
  refetch(id: string): Promise<ConsentStatusResult> {
    return this.post<ConsentStatusResult>(API_ENDPOINTS.CONSENT.REFETCH(id));
  }

  /**
   * Sandbox-only: approve/reject the pending consent at the mock AA screen
   * (drives the same notification path a live AA webhook would). No auth.
   */
  mockDecision(
    providerConsentId: string,
    decision: 'APPROVE' | 'REJECT',
  ): Promise<{ ok: boolean; status: string }> {
    // Absolute path (different base) + no auth — call the client directly.
    return apiClient.post<{ ok: boolean; status: string }>(
      `${API_ENDPOINTS.MOCK_AA.BASE}${API_ENDPOINTS.MOCK_AA.DECISION(providerConsentId)}`,
      { decision },
      false,
    );
  }
}

export const consentService = new ConsentService();
