import { randomBytes } from 'node:crypto'

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
  type AdminPartnerListQueryDto,
  type ApplyPartnerDto,
  type ApprovePartnerDto,
  type UpdatePartnerPolicyDto,
  type UpdatePartnerProfileDto,
} from '@pravaah/schema'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { VerifierSessionService } from '@/modules/passport/services/verifier-session.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import {
  ActorType,
  PartnerRole,
  PartnerStatus,
  Prisma,
  WebhookDeliveryStatus,
  type VerifierPartner,
} from 'generated/prisma/client'

import { PartnerConfig } from '@/modules/partner/partner.config'
import { canPartnerTransition } from '@/modules/partner/partner.state'
import {
  WebhookTargetError,
  assertWebhookUrl,
} from '@/modules/partner/partner-webhook.util'
import { PartnerApiKeyService } from '@/modules/partner/services/partner-api-key.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'
import { VerificationAbuseService } from '@/modules/partner/services/verification-abuse.service'

/** The console-facing projection. No secret, no hash, ever. */
const PROFILE_VIEW = {
  id: true,
  name: true,
  type: true,
  status: true,
  trustLevel: true,
  domain: true,
  audience: true,
  country: true,
  contactEmail: true,
  allowedScopes: true,
  requestedScopes: true,
  retentionDays: true,
  webhookUrl: true,
  webhookSecretEnc: true,
  statusReason: true,
  useCase: true,
  appliedAt: true,
  approvedAt: true,
  createdAt: true,
  lastUsedAt: true,
} as const

type ProfileRow = Prisma.VerifierPartnerGetPayload<{
  select: typeof PROFILE_VIEW
}>

/**
 * The partner lifecycle: apply → approve → (suspend ⇄ reinstate) → revoke.
 *
 * Every transition is a compare-and-swap on the CURRENT status (`updateMany` with
 * `status: from` in the WHERE), so two admins acting at once cannot both win — the
 * second sees `count === 0` and a 409. The allowed moves live in
 * `canPartnerTransition`, one table, so the admin API and any future automation
 * cannot disagree about what "suspend" may follow.
 *
 * `isActive` is written alongside `status` on every transition. M3 code that
 * predates the status enum reads the boolean, and the two must never disagree.
 */
