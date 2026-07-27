import { z } from 'zod'

import { APIResponseSchema, PravaahIdSchema } from '../../common'
import { authFields } from './sign-in.dto'

/** Verify an OTP by phone (SMS). */
export const VerifyRequestSchema = z.object({
  phone: authFields.phone,
  countryCode: authFields.countryCode,
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Invalid OTP'),
})
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>

export const VerifyDataSchema = z.object({
  /** Internal row id. Kept for API calls; never rendered to a user. */
  userId: z.string().uuid(),
  /** The user's public identity, `PVH-XXXX-XXXX-XXXX`. This is what the app shows. */
  pravaahId: PravaahIdSchema,
  channel: z.literal('sms'),
  phone: z.string(),
  countryCode: z.string(),
  kycStatus: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
})
export type VerifyData = z.infer<typeof VerifyDataSchema>

export const VerifyResponseSchema = APIResponseSchema(VerifyDataSchema)
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>
