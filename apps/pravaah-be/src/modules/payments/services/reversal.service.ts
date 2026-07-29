import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { formatMoney } from '@/modules/payments/money.util'
import { isRefundable } from '@/modules/payments/payments.state'
import { refundPlan } from '@/modules/payments/posting-plan'
import {
  LedgerService,
  isDuplicatePostingError,
  isUniqueViolation,
} from '@/modules/payments/services/ledger.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  ReversalKind,
  ReversalStatus,
  TxnStatus,
  type Reversal,
  type Transaction,
} from 'generated/prisma/client'

export interface RefundRequest {
  transactionId: string
  /** Source-currency minor units. Omit for a full refund of what remains. */
  amountMinor?: bigint
  reason: string
  actor: { type: ActorType; id?: string | null }
  /**
   * True when the rail has ALREADY returned the money — a rail-initiated reversal or a
   * post-settlement FAILED. Skips the outbound refund call, which would otherwise ask
   * the rail to send the money back a second time.
   */
  railAlreadyReturned?: boolean
}

/**
 * Refunds — returning money that has already settled.
 *
 * Distinct from releasing a reserve, and the distinction is the whole reason this is its
 * own service. A reserve release is a compensation: nothing left the platform, so the
 * mirror entries put it back. A refund is a REAL MOVEMENT IN THE OPPOSITE DIRECTION —
 * the money is with the beneficiary and has to come back off the rail before our books
 * may say it did.
 *
 * That ordering is the correctness question here, and it is easy to get backwards. The
 * tempting implementation credits the user's wallet and then asks the rail for the money.
 * If the rail call then fails, our ledger says the money came back while the beneficiary
 * still has it — a real loss, recorded as a successful refund. So: **the rail goes
 * first.** The ledger is posted only once the rail has confirmed, and a PENDING refund
 * stays PENDING until it does.
 *
 * Partial refunds are supported and bounded by `refundedMinor`, so successive partials
 * can never sum past what was actually settled. Each carries its own `sequence`, which is
 * what lets two legitimate partial refunds coexist without the second colliding on the
 * ledger's unique key.
 */
