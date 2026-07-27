import { z } from 'zod'

import { APIResponseSchema } from '../../common'

const phone = z
  .string()
  .trim()
  .regex(/^\d{6,15}$/, 'Invalid phone number')
const countryCode = z
  .string()
  .trim()
  .regex(/^\+?\d{1,4}$/, 'Invalid country code')

/** Request an OTP by phone (SMS). Signup and login are the same flow. */
export const SignInRequestSchema = z.object({
  phone,
  countryCode,
})
export type SignInRequest = z.infer<typeof SignInRequestSchema>

export const SignInDataSchema = z.object({
  channel: z.literal('sms'),
  phone: z.string(),
  countryCode: z.string(),
})
export type SignInData = z.infer<typeof SignInDataSchema>

export const SignInResponseSchema = APIResponseSchema(SignInDataSchema)
export type SignInResponse = z.infer<typeof SignInResponseSchema>

// Re-exported field validators so verify.dto can share them.
export const authFields = { phone, countryCode }
