import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { CollectListQueryDto, CreateCollectDto } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { toMinor } from '@/modules/payments/money.util'
import {
  canCollectTransition,
  isCollectOpen,
} from '@/modules/payments/payments.state'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { LimitService } from '@/modules/payments/services/limit.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { maskVpa, normaliseVpa } from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CollectStatus,
  Corridor,
  KycStatus,
  TxnStatus,
  TxnType,
  UpiHandleStatus,
  type CollectRequest,
} from 'generated/prisma/client'

/**
 * UPI collect — requesting money.
 *
 * The mirror image of a transfer, and the asymmetries matter more than the symmetry:
 *
 *  - **There is no reserve.** The funds are the PAYER's, not ours, so there is nothing to
 *    lock. The transaction sits in AWAITING_APPROVAL until the rail reports what the payer
 *    decided, and the money is credited on settlement.
 *  - **We never touch a UPI PIN.** Authorisation happens inside the payer's own PSP app,
 *    in the bank/NPCI secure component. This service records a request and reads back an
 *    answer; the credential never enters our process.
 *  - **It must expire.** A live collect is an open authorisation sitting in a stranger's
 *    app — approvable days later, against a balance and an intent that have both moved on.
 *  - **Approval is not settlement.** The payer's bank can still decline for insufficient
 *    funds after they have said yes, which is why `APPROVED → FAILED` is a legal
 *    transition and why the payee is not shown the money until it settles.
 *
 * Cross-border collect does not exist. The UPI↔PayNow linkage is payer-initiated only, so
 * a "request money from abroad" feature would be a screen that can never succeed —
 * refused here with that reason rather than accepted and silently stuck.
 */
