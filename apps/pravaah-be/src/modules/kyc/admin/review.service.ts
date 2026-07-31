import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { EmailService } from '@/modules/notifications/email.service'
import { PushService } from '@/modules/notifications/push.service'
import { SmsService } from '@/modules/notifications/sms.service'

import {
  AdminRole,
  AdminUser,
  KycStatus,
  Prisma,
  ReviewDecision,
  ReviewStatus,
} from 'generated/prisma/client'

import { ReviewEventsService } from '@/modules/kyc/admin/review-events.service'
import { ScoringService } from '@/modules/scoring/services/scoring.service'
import {
  CASE_DETAIL_INCLUDE,
  CASE_LIST_INCLUDE,
  toCaseDetail,
  toCaseListItem,
  type AdminCaseDetail,
  type AdminCaseListItem,
} from '@/modules/kyc/admin/review.mapper'

/**
 * Admin review workflow: a claim-locked queue where each case is actioned by
 * exactly one reviewer, decisions carry a mandatory reason, and sanctions-
 * related rejections require a SENIOR_REVIEWER. Admins only ever see the
 * masked projection of each check — never the encrypted raw payload.
 */
@Injectable()
export class ReviewService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ReviewEventsService,
    private readonly email: EmailService,
    private readonly push: PushService,
    private readonly sms: SmsService,
    private readonly scoring: ScoringService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ReviewService.name })
  }

  async queue(filter: string = ReviewStatus.OPEN): Promise<AdminCaseListItem[]> {
    const where = ReviewService.filterToWhere(filter)
    const rows = await this.prisma.reviewCase.findMany({
      where,
      // Most-urgent SLA first (unset SLAs last), then newest — a stable order
      // that reads well for both live queues and resolved history.
      orderBy: [
        { slaDueAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      include: CASE_LIST_INCLUDE,
    })
    // Flatten to the admin-safe DTO (country + user come from nested relations;
    // the encrypted blob is never included here at all).
    return rows.map(toCaseListItem)
  }

  /**
   * Maps a UI filter to a Prisma `where`. Crucially, `APPROVED`/`REJECTED` are
   * NOT case statuses — they are decisions on a `RESOLVED` case — so filtering
   * by them must key off `decision`, not `status`. Anything unrecognised is a
   * 400 (never a blind enum cast that Prisma would 500 on).
   */
  static filterToWhere(filter: string): Prisma.ReviewCaseWhereInput {
    switch (filter?.toUpperCase()) {
      case 'ALL':
        return {}
      case ReviewStatus.OPEN:
        return { status: ReviewStatus.OPEN }
      case ReviewStatus.CLAIMED:
        return { status: ReviewStatus.CLAIMED }
      case ReviewStatus.RESOLVED:
        return { status: ReviewStatus.RESOLVED }
      case ReviewDecision.APPROVED:
        return { status: ReviewStatus.RESOLVED, decision: ReviewDecision.APPROVED }
      case ReviewDecision.REJECTED:
        return { status: ReviewStatus.RESOLVED, decision: ReviewDecision.REJECTED }
      case ReviewDecision.INFO_REQUESTED:
        return {
          status: ReviewStatus.RESOLVED,
          decision: ReviewDecision.INFO_REQUESTED,
        }
      default:
        throw new BadRequestException(`Unknown case filter: ${filter}`)
    }
  }

  async detail(id: string): Promise<AdminCaseDetail> {
    const c = await this.prisma.reviewCase.findUnique({
      where: { id },
      include: CASE_DETAIL_INCLUDE,
    })
    if (!c) throw new NotFoundException('Review case not found')
    // The mapper projects only masked fields — the encrypted blob is dropped.
    return toCaseDetail(c)
  }

  /** Claim-lock: only one reviewer can hold an OPEN, unassigned case. */
  async claim(id: string, adminId: string): Promise<AdminCaseDetail> {
    const res = await this.prisma.reviewCase.updateMany({
      where: { id, status: ReviewStatus.OPEN, assignedAdminId: null },
      data: { status: ReviewStatus.CLAIMED, assignedAdminId: adminId },
    })
    if (res.count === 0) {
      throw new ConflictException('Case already claimed')
    }
    // Broadcast so every open console drops this case out of the OPEN queue.
    void this.events.publish({ type: 'CLAIMED', caseId: id, status: 'CLAIMED' })
    // Return the fresh detail so the console re-renders from one canonical shape.
    return this.detail(id)
  }

  async decide(
    id: string,
    admin: AdminUser,
    decision: ReviewDecision,
    notes: string,
  ): Promise<AdminCaseDetail> {
    const c = await this.prisma.reviewCase.findUnique({
      where: { id },
      include: { kycProfile: { include: { user: true } } },
    })
    if (!c) throw new NotFoundException('Review case not found')
    if (c.assignedAdminId !== admin.id) {
      throw new ForbiddenException('Not your case')
    }

    // Sanctions-related rejections require a senior reviewer.
    if (
      c.reason.toLowerCase().includes('sanctions') &&
      admin.role === AdminRole.REVIEWER
    ) {
      throw new ForbiddenException('Senior reviewer required')
    }

    const nextStatus =
      decision === ReviewDecision.APPROVED
        ? KycStatus.VERIFIED
        : decision === ReviewDecision.REJECTED
          ? KycStatus.REJECTED
          : KycStatus.ACTION_REQUIRED

    await this.prisma.$transaction([
      this.prisma.reviewCase.update({
        where: { id },
        data: {
          status: ReviewStatus.RESOLVED,
          decision,
          decisionNotes: notes,
          resolvedAt: new Date(),
        },
      }),
      this.prisma.kycProfile.update({
        where: { id: c.kycProfileId },
        data: {
          overallStatus: nextStatus,
          completedAt:
            nextStatus === KycStatus.VERIFIED ? new Date() : null,
        },
      }),
      this.prisma.user.update({
        where: { id: c.kycProfile.userId },
        data: { kycStatus: nextStatus },
      }),
    ])

    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: `admin.case.${decision}`,
      entity: 'ReviewCase',
      entityId: id,
      metadata: { notes },
    })
    this.logger.info(`[${this.decide.name}] Case resolved`, {
      caseId: id,
      adminId: admin.id,
      decision,
      nextStatus,
    })

    // Broadcast to open consoles + notify the user. All fire-and-forget: a
    // delivery failure must never roll back a recorded decision.
    void this.events.publish({
      type: 'RESOLVED',
      caseId: id,
      status: 'RESOLVED',
    })
    void this.notifyUser(c.kycProfile.user, decision, notes)

    if (decision === ReviewDecision.APPROVED) {
      void this.scoreOnApproval(c.kycProfile.userId)
    }

    return this.detail(id)
  }

  /**
   * Score the holder now that they are verified.
   *
   * The reason this exists at all is an ORDERING gap. `ScoringService.compute`
   * refuses anyone who is not VERIFIED, and M1 computes a score when Account
   * Aggregator data lands — so a user who shared their data while waiting for
   * this decision was refused at fetch time and had nothing to re-trigger it.
   * They sat on a verified passport with no score and no button that would
   * produce one. Approval is the other half of that pair.
   *
   * Fire-and-forget, and deliberately swallowing: `compute` returns a NO_CONSENT
   * state rather than throwing when the user has shared nothing yet (the common
   * case — most people verify first), and no scoring failure may ever undo a
   * decision that is already recorded and already notified.
   */
  private async scoreOnApproval(userId: string): Promise<void> {
    try {
      const result = await this.scoring.compute(userId)
      this.logger.info(`[${this.scoreOnApproval.name}] Post-approval scoring`, {
        userId,
        state: (result as { state?: string }).state ?? 'COMPUTED',
      })
    } catch (e) {
      this.logger.warn(
        `[${this.scoreOnApproval.name}] Post-approval scoring failed`,
        { userId, err: e },
      )
    }
  }

  private async notifyUser(
    user: {
      email: string | null
      phone: string | null
      expoPushToken: string | null
    },
    decision: ReviewDecision,
    notes: string,
  ): Promise<void> {
    const name = null // verified name intentionally omitted from the channel copy
    if (user.email) {
      await this.email.sendKycDecision({
        to: user.email,
        name,
        decision,
        notes,
      })
    }
    if (user.phone) {
      await this.sms.sendKycDecision(user.phone, decision)
    }
    if (user.expoPushToken) {
      const approved = decision === ReviewDecision.APPROVED
      await this.push.send({
        token: user.expoPushToken,
        title: approved
          ? 'You’re verified ✅'
          : 'Update on your verification',
        body: approved
          ? 'Your Pravaah reputation passport is now verified. Tap to view it.'
          : 'Tap to see the status of your verification.',
        data: { kind: 'KYC_DECISION', decision },
      })
    }
  }
}
