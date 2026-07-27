import { z } from 'zod'

import { APIResponseSchema } from '../../common'
import { AdminProfileSchema } from '../schemas/admin-profile.schema'

/**
 * Admin OTP verify returns the reviewer profile alongside the session, so the
 * console can render role-gated UI immediately. Request shape is reused from
 * the shared auth `VerifyRequestSchema` (phone | email + otp).
 */
export const AdminVerifyDataSchema = z.object({
  admin: AdminProfileSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
})
export type AdminVerifyData = z.infer<typeof AdminVerifyDataSchema>

export const AdminVerifyResponseSchema = APIResponseSchema(
  AdminVerifyDataSchema,
)
export type AdminVerifyResponse = z.infer<typeof AdminVerifyResponseSchema>
