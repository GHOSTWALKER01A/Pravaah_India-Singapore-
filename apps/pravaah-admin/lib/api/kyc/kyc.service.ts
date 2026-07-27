import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../core/base-api-service';
import {
  DecisionRequest,
  KycCaseDetailResponseSchema,
  KycCaseListResponseSchema,
} from './kyc.schema';

class KycService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.KYC.BASE);
  }

  async listCases(status = 'OPEN') {
    const res = await this.get(
      `${API_ENDPOINTS.KYC.CASES}?status=${encodeURIComponent(status)}`,
    );
    return KycCaseListResponseSchema.parse(res).data;
  }

  async getCase(id: string) {
    const res = await this.get(API_ENDPOINTS.KYC.CASE_DETAIL(id));
    return KycCaseDetailResponseSchema.parse(res).data;
  }

  async claimCase(id: string) {
    const res = await this.post(API_ENDPOINTS.KYC.CASE_CLAIM(id));
    return KycCaseDetailResponseSchema.parse(res).data;
  }

  async decideCase(id: string, request: DecisionRequest) {
    const res = await this.post(API_ENDPOINTS.KYC.CASE_DECISION(id), request);
    return KycCaseDetailResponseSchema.parse(res).data;
  }
}

export const kycService = new KycService();
