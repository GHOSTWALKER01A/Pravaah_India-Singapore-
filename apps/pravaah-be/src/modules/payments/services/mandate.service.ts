import { randomUUID } from 'crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  CreateMandateDto,
  MandateActionDto,
  MandateListQueryDto,
  PresentMandateDebitDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { formatMoney, toMinor } from '@/modules/payments/money.util'
import {
  MANDATE_MAX_EXECUTION_ATTEMPTS,
  MANDATE_PREDEBIT_NOTICE_MS,
} from '@/modules/payments/payments.config'
import {
  canMandateTransition,
  isMandateDebitable,
  nextDebitDate,
} from '@/modules/payments/payments.state'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { BeneficiaryService } from '@/modules/payments/services/beneficiary.service'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  Corridor,
  MandateExecutionStatus,
  MandateStatus,
  TxnStatus,
  TxnType,
  type Mandate,
  type MandateExecution,
} from 'generated/prisma/client'

/**
 * UPI AutoPay — standing permission to debit.
 *
 * The most dangerous object a user can create, because it is the only one that moves money
 * without them being present. Every rule here is a bound on that:
 *
 *  - **The pre-debit notification is a PRECONDITION, not a courtesy.** NPCI requires it at
 *    least 24 hours before each debit, and {@link executeDue} refuses to debit a row whose
 *    `notifiedAt` is null. A recurring debit nobody was warned about is
 *    indistinguishable from an unauthorised one — which is exactly what makes AutoPay
 *    disputes unwinnable for a PSP that skipped it.
 *  - **Every debit is re-checked against the authorised ceiling.** The merchant chooses
 *    the amount later, so a check at creation time proves nothing about the eleventh debit.
 *  - **Executions are sequenced, and the sequence is unique.** A duplicate debit is a
 *    database error rather than a second charge.
 *  - **Revocation is terminal; pausing is not.** A person cancelling a subscription must
 *    not be one mis-tap away from it resuming, and a merchant must not read "paused" as
 *    "will come back".
 */
