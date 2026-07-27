import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../api/core/base-api-service';
import {
  MeResponseSchema,
  RefreshTokenRequest,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
  SendOtpRequest,
  SendOtpResponseSchema,
  VerifyOtpRequest,
  VerifyOtpResponseSchema,
} from './auth.schema';

class AuthService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.AUTH.BASE);
  }

  async sendOtp(request: SendOtpRequest) {
    const res = await this.post(API_ENDPOINTS.AUTH.SEND_OTP, request);
    return SendOtpResponseSchema.parse(res).data;
  }

  async resendOtp(request: SendOtpRequest) {
    const res = await this.post(API_ENDPOINTS.AUTH.RESEND_OTP, request);
    return SendOtpResponseSchema.parse(res).data;
  }

  async verifyOtp(request: VerifyOtpRequest) {
    const res = await this.post(API_ENDPOINTS.AUTH.VERIFY, request);
    return VerifyOtpResponseSchema.parse(res).data;
  }

  async refreshToken(request: RefreshTokenRequest) {
    const validated = RefreshTokenRequestSchema.parse(request);
    const res = await this.post(API_ENDPOINTS.AUTH.REFRESH, validated);
    return RefreshTokenResponseSchema.parse(res).data;
  }

  /** Resolve the current admin profile from the bearer token (used on load). */
  async me() {
    const res = await this.get(API_ENDPOINTS.AUTH.ME);
    return MeResponseSchema.parse(res).data;
  }
}

export const authService = new AuthService();