@Injectable()
export class ReversalService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly providers: PaymentProviderFactory,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ReversalService.name })
  }

  async refund(request: RefundRequest): Promise<Reversal> {
    const transaction = await this.orchestrator.load(request.transactionId)

    if (!isRefundable(transaction.status)) {
      throw new ConflictException(
        transaction.status === TxnStatus.REFUNDED
          ? 'That payment has already been fully refunded'
          : 'Only a settled payment can be refunded',
      )
    }

    const remaining = this.orchestrator.refundableMinor(transaction)
    if (remaining <= 0n) {
      throw new ConflictException('There is nothing left to refund')
    }

    const amountMinor = request.amountMinor ?? remaining
    if (amountMinor <= 0n) {
      throw new BadRequestException('Refund amount must be greater than zero')
    }
    if (amountMinor > remaining) {
      /**
       * Bounded by what is actually left.
       *
       * Without this, two concurrent partial refunds of half each plus a third would
       * return more than was ever sent — and every one of them would be individually
       * balanced, so the ledger would happily record the overpayment.
       */
      throw new BadRequestException(
        `Only ${formatMoney(remaining, transaction.sourceCurrency)} of this payment can still be refunded`,
      )
    }

    const full = amountMinor === remaining && transaction.refundedMinor === 0n
    const reversal = await this.openReversal(
      transaction,
      amountMinor,
      full,
      request,
    )

    // ── the rail leg, FIRST ─────────────────────────────────────────────────
    if (!request.railAlreadyReturned) {
      if (!transaction.railRef) {
        /**
         * A settled transaction with no rail reference.
         *
         * Cannot be refunded automatically: there is nothing to ask the rail to reverse,
         * and posting the ledger alone would credit the user out of our own funds. It is
         * escalated as a failed reversal for a human to resolve against the statement.
         */
        await this.failReversal(
          reversal.id,
          'No rail reference to reverse against',
        )
        throw new ConflictException(
          'This payment cannot be refunded automatically. Support will resolve it manually.',
        )
      }

      const provider = this.providers.byName(transaction.provider)
      const result = await provider.refund({
        idempotencyKey: `refund_${reversal.id}`,
        originalRailRef: transaction.railRef,
        amountMinor: this.railAmount(transaction, amountMinor, full),
        currency: transaction.destCurrency,
        reason: request.reason,
        traceId: reversal.id,
      })

      if (!result.ok) {
        await this.failReversal(reversal.id, result.error.message)
        throw new ConflictException(
          `The refund could not be sent to the payment network: ${result.error.message}`,
        )
      }

      await this.prisma.reversal.update({
        where: { id: reversal.id },
        data: { railRef: result.value.railRef },
      })

      if (result.value.status !== 'SUCCESS') {
        /**
         * The rail accepted the refund but has not completed it.
         *
         * The ledger is NOT posted yet. Crediting the wallet now would say the money is
         * back while it is still in flight — and if the rail's refund later fails, the
         * user would keep a credit funded by nobody.
         */
        this.logger.info(
          `[${this.refund.name}] Refund accepted by the rail and pending confirmation`,
          { transactionId: transaction.id, reversalId: reversal.id },
        )
        return this.prisma.reversal.findUniqueOrThrow({
          where: { id: reversal.id },
        })
      }
    }

    return this.completeReversal(reversal.id)
  }

  /**
   * Post the ledger and close the reversal.
   *
   * Reached either directly (the rail confirmed synchronously) or later, from a webhook
   * or the reconciler, once a PENDING refund completes.
   */
  async completeReversal(reversalId: string): Promise<Reversal> {
    const reversal = await this.prisma.reversal.findUnique({
      where: { id: reversalId },
      include: { transaction: true },
    })
    if (!reversal) throw new NotFoundException('Reversal not found')
    if (reversal.status === ReversalStatus.DONE) return reversal

    const transaction = reversal.transaction
    const full = reversal.kind === ReversalKind.REFUND

    try {
      await this.prisma.$transaction(async (tx) => {
        const accounts = await this.accountsFor(tx, transaction)
        await this.ledger.post(
          tx,
          transaction.id,
          refundPlan(accounts, this.orchestrator.amountsOf(transaction), {
            amountMinor: reversal.amountMinor,
            full,
            // The reversal's own id, so successive partial refunds never collide on the
            // ledger's unique key.
            legRef: reversal.id,
          }),
        )

        const refundedTotal = transaction.refundedMinor + reversal.amountMinor
        const fullyRefunded = refundedTotal >= transaction.sourceAmount

        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            refundedMinor: refundedTotal,
            status: fullyRefunded
              ? TxnStatus.REFUNDED
              : TxnStatus.PARTIALLY_REFUNDED,
          },
        })
        await tx.reversal.update({
          where: { id: reversal.id },
          data: { status: ReversalStatus.DONE, completedAt: new Date() },
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        this.logger.warn(
          `[${this.completeReversal.name}] Refund legs already posted concurrently`,
          { reversalId },
        )
        return this.prisma.reversal.findUniqueOrThrow({
          where: { id: reversalId },
        })
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: full ? 'txn.refunded' : 'txn.partially_refunded',
      entity: 'Transaction',
      entityId: transaction.id,
      metadata: {
        reversalId,
        amountMinor: reversal.amountMinor.toString(),
        reason: reversal.reason,
      },
    })

    this.logger.info(`[${this.completeReversal.name}] Refund completed`, {
      transactionId: transaction.id,
      reversalId,
      amount: formatMoney(reversal.amountMinor, transaction.sourceCurrency),
    })
    return this.prisma.reversal.findUniqueOrThrow({ where: { id: reversalId } })
  }

  /**
   * Refund a payment the rail told us failed AFTER it had settled on our side.
   *
   * The rail has already returned the money, so no outbound refund is sent — asking for
   * it again would either be rejected or, worse, return it twice.
   */
  async refundRailFailure(
    transactionId: string,
    reason: string,
  ): Promise<Reversal | null> {
    const transaction = await this.orchestrator.load(transactionId)
    if (!isRefundable(transaction.status)) return null

    return this.refund({
      transactionId,
      reason,
      actor: { type: ActorType.SYSTEM },
      railAlreadyReturned: true,
    })
  }

  /** Every reversal against a transaction, for the receipt and the admin view. */
  listForTransaction(transactionId: string): Promise<Reversal[]> {
    return this.prisma.reversal.findMany({
      where: { transactionId },
      orderBy: { sequence: 'asc' },
    })
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * Open a reversal row, claiming the next sequence.
   *
   * The sequence is part of a unique key, so two concurrent refund attempts race to
   * insert and exactly one wins. A retry loop rather than a pre-computed count, because
   * `count() + 1` is stale the instant it returns — and the loser of that race would
   * otherwise create a second reversal for the same intent.
   */
  private async openReversal(
    transaction: Transaction,
    amountMinor: bigint,
    full: boolean,
    request: RefundRequest,
  ): Promise<Reversal> {
    const kind = full ? ReversalKind.REFUND : ReversalKind.PARTIAL_REFUND

    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.reversal.findFirst({
        where: { transactionId: transaction.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      const sequence = (last?.sequence ?? 0) + 1

      try {
        return await this.prisma.reversal.create({
          data: {
            transactionId: transaction.id,
            sequence,
            kind,
            reason: request.reason.slice(0, 500),
            amountMinor,
            status: ReversalStatus.PENDING,
            initiatedByAdminId:
              request.actor.type === ActorType.ADMIN
                ? (request.actor.id ?? null)
                : null,
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) continue
        throw error
      }
    }

    throw new ConflictException(
      'Another refund for this payment is being processed. Please try again.',
    )
  }

  private async failReversal(
    reversalId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.reversal.update({
      where: { id: reversalId },
      data: {
        status: ReversalStatus.FAILED,
        failureReason: reason.slice(0, 500),
      },
    })
    this.logger.error(`[${this.failReversal.name}] Reversal failed`, {
      reversalId,
      reason,
    })
  }

  /**
   * The amount to ask the rail for, in the DESTINATION currency.
   *
   * The user is refunded in the source currency, but the rail returns what it actually
   * paid out. For a full refund that is the whole destination amount; for a partial one
   * it is the portion converted at the ORIGINAL locked rate — re-rating it would book an
   * FX movement into a customer's refund and leave them short by however much the market
   * had moved.
   */
  private railAmount(
    transaction: Transaction,
    amountMinor: bigint,
    full: boolean,
  ): bigint {
    if (full) return transaction.destAmount
    if (transaction.sourceCurrency === transaction.destCurrency) {
      return amountMinor
    }
    const rateE8 = transaction.fxRateE8
    if (!rateE8 || rateE8 <= 0n) {
      throw new ConflictException(
        'This cross-currency payment cannot be partially refunded — its locked rate is missing',
      )
    }
    // Same conversion the posting plan performs, so the rail leg and the ledger leg ask
    // for exactly the same number.
    return (amountMinor * rateE8) / 100_000_000n
  }

  /**
   * Reuse the orchestrator's account resolution.
   *
   * Deliberately not a second implementation. A refund must post against exactly the
   * accounts the settlement used — two resolvers would eventually disagree about which
   * account a payee's money went to (internal wallet versus external), and the refund
   * would come out of the wrong one while balancing perfectly.
   */
  private accountsFor(
    tx: Parameters<LedgerService['post']>[0],
    transaction: Transaction,
  ) {
    return this.orchestrator.resolveTransactionAccounts(tx, transaction, {
      includeReceivable: false,
    })
  }
}
