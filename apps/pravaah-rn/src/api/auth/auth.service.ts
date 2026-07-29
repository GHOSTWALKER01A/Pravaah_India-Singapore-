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

  /**
   * Exchange a persisted refresh token for a live session.
   *
   * Used by the launch unlock gate after the OS has released the stored token. The endpoint
   * mints a FRESH pair rather than reusing the presented one, so a token read from one launch
   * is not the token the app carries afterwards.
   *
   * `auth: false` because there is no access token yet — that is the whole point of the call.
   * Sending one would be sending the expired token this exists to replace.
   *
   * Throws on a rejected token. The caller treats that as "sign in with a code", because a
   * refresh token the server will not honour cannot be recovered on the client: it is either
   * past its 30 days or signed with a key that has since rotated, and no retry changes either.
   */
  async restore(refreshToken: string): Promise<void> {
    const data = await this.post<{ accessToken: string; refreshToken: string }>(
      API_ENDPOINTS.AUTH.REFRESH,
      { refreshToken },
      false,
    );
    tokenManager.setTokens(data.accessToken, data.refreshToken);
  }

  logout(): void {
    tokenManager.clear();
  }
}

export const authService = new AuthService();
