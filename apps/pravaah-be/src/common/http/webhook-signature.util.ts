import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Shared HMAC-SHA256 webhook verification (over `${timestamp}.${rawBody}`) with
 * a replay-freshness window and a timing-safe compare. Used by the M0 KYC
 * webhook guard and the M1 AA webhook controller so the signing scheme lives in
 * exactly one place.
 */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000

export interface HmacVerifyResult {
  ok: boolean
  /** Why verification failed — a client-safe reason for a 403. */
  reason?: string
}

export function verifyHmacWebhook(params: {
  signature?: string
  timestamp?: string | number
  rawBody: string
  secret: string
}): HmacVerifyResult {
  const sig = params.signature
  const ts = Number(params.timestamp)

  if (!sig || !Number.isFinite(ts)) return { ok: false, reason: 'Unsigned webhook' }
  if (Math.abs(Date.now() - ts) > WEBHOOK_REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'Stale webhook' }
  }

  const expected = createHmac('sha256', params.secret)
    .update(`${ts}.${params.rawBody}`)
    .digest('hex')

  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Bad signature' }
  }
  return { ok: true }
}
