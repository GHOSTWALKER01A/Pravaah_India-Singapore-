import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'

import type { Request } from 'express'

import { verifyHmacWebhook } from '@/common/http/webhook-signature.util'

/**
 * Verifies inbound provider webhooks: HMAC-SHA256 over `${timestamp}.${body}`,
 * a freshness window to blunt replay, and a timing-safe signature compare.
 * Per-event idempotency (dedupe) is enforced separately in the controller via
 * the unique `WebhookEvent(provider, eventId)` row.
 *
 * Signs over the raw request bytes when available (bootstrap sets
 * `rawBody: true`) so re-serialisation can never change the signed payload.
 */
@Injectable()
export class WebhookHmacGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>()

    const secret = process.env.WEBHOOK_HMAC_SECRET
    if (!secret) {
      throw new ForbiddenException('Webhook verification not configured')
    }

    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body ?? {})

    const res = verifyHmacWebhook({
      signature: req.headers['x-webhook-signature'] as string | undefined,
      timestamp: req.headers['x-webhook-timestamp'] as string | undefined,
      rawBody,
      secret,
    })
    if (!res.ok) throw new ForbiddenException(res.reason ?? 'Bad signature')
    return true
  }
}
