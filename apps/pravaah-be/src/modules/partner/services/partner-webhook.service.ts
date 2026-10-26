import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  PARTNER_WEBHOOK_EVENT,
  PARTNER_WEBHOOK_HEADERS,
  type PartnerWebhookEventType,
  type WebhookDeliveryQueryDto,
} from '@pravaah/schema'
import axios from 'axios'

import { decryptField } from '@/common/crypto/field-crypto.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  PartnerStatus,
  WebhookDeliveryStatus,
  type Prisma,
  type PartnerWebhookDelivery,
  type VerifierPartner,
} from 'generated/prisma/client'

import { PartnerConfig } from '@/modules/partner/partner.config'
import { webhookBackoffMs } from '@/modules/partner/partner.state'
import {
  WebhookTargetError,
  assertWebhookUrl,
  safeLookupFor,
  signWebhook,
} from '@/modules/partner/partner-webhook.util'

type Db = Prisma.TransactionClient | PrismaService

/** Deliveries claimed per dispatcher run. The next run takes the rest. */
const DISPATCH_BATCH = 25
/** How long a claimed delivery is ours before another run may take it. */
const LEASE_MS = 60_000
/** Response bodies are recorded for debugging, truncated. */
const MAX_ERROR_CHARS = 500

type PartnerWebhookTarget = Pick<
  VerifierPartner,
  'id' | 'webhookUrl' | 'webhookSecretEnc' | 'status'
>

/**
 * Outbound, signed, retried webhooks to partners.
 *
 * A TRANSACTIONAL OUTBOX: a delivery row is written in the same transaction as the
 * fact it reports (the usage event, the consent receipt), so "the partner was told"
 * can never diverge from "it happened". The dispatcher then delivers asynchronously
 * with exponential backoff. A synchronous POST inside the holder's approval would
 * put a partner's slow endpoint on the holder's critical path — and a failed POST
 * would have to either fail the approval or be forgotten.
 *
 * Guarantees, and how each is kept:
 *
 *  - AT-LEAST-ONCE: a row stays PENDING until a 2xx; a crashed run's lease expires.
 *  - IDEMPOTENT for the partner: every delivery carries a stable `x-pravaah-event-id`.
 *  - ONE delivery per fact: `dedupeKey` is unique, so re-observing a fact enqueues nothing.
 *  - AUTHENTIC: HMAC over `${timestamp}.${body}` — see `signWebhook`.
 *  - NO SSRF: static URL checks plus connect-time address validation, no redirects.
 *  - MINIMAL: payloads carry claim NAMES and predicate booleans, never claim values.
 */
