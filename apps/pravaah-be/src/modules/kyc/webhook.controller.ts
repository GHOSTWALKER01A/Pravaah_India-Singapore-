import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { WebhookHmacGuard } from '@/common/guards/webhook-hmac.guard'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { KYC_WEBHOOK_ROUTES } from '@/modules/kyc/kyc.route'
import { AadhaarOkycService } from '@/modules/kyc/services/aadhaar-okyc.service'

interface KycWebhookBody {
  eventId?: string
  decentroTxnId?: string
  type?: string
  [key: string]: unknown
}

/**
 * Inbound provider webhooks. Signature/freshness are enforced by
 * {@link WebhookHmacGuard}; here we add per-event idempotency (unique
 * `WebhookEvent`) and route by event type. The internal user is resolved from
 * the stored `providerRefId` — webhooks never carry our internal ids.
 */
@Controller(KYC_WEBHOOK_ROUTES.BASE)
@UseGuards(WebhookHmacGuard)
export class KycWebhookController {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly okyc: AadhaarOkycService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: KycWebhookController.name })
  }

  @Post(KYC_WEBHOOK_ROUTES.PROVIDER)
  async handle(
    @Param('provider') provider: string,
    @Body() body: KycWebhookBody,
  ): Promise<{ ok: boolean; duplicate?: boolean }> {
    const eventId = body.eventId ?? body.decentroTxnId
    if (!eventId) {
      throw new BadRequestException('Webhook missing event id')
    }
    this.logger.info(`[${this.handle.name}] Received webhook`, {
      provider,
      eventId,
      type: body.type,
    })

    // Replay protection: a duplicate (provider, eventId) is acked and ignored.
    try {
      await this.prisma.webhookEvent.create({ data: { provider, eventId } })
    } catch {
      this.logger.warn(`[${this.handle.name}] Duplicate webhook ignored`, {
        provider,
        eventId,
      })
      return { ok: true, duplicate: true }
    }

    if (body.type === 'DIGILOCKER_COMPLETED' && body.decentroTxnId) {
      const userId = await this.resolveUserByProviderRef(body.decentroTxnId)
      if (userId) {
        await this.okyc.complete(userId, body.decentroTxnId)
      } else {
        this.logger.warn(
          `[${this.handle.name}] No user found for providerRef`,
          { providerRefId: body.decentroTxnId },
        )
      }
    }
    return { ok: true }
  }

  private async resolveUserByProviderRef(
    providerRefId: string,
  ): Promise<string | null> {
    const check = await this.prisma.kycCheck.findFirst({
      where: { providerRefId },
      include: { kycProfile: { select: { userId: true } } },
    })
    return check?.kycProfile.userId ?? null
  }
}
