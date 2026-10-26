import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  PARTNER_WEBHOOK_EVENT,
  type PartnerWebhookEventType,
} from '@pravaah/schema'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { PushService } from '@/modules/notifications/push.service'
import { PassportConfig } from '@/modules/passport/passport.config'
import {
  VerifierEventsRegistry,
  type VerifierApprovalContext,
  type VerifierRequestEvent,
  type VerifierRequestEventType,
  type VerifierRequestObserver,
} from '@/modules/passport/services/verifier-events.registry'

import {
  PartnerStatus,
  PartnerUsageKind,
  RiskDecision,
  VerifierRequestStatus,
} from 'generated/prisma/client'

import {
  evaluatePredicates,
  readCompiledPredicates,
} from '@/modules/partner/partner.state'
import { ConsentReceiptService } from '@/modules/partner/services/consent-receipt.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'
import { VerificationAbuseService } from '@/modules/partner/services/verification-abuse.service'

/**
 * How far back the reconciliation sweep looks for facts it never processed. A
 * request is terminal within its TTL (≤ 15 minutes), so two days covers any outage
 * worth recovering from while keeping a 5-minute sweep cheap at ~330ms a query.
 */
const RECONCILE_WINDOW_MS = 2 * 86_400_000
const RECONCILE_BATCH = 200

/** A terminal request status, and what it means for metering and webhooks. */
const TERMINAL: Partial<
  Record<
    VerifierRequestStatus,
    { kind: PartnerUsageKind; event: PartnerWebhookEventType }
  >
> = {
  APPROVED: {
    kind: PartnerUsageKind.VERIFIED,
    event: PARTNER_WEBHOOK_EVENT.VERIFICATION_APPROVED,
  },
  CONSUMED: {
    kind: PartnerUsageKind.VERIFIED,
    event: PARTNER_WEBHOOK_EVENT.VERIFICATION_APPROVED,
  },
  DECLINED: {
    kind: PartnerUsageKind.DECLINED,
    event: PARTNER_WEBHOOK_EVENT.VERIFICATION_DECLINED,
  },
  EXPIRED: {
    kind: PartnerUsageKind.EXPIRED,
    event: PARTNER_WEBHOOK_EVENT.VERIFICATION_EXPIRED,
  },
  CANCELLED: {
    kind: PartnerUsageKind.CANCELLED,
    event: PARTNER_WEBHOOK_EVENT.VERIFICATION_CANCELLED,
  },
}

/** Which statuses a reported event type may legitimately find the request in. */
const EXPECTED_STATUS: Partial<
  Record<VerifierRequestEventType, VerifierRequestStatus[]>
> = {
  APPROVED: [VerifierRequestStatus.APPROVED, VerifierRequestStatus.CONSUMED],
  DECLINED: [VerifierRequestStatus.DECLINED],
  EXPIRED: [VerifierRequestStatus.EXPIRED],
  CANCELLED: [VerifierRequestStatus.CANCELLED],
}

/**
 * M7's observer on M3's handshake — where a verification becomes a product.
 *
 * `beforeApprove` is the consent gate M7 adds: a suspended partner cannot receive a
 * share, and M6 gets a say on the holder side. It fails CLOSED.
 *
 * `onEvent` turns each handshake fact into its commercial side effects — a usage
 * event, a consent receipt, a partner webhook — written in ONE transaction so they
 * cannot disagree with each other. Every write is keyed by the fact
 * (`<requestId>:VERIFIED`), so the same event processed twice changes nothing.
 *
 * Events are best-effort by design (see `VerifierEventsRegistry.emit`), so the
 * guarantee lives in {@link reconcile}: a periodic sweep that finds terminal
 * requests whose facts were never processed — a crash between M3's write and the
 * emit, a database blip inside the handler — and processes them. The event is the
 * fast path; the sweep is the promise.
 *
 * Every handler RE-READS the request and checks its status before acting, because
 * an event is a claim about the past: `expireStale` can report an expiry for a
 * request that a holder approved in the same instant.
 */
