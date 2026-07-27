import { z } from 'zod'

/**
 * Registers a device's Expo push token so the backend can notify the user of
 * KYC decisions even when the app is closed. Token looks like
 * `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`.
 */
export const PushTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, 'Push token is required')
    .max(255)
    .regex(/^Expo(nent)?PushToken\[.+\]$/, 'Invalid Expo push token'),
})
export type PushTokenDto = z.infer<typeof PushTokenSchema>
