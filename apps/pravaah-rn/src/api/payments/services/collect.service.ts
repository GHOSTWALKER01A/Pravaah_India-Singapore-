import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  CollectStatus,
  CollectView,
  Paged,
  PurposeCode,
} from '../schemas';
import { toQuery } from './query';

/** Collect requests — asking someone else to pay. */
class CollectService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.COLLECT.BASE);
  }

  create(
    idempotencyKey: string,
    request: {
      payerHandle: string;
      amountMinor: string;
      currency: string;
      purposeCode: PurposeCode;
      narration?: string;
      expiresInSeconds?: number;
    },
  ): Promise<CollectView> {
    return this.postIdempotent<CollectView>(
      API_ENDPOINTS.COLLECT.CREATE,
      idempotencyKey,
      request,
    );
  }

  /**
   * `side` is required by the caller, never defaulted here.
   *
   * "You owe ₹500" and "you are owed ₹500" are opposite facts, and a default would let a screen
   * render one list believing it had the other. Being required means the mistake is a compile
   * error rather than a wrong screen.
   */
  list(params: {
    side: 'RAISED' | 'RECEIVED';
    status?: CollectStatus;
    limit?: number;
    offset?: number;
  }): Promise<Paged<CollectView>> {
    return this.get<Paged<CollectView>>(
      `${API_ENDPOINTS.COLLECT.LIST}${toQuery(params)}`,
    );
  }

  detail(id: string): Promise<CollectView> {
    return this.get<CollectView>(API_ENDPOINTS.COLLECT.DETAIL(id));
  }

  revoke(id: string): Promise<CollectView> {
    return this.post<CollectView>(API_ENDPOINTS.COLLECT.REVOKE(id));
  }
}

export const collectService = new CollectService();
