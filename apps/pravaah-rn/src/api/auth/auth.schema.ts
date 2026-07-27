export type Channel = 'sms';

/** OTP delivery target: phone + countryCode (SMS). */
export interface SendOtpRequest {
  phone: string;
  countryCode: string;
}

export interface SendOtpData {
  channel: Channel;
  phone?: string;
  countryCode?: string;
}

export interface VerifyOtpRequest extends SendOtpRequest {
  otp: string;
}

export interface VerifyOtpData {
  /** Internal row id — used for API calls, never shown to the user. */
  userId: string;
  /** The user's permanent public identity, `PVH-XXXX-XXXX-XXXX`. */
  pravaahId: string;
  channel: Channel;
  phone?: string;
  countryCode?: string;
  kycStatus: string;
  accessToken: string;
  refreshToken: string;
}
