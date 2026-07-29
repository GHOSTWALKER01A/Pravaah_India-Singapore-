import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  AdminDisputeListQueryDto,
  DisputeListQueryDto,
  RaiseDisputeDto,
  ResolveDisputeDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { presentDispute } from '@/modules/payments/admin-projection'
import { toMinor } from '@/modules/payments/money.util'
import {
  DISPUTE_SLA_MS,
  DISPUTE_WINDOW_MS,
} from '@/modules/payments/payments.config'
import { isRefundable, isSettled } from '@/modules/payments/payments.state'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import { ReversalService } from '@/modules/payments/services/reversal.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  DisputeStatus,
  Prisma,
  TxnStatus,
  type PaymentDispute,
} from 'generated/prisma/client'

/**
 * UDIR — the in-app dispute every UPI app is obliged to offer.
 *
 * UDIR exists because the alternative is a customer with a debited account, an uncredited
 * payee, and a branch queue. Three properties make this an actual dispute mechanism rather
 * than a support form:
 *
 *  - **The SLA is set server-side.** `slaDueAt` is stamped on creation, so the obligation is
 *    a queryable deadline rather than a promise in a support script.
 *  - **Raising one is not a refund.** A dispute is a claim; the money moves only when it is
 *    resolved in the customer's favour, through {@link ReversalService} like every other
 *    refund. A dispute flow that credited on submission would be a self-service refund
 *    button.
 *  - **One open dispute per (transaction, kind).** A second is the same complaint retyped,
 *    and two open investigations into one event produce two answers.
 *
 * An `UNAUTHORISED` dispute is treated differently from the others: it is a fraud claim, so
 * it also feeds the risk engine (see `PaymentRiskService`), because a user reporting
 * payments they did not make is a signal about the ACCOUNT and not only about that payment.
 */