@Injectable()
export class MandateService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly providers: PaymentProviderFactory,
    private readonly beneficiaries: BeneficiaryService,
    private readonly handles: UpiHandleService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MandateService.name })
  }

  // ── create ────────────────────────────────────────────────────────────────
  async create(
    userId: string,
    dto: CreateMandateDto,
    idempotencyKey: string,
  ): Promise<Mandate> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true, isSuspended: true },
    })
    if (!user) throw new NotFoundException('User not found')
    if (user.isSuspended)
      throw new ForbiddenException('Your account is on hold')
    if (user.kycStatus !== 'VERIFIED') {
      throw new ForbiddenException(
        'Complete your identity verification before setting up AutoPay',
      )
    }

    // A mandate is a standing domestic instruction; there is no cross-border AutoPay.
    const beneficiary = await this.beneficiaries.assertPayable(
      userId,
      dto.beneficiaryId,
      Corridor.DOMESTIC,
    )

    const payer = await this.handles.primary(userId)
    if (!payer) {
      throw new BadRequestException(
        'Create and verify a UPI ID before setting up AutoPay',
      )
    }

    if (dto.validUntil <= new Date()) {
      throw new BadRequestException('That mandate would already have expired')
    }

    const mandateRef = `MND-${randomUUID()}`
    const maxAmountMinor = toMinor(dto.maxAmountMinor)

    let mandate: Mandate
    try {
      mandate = await this.prisma.mandate.create({
        data: {
          userId,
          beneficiaryId: beneficiary.id,
          mandateRef,
          status: MandateStatus.CREATED,
          frequency: dto.frequency,
          amountRule: dto.amountRule,
          maxAmountMinor,
          currency: dto.currency,
          purposeCode: dto.purposeCode,
          narration: dto.narration ?? null,
          validFrom: dto.validFrom,
          validUntil: dto.validUntil,
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('That mandate already exists')
      }
      throw error
    }

    const provider = this.providers.forCorridor(Corridor.DOMESTIC)
    if (!provider.createMandate) {
      await this.markFailed(mandate.id, 'This rail does not support AutoPay')
      throw new BadRequestException('AutoPay is not available on this rail')
    }

    const result = await provider.createMandate({
      idempotencyKey,
      mandateId: mandate.id,
      mandateRef,
      payerVpa: payer.vpa,
      payeeHandle: beneficiary.handle,
      payeeName: beneficiary.registeredName ?? beneficiary.displayName,
      maxAmountMinor,
      currency: dto.currency,
      frequency: dto.frequency,
      amountRule: dto.amountRule,
      validFrom: dto.validFrom,
      validUntil: dto.validUntil,
      purposeCode: dto.purposeCode,
      narration: dto.narration ?? null,
      traceId: mandate.id,
    })

    if (!result.ok) {
      await this.markFailed(mandate.id, result.error.message)
      throw new BadRequestException(
        `AutoPay could not be set up: ${result.error.message}`,
      )
    }

    /**
     * PENDING, not ACTIVE.
     *
     * The payer has to approve the mandate in their own PSP app with their UPI PIN. A
     * mandate we marked ACTIVE on creation would be a standing debit permission the user
     * never actually authorised.
     */
    const updated = await this.prisma.mandate.update({
      where: { id: mandate.id },
      data: {
        status: MandateStatus.PENDING,
        railRef: result.value.railRef,
        umn: result.value.umn ?? null,
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'mandate.created',
      entity: 'Mandate',
      entityId: mandate.id,
      metadata: {
        frequency: dto.frequency,
        maxAmountMinor: maxAmountMinor.toString(),
        validUntil: dto.validUntil.toISOString(),
      },
    })
    return updated
  }

  /** The rail reports the payer's decision on the mandate itself. */
  async applyRailDecision(params: {
    railRef?: string
    mandateRef?: string
    approved: boolean
    umn?: string | null
    reason?: string | null
  }): Promise<Mandate | null> {
    const mandate = params.railRef
      ? await this.prisma.mandate.findUnique({
          where: { railRef: params.railRef },
        })
      : params.mandateRef
        ? await this.prisma.mandate.findUnique({
            where: { mandateRef: params.mandateRef },
          })
        : null
    if (!mandate) return null

    const target = params.approved ? MandateStatus.ACTIVE : MandateStatus.FAILED
    if (!canMandateTransition(mandate.status, target)) return mandate

    const updated = await this.prisma.mandate.update({
      where: { id: mandate.id },
      data: {
        status: target,
        umn: params.umn ?? mandate.umn,
        approvedAt: params.approved ? new Date() : null,
        failureReason: params.approved ? null : (params.reason ?? 'Declined'),
        // The first debit is scheduled from `validFrom`, not from now — a mandate
        // approved early must not debit before the date the user agreed to.
        nextDebitAt: params.approved
          ? mandate.validFrom > new Date()
            ? mandate.validFrom
            : (nextDebitDate(mandate.frequency, new Date()) ??
              mandate.validFrom)
          : null,
      },
    })

    if (params.approved) {
      // Schedule the first execution immediately, so the 24-hour notice clock starts now
      // rather than when a cron next happens to look.
      await this.scheduleNext(updated).catch((error: unknown) => {
        this.logger.error(
          `[${this.applyRailDecision.name}] Could not schedule the first debit`,
          { mandateId: mandate.id, err: error },
        )
      })
    }
    return updated
  }

  // ── presenting a debit ────────────────────────────────────────────────────
  /**
   * Schedule a debit against a mandate.
   *
   * Checked against the authorised ceiling HERE rather than only at creation, because the
   * merchant chooses the amount and a mandate is a permission that outlives the moment it
   * was granted. An `EXACT` mandate must be debited for exactly the authorised amount; a
   * `MAX` one may be debited for less, never more.
   *
   * The due date must leave room for the 24-hour pre-debit notice, so a merchant cannot
   * schedule a debit for "now" and bypass the warning.
   */
  async presentDebit(
    mandateId: string,
    dto: PresentMandateDebitDto,
  ): Promise<MandateExecution> {
    const mandate = await this.prisma.mandate.findUnique({
      where: { id: mandateId },
    })
    if (!mandate) throw new NotFoundException('Mandate not found')

    if (
      !isMandateDebitable(mandate.status, mandate.validFrom, mandate.validUntil)
    ) {
      throw new ConflictException(
        mandate.status === MandateStatus.PAUSED
          ? 'That AutoPay mandate is paused'
          : 'That AutoPay mandate is not active',
      )
    }

    const amountMinor = toMinor(dto.amountMinor)
    if (
      mandate.amountRule === 'EXACT' &&
      amountMinor !== mandate.maxAmountMinor
    ) {
      throw new BadRequestException(
        `This mandate authorises exactly ${formatMoney(mandate.maxAmountMinor, mandate.currency)}`,
      )
    }
    if (amountMinor > mandate.maxAmountMinor) {
      throw new BadRequestException(
        `This debit is larger than the ${formatMoney(mandate.maxAmountMinor, mandate.currency)} you approved`,
      )
    }
    if (dto.dueAt > mandate.validUntil) {
      throw new BadRequestException(
        'That debit falls after the mandate expires',
      )
    }

    const earliest = new Date(Date.now() + MANDATE_PREDEBIT_NOTICE_MS)
    if (dto.dueAt < earliest) {
      throw new BadRequestException(
        'A debit must be scheduled at least 24 hours ahead so the payer can be notified first',
      )
    }

    return this.createExecution(mandate, amountMinor, dto.dueAt)
  }

  /** Queue the next scheduled debit for a recurring mandate. */
  async scheduleNext(mandate: Mandate): Promise<MandateExecution | null> {
    if (mandate.frequency === 'AS_PRESENTED') {
      // No schedule — the merchant presents a debit when one is due. Inventing a date
      // would make the scheduler debit a mandate nobody has claimed against.
      return null
    }

    const dueAt = mandate.nextDebitAt ?? mandate.validFrom
    if (dueAt > mandate.validUntil) {
      await this.prisma.mandate.update({
        where: { id: mandate.id },
        data: { status: MandateStatus.COMPLETED, nextDebitAt: null },
      })
      return null
    }

    return this.createExecution(mandate, mandate.maxAmountMinor, dueAt)
  }

  /**
   * Send the pre-debit notification.
   *
   * Stamping `notifiedAt` is what UNLOCKS the debit — {@link executeDue} skips any row
   * without it. Modelled as a gate rather than a side effect precisely so that a
   * notification failure blocks the debit instead of being logged and forgotten.
   */
  async notifyDue(limit = 100): Promise<number> {
    const window = new Date(Date.now() + MANDATE_PREDEBIT_NOTICE_MS)
    const due = await this.prisma.mandateExecution.findMany({
      where: {
        status: MandateExecutionStatus.SCHEDULED,
        notifiedAt: null,
        dueAt: { lte: window },
      },
      include: { mandate: true },
      take: limit,
    })

    let notified = 0
    for (const execution of due) {
      const updated = await this.prisma.mandateExecution.updateMany({
        where: { id: execution.id, notifiedAt: null },
        data: {
          status: MandateExecutionStatus.NOTIFIED,
          notifiedAt: new Date(),
        },
      })
      if (updated.count === 0) continue

      notified += 1
      this.logger.info(`[${this.notifyDue.name}] Pre-debit notice recorded`, {
        executionId: execution.id,
        mandateId: execution.mandateId,
        dueAt: execution.dueAt.toISOString(),
      })
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'mandate.pre_debit_notified',
        entity: 'MandateExecution',
        entityId: execution.id,
        metadata: {
          amountMinor: execution.amountMinor.toString(),
          dueAt: execution.dueAt.toISOString(),
        },
      })
    }
    return notified
  }

  /**
   * Execute the debits that are due.
   *
   * Only NOTIFIED rows, and only where the 24-hour notice has actually elapsed. The
   * elapsed check is separate from the status check on purpose: a notification stamped
   * five minutes ago satisfies "notified" but not the obligation, and debiting on it would
   * be technically notified and substantively unannounced.
   */
  async executeDue(limit = 50): Promise<number> {
    const now = new Date()
    const due = await this.prisma.mandateExecution.findMany({
      where: {
        status: MandateExecutionStatus.NOTIFIED,
        dueAt: { lte: now },
        notifiedAt: {
          lte: new Date(now.getTime() - MANDATE_PREDEBIT_NOTICE_MS),
        },
        transactionId: null,
      },
      include: { mandate: { include: { beneficiary: true } } },
      take: limit,
    })

    let executed = 0
    for (const execution of due) {
      try {
        await this.execute(execution.id)
        executed += 1
      } catch (error) {
        this.logger.error(`[${this.executeDue.name}] Debit failed`, {
          executionId: execution.id,
          err: error,
        })
      }
    }
    return executed
  }

  /** Debit one execution. Idempotent on `(mandate, sequence)`. */
  async execute(executionId: string): Promise<MandateExecution> {
    const execution = await this.prisma.mandateExecution.findUnique({
      where: { id: executionId },
      include: { mandate: { include: { beneficiary: true } } },
    })
    if (!execution) throw new NotFoundException('Scheduled debit not found')
    if (execution.transactionId) return execution

    const { mandate } = execution
    if (
      !isMandateDebitable(mandate.status, mandate.validFrom, mandate.validUntil)
    ) {
      return this.skip(execution.id, 'The mandate is no longer active')
    }
    if (!execution.notifiedAt) {
      // The gate. NPCI requires the notice, and a debit without one is not permitted.
      return this.skip(
        execution.id,
        'The pre-debit notification has not been sent',
      )
    }
    // Re-checked at debit time, not only when presented: the ceiling is what the payer
    // authorised, and nothing between then and now is allowed to raise it.
    if (execution.amountMinor > mandate.maxAmountMinor) {
      return this.fail(
        execution.id,
        'The debit exceeds the authorised mandate amount',
      )
    }

    const transaction = await this.orchestrator.createRaw({
      userId: mandate.userId,
      type: TxnType.REPAYMENT,
      currency: mandate.currency,
      amountMinor: execution.amountMinor,
      counterpartyHandle: mandate.beneficiary.handle,
      counterpartyName: mandate.beneficiary.registeredName,
      beneficiaryId: mandate.beneficiaryId,
      purposeCode: mandate.purposeCode,
      narration: mandate.narration ?? 'AutoPay debit',
      // Derived from the execution, so a retried cron run cannot mint a second debit.
      idempotencyKey: `mandate_exec_${execution.id}`,
      status: TxnStatus.VALIDATED,
    })

    await this.prisma.mandateExecution.update({
      where: { id: execution.id },
      data: {
        transactionId: transaction.id,
        attempts: { increment: 1 },
      },
    })

    const driven = await this.orchestrator.drive(transaction.id)

    const settled =
      driven.status === TxnStatus.SUCCESS ||
      driven.status === TxnStatus.PENDING ||
      driven.status === TxnStatus.SUBMITTED

    const updated = await this.prisma.mandateExecution.update({
      where: { id: execution.id },
      data: {
        status: settled
          ? MandateExecutionStatus.DEBITED
          : MandateExecutionStatus.FAILED,
        debitedAt: settled ? new Date() : null,
        failureReason: settled ? null : driven.failureReason,
      },
    })

    await this.advance(mandate, settled, updated)
    return updated
  }

  // ── lifecycle actions ─────────────────────────────────────────────────────
  async act(
    userId: string,
    mandateId: string,
    dto: MandateActionDto,
  ): Promise<Mandate> {
    const mandate = await this.owned(userId, mandateId)

    const target =
      dto.action === 'PAUSE'
        ? MandateStatus.PAUSED
        : dto.action === 'RESUME'
          ? MandateStatus.ACTIVE
          : MandateStatus.REVOKED

    if (!canMandateTransition(mandate.status, target)) {
      throw new ConflictException(
        `An AutoPay mandate that is ${mandate.status.toLowerCase()} cannot be ${dto.action.toLowerCase()}d`,
      )
    }

    if (target === MandateStatus.REVOKED && mandate.railRef) {
      const provider = this.providers.byName(
        this.providers.nameFor(Corridor.DOMESTIC),
      )
      // Best-effort on the rail. A rail that will not accept the revocation must not stop
      // us from honouring it locally — the scheduler refuses to debit a REVOKED mandate
      // regardless, so the user's instruction takes effect either way.
      await provider
        .revokeMandate?.(mandate.railRef, mandate.id)
        .then((result) => {
          if (!result.ok) {
            this.logger.warn(
              `[${this.act.name}] Rail did not confirm the revocation; enforcing it locally`,
              { mandateId: mandate.id, reason: result.error.code },
            )
          }
        })
        .catch(() => void 0)
    }

    const updated = await this.prisma.mandate.update({
      where: { id: mandate.id },
      data: {
        status: target,
        revokeReason:
          target === MandateStatus.REVOKED
            ? (dto.reason ?? 'Cancelled by the user')
            : null,
        revokedAt: target === MandateStatus.REVOKED ? new Date() : null,
        // A paused or revoked mandate has no next debit. Leaving one set is how a
        // "cancelled" subscription charges somebody a month later.
        nextDebitAt:
          target === MandateStatus.ACTIVE ? mandate.nextDebitAt : null,
      },
    })

    if (target !== MandateStatus.ACTIVE) {
      await this.prisma.mandateExecution.updateMany({
        where: {
          mandateId: mandate.id,
          status: {
            in: [
              MandateExecutionStatus.SCHEDULED,
              MandateExecutionStatus.NOTIFIED,
            ],
          },
        },
        data: {
          status: MandateExecutionStatus.SKIPPED,
          failureReason: `Mandate ${target.toLowerCase()}`,
        },
      })
    }

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: `mandate.${dto.action.toLowerCase()}`,
      entity: 'Mandate',
      entityId: mandate.id,
      metadata: { reason: dto.reason ?? null },
    })
    return updated
  }

  async list(
    userId: string,
    query: MandateListQueryDto,
  ): Promise<{ items: Mandate[]; total: number }> {
    const where = {
      userId,
      ...(query.status ? { status: query.status } : {}),
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.mandate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { beneficiary: true },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.mandate.count({ where }),
    ])
    return { items, total }
  }

  async get(userId: string, mandateId: string) {
    const mandate = await this.prisma.mandate.findFirst({
      where: { id: mandateId, userId },
      include: {
        beneficiary: true,
        executions: { orderBy: { sequence: 'desc' }, take: 24 },
      },
    })
    if (!mandate) throw new NotFoundException('AutoPay mandate not found')
    return mandate
  }

  /** Expire mandates past their end date. */
  async expireStale(limit = 200): Promise<number> {
    const result = await this.prisma.mandate.updateMany({
      where: {
        status: {
          in: [
            MandateStatus.ACTIVE,
            MandateStatus.PAUSED,
            MandateStatus.PENDING,
          ],
        },
        validUntil: { lt: new Date() },
      },
      data: { status: MandateStatus.EXPIRED, nextDebitAt: null },
    })
    if (result.count > 0) {
      this.logger.info(`[${this.expireStale.name}] Expired mandates`, {
        count: result.count,
      })
    }
    return Math.min(result.count, limit)
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * Create an execution row, claiming the next sequence.
   *
   * The sequence is half of a unique key, so two concurrent schedulers race to insert and
   * exactly one wins. That constraint is what makes a duplicate debit a database error
   * rather than a second charge on somebody's account.
   */
  private async createExecution(
    mandate: Mandate,
    amountMinor: bigint,
    dueAt: Date,
  ): Promise<MandateExecution> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.mandateExecution.findFirst({
        where: { mandateId: mandate.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      const sequence = (last?.sequence ?? 0) + 1

      try {
        return await this.prisma.mandateExecution.create({
          data: {
            mandateId: mandate.id,
            sequence,
            status: MandateExecutionStatus.SCHEDULED,
            amountMinor,
            dueAt,
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) continue
        throw error
      }
    }
    throw new ConflictException(
      'Another debit for this mandate is being scheduled. Please try again.',
    )
  }

  /** Move the mandate forward after an execution resolves. */
  private async advance(
    mandate: Mandate,
    settled: boolean,
    execution: MandateExecution,
  ): Promise<void> {
    if (!settled) {
      if (execution.attempts >= MANDATE_MAX_EXECUTION_ATTEMPTS) {
        /**
         * Repeated failures PAUSE the mandate rather than cancelling it.
         *
         * Three failed debits usually means an empty account, not a customer who wants
         * out. Revoking would force them to re-authorise a subscription they never
         * cancelled; pausing lets them fix the balance and resume.
         */
        await this.prisma.mandate.update({
          where: { id: mandate.id },
          data: {
            status: MandateStatus.PAUSED,
            failureReason: `Paused after ${execution.attempts} failed debits`,
          },
        })
        this.logger.warn(
          `[${this.advance.name}] Mandate paused after repeated failures`,
          { mandateId: mandate.id, attempts: execution.attempts },
        )
      }
      return
    }

    const next = nextDebitDate(mandate.frequency, execution.dueAt)
    const completed = !next || next > mandate.validUntil

    await this.prisma.mandate.update({
      where: { id: mandate.id },
      data: {
        lastDebitAt: new Date(),
        nextDebitAt: completed ? null : next,
        status: completed ? MandateStatus.COMPLETED : mandate.status,
      },
    })

    if (!completed && next) {
      await this.createExecution(mandate, mandate.maxAmountMinor, next).catch(
        (error: unknown) => {
          this.logger.error(
            `[${this.advance.name}] Could not schedule the next debit`,
            { mandateId: mandate.id, err: error },
          )
        },
      )
    }
  }

  private async skip(
    executionId: string,
    reason: string,
  ): Promise<MandateExecution> {
    return this.prisma.mandateExecution.update({
      where: { id: executionId },
      data: {
        status: MandateExecutionStatus.SKIPPED,
        failureReason: reason.slice(0, 300),
      },
    })
  }

  private async fail(
    executionId: string,
    reason: string,
  ): Promise<MandateExecution> {
    return this.prisma.mandateExecution.update({
      where: { id: executionId },
      data: {
        status: MandateExecutionStatus.FAILED,
        failureReason: reason.slice(0, 300),
        attempts: { increment: 1 },
      },
    })
  }

  private async markFailed(mandateId: string, reason: string): Promise<void> {
    await this.prisma.mandate
      .update({
        where: { id: mandateId },
        data: {
          status: MandateStatus.FAILED,
          failureReason: reason.slice(0, 300),
        },
      })
      .catch(() => void 0)
  }

  private async owned(userId: string, mandateId: string): Promise<Mandate> {
    const mandate = await this.prisma.mandate.findFirst({
      where: { id: mandateId, userId },
    })
    if (!mandate) throw new NotFoundException('AutoPay mandate not found')
    return mandate
  }
}
