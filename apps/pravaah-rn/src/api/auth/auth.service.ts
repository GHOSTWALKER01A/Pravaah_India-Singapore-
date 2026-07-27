import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import {
  SendOtpData,
  SendOtpRequest,
  VerifyOtpData,
  VerifyOtpRequest,
} from './auth.schema';
import { tokenManager } from './token-manager';

class AuthService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.AUTH.BASE);
  }

  sendOtp(request: SendOtpRequest): Promise<SendOtpData> {
    return this.post<SendOtpData>(API_ENDPOINTS.AUTH.SEND_OTP, request, false);
  }

  resendOtp(request: SendOtpRequest): Promise<SendOtpData> {
    return this.post<SendOtpData>(API_ENDPOINTS.AUTH.RESEND_OTP, request, false);
  }

  async verifyOtp(request: VerifyOtpRequest): Promise<VerifyOtpData> {
    const data = await this.post<VerifyOtpData>(
      API_ENDPOINTS.AUTH.VERIFY,
      request,
      false,
    );
    tokenManager.setTokens(data.accessToken, data.refreshToken);
    return data;
  }

  logout(): void {
    tokenManager.clear();
  }
}

export const authService = new AuthService();