@Injectable()
export class DisputeService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly reversals: ReversalService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DisputeService.name })
  }

  async raise(userId: string, dto: RaiseDisputeDto): Promise<PaymentDispute> {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: dto.transactionId, userId },
    })
    if (!transaction) throw new NotFoundException('Payment not found')

    /**
     * A dispute needs something to have actually happened.
     *
     * A payment still in flight is not a grievance yet — it may settle in the next minute,
     * and opening an investigation into it would have a human chasing a rail that is
     * already answering. In-flight rows go to the reconciler, not to UDIR.
     */
    if (
      !isSettled(transaction.status) &&
      transaction.status !== TxnStatus.DEEMED &&
      transaction.status !== TxnStatus.FAILED
    ) {
      throw new BadRequestException(
        'This payment is still being processed. Check back shortly before raising a dispute.',
      )
    }

    const age = Date.now() - transaction.createdAt.getTime()
    if (age > DISPUTE_WINDOW_MS) {
      throw new BadRequestException(
        'This payment is too old to dispute in the app. Please contact support.',
      )
    }

    if (dto.claimedAmountMinor) {
      const claimed = toMinor(dto.claimedAmountMinor)
      if (claimed > transaction.totalDebitMinor) {
        throw new BadRequestException(
          'You cannot dispute more than the amount that was paid',
        )
      }
    }

    try {
      const dispute = await this.prisma.paymentDispute.create({
        data: {
          userId,
          transactionId: transaction.id,
          kind: dto.kind,
          status: DisputeStatus.OPEN,
          description: dto.description,
          claimedAmountMinor: dto.claimedAmountMinor
            ? toMinor(dto.claimedAmountMinor)
            : null,
          evidence: (dto.evidence ?? undefined) as Prisma.InputJsonValue,
          railRef: transaction.railRef,
          // The obligation, as a deadline a query can find.
          slaDueAt: new Date(Date.now() + DISPUTE_SLA_MS),
        },
      })

      await this.audit.log({
        actorType: ActorType.USER,
        actorId: userId,
        action: 'dispute.raised',
        entity: 'PaymentDispute',
        entityId: dispute.id,
        metadata: {
          transactionId: transaction.id,
          kind: dto.kind,
          transactionStatus: transaction.status,
        },
      })

      this.logger.warn(`[${this.raise.name}] Dispute raised`, {
        disputeId: dispute.id,
        transactionId: transaction.id,
        kind: dto.kind,
      })
      return dispute
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'You have already raised this kind of dispute for this payment. We are looking into it.',
        )
      }
      throw error
    }
  }

  async list(
    userId: string,
    query: DisputeListQueryDto,
  ): Promise<{ items: PaymentDispute[]; total: number }> {
    const where = {
      userId,
      ...(query.status ? { status: query.status } : {}),
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentDispute.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.paymentDispute.count({ where }),
    ])
    return { items, total }
  }

  async get(userId: string, disputeId: string) {
    const dispute = await this.prisma.paymentDispute.findFirst({
      where: { id: disputeId, userId },
      include: { transaction: true },
    })
    if (!dispute) throw new NotFoundException('Dispute not found')
    return dispute
  }

  async withdraw(
    userId: string,
    disputeId: string,
    reason?: string,
  ): Promise<PaymentDispute> {
    const dispute = await this.prisma.paymentDispute.findFirst({
      where: { id: disputeId, userId },
    })
    if (!dispute) throw new NotFoundException('Dispute not found')
    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.UNDER_REVIEW
    ) {
      throw new ConflictException('That dispute has already been resolved')
    }

    return this.prisma.paymentDispute.update({
      where: { id: dispute.id },
      data: {
        status: DisputeStatus.WITHDRAWN,
        resolution: reason ?? 'Withdrawn by the customer',
        resolvedAt: new Date(),
      },
    })
  }

  /** Claim a dispute for review, so two reviewers do not both work it. */
  async claim(disputeId: string, adminId: string): Promise<PaymentDispute> {
    const claimed = await this.prisma.paymentDispute.updateMany({
      where: { id: disputeId, status: DisputeStatus.OPEN },
      data: { status: DisputeStatus.UNDER_REVIEW, resolvedByAdminId: adminId },
    })
    if (claimed.count === 0) {
      throw new ConflictException(
        'That dispute is already under review or resolved',
      )
    }
    return this.prisma.paymentDispute.findUniqueOrThrow({
      where: { id: disputeId },
    })
  }

  /**
   * Resolve a dispute.
   *
   * Crediting the customer goes through {@link ReversalService} rather than posting entries
   * here. That is not indirection for its own sake: a refund has to send a rail leg before
   * the ledger may say the money came back, has to respect what remains refundable, and has
   * to be idempotent — three properties a dispute-resolution shortcut would have to
   * reimplement, and would get wrong.
   *
   * The dispute is closed even when the refund fails, with the failure recorded. A dispute
   * stuck open because a rail refused a refund is invisible to the SLA report, which is
   * exactly the case a customer would escalate.
   */
  async resolve(
    disputeId: string,
    dto: ResolveDisputeDto,
    admin: { id: string },
  ): Promise<PaymentDispute> {
    const dispute = await this.prisma.paymentDispute.findUnique({
      where: { id: disputeId },
      include: { transaction: true },
    })
    if (!dispute) throw new NotFoundException('Dispute not found')
    if (
      dispute.status === DisputeStatus.RESOLVED_CREDITED ||
      dispute.status === DisputeStatus.RESOLVED_REJECTED
    ) {
      throw new ConflictException('That dispute has already been resolved')
    }

    let refundNote: string | null = null

    if (dto.status === DisputeStatus.RESOLVED_CREDITED) {
      const transaction = dispute.transaction

      if (isRefundable(transaction.status)) {
        const amountMinor = dto.refundAmountMinor
          ? toMinor(dto.refundAmountMinor)
          : (dispute.claimedAmountMinor ?? undefined)

        try {
          const reversal = await this.reversals.refund({
            transactionId: transaction.id,
            amountMinor,
            reason: `Dispute ${dispute.kind} resolved in the customer's favour`,
            actor: { type: ActorType.ADMIN, id: admin.id },
          })
          refundNote = `Refund ${reversal.id} raised`
        } catch (error) {
          refundNote = `Refund could not be raised automatically: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
          this.logger.error(
            `[${this.resolve.name}] Dispute resolved in favour but the refund failed`,
            { disputeId, err: error },
          )
        }
      } else {
        /**
         * Nothing to refund.
         *
         * A dispute upheld against a FAILED transaction usually means the money never left
         * in the first place — the customer's complaint was that they were debited, and the
         * reserve was already released. Saying so beats attempting a refund that would be
         * rejected.
         */
        refundNote =
          'No refund was needed — the payment had already been reversed'
      }
    }

    const resolved = await this.prisma.paymentDispute.update({
      where: { id: dispute.id },
      data: {
        status: dto.status,
        resolution: refundNote
          ? `${dto.resolution} · ${refundNote}`
          : dto.resolution,
        resolvedByAdminId: admin.id,
        resolvedAt: new Date(),
      },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: `dispute.${dto.status.toLowerCase()}`,
      entity: 'PaymentDispute',
      entityId: dispute.id,
      metadata: {
        transactionId: dispute.transactionId,
        resolution: dto.resolution,
        refundNote,
      },
    })
    return resolved
  }

  /**
   * The admin work queue, across every user.
   *
   * Ordered by `slaDueAt` ascending by default, because a dispute queue exists to be worked and
   * the only sensible priority is "what is closest to breaking a promise we made". Newest-first —
   * the ordering the customer's own list uses — would systematically starve the oldest claims,
   * which are exactly the ones that get escalated.
   *
   * The transaction is included so the reviewer can see the amount and status without opening a
   * second screen; the beneficiary handle is not, because a dispute queue is a shared screen and
   * that handle is a payable address.
   */
  async queue(query: AdminDisputeListQueryDto) {
    const where: Prisma.PaymentDisputeWhereInput = {
      ...(query.status
        ? { status: query.status }
        : query.openOnly
          ? {
              status: {
                in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW],
              },
            }
          : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.transactionId ? { transactionId: query.transactionId } : {}),
      ...(query.breachedOnly ? { slaDueAt: { lt: new Date() } } : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentDispute.findMany({
        where,
        orderBy:
          query.orderBy === 'created'
            ? { createdAt: 'desc' }
            : { slaDueAt: 'asc' },
        include: {
          transaction: {
            select: {
              id: true,
              status: true,
              corridor: true,
              totalDebitMinor: true,
              sourceCurrency: true,
              refundedMinor: true,
            },
          },
        },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.paymentDispute.count({ where }),
    ])
    return { items: items.map((item) => presentDispute(item)), total }
  }

  /** Disputes past their SLA. The queue an operations lead actually watches. */
  async breachingSla(limit = 100) {
    const items = await this.prisma.paymentDispute.findMany({
      where: {
        status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
        slaDueAt: { lt: new Date() },
      },
      orderBy: { slaDueAt: 'asc' },
      include: {
        transaction: {
          select: {
            id: true,
            status: true,
            corridor: true,
            totalDebitMinor: true,
            sourceCurrency: true,
            refundedMinor: true,
          },
        },
      },
      take: limit,
    })
    return items.map((item) => presentDispute(item))
  }
}
