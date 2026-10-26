import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  PageOf,
  ShareReceipt,
  ShareReceiptDetail,
  ShareReceiptStatus,
  WithdrawShareResult,
} from './shares.schema';

/**
 * M7 consent receipts. A thin typed wrapper, like every other domain service — auth,
 * refresh and the `{ data }` unwrap live in the shared client.
 *
 * Every call is scoped server-side to the signed-in holder, so a receipt id belonging to
 * anyone else is a 404 rather than a way to learn that it exists.
 */
class SharesService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.SHARES.BASE);
  }

  list(query: {
    status?: ShareReceiptStatus;
    limit?: number;
    offset?: number;
  } = {}): Promise<PageOf<ShareReceipt>> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    params.set('limit', String(query.limit ?? 25));
    params.set('offset', String(query.offset ?? 0));
    return this.get<PageOf<ShareReceipt>>(`${API_ENDPOINTS.SHARES.LIST}?${params.toString()}`);
  }

  detail(receiptId: string): Promise<ShareReceiptDetail> {
    return this.get<ShareReceiptDetail>(API_ENDPOINTS.SHARES.DETAIL(receiptId));
  }

  /** The receipt for a request the holder just approved — the "shared ✓" screen. */
  byRequest(requestId: string): Promise<ShareReceipt> {
    return this.get<ShareReceipt>(API_ENDPOINTS.SHARES.BY_REQUEST(requestId));
  }

  /**
   * Withdraw a share. No reason is sent: the server would keep it for PRAVAAH's own
   * insight and never forward it, and asking for one adds friction to the one action a
   * holder must always be able to take quickly.
   */
  withdraw(receiptId: string): Promise<WithdrawShareResult> {
    return this.post<WithdrawShareResult>(API_ENDPOINTS.SHARES.WITHDRAW(receiptId), {});
  }
}

export const sharesService = new SharesService();
