import { z } from 'zod'

/**
 * Payload Supabase Auth POSTs to our "Send SMS Hook" endpoint. Supabase
 * generates the OTP and delegates delivery to us (signed with standardwebhooks),
 * so we can send it over our own channel (MSG91 SMS).
 */

// Send SMS Hook — phone OTP.
export const SendSmsHookPayloadSchema = z.object({
  user: z.object({ phone: z.string().min(1) }),
  sms: z.object({ otp: z.string().min(1) }),
})
export type SendSmsHookPayload = z.infer<typeof SendSmsHookPayloadSchema>
