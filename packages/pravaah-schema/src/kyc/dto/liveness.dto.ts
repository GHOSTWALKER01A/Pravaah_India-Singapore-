import { z } from 'zod'

/**
 * Gesture prompts an active-liveness challenge can contain. The server issues a
 * randomized, ordered subset per session; the client must perform them in order
 * on the live camera. Randomization per attempt defeats replay/recorded-video
 * attacks — a captured clip won't satisfy the next challenge sequence.
 */
export const LIVENESS_GESTURES = [
  'BLINK',
  'TURN_LEFT',
  'TURN_RIGHT',
  'SMILE',
  'NOD',
] as const
export const LivenessGestureSchema = z.enum(LIVENESS_GESTURES)
export type LivenessGesture = z.infer<typeof LivenessGestureSchema>

/** Returned by POST /liveness/session — the session id + its randomized challenge. */
export const LivenessSessionDataSchema = z.object({
  sessionId: z.string().min(1),
  challenge: z.array(LivenessGestureSchema).min(1),
})
export type LivenessSessionData = z.infer<typeof LivenessSessionDataSchema>

/**
 * Verify body (multipart). The `selfie` frame is read as a file; these are the
 * accompanying text fields. `challenge` arrives as a comma-separated string
 * (multipart fields are strings) and is coerced to the ordered gesture list so
 * the server can match it against the sequence it issued for the session.
 */
export const LivenessVerifySchema = z.object({
  sessionId: z.string().min(1),
  challenge: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
    )
    .pipe(z.array(LivenessGestureSchema).min(1)),
})
export type LivenessVerifyDto = z.infer<typeof LivenessVerifySchema>
