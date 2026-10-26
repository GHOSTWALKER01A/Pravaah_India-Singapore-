import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import type { Signal } from '@/modules/fraud/fraud.state'
import type { RiskOutcome } from '@/modules/fraud/risk.types'
import { RiskService } from '@/modules/fraud/services/risk.service'

import {
  ActorType,
  RiskSubjectType,
  VerifierRequestStatus,
} from 'generated/prisma/client'

import { PartnerConfig } from '@/modules/partner/partner.config'

const HOUR_MS = 3_600_000
const FIFTEEN_MIN_MS = 15 * 60_000

/**
 * Signal weights. Calibrated against M6's ladder (STEP_UP 0.55, HOLD 0.85) so that
 * either pattern alone at full strength stops short of a HOLD, and both together
 * cross it: 1 − (1−0.6)(1−0.7) = 0.88. One odd pattern is worth an analyst's look;
 * a holder fanning out to many partners WHILE their presentations keep failing is
 * the shape of a stolen credential being shopped around.
 */
const FANOUT_WEIGHT = 0.6
const REJECT_BURST_WEIGHT = 0.7
/** Distinct partners shared with in an hour before the fan-out signal starts. */
const FANOUT_FLOOR = 3
const FANOUT_SATURATION = 10
/** Failed presentations in fifteen minutes before the burst signal starts. */
const REJECT_FLOOR = 3
const REJECT_SATURATION = 10

/**
 * Abuse controls on the verification surface — M7's half of the M6 hook.
 *
 * Two different threats, caught at two different moments:
 *
 *  - HARVESTING, at request time. A partner (or a stolen partner key) spraying
 *    requests at holders to build a profile, or many partners piling onto one
 *    holder. Hard ceilings, refused with 429 before a prompt ever reaches a wallet —
 *    an unsolicited consent prompt is itself a harm, it trains people to tap "yes".
 *  - CREDENTIAL MISUSE, at approval time. Patterns on the HOLDER side, fed to M6's
 *    engine as domain signals so they are scored, persisted and explained exactly
 *    like every other risk decision in the product.
 */