@Injectable()
export class CollectService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly providers: PaymentProviderFactory,
    private readonly handles: UpiHandleService,
    private readonly limits: LimitService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: CollectService.name })
  }

  /** Raise a collect against a payer. Our user is the payee. */
  async create(
    userId: string,
    dto: CreateCollectDto,
    idempotencyKey: string,
  ): Promise<CollectRequest> {
    const payee = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        isSuspended: true,
        kycProfile: { select: { verifiedName: true } },
      },
    })
    if (!payee) throw new NotFoundException('User not found')
    if (payee.isSuspended) {
      throw new ForbiddenException('Your account is on hold')
    }
    /**
     * KYC gate on the PAYEE.
     *
     * Requesting money is how a mule account operates: an unverified identity that can
     * pull funds from strangers is the whole business model of a payment scam, and the
     * transfers are irreversible by the time anyone reports it.
     */
    if (payee.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException(
        'Complete your identity verification before requesting money',
      )
    }

    const handle = await this.handles.primary(userId)
    if (!handle || handle.status !== UpiHandleStatus.ACTIVE) {
      throw new BadRequestException(
        'Create and verify a UPI ID before requesting money',
      )
    }

    const payerHandle = normaliseVpa(dto.payerHandle)
    if (payerHandle === handle.vpa) {
      throw new BadRequestException('You cannot request money from yourself')
    }

    const amountMinor = toMinor(dto.amountMinor)

    /**
     * The collect is bounded by the PAYER's per-transaction cap, checked against the
     * corridor policy.
     *
     * A request the payer's own limits cannot satisfy would be approved and then declined
     * by their bank, which reads to both parties as a broken product rather than a limit.
     */
    const policy = this.limits.policy(Corridor.DOMESTIC)
    if (amountMinor > policy.perTxnValueMinor) {
      throw new BadRequestException(
        'That is more than a single UPI payment can carry',
      )
    }

    const existing = await this.prisma.collectRequest.findFirst({
      where: {
        userId,
        payerHandle,
        amountMinor,
        status: { in: [CollectStatus.CREATED, CollectStatus.PENDING] },
        expiresAt: { gt: new Date() },
      },
    })
    if (existing) {
      /**
       * An identical open request already exists.
       *
       * Returned rather than duplicated. Two live requests for the same amount to the
       * same payer is how somebody gets debited twice for one debt — the payer sees two
       * notifications and has no way to tell they are the same ask.
       */
      return existing
    }

    const expiresAt = new Date(Date.now() + dto.expiresInSeconds * 1_000)

    const collect = await this.prisma.collectRequest.create({
      data: {
        userId,
        payerHandle,
        amountMinor,
        currency: dto.currency,
        purposeCode: dto.purposeCode,
        narration: dto.narration ?? null,
        status: CollectStatus.CREATED,
        expiresAt,
      },
    })

    const provider = this.providers.forCorridor(Corridor.DOMESTIC)
    if (!provider.createCollect) {
      await this.fail(collect.id, 'This rail does not support collect requests')
      throw new BadRequestException(
        'Requesting money is not available on this rail',
      )
    }

    const result = await provider.createCollect({
      idempotencyKey,
      collectRequestId: collect.id,
      payerHandle,
      payeeVpa: handle.vpa,
      payeeName: payee.kycProfile?.verifiedName ?? 'Pravaah user',
      amountMinor,
      currency: dto.currency,
      purposeCode: dto.purposeCode,
      narration: dto.narration ?? null,
      expiresAt,
      traceId: collect.id,
    })

    if (!result.ok) {
      await this.fail(collect.id, result.error.message)
      throw new BadRequestException(
        `The request could not be sent: ${result.error.message}`,
      )
    }

    const updated = await this.prisma.collectRequest.update({
      where: { id: collect.id },
      data: { status: CollectStatus.PENDING, railRef: result.value.railRef },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'collect.created',
      entity: 'CollectRequest',
      entityId: collect.id,
      metadata: {
        payer: maskVpa(payerHandle),
        amountMinor: amountMinor.toString(),
      },
    })

    this.logger.info(`[${this.create.name}] Collect request raised`, {
      collectId: collect.id,
      payer: maskVpa(payerHandle),
    })
    return updated
  }

  /**
   * The rail tells us what the payer decided.
   *
   * The only path by which a collect is approved. There is deliberately no endpoint that
   * lets a payer approve one through us: authorisation belongs in their PSP app, with
   * their bank's own second factor, and any approval we accepted directly would be an
   * approval without a UPI PIN behind it.
   */
  async applyRailDecision(params: {
    collectId?: string
    railRef?: string
    decision: 'APPROVED' | 'DECLINED' | 'FAILED' | 'EXPIRED'
    railCode?: string | null
    reason?: string | null
    utr?: string | null
  }): Promise<CollectRequest | null> {
    const collect = params.collectId
      ? await this.prisma.collectRequest.findUnique({
          where: { id: params.collectId },
        })
      : params.railRef
        ? await this.prisma.collectRequest.findUnique({
            where: { railRef: params.railRef },
          })
        : null

    if (!collect) return null

    const target =
      params.decision === 'APPROVED'
        ? CollectStatus.APPROVED
        : params.decision === 'DECLINED'
          ? CollectStatus.DECLINED
          : params.decision === 'EXPIRED'
            ? CollectStatus.EXPIRED
            : CollectStatus.FAILED

    if (!canCollectTransition(collect.status, target)) {
      this.logger.warn(
        `[${this.applyRailDecision.name}] Ignoring an illegal collect transition`,
        { collectId: collect.id, from: collect.status, to: target },
      )
      return collect
    }

    if (target !== CollectStatus.APPROVED) {
      return this.prisma.collectRequest.update({
        where: { id: collect.id },
        data: {
          status: target,
          railCode: params.railCode ?? collect.railCode,
          declineReason: params.reason ?? null,
          respondedAt: new Date(),
        },
      })
    }

    // Approved: the money is coming in. Create the transaction that records it and credit
    // the wallet.
    const transaction = await this.orchestrator.createRaw({
      userId: collect.userId,
      type: collect.qrId ? TxnType.P2M : TxnType.P2P,
      direction: 'INBOUND',
      currency: collect.currency,
      amountMinor: collect.amountMinor,
      counterpartyHandle: collect.payerHandle,
      counterpartyName: collect.payerName,
      purposeCode: collect.purposeCode,
      narration: collect.narration,
      // Derived from the collect, so a duplicated rail notification cannot mint a second
      // inbound transaction for one approval.
      idempotencyKey: `collect_${collect.id}`,
      status: TxnStatus.AWAITING_APPROVAL,
    })

    const updated = await this.prisma.collectRequest.update({
      where: { id: collect.id },
      data: {
        status: CollectStatus.APPROVED,
        railCode: params.railCode ?? collect.railCode,
        transactionId: transaction.id,
        respondedAt: new Date(),
      },
    })

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { railRef: collect.railRef, utr: params.utr ?? null },
    })

    await this.orchestrator.settleInbound(transaction.id, {
      status: 'SUCCESS',
      railCode: params.railCode,
      utr: params.utr,
    })

    this.logger.info(
      `[${this.applyRailDecision.name}] Collect approved and credited`,
      {
        collectId: collect.id,
        transactionId: transaction.id,
      },
    )
    return updated
  }

  /** Cancel a request the user no longer wants answered. */
  async revoke(userId: string, collectId: string): Promise<CollectRequest> {
    const collect = await this.owned(userId, collectId)
    if (!canCollectTransition(collect.status, CollectStatus.REVOKED)) {
      throw new ConflictException(
        'That request has already been answered and cannot be cancelled',
      )
    }
    return this.prisma.collectRequest.update({
      where: { id: collect.id },
      data: { status: CollectStatus.REVOKED, respondedAt: new Date() },
    })
  }

  async list(
    userId: string,
    query: CollectListQueryDto,
  ): Promise<{ items: CollectRequest[]; total: number }> {
    /**
     * The two sides are separate queries, never one merged list.
     *
     * "You owe ₹500" and "you are owed ₹500" are opposite facts, and a UI that mixed them
     * would have people paying money they were expecting to receive.
     */
    const where =
      query.side === 'RECEIVED'
        ? await this.receivedWhere(userId, query.status)
        : { userId, ...(query.status ? { status: query.status } : {}) }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.collectRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.collectRequest.count({ where }),
    ])
    return { items, total }
  }

  async get(userId: string, collectId: string): Promise<CollectRequest> {
    const collect = await this.prisma.collectRequest.findFirst({
      where: { id: collectId, userId },
    })
    if (collect) return collect

    // Might be one raised AGAINST this user. Same 404 if it is neither.
    const handles = await this.handles.list(userId)
    const asPayer = await this.prisma.collectRequest.findFirst({
      where: {
        id: collectId,
        payerHandle: { in: handles.map((handle) => handle.vpa) },
      },
    })
    if (!asPayer) throw new NotFoundException('Payment request not found')
    return asPayer
  }

  /**
   * Expire collects nobody answered.
   *
   * Run as a scheduled sweep rather than checked lazily on read, because an unexpired row
   * is still APPROVABLE by the rail: the state has to actually change, not merely look
   * expired to whoever happens to load it.
   */
  async expireStale(limit = 200): Promise<number> {
    const stale = await this.prisma.collectRequest.findMany({
      where: {
        status: { in: [CollectStatus.CREATED, CollectStatus.PENDING] },
        expiresAt: { lt: new Date() },
      },
      take: limit,
      select: { id: true },
    })

    let expired = 0
    for (const { id } of stale) {
      // Conditional on the status, so a rail approval landing in the same instant wins
      // rather than being overwritten by an expiry.
      const result = await this.prisma.collectRequest.updateMany({
        where: {
          id,
          status: { in: [CollectStatus.CREATED, CollectStatus.PENDING] },
        },
        data: { status: CollectStatus.EXPIRED, respondedAt: new Date() },
      })
      expired += result.count
    }

    if (expired > 0) {
      this.logger.info(`[${this.expireStale.name}] Expired stale collects`, {
        count: expired,
      })
    }
    return expired
  }

  /** Requests still awaiting an answer, for the payee's list. */
  openForUser(userId: string): Promise<CollectRequest[]> {
    return this.prisma.collectRequest.findMany({
      where: {
        userId,
        status: { in: [CollectStatus.CREATED, CollectStatus.PENDING] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  isOpen(collect: CollectRequest): boolean {
    return isCollectOpen(collect.status, collect.expiresAt)
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private async receivedWhere(userId: string, status?: CollectStatus) {
    const handles = await this.handles.list(userId)
    return {
      payerHandle: { in: handles.map((handle) => handle.vpa) },
      ...(status ? { status } : {}),
    }
  }

  private async fail(collectId: string, reason: string): Promise<void> {
    await this.prisma.collectRequest
      .update({
        where: { id: collectId },
        data: {
          status: CollectStatus.FAILED,
          declineReason: reason.slice(0, 200),
          respondedAt: new Date(),
        },
      })
      .catch(() => void 0)
  }

  private async owned(
    userId: string,
    collectId: string,
  ): Promise<CollectRequest> {
    const collect = await this.prisma.collectRequest.findFirst({
      where: { id: collectId, userId },
    })
    if (!collect) throw new NotFoundException('Payment request not found')
    return collect
  }
}
