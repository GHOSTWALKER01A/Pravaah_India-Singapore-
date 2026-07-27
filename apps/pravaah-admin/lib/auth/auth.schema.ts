import { z } from 'zod';

import { APIResponseSchema } from '../api/core/api.schema';

// ── Phone validation (shared by the login form + request) ─────────────────
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\d{6,15}$/, 'Enter a valid phone number (digits only, 6–15)');

export const CountryCodeSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{1,4}$/, 'Invalid country code');

// Phone login validator used by the login form.
export const PhoneLoginSchema = z.object({
  phone: PhoneSchema,
  countryCode: CountryCodeSchema,
});
export type PhoneLoginValues = z.infer<typeof PhoneLoginSchema>;

// Request an OTP by phone (SMS) — mirrors the backend.
export const SendOtpRequestSchema = z.object({
  phone: PhoneSchema,
  countryCode: CountryCodeSchema,
});
export type SendOtpRequest = z.infer<typeof SendOtpRequestSchema>;

export const SendOtpDataSchema = z.object({
  channel: z.literal('sms'),
  phone: z.string().optional(),
  countryCode: z.string().optional(),
});
export const SendOtpResponseSchema = APIResponseSchema(SendOtpDataSchema);
export type SendOtpResponse = z.infer<typeof SendOtpResponseSchema>;

export const VerifyOtpRequestSchema = z.object({
  phone: PhoneSchema,
  countryCode: CountryCodeSchema,
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Enter the 6-digit code'),
});
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequestSchema>;

// ── Admin profile returned by /admin/auth/verify and /admin/auth/me ────────
export const AdminProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: z.enum(['REVIEWER', 'SENIOR_REVIEWER', 'ADMIN']),
  isActive: z.boolean(),
});
export type AdminProfile = z.infer<typeof AdminProfileSchema>;

export const VerifyOtpDataSchema = z.object({
  admin: AdminProfileSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
});
export const VerifyOtpResponseSchema = APIResponseSchema(VerifyOtpDataSchema);
export type VerifyOtpData = z.infer<typeof VerifyOtpDataSchema>;

export const MeResponseSchema = APIResponseSchema(AdminProfileSchema);

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string(),
});
export const RefreshTokenDataSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export const RefreshTokenResponseSchema = APIResponseSchema(
  RefreshTokenDataSchema,
);
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