@Injectable()
export class VerificationAbuseService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    private readonly config: PartnerConfig,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: VerificationAbuseService.name })
  }

  /** Refuse a request that would push a holder past the harvesting ceilings. */
  async assertCanOpen(partnerId: string, targetUserId: string): Promise<void> {
    const since = new Date(Date.now() - HOUR_MS)

    const [fromThisPartner, distinctPartners] = await Promise.all([
      this.prisma.verifierRequest.count({
        where: { partnerId, userId: targetUserId, createdAt: { gte: since } },
      }),
      this.prisma.verifierRequest.findMany({
        where: {
          userId: targetUserId,
          partnerId: { not: null },
          createdAt: { gte: since },
        },
        distinct: ['partnerId'],
        select: { partnerId: true },
      }),
    ])

    if (fromThisPartner >= this.config.perHolderRequestsPerHour()) {
      await this.refuse(
        'partner.verify_holder_spam_blocked',
        partnerId,
        targetUserId,
        {
          requestsThisHour: fromThisPartner,
        },
      )
      throw new HttpException(
        'Too many requests to this holder in the last hour — wait before asking again',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    const alreadyAsking = distinctPartners.some(
      (row) => row.partnerId === partnerId,
    )
    if (
      !alreadyAsking &&
      distinctPartners.length >= this.config.holderFanoutPerHour()
    ) {
      await this.refuse(
        'partner.verify_fanout_blocked',
        partnerId,
        targetUserId,
        {
          distinctPartnersThisHour: distinctPartners.length,
        },
      )
      throw new HttpException(
        'This holder is receiving an unusual number of verification requests — try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  /**
   * Score a holder's approval through M6. Throws only if M6 itself cannot run —
   * the caller treats that as a veto (fail closed), never as an allow.
   */
  async assessApproval(ctx: {
    requestId: string
    partnerId: string
    userId: string
  }): Promise<RiskOutcome> {
    const signals = await this.approvalSignals(ctx.userId)
    return this.risk.scoreVerification({
      userId: ctx.userId,
      subjectType: RiskSubjectType.VERIFICATION,
      subjectId: `verify:${ctx.requestId}`,
      domainSignals: signals,
    })
  }

  /** Holder-side misuse patterns, as M6 signals. */
  async approvalSignals(userId: string): Promise<Signal[]> {
    const now = Date.now()
    const [sharedWith, rejected] = await Promise.all([
      this.prisma.presentation.findMany({
        where: {
          credential: { userId },
          partnerId: { not: null },
          valid: true,
          presentedAt: { gte: new Date(now - HOUR_MS) },
        },
        distinct: ['partnerId'],
        select: { partnerId: true },
      }),
      this.prisma.presentation.count({
        where: {
          credential: { userId },
          valid: false,
          presentedAt: { gte: new Date(now - FIFTEEN_MIN_MS) },
        },
      }),
    ])

    const signals: Signal[] = []
    const fanout = sharedWith.length
    if (fanout > FANOUT_FLOOR) {
      signals.push({
        type: 'VERIFICATION_FANOUT',
        weight: FANOUT_WEIGHT,
        value: degree(fanout, FANOUT_FLOOR, FANOUT_SATURATION),
        reason:
          'Your passport has been shared with many organisations in a short time',
      })
    }
    if (rejected >= REJECT_FLOOR) {
      signals.push({
        type: 'VERIFICATION_REJECT_BURST',
        weight: REJECT_BURST_WEIGHT,
        value: degree(rejected, REJECT_FLOOR - 1, REJECT_SATURATION),
        reason:
          'Several recent attempts to share your passport could not be verified',
      })
    }
    return signals
  }

  /** Operational health of one partner, for the admin detail view. */
  async partnerHealth(partnerId: string): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - 30 * 24 * HOUR_MS)
    const [byStatus, presentations, failedPresentations, holders] =
      await Promise.all([
        this.prisma.verifierRequest.groupBy({
          by: ['status'],
          where: { partnerId, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.prisma.presentation.count({
          where: { partnerId, presentedAt: { gte: since } },
        }),
        this.prisma.presentation.count({
          where: { partnerId, valid: false, presentedAt: { gte: since } },
        }),
        this.prisma.verifierRequest.findMany({
          where: {
            partnerId,
            createdAt: { gte: since },
            userId: { not: null },
          },
          distinct: ['userId'],
          select: { userId: true },
        }),
      ])

    const count = (status: VerifierRequestStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0
    const total = byStatus.reduce((sum, row) => sum + row._count._all, 0)
    const answered = count('APPROVED') + count('CONSUMED')

    return {
      windowDays: 30,
      requests: total,
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all]),
      ),
      approvalRate: total > 0 ? Number((answered / total).toFixed(3)) : 0,
      declineRate:
        total > 0 ? Number((count('DECLINED') / total).toFixed(3)) : 0,
      distinctHolders: holders.length,
      presentations,
      // A high failure rate against one partner is what a replay or a phishing
      // relay looks like from our side.
      presentationFailureRate:
        presentations > 0
          ? Number((failedPresentations / presentations).toFixed(3))
          : 0,
    }
  }

  private async refuse(
    action: string,
    partnerId: string,
    userId: string,
    metadata: Record<string, number>,
  ): Promise<void> {
    this.logger.warn(
      `[${this.assertCanOpen.name}] Verification request refused`,
      {
        action,
        partnerId,
        ...metadata,
      },
    )
    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action,
      entity: 'VerifierPartner',
      entityId: partnerId,
      metadata: { targetUserId: userId, ...metadata },
    })
  }
}

/** Map a count onto 0..1 between a floor and a saturation point. */
function degree(n: number, floor: number, saturation: number): number {
  if (saturation <= floor) return 1
  return Math.min(1, Math.max(0, (n - floor) / (saturation - floor)))
}
