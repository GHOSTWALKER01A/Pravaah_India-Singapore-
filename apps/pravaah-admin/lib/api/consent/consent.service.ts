import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../core/base-api-service';
import {
  ConsentAuditResponseSchema,
  ConsentDetailResponseSchema,
  ConsentListResponseSchema,
} from './consent.schema';

/** Admin read-only view of the AA consent estate + audit trail. */
class ConsentService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.CONSENT.BASE);
  }

  async listConsents(status?: string) {
    const q =
      status && status !== 'ALL'
        ? `?status=${encodeURIComponent(status)}`
        : '';
    const res = await this.get(`${API_ENDPOINTS.CONSENT.LIST}${q}`);
    return ConsentListResponseSchema.parse(res).data;
  }

  async getConsent(id: string) {
    const res = await this.get(API_ENDPOINTS.CONSENT.DETAIL(id));
    return ConsentDetailResponseSchema.parse(res).data;
  }

  async getAudit(id: string) {
    const res = await this.get(API_ENDPOINTS.CONSENT.AUDIT(id));
    return ConsentAuditResponseSchema.parse(res).data;
  }
}

export const consentService = new ConsentService();
