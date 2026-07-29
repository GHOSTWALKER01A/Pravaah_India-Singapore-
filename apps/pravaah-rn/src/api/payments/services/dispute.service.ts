import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  DisputeDetail,
  DisputeStatus,
  DisputeView,
  Paged,
} from '../schemas';
import { toQuery } from './query';

/** UDIR — the user's own disputes. */
class PaymentDisputeService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.DISPUTES.BASE);
  }

  /**
   * `status` is the shared `DisputeStatus`.
   *
   * This previously took a locally-declared `DisputeStatusFilter` listing the same five values — a
   * fourth copy of a vocabulary the Prisma enum already owns. It is now one type, so adding a
   * status upstream cannot leave this filter silently behind.
   */
  list(
    params: { status?: DisputeStatus; limit?: number; offset?: number } = {},
  ): Promise<Paged<DisputeView>> {
    return this.get<Paged<DisputeView>>(
      `${API_ENDPOINTS.DISPUTES.LIST}${toQuery(params)}`,
    );
  }

  detail(id: string): Promise<DisputeDetail> {
    return this.get<DisputeDetail>(API_ENDPOINTS.DISPUTES.DETAIL(id));
  }

  withdraw(id: string, reason?: string): Promise<DisputeView> {
    return this.post<DisputeView>(
      API_ENDPOINTS.DISPUTES.WITHDRAW(id),
      reason ? { reason } : {},
    );
  }
}

export const paymentDisputeService = new PaymentDisputeService();