@Injectable()
export class PartnerWebhookService {
  private readonly logger: AppLogger
  private dispatching = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PartnerConfig,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerWebhookService.name })
  }

  /**
   * Queue a webhook. A no-op when the partner has no endpoint or no secret yet —
   * polling `GET /partner/verifications/:id` always works, so a missing webhook
   * degrades to polling rather than to a pile of undeliverable rows.
   */
  async enqueue(
    db: Db,
    partner: PartnerWebhookTarget,
    type: PartnerWebhookEventType,
    data: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<boolean> {
    if (!partner.webhookUrl || !partner.webhookSecretEnc) return false
    if (partner.status === PartnerStatus.REVOKED) return false

    const eventId = randomUUID()
    const result = await db.partnerWebhookDelivery.createMany({
      data: [
        {
          partnerId: partner.id,
          eventId,
          eventType: type,
          dedupeKey,
          payload: {
            id: eventId,
            type,
            createdAt: new Date().toISOString(),
            data,
          } as Prisma.InputJsonValue,
        },
      ],
      // ON CONFLICT DO NOTHING — safe inside the caller's transaction.
      skipDuplicates: true,
    })
    return result.count > 0
  }

  /** Nudge the dispatcher after a commit. Best-effort; the cron is the guarantee. */
  kick(): void {
    void this.dispatchDue().catch((error) =>
      this.logger.warn(`[${this.kick.name}] Immediate dispatch failed`, {
        err: error,
      }),
    )
  }

  /**
   * Deliver everything due. Safe to run concurrently across instances: each row is
   * claimed with a compare-and-swap on its lease before it is sent.
   */
  async dispatchDue(): Promise<{ attempted: number; delivered: number }> {
    // In-process overlap guard: the cron and a kick must not both walk the queue.
    if (this.dispatching) return { attempted: 0, delivered: 0 }
    this.dispatching = true
    try {
      const now = new Date()
      const due = await this.prisma.partnerWebhookDelivery.findMany({
        where: {
          status: WebhookDeliveryStatus.PENDING,
          nextAttemptAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: DISPATCH_BATCH,
        select: { id: true },
      })

      let delivered = 0
      let attempted = 0
      for (const { id } of due) {
        const claimed = await this.claim(id)
        if (!claimed) continue
        attempted++
        if (await this.attempt(claimed)) delivered++
      }
      return { attempted, delivered }
    } finally {
      this.dispatching = false
    }
  }

  /** Console: send a test event and report the outcome synchronously. */
  async sendTest(partnerId: string): Promise<Record<string, unknown>> {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
      select: {
        id: true,
        webhookUrl: true,
        webhookSecretEnc: true,
        status: true,
      },
    })
    if (!partner) throw new NotFoundException('Partner not found')
    if (!partner.webhookUrl) {
      throw new BadRequestException('Configure a webhook URL first')
    }
    if (!partner.webhookSecretEnc) {
      throw new BadRequestException(
        'Rotate the webhook secret first — deliveries are always signed',
      )
    }

    const dedupeKey = `test:${randomUUID()}`
    await this.enqueue(
      this.prisma,
      partner,
      PARTNER_WEBHOOK_EVENT.TEST,
      { message: 'This is a test delivery from PRAVAAH.' },
      dedupeKey,
    )
    const row = await this.prisma.partnerWebhookDelivery.findUnique({
      where: { dedupeKey },
    })
    const claimed = row ? await this.claim(row.id) : null
    if (!claimed)
      throw new ConflictException('The test delivery is already in flight')

    const ok = await this.attempt(claimed)
    const after = await this.prisma.partnerWebhookDelivery.findUnique({
      where: { id: claimed.id },
      select: {
        id: true,
        eventId: true,
        status: true,
        lastStatusCode: true,
        lastError: true,
      },
    })
    return { delivered: ok, ...after }
  }

  async listDeliveries(
    partnerId: string,
    query: WebhookDeliveryQueryDto,
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    const where: Prisma.PartnerWebhookDeliveryWhereInput = {
      partnerId,
      ...(query.status ? { status: query.status } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.partnerWebhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          eventId: true,
          eventType: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
          lastAttemptAt: true,
          lastStatusCode: true,
          lastError: true,
          deliveredAt: true,
          createdAt: true,
        },
      }),
      this.prisma.partnerWebhookDelivery.count({ where }),
    ])
    return { items, total }
  }

  /** Put a DEAD (or delivered) event back on the queue, with a fresh retry budget. */
  async redeliver(
    partnerId: string,
    deliveryId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.prisma.partnerWebhookDelivery.updateMany({
      where: {
        id: deliveryId,
        partnerId,
        status: {
          in: [WebhookDeliveryStatus.DEAD, WebhookDeliveryStatus.DELIVERED],
        },
      },
      data: {
        status: WebhookDeliveryStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseUntil: null,
      },
    })
    if (result.count === 0) {
      const exists = await this.prisma.partnerWebhookDelivery.findFirst({
        where: { id: deliveryId, partnerId },
        select: { status: true },
      })
      if (!exists) throw new NotFoundException('Delivery not found')
      throw new ConflictException('This delivery is already queued')
    }
    this.kick()
    return { id: deliveryId, status: WebhookDeliveryStatus.PENDING }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /** Compare-and-swap a lease onto a due row. Null when another run got it first. */
  private async claim(id: string): Promise<PartnerWebhookDelivery | null> {
    const now = new Date()
    const leased = await this.prisma.partnerWebhookDelivery.updateMany({
      where: {
        id,
        status: WebhookDeliveryStatus.PENDING,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
    })
    if (leased.count === 0) return null
    return this.prisma.partnerWebhookDelivery.findUnique({ where: { id } })
  }

  /** One delivery attempt. Records the outcome; never throws. */
  private async attempt(delivery: PartnerWebhookDelivery): Promise<boolean> {
    const attempts = delivery.attempts + 1
    try {
      const partner = await this.prisma.verifierPartner.findUnique({
        where: { id: delivery.partnerId },
        select: { webhookUrl: true, webhookSecretEnc: true, status: true },
      })
      if (!partner || partner.status === PartnerStatus.REVOKED) {
        return this.finish(delivery.id, attempts, { dead: 'Partner revoked' })
      }
      if (!partner.webhookUrl || !partner.webhookSecretEnc) {
        return this.finish(delivery.id, attempts, {
          dead: 'No webhook endpoint configured',
        })
      }

      const allowPrivate = this.config.allowPrivateWebhooks()
      const url = assertWebhookUrl(partner.webhookUrl, {
        allowPrivate,
        requireHttps: this.config.isProduction(),
      })

      const body = JSON.stringify(delivery.payload)
      const timestamp = Date.now()
      const signature = signWebhook(
        decryptField(partner.webhookSecretEnc),
        timestamp,
        body,
      )
      const lookup = safeLookupFor(allowPrivate)

      const response = await axios.post(url.toString(), body, {
        timeout: this.config.webhookTimeoutMs(),
        // A redirect is a second, unvalidated destination. Refused outright.
        maxRedirects: 0,
        // Every status is an answer to record, not an exception to catch.
        validateStatus: () => true,
        // Connect-time address validation — the DNS-rebinding defence.
        httpAgent: new http.Agent({ lookup: lookup as never }),
        httpsAgent: new https.Agent({ lookup: lookup as never }),
        maxContentLength: 64 * 1024,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'PRAVAAH-Webhooks/1',
          [PARTNER_WEBHOOK_HEADERS.SIGNATURE]: signature,
          [PARTNER_WEBHOOK_HEADERS.TIMESTAMP]: String(timestamp),
          [PARTNER_WEBHOOK_HEADERS.EVENT_ID]: delivery.eventId,
          [PARTNER_WEBHOOK_HEADERS.EVENT_TYPE]: delivery.eventType,
        },
      })

      if (response.status >= 200 && response.status < 300) {
        return this.finish(delivery.id, attempts, {
          delivered: true,
          statusCode: response.status,
        })
      }
      return this.finish(delivery.id, attempts, {
        statusCode: response.status,
        error: `HTTP ${response.status}: ${truncate(stringify(response.data))}`,
      })
    } catch (error) {
      if (error instanceof WebhookTargetError) {
        // A misconfigured target will not fix itself on retry.
        return this.finish(delivery.id, attempts, { dead: error.message })
      }
      return this.finish(delivery.id, attempts, {
        error: truncate((error as Error).message ?? 'Delivery failed'),
      })
    }
  }

  private async finish(
    id: string,
    attempts: number,
    outcome: {
      delivered?: boolean
      statusCode?: number
      error?: string
      dead?: string
    },
  ): Promise<boolean> {
    const now = new Date()
    const exhausted = attempts >= this.config.webhookMaxAttempts()
    const status = outcome.delivered
      ? WebhookDeliveryStatus.DELIVERED
      : outcome.dead || exhausted
        ? WebhookDeliveryStatus.DEAD
        : WebhookDeliveryStatus.PENDING

    try {
      await this.prisma.partnerWebhookDelivery.update({
        where: { id },
        data: {
          status,
          attempts,
          leaseUntil: null,
          lastAttemptAt: now,
          lastStatusCode: outcome.statusCode ?? null,
          lastError: outcome.delivered
            ? null
            : (outcome.dead ?? outcome.error ?? null),
          deliveredAt: outcome.delivered ? now : null,
          nextAttemptAt:
            status === WebhookDeliveryStatus.PENDING
              ? new Date(
                  now.getTime() + webhookBackoffMs(attempts, Math.random()),
                )
              : now,
        },
      })
    } catch (error) {
      // The lease expires on its own, so an unrecorded outcome means one extra
      // delivery (which the partner dedupes by event id), never a lost one.
      this.logger.error(
        `[${this.finish.name}] Could not record a delivery outcome`,
        {
          deliveryId: id,
          err: error,
        },
      )
    }

    if (status === WebhookDeliveryStatus.DEAD) {
      this.logger.warn(`[${this.finish.name}] Webhook delivery gave up`, {
        deliveryId: id,
        attempts,
        reason: outcome.dead ?? outcome.error,
      })
    }
    return !!outcome.delivered
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_CHARS
    ? `${value.slice(0, MAX_ERROR_CHARS)}…`
    : value
}