@Injectable()
export class VerificationEventsService
  implements VerifierRequestObserver, OnModuleInit
{
  readonly name = 'm7-partner-console'
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: VerifierEventsRegistry,
    private readonly usage: PartnerUsageService,
    private readonly receipts: ConsentReceiptService,
    private readonly webhooks: PartnerWebhookService,
    private readonly abuse: VerificationAbuseService,
    private readonly push: PushService,
    private readonly passport: PassportConfig,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: VerificationEventsService.name })
  }

  onModuleInit(): void {
    this.registry.register(this)
  }

  // ── the consent gate ──────────────────────────────────────────────────────
  async beforeApprove(ctx: VerifierApprovalContext): Promise<void> {
    // Peer checks have no partner; M3's own rules govern them.
    if (!ctx.partnerId) return

    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: ctx.partnerId },
      select: { status: true, isActive: true },
    })
    if (
      !partner ||
      partner.status !== PartnerStatus.ACTIVE ||
      !partner.isActive
    ) {
      throw new ForbiddenException(
        'This organisation is no longer approved to receive passport shares. Nothing was shared.',
      )
    }

    let decision: RiskDecision
    let reasons: string[]
    try {
      const outcome = await this.abuse.assessApproval({
        requestId: ctx.requestId,
        partnerId: ctx.partnerId,
        userId: ctx.userId,
      })
      decision = outcome.decision
      reasons = outcome.reasons
    } catch (error) {
      // Fail CLOSED. A consent gate that lets data through when it cannot decide is
      // not a gate — the same rule M6 applies when it cannot read PIN state.
      this.logger.error(
        `[${this.beforeApprove.name}] Risk assessment failed — refusing the share`,
        {
          requestId: ctx.requestId,
          err: error,
        },
      )
      throw new ServiceUnavailableException(
        'A security check could not be completed. Nothing was shared — please try again.',
      )
    }

    // STEP_UP and REVIEW are recorded for analysts but do not stop the share: the
    // holder has just proven possession of the credential's device key, and the
    // wallet's approval flow has no step-up leg. See RiskService.scoreVerification.
    if (decision === RiskDecision.HOLD || decision === RiskDecision.BLOCK) {
      throw new ForbiddenException({
        message:
          'This share was stopped by a security check. Nothing was shared.',
        reasons,
      })
    }
  }

  // ── facts → side effects ──────────────────────────────────────────────────
  async onEvent(event: VerifierRequestEvent): Promise<void> {
    if (!event.partnerId) return
    await this.process(
      event.type,
      event.requestId,
      event.presentationId ?? null,
    )
  }

  /** Process one fact. Idempotent; safe to call from the event path and the sweep. */
  async process(
    type: VerifierRequestEventType,
    requestId: string,
    presentationId: string | null = null,
  ): Promise<void> {
    switch (type) {
      case 'REQUEST_CREATED':
        return this.handleCreated(requestId)
      case 'PRESENTATION_REJECTED':
        return presentationId
          ? this.handleRejected(requestId, presentationId)
          : undefined
      case 'APPROVED':
      case 'DECLINED':
      case 'EXPIRED':
      case 'CANCELLED':
        return this.handleTerminal(type, requestId)
      case 'COLLECTED':
        // Collection is M3's nonce-burning step; nothing commercial happens on it.
        return
    }
  }

  private async handleCreated(requestId: string): Promise<void> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        partnerId: true,
        apiKeyId: true,
        createdAt: true,
        status: true,
        expiresAt: true,
        user: { select: { expoPushToken: true } },
        partner: { select: { name: true } },
      },
    })
    if (!request?.partnerId) return
    const fresh = await this.usage.record(this.prisma, [
      {
        partnerId: request.partnerId,
        kind: PartnerUsageKind.REQUEST_CREATED,
        dedupeKey: `${request.id}:${PartnerUsageKind.REQUEST_CREATED}`,
        verifierRequestId: request.id,
        apiKeyId: request.apiKeyId,
        occurredAt: request.createdAt,
      },
    ])

    // Only on FIRST processing: the usage row doubles as the "already handled" marker,
    // so the reconciliation sweep can never re-notify the holder about the same request.
    if (
      fresh > 0 &&
      request.status === VerifierRequestStatus.PENDING &&
      request.expiresAt > new Date()
    ) {
      this.notifyHolder(
        request.id,
        request.user?.expoPushToken ?? null,
        request.partner?.name,
      )
    }
  }

  /**
   * Tell a named holder an organisation is waiting.
   *
   * Only for requests aimed at a known holder (a Pravaah ID or a card) — an open QR request
   * has nobody to notify until someone scans it. Fire-and-forget: the wallet polls its
   * inbox anyway, so a failed push costs latency, never the request.
   *
   * Unlike a peer scan, the organisation IS named on the lock screen. It is a registered,
   * accountable business rather than the stranger at the counter, and "Acme Bank is asking"
   * is what lets a holder tell a request they expected from one they did not.
   */
  private notifyHolder(
    requestId: string,
    token: string | null,
    partnerName: string | undefined,
  ): void {
    if (!token) return
    void this.push
      .send({
        token,
        title: `${partnerName ?? 'An organisation'} is asking to verify you`,
        body: 'Open Pravaah to see exactly what they are asking for. Nothing is shared until you approve.',
        data: {
          kind: 'passport.partner_request',
          requestId,
          url: this.passport.walletRequestLink(requestId),
        },
      })
      .catch(() => undefined)
  }

  private async handleRejected(
    requestId: string,
    presentationId: string,
  ): Promise<void> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        externalRef: true,
        apiKeyId: true,
        partner: {
          select: {
            id: true,
            webhookUrl: true,
            webhookSecretEnc: true,
            status: true,
          },
        },
      },
    })
    if (!request?.partner) return
    const presentation = await this.prisma.presentation.findUnique({
      where: { id: presentationId },
      select: { failureReason: true, presentedAt: true },
    })
    // The machine code only (`KEY_BINDING_FAILED`), never the free-text reason,
    // which can quote details of the holder's device proof.
    const code = presentation?.failureReason?.split(':')[0] ?? 'UNKNOWN'

    const enqueued = await this.prisma.$transaction(async (tx) => {
      await this.usage.record(tx, [
        {
          partnerId: request.partner!.id,
          kind: PartnerUsageKind.PRESENTATION_REJECTED,
          dedupeKey: `${presentationId}:${PartnerUsageKind.PRESENTATION_REJECTED}`,
          verifierRequestId: request.id,
          apiKeyId: request.apiKeyId,
          occurredAt: presentation?.presentedAt,
        },
      ])
      return this.webhooks.enqueue(
        tx,
        request.partner!,
        PARTNER_WEBHOOK_EVENT.VERIFICATION_PRESENTATION_REJECTED,
        {
          requestId: request.id,
          externalRef: request.externalRef,
          code,
          // Not terminal: the holder may retry inside the same request.
          retryable: true,
        },
        `${presentationId}:REJECTED`,
      )
    })
    if (enqueued) this.webhooks.kick()
  }

  private async handleTerminal(
    type: VerifierRequestEventType,
    requestId: string,
  ): Promise<void> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
      include: {
        partner: {
          select: {
            id: true,
            name: true,
            domain: true,
            retentionDays: true,
            webhookUrl: true,
            webhookSecretEnc: true,
            status: true,
          },
        },
        presentation: {
          select: { id: true, disclosedClaims: true, presentedAt: true },
        },
      },
    })
    if (!request?.partner) return

    // The event is a claim about the past; the row is the truth.
    const expected = EXPECTED_STATUS[type]
    if (expected && !expected.includes(request.status)) {
      this.logger.info(
        `[${this.handleTerminal.name}] Stale ${type} event ignored`,
        {
          requestId,
          status: request.status,
        },
      )
      return
    }
    const terminal = TERMINAL[request.status]
    if (!terminal) return

    const partner = request.partner
    const occurredAt =
      request.respondedAt ??
      request.cancelledAt ??
      request.consumedAt ??
      request.expiresAt
    const approved = terminal.kind === PartnerUsageKind.VERIFIED

    // For an approval, the webhook carries predicate ANSWERS and claim NAMES — the
    // values are fetched over the authenticated API.
    const result = (request.resultJson ?? {}) as {
      claims?: Record<string, unknown>
      withheldClaims?: string[]
      holderVerified?: boolean
      replayProtected?: boolean
    }
    const compiled = readCompiledPredicates(request.predicates)

    const enqueued = await this.prisma.$transaction(async (tx) => {
      await this.usage.record(tx, [
        {
          partnerId: partner.id,
          kind: terminal.kind,
          dedupeKey: `${request.id}:${terminal.kind}`,
          verifierRequestId: request.id,
          apiKeyId: request.apiKeyId,
          occurredAt,
        },
      ])

      if (approved && request.userId) {
        await this.receipts.issue(
          tx,
          {
            requestId: request.id,
            userId: request.userId,
            purpose: request.purpose,
            requestedClaims: request.requestedClaims,
            predicates: request.predicates,
            presentationId: request.presentation?.id ?? null,
            disclosedClaims: request.presentation?.disclosedClaims ?? [],
            partner,
          },
          request.respondedAt ?? new Date(),
        )
      }

      return this.webhooks.enqueue(
        tx,
        partner,
        terminal.event,
        {
          requestId: request.id,
          externalRef: request.externalRef,
          status: request.status,
          ...(approved
            ? {
                disclosedClaims: request.presentation?.disclosedClaims ?? [],
                withheldClaims: result.withheldClaims ?? [],
                predicates: evaluatePredicates(compiled, result.claims ?? {}),
                holderVerified: result.holderVerified ?? false,
                replayProtected: result.replayProtected ?? false,
                verifiedAt: request.respondedAt?.toISOString() ?? null,
              }
            : {}),
        },
        `${request.id}:${terminal.kind}`,
      )
    })
    if (enqueued) this.webhooks.kick()
  }

  // ── the guarantee ─────────────────────────────────────────────────────────
  /**
   * Process every recent partner request whose facts were never recorded.
   *
   * Keyset-paginated on (createdAt, id) so a request that keeps failing cannot pin
   * the sweep to page one. Returns how many facts were (re)processed.
   */
  async reconcile(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - RECONCILE_WINDOW_MS)
    let processed = 0
    let cursor: { id: string } | undefined

    for (;;) {
      const batch = await this.prisma.verifierRequest.findMany({
        where: { partnerId: { not: null }, createdAt: { gte: since } },
        orderBy: { id: 'asc' },
        take: RECONCILE_BATCH,
        ...(cursor ? { cursor, skip: 1 } : {}),
        select: { id: true, status: true },
      })
      if (!batch.length) return processed
      cursor = { id: batch[batch.length - 1].id }

      const seen = await this.prisma.partnerUsageEvent.findMany({
        where: { verifierRequestId: { in: batch.map((row) => row.id) } },
        select: { verifierRequestId: true, kind: true },
      })
      const have = new Set(
        seen.map((row) => `${row.verifierRequestId}:${row.kind}`),
      )

      for (const row of batch) {
        try {
          if (!have.has(`${row.id}:${PartnerUsageKind.REQUEST_CREATED}`)) {
            await this.handleCreated(row.id)
            processed++
          }
          const terminal = TERMINAL[row.status]
          if (terminal && !have.has(`${row.id}:${terminal.kind}`)) {
            await this.handleTerminal(eventTypeFor(row.status), row.id)
            processed++
          }
        } catch (error) {
          this.logger.error(
            `[${this.reconcile.name}] Could not reconcile a request`,
            {
              requestId: row.id,
              err: error,
            },
          )
        }
      }
    }
  }
}

function eventTypeFor(status: VerifierRequestStatus): VerifierRequestEventType {
  switch (status) {
    case VerifierRequestStatus.APPROVED:
    case VerifierRequestStatus.CONSUMED:
      return 'APPROVED'
    case VerifierRequestStatus.DECLINED:
      return 'DECLINED'
    case VerifierRequestStatus.EXPIRED:
      return 'EXPIRED'
    default:
      return 'CANCELLED'
  }
}
