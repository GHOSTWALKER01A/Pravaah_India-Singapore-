import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  MandateDetail,
  MandateFrequency,
  MandateStatus,
  MandateView,
  Paged,
  PurposeCode,
} from '../schemas';
import { toQuery } from './query';

/** AutoPay — standing authorisations. */
class MandateService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.MANDATES.BASE);
  }

  create(
    idempotencyKey: string,
    request: {
      beneficiaryId: string;
      frequency: MandateFrequency;
      amountRule: 'EXACT' | 'MAX';
      maxAmountMinor: string;
      currency: string;
      purposeCode: PurposeCode;
      narration?: string;
      validFrom: string;
      validUntil: string;
      confirmedMandate: true;
    },
  ): Promise<MandateView> {
    return this.postIdempotent<MandateView>(
      API_ENDPOINTS.MANDATES.CREATE,
      idempotencyKey,
      request,
    );
  }

  list(
    params: { status?: MandateStatus; limit?: number; offset?: number } = {},
  ): Promise<Paged<MandateView>> {
    return this.get<Paged<MandateView>>(
      `${API_ENDPOINTS.MANDATES.LIST}${toQuery(params)}`,
    );
  }

  detail(id: string): Promise<MandateDetail> {
    return this.get<MandateDetail>(API_ENDPOINTS.MANDATES.DETAIL(id));
  }

  /** Pause and resume are reversible; REVOKE is permanent. */
  act(
    id: string,
    action: 'PAUSE' | 'RESUME' | 'REVOKE',
    reason?: string,
  ): Promise<MandateView> {
    return this.post<MandateView>(API_ENDPOINTS.MANDATES.ACTION(id), {
      action,
      ...(reason ? { reason } : {}),
    });
  }
}

export const mandateService = new MandateService();
