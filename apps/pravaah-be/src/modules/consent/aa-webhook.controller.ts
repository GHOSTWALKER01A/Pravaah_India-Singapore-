import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Inject,
  Post,
  Req,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { Request } from 'express'

import { verifyHmacWebhook } from '@/common/http/webhook-signature.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { AA_WEBHOOK_ROUTES } from '@/modules/consent/consent.route'
import { AaProviderRegistry } from '@/modules/consent/providers/aa/aa-registry'
import {
  ConsentNotificationService,
  type AaNotificationBody,
} from '@/modules/consent/services/consent-notification.service'

/**
 * Inbound AA notifications (consent status + FI-data-ready).
 *
 * A real AA (Setu/Finvu) signs each notification with a DETACHED JWS using its
 * OWN key — it does not know our HMAC secret — so this route can't use the
 * shared M0 HMAC guard. Instead {@link authenticate} accepts EITHER:
 *   1. `x-jws-signature` → verified against the ONE provider that owns the
 *      referenced consent/session (the real live path); or
 *   2. `x-webhook-signature` + `x-webhook-timestamp` → our HMAC convention
 *      (for local/sandbox testing; `npm run sign:webhook`).
 * An unsigned request is rejected. Per-event idempotency is enforced by the
 * unique `WebhookEvent(provider, eventId)` row.
 */
@Controller(AA_WEBHOOK_ROUTES.BASE)
export class AaWebhookController {
  private readonly logger: AppLogger

  constructor(
    private readonly registry: AaProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly notif: ConsentNotificationService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AaWebhookController.name })
  }

  @Post()
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string>,
    @Body() body: AaNotificationBody,
  ): Promise<{ ok: boolean; duplicate?: boolean }> {
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(body ?? {})

    await this.authenticate(headers, rawBody, body)

    const eventId =
      (body.notificationId as string) ??
      (body.txnid as string) ??
      `${body.consentId ?? body.sessionId ?? 'evt'}-${body.status ?? body.type ?? ''}`
    if (!eventId) throw new BadRequestException('Webhook missing event id')

    // Replay dedupe: a repeated (provider, eventId) is acked and ignored.
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: 'aa', eventId },
      })
    } catch {
      this.logger.warn('[handle] Duplicate AA webhook ignored', { eventId })
      return { ok: true, duplicate: true }
    }

    const isConsent =
      body.type === 'CONSENT' ||
      !!body.ConsentStatusNotification ||
      (!!body.consentId && !body.sessionId)

    if (isConsent) {
      await this.notif.onConsentNotification(body)
    } else {
      await this.notif.onFiNotification(body)
    }
    return { ok: true }
  }

  /**
   * Authenticate the notification: a real AA detached-JWS (routed to the owning
   * provider), OR our HMAC convention for testing. Throws 403 otherwise.
   */
  private async authenticate(
    headers: Record<string, string>,
    rawBody: string,
    body: AaNotificationBody,
  ): Promise<void> {
    // 1. Real AA path — detached JWS signed by the AA with its own key.
    if (headers['x-jws-signature']) {
      const provider = await this.resolveOwningProvider(body)
      if (!provider.verifyNotificationSignature(headers, rawBody)) {
        throw new ForbiddenException('Bad AA signature')
      }
      return
    }

    // 2. Testing/sandbox path — our HMAC convention (`npm run sign:webhook`).
    const secret = process.env.WEBHOOK_HMAC_SECRET
    if (secret && headers['x-webhook-signature']) {
      const res = verifyHmacWebhook({
        signature: headers['x-webhook-signature'],
        timestamp: headers['x-webhook-timestamp'],
        rawBody,
        secret,
      })
      if (!res.ok) throw new ForbiddenException(res.reason ?? 'Bad signature')
      return
    }

    throw new ForbiddenException('Unsigned webhook')
  }

  /**
   * Route signature verification to the provider that owns the referenced
   * consent/session (persisted `Consent.aaProvider`). Falls back to the current
   * mode's primary provider when the entity isn't found yet.
   */
  private async resolveOwningProvider(body: AaNotificationBody) {
    const providerConsentId =
      body.ConsentStatusNotification?.consentId ?? body.consentId
    if (providerConsentId) {
      const c = await this.prisma.consent.findUnique({
        where: { providerConsentId },
        select: { aaProvider: true },
      })
      if (c) return this.registry.byName(c.aaProvider)
    }
    const providerSessionId =
      body.FIStatusNotification?.sessionId ?? body.sessionId
    if (providerSessionId) {
      const s = await this.prisma.dataSession.findUnique({
        where: { providerSessionId },
        include: { consent: { select: { aaProvider: true } } },
      })
      if (s) return this.registry.byName(s.consent.aaProvider)
    }
    return this.registry.primary()
  }
}
