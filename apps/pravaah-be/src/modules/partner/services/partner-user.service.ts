import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  InvitePartnerUserDto,
  UpdatePartnerUserDto,
} from '@pravaah/schema'

import { phoneDigits } from '@/common/utils/admin-identity.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import {
  ActorType,
  PartnerRole,
  PartnerStatus,
  type PartnerUser,
  type Prisma,
  type VerifierPartner,
} from 'generated/prisma/client'

const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000'
/** `lastLoginAt` is observability; one write an hour per user is plenty. */
const LOGIN_TOUCH_INTERVAL_MS = 3_600_000

const USER_VIEW = {
  id: true,
  email: true,
  phone: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const

/**
 * A partner's console team.
 *
 * Console users are PRE-PROVISIONED and never auto-created from a login — the
 * same rule as `AdminUser`. They sign in with the product's ordinary OTP flow and
 * `PartnerConsoleGuard` authorises that session against this table by its verified
 * phone (or email). A self-service signup path here would let anyone who can
 * receive an OTP attach themselves to a lender's console.
 */
@Injectable()
export class PartnerUserService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerUserService.name })
  }

  /**
   * Resolve an authenticated session to an ACTIVE console user of a non-revoked
   * partner. Phone matching tolerates `+E164` vs bare digits exactly as the admin
   * lookup does. With no identifier it matches nothing — never everyone.
   */
  async resolveForSession(identity: {
    phone?: string
    email?: string
  }): Promise<(PartnerUser & { partner: VerifierPartner }) | null> {
    const digits = phoneDigits(identity.phone)
    const or: Prisma.PartnerUserWhereInput[] = []
    if (identity.email) or.push({ email: identity.email.toLowerCase() })
    if (digits) or.push({ phone: { in: [digits, `+${digits}`] } })

    const user = await this.prisma.partnerUser.findFirst({
      where: {
        isActive: true,
        partner: { status: { not: PartnerStatus.REVOKED } },
        OR: or.length ? or : [{ id: NO_MATCH_UUID }],
      },
      include: { partner: true },
    })
    if (user) this.touchLogin(user)
    return user
  }

  list(partnerId: string) {
    return this.prisma.partnerUser.findMany({
      where: { partnerId },
      orderBy: [{ isActive: 'desc' }, { role: 'desc' }, { createdAt: 'asc' }],
      select: USER_VIEW,
    })
  }

  /**
   * Add a colleague. An email or phone already on ANY partner's team is refused:
   * one login resolving to two partners would make "which lender am I acting for"
   * a guess, and the guard must never guess.
   */
  async invite(
    partnerId: string,
    dto: InvitePartnerUserDto,
    actor: { kind: 'PARTNER_USER' | 'ADMIN'; id: string },
  ) {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
      select: { status: true },
    })
    if (!partner) throw new NotFoundException('Partner not found')
    if (partner.status === PartnerStatus.REVOKED) {
      throw new BadRequestException('A revoked partner cannot add team members')
    }

    try {
      const user = await this.prisma.partnerUser.create({
        data: {
          partnerId,
          email: dto.email,
          phone: dto.phone ?? null,
          name: dto.name ?? null,
          role: dto.role,
        },
        select: USER_VIEW,
      })
      await this.auditUser('partner.user_invited', user.id, partnerId, actor, {
        role: user.role,
      })
      return user
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'That email or phone number already belongs to a partner console account',
        )
      }
      throw error
    }
  }

  /**
   * Change a member's role or deactivate them.
   *
   * Refuses to leave a partner with no active PARTNER_ADMIN — including by an admin
   * demoting themselves. A console with no admin cannot rotate a leaked key, and the
   * only recovery would be a PRAVAAH support ticket in the middle of an incident.
   */
  async update(
    partnerId: string,
    targetId: string,
    dto: UpdatePartnerUserDto,
    actor: { kind: 'PARTNER_USER' | 'ADMIN'; id: string },
  ) {
    const target = await this.prisma.partnerUser.findFirst({
      where: { id: targetId, partnerId },
    })
    if (!target) throw new NotFoundException('Team member not found')

    const losesAdmin =
      target.isActive &&
      target.role === PartnerRole.PARTNER_ADMIN &&
      (dto.isActive === false ||
        (dto.role !== undefined && dto.role !== PartnerRole.PARTNER_ADMIN))

    const updated = await this.prisma.$transaction(async (tx) => {
      if (losesAdmin) {
        const admins = await tx.partnerUser.count({
          where: { partnerId, isActive: true, role: PartnerRole.PARTNER_ADMIN },
        })
        if (admins <= 1) {
          throw new ConflictException(
            'A partner must keep at least one active admin — promote someone else first',
          )
        }
      }
      return tx.partnerUser.update({
        where: { id: target.id },
        data: {
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        select: USER_VIEW,
      })
    })

    await this.auditUser('partner.user_updated', target.id, partnerId, actor, {
      before: { role: target.role, isActive: target.isActive },
      after: { role: updated.role, isActive: updated.isActive },
    })
    return updated
  }

  private touchLogin(user: PartnerUser): void {
    if (
      user.lastLoginAt &&
      Date.now() - user.lastLoginAt.getTime() < LOGIN_TOUCH_INTERVAL_MS
    ) {
      return
    }
    void this.prisma.partnerUser
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined)
  }

  private auditUser(
    action: string,
    targetId: string,
    partnerId: string,
    actor: { kind: 'PARTNER_USER' | 'ADMIN'; id: string },
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.log({
      actorType: actor.kind === 'ADMIN' ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: actor.kind === 'ADMIN' ? actor.id : null,
      action,
      entity: 'PartnerUser',
      entityId: targetId,
      metadata: {
        partnerId,
        ...(actor.kind === 'PARTNER_USER' ? { partnerUserId: actor.id } : {}),
        ...metadata,
      },
    })
  }
}