@Injectable()
export class PartnerRegistryService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: VerifierSessionService,
    private readonly keys: PartnerApiKeyService,
    private readonly webhooks: PartnerWebhookService,
    private readonly usage: PartnerUsageService,
    private readonly abuse: VerificationAbuseService,
    private readonly config: PartnerConfig,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerRegistryService.name })
  }

  // ── onboarding ────────────────────────────────────────────────────────────
  /**
   * A relying party applies. Creates the partner PENDING_APPROVAL with NO scope,
   * and its first console user as PARTNER_ADMIN — who can sign in to watch the
   * application but can verify nothing until an admin approves.
   *
   * The audience is derived from the domain rather than chosen: it is baked into
   * every key-binding proof made out to this partner, and a self-chosen audience
   * would let an applicant squat on a string that looks like somebody else's.
   */
  async apply(
    dto: ApplyPartnerDto,
    ipAddress?: string | null,
  ): Promise<Record<string, unknown>> {
    if (dto.webhookUrl) this.assertWebhook(dto.webhookUrl)

    try {
      const partner = await this.prisma.$transaction(async (tx) => {
        const created = await tx.verifierPartner.create({
          data: {
            name: dto.name,
            audience: dto.domain,
            type: dto.type,
            domain: dto.domain,
            country: dto.country,
            contactEmail: dto.contactEmail,
            status: PartnerStatus.PENDING_APPROVAL,
            isActive: false,
            allowedScopes: [],
            requestedScopes: [...new Set(dto.requestedScopes)],
            useCase: dto.useCase,
            webhookUrl: dto.webhookUrl ?? null,
            appliedAt: new Date(),
          },
        })
        await tx.partnerUser.create({
          data: {
            partnerId: created.id,
            email: dto.contactEmail,
            phone: dto.contactPhone ?? null,
            name: dto.contactName,
            role: PartnerRole.PARTNER_ADMIN,
          },
        })
        return created
      })

      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'partner.applied',
        entity: 'VerifierPartner',
        entityId: partner.id,
        ipAddress: ipAddress ?? null,
        metadata: {
          name: partner.name,
          domain: partner.domain,
          type: partner.type,
          requestedScopes: partner.requestedScopes,
        },
      })
      this.logger.info(`[${this.apply.name}] Partner application received`, {
        partnerId: partner.id,
        domain: partner.domain,
      })

      return {
        id: partner.id,
        name: partner.name,
        status: partner.status,
        audience: partner.audience,
        message:
          'Application received. Sign in to the partner console with your contact phone or email to follow its status.',
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Deliberately does not say WHICH field collided — that would let anyone
        // probe which lenders and which staff emails are already registered.
        throw new ConflictException(
          'A partner with this domain, or a console user with this email or phone, already exists',
        )
      }
      throw error
    }
  }

  // ── admin transitions ─────────────────────────────────────────────────────
  /**
   * Approve an applicant. The moment its reach is decided: `allowedScopes` is the
   * ceiling on every request it will ever make. May be narrower than — or simply
   * different from — what it asked for.
   */
  async approve(partnerId: string, dto: ApprovePartnerDto, adminId: string) {
    const partner = await this.transition(
      partnerId,
      PartnerStatus.ACTIVE,
      adminId,
      {
        from: [PartnerStatus.PENDING_APPROVAL],
        reason: dto.note ?? null,
        data: {
          allowedScopes: [...new Set(dto.allowedScopes)],
          trustLevel: dto.trustLevel,
          retentionDays: dto.retentionDays,
          approvedAt: new Date(),
          approvedById: adminId,
        },
        action: 'partner.approved',
        metadata: {
          allowedScopes: dto.allowedScopes,
          trustLevel: dto.trustLevel,
          retentionDays: dto.retentionDays,
        },
      },
    )
    return partner
  }

  reject(partnerId: string, reason: string, adminId: string) {
    return this.transition(partnerId, PartnerStatus.REVOKED, adminId, {
      from: [PartnerStatus.PENDING_APPROVAL],
      reason,
      action: 'partner.rejected',
    })
  }

  /**
   * Suspend. Reversible, and instant in effect: keys keep existing (so reinstating
   * is one click) but stop authenticating at once, and every open request is
   * cancelled so no holder is left holding a prompt from a party we stopped vouching
   * for.
   */
  async suspend(partnerId: string, reason: string, adminId: string) {
    const partner = await this.transition(
      partnerId,
      PartnerStatus.SUSPENDED,
      adminId,
      {
        from: [PartnerStatus.ACTIVE],
        reason,
        action: 'partner.suspended',
      },
    )
    const cancelledRequests =
      await this.sessions.cancelPendingForPartner(partnerId)
    return { ...partner, cancelledRequests }
  }

  reinstate(partnerId: string, reason: string, adminId: string) {
    return this.transition(partnerId, PartnerStatus.ACTIVE, adminId, {
      from: [PartnerStatus.SUSPENDED],
      reason,
      action: 'partner.reinstated',
    })
  }

  /**
   * Revoke. Terminal. Burns every key (including the M3 bootstrap hash), cancels
   * every open request. Console users are kept but can no longer sign in — the
   * guard refuses a revoked partner — so the audit trail still names them.
   */
  async revoke(partnerId: string, reason: string, adminId: string) {
    const partner = await this.transition(
      partnerId,
      PartnerStatus.REVOKED,
      adminId,
      {
        from: [
          PartnerStatus.PENDING_APPROVAL,
          PartnerStatus.ACTIVE,
          PartnerStatus.SUSPENDED,
        ],
        reason,
        data: { apiKeyHash: null },
        action: 'partner.revoked',
      },
    )
    const [keys, cancelledRequests] = await Promise.all([
      this.keys.revokeAllForPartner(partnerId, `Partner revoked: ${reason}`),
      this.sessions.cancelPendingForPartner(partnerId),
    ])
    return { ...partner, revokedKeys: keys.count, cancelledRequests }
  }

  /**
   * Adjust an approved partner's policy. A narrowed scope takes effect on the next
   * request of every key — the guard intersects key scopes with the partner's.
   */
  async updatePolicy(
    partnerId: string,
    dto: UpdatePartnerPolicyDto,
    adminId: string,
  ) {
    const existing = await this.requirePartner(partnerId)
    if (
      existing.status !== PartnerStatus.ACTIVE &&
      existing.status !== PartnerStatus.SUSPENDED
    ) {
      throw new ConflictException(
        `Policy can only be changed for an approved partner (this one is ${existing.status})`,
      )
    }
    const updated = await this.prisma.verifierPartner.update({
      where: { id: partnerId },
      data: {
        ...(dto.allowedScopes
          ? { allowedScopes: [...new Set(dto.allowedScopes)] }
          : {}),
        ...(dto.trustLevel ? { trustLevel: dto.trustLevel } : {}),
        ...(dto.retentionDays ? { retentionDays: dto.retentionDays } : {}),
      },
      select: PROFILE_VIEW,
    })
    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: adminId,
      action: 'partner.policy_updated',
      entity: 'VerifierPartner',
      entityId: partnerId,
      metadata: {
        reason: dto.reason,
        before: {
          allowedScopes: existing.allowedScopes,
          trustLevel: existing.trustLevel,
          retentionDays: existing.retentionDays,
        },
        after: {
          allowedScopes: updated.allowedScopes,
          trustLevel: updated.trustLevel,
          retentionDays: updated.retentionDays,
        },
      },
    })
    return this.toProfile(updated)
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  async list(query: AdminPartnerListQueryDto) {
    const where: Prisma.VerifierPartnerWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { domain: { contains: query.q, mode: 'insensitive' } },
              { audience: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.verifierPartner.findMany({
        where,
        // Applicants first — they are the queue an admin works.
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: query.offset,
        take: query.limit,
        select: {
          ...PROFILE_VIEW,
          _count: { select: { apiKeys: true, users: true, requests: true } },
        },
      }),
      this.prisma.verifierPartner.count({ where }),
    ])
    return {
      total,
      items: rows.map(({ _count, ...row }) => ({
        ...this.toProfile(row),
        keyCount: _count.apiKeys,
        userCount: _count.users,
        requestCount: _count.requests,
      })),
    }
  }

  /** Everything an admin needs to decide on, or investigate, one partner. */
  async detail(partnerId: string): Promise<Record<string, unknown>> {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
      select: {
        ...PROFILE_VIEW,
        approvedBy: { select: { id: true, email: true } },
        users: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        apiKeys: {
          select: {
            id: true,
            label: true,
            prefix: true,
            scopes: true,
            status: true,
            expiresAt: true,
            lastUsedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!partner) throw new NotFoundException('Partner not found')

    const [health, usage, deadWebhooks] = await Promise.all([
      this.abuse.partnerHealth(partnerId),
      this.usage.summary(partnerId),
      this.prisma.partnerWebhookDelivery.count({
        where: { partnerId, status: WebhookDeliveryStatus.DEAD },
      }),
    ])

    const { approvedBy, users, apiKeys, ...profile } = partner
    return {
      ...this.toProfile(profile),
      approvedBy,
      users,
      apiKeys,
      health,
      usage,
      webhookHealth: { deadDeliveries: deadWebhooks },
    }
  }

  async profile(partnerId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
      select: PROFILE_VIEW,
    })
    if (!row) throw new NotFoundException('Partner not found')
    return this.toProfile(row)
  }

  // ── partner self-service ──────────────────────────────────────────────────
  async updateProfile(
    partnerId: string,
    dto: UpdatePartnerProfileDto,
    partnerUserId: string,
  ): Promise<Record<string, unknown>> {
    if (dto.webhookUrl) this.assertWebhook(dto.webhookUrl)
    const partner = await this.requirePartner(partnerId)
    if (partner.status === PartnerStatus.REVOKED) {
      throw new ConflictException('A revoked partner cannot be edited')
    }

    const updated = await this.prisma.verifierPartner.update({
      where: { id: partnerId },
      data: {
        ...(dto.webhookUrl !== undefined ? { webhookUrl: dto.webhookUrl } : {}),
        ...(dto.contactEmail !== undefined
          ? { contactEmail: dto.contactEmail }
          : {}),
      },
      select: PROFILE_VIEW,
    })
    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'partner.profile_updated',
      entity: 'VerifierPartner',
      entityId: partnerId,
      metadata: {
        partnerUserId,
        webhookChanged: dto.webhookUrl !== undefined,
        contactChanged: dto.contactEmail !== undefined,
      },
    })
    return this.toProfile(updated)
  }

  /**
   * Mint a new webhook signing secret and return it ONCE. The old secret stops
   * validating immediately, so the partner should deploy the new one first — or
   * accept a short window of signature failures, which retries absorb.
   */
  async rotateWebhookSecret(partnerId: string, partnerUserId: string) {
    const partner = await this.requirePartner(partnerId)
    if (partner.status === PartnerStatus.REVOKED) {
      throw new ConflictException('A revoked partner cannot rotate secrets')
    }
    const secret = `whsec_${randomBytes(32).toString('base64url')}`
    await this.prisma.verifierPartner.update({
      where: { id: partnerId },
      data: { webhookSecretEnc: encryptField(secret) },
    })
    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'partner.webhook_secret_rotated',
      entity: 'VerifierPartner',
      entityId: partnerId,
      metadata: { partnerUserId },
    })
    return {
      webhookSecret: secret,
      warning:
        'This is the only time this secret will be shown. Verify x-pravaah-signature as hex(HMAC-SHA256(secret, `${x-pravaah-timestamp}.${rawBody}`)).',
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async transition(
    partnerId: string,
    to: PartnerStatus,
    adminId: string,
    opts: {
      from: PartnerStatus[]
      reason: string | null
      action: string
      data?: Prisma.VerifierPartnerUncheckedUpdateManyInput
      metadata?: Record<string, unknown>
    },
  ) {
    const existing = await this.requirePartner(partnerId)
    if (
      !opts.from.includes(existing.status) ||
      !canPartnerTransition(existing.status, to)
    ) {
      throw new ConflictException(
        `A partner that is ${existing.status} cannot move to ${to}`,
      )
    }

    const swapped = await this.prisma.verifierPartner.updateMany({
      where: { id: partnerId, status: existing.status },
      data: {
        ...opts.data,
        status: to,
        isActive: to === PartnerStatus.ACTIVE,
        statusReason: opts.reason,
      },
    })
    if (swapped.count === 0) {
      throw new ConflictException(
        'This partner changed state while you were acting — reload and retry',
      )
    }

    const updated = await this.prisma.verifierPartner.findUniqueOrThrow({
      where: { id: partnerId },
      select: PROFILE_VIEW,
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: adminId,
      action: opts.action,
      entity: 'VerifierPartner',
      entityId: partnerId,
      metadata: {
        from: existing.status,
        to,
        reason: opts.reason,
        ...opts.metadata,
      },
    })
    this.logger.warn(`[${this.transition.name}] Partner status changed`, {
      partnerId,
      from: existing.status,
      to,
      adminId,
    })

    // Told to the partner's systems too, so an integration can stop sending traffic
    // on suspension instead of discovering it through 403s.
    const enqueued = await this.webhooks
      .enqueue(
        this.prisma,
        { ...updated, status: to },
        PARTNER_WEBHOOK_EVENT.PARTNER_STATUS_CHANGED,
        { from: existing.status, to, at: new Date().toISOString() },
        `partner-status:${partnerId}:${to}:${Date.now()}`,
      )
      .catch(() => false)
    if (enqueued) this.webhooks.kick()

    return this.toProfile(updated)
  }

  private async requirePartner(partnerId: string): Promise<VerifierPartner> {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
    })
    if (!partner) throw new NotFoundException('Partner not found')
    return partner
  }

  private assertWebhook(url: string): void {
    try {
      assertWebhookUrl(url, {
        allowPrivate: this.config.allowPrivateWebhooks(),
        requireHttps: this.config.isProduction(),
      })
    } catch (error) {
      if (error instanceof WebhookTargetError)
        throw new BadRequestException(error.message)
      throw error
    }
  }

  private toProfile(row: ProfileRow): Record<string, unknown> {
    const { webhookSecretEnc, ...rest } = row
    return {
      ...rest,
      // Whether a secret exists, never the secret.
      webhookSecretConfigured: !!webhookSecretEnc,
      canVerify: row.status === PartnerStatus.ACTIVE,
    }
  }
}
