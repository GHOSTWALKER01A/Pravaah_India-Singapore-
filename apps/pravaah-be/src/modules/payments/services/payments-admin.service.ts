import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  AdminTxnListQueryDto,
  LedgerQueryDto,
  ManualReversalDto,
  ReconListQueryDto,
  ResolveDeemedDto,
  TrialBalanceQueryDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import {
  presentDispute,
  presentLedgerEntry,
  presentRecon,
  presentReversal,
} from '@/modules/payments/admin-projection'
import { moneyView, toMinor } from '@/modules/payments/money.util'
import { needsHumanAttention } from '@/modules/payments/payments.state'
import { LedgerService } from '@/modules/payments/services/ledger.service'
import { ReconciliationService } from '@/modules/payments/services/reconciliation.service'
import { ReversalService } from '@/modules/payments/services/reversal.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { maskHandle } from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  ReconStatus,
  TxnStatus,
  type Transaction,
} from 'generated/prisma/client'

/**
 * The admin surface for M4 — oversight, and the two break-glass controls.
 *
 * Everything read-only here exists so an operator can answer three questions during an
 * incident: is the ledger sound (the trial balance), what is stuck (the attention queue), and
 * what did the rail actually say (the reconciliation trail).
 *
 * Everything that WRITES here moves customer money without a rail event to corroborate it,
 * which is why each one demands a typed confirmation and a written reason, and attributes
 * the acting admin from the authenticated session rather than from the request body. A
 * self-declared actor id would make the whole attribution trail worthless.
 */
@Injectable()
export class PaymentsAdminService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly reversals: ReversalService,
    private readonly reconciliation: ReconciliationService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentsAdminService.name })
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  /**
   * The trial balance — the one number to page somebody about.
   *
   * Zero, in every currency, always. A non-zero result cannot come from a rejected posting,
   * so it means entries reached the table without passing through `LedgerService.post`.
   */
  async trialBalance(query: TrialBalanceQueryDto) {
    const rows = await this.ledger.trialBalance(query.currency)

    return {
      balanced: rows.every((row) => row.balanced),
      currencies: rows.map((row) => ({
        currency: row.currency,
        credits: moneyView(row.credits, row.currency),
        debits: moneyView(row.debits, row.currency),
        netMinor: row.net.toString(),
        balanced: row.balanced,
      })),
      accounts: query.detailed
        ? (await this.ledger.accountBalances(query.currency)).map((entry) => ({
            id: entry.account.id,
            ownerType: entry.account.ownerType,
            type: entry.account.type,
            currency: entry.account.currency,
            label: entry.account.label,
            allowNegative: entry.account.allowNegative,
            balanceMinor: entry.balance.toString(),
            balance:
              entry.balance >= 0n
                ? moneyView(entry.balance, entry.account.currency)
                : null,
          }))
        : undefined,
    }
  }

  /**
   * Transactions, with a `needsAttention` filter.
   *
   * That filter is the operational point of this endpoint. DEEMED and RISK_HELD rows are the
   * only ones where money is parked awaiting a HUMAN, and an admin console that made them
   * findable only by scrolling would leave real funds in suspense indefinitely.
   */
  async transactions(query: AdminTxnListQueryDto) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.corridor ? { corridor: query.corridor } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.needsAttention
        ? { status: { in: [TxnStatus.DEEMED, TxnStatus.RISK_HELD] } }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.transaction.count({ where }),
    ])

    return { items: items.map((item) => this.summarise(item)), total }
  }

  /** Everything about one transaction: the ledger, the rail trail, the reversals. */
  async transactionDetail(transactionId: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        beneficiary: true,
        reversals: { orderBy: { sequence: 'asc' } },
        recons: { orderBy: { createdAt: 'desc' } },
        disputes: true,
        railEvents: {
          orderBy: { receivedAt: 'desc' },
          // The encrypted payload is deliberately NOT selected. An admin needs to know an
          // event arrived and what it said; the raw body is evidence for a dispute, not
          // material for a console screen.
          select: {
            id: true,
            provider: true,
            eventId: true,
            kind: true,
            status: true,
            signatureVerified: true,
            receivedAt: true,
            processedAt: true,
            attempts: true,
            lastError: true,
          },
        },
      },
    })
    if (!transaction) throw new NotFoundException('Payment not found')

    const entries = await this.ledger.entriesForTransaction(transactionId)

    return {
      transaction: this.summarise(transaction),
      /**
       * The ledger, as the audit trail of how the balance came to be.
       *
       * Shown per leg rather than netted, because the whole value of an append-only ledger
       * during an incident is being able to see the reserve, the fee, the FX crossing and the
       * payout as separate, timestamped facts.
       */
      ledger: entries.map((entry) => ({
        id: entry.id,
        leg: entry.leg,
        legRef: entry.legRef || null,
        direction: entry.direction,
        amountMinor: entry.amountMinor.toString(),
        currency: entry.currency,
        account: {
          id: entry.account.id,
          type: entry.account.type,
          ownerType: entry.account.ownerType,
          currency: entry.account.currency,
        },
        postedAt: entry.postedAt,
      })),
      // Projected, not passed through: each of these three carries a BigInt column, and
      // `JSON.stringify` throws on a BigInt rather than rounding it. A raw row here is a 500.
      reversals: transaction.reversals.map(presentReversal),
      reconciliations: transaction.recons.map((record) => presentRecon(record)),
      disputes: transaction.disputes.map((dispute) => presentDispute(dispute)),
      railEvents: transaction.railEvents,
      beneficiary: transaction.beneficiary
        ? {
            id: transaction.beneficiary.id,
            displayName: transaction.beneficiary.displayName,
            registeredName: transaction.beneficiary.registeredName,
            handle: maskHandle(transaction.beneficiary.handle),
            status: transaction.beneficiary.status,
            screeningHit: transaction.beneficiary.screeningHit,
          }
        : null,
    }
  }

  /** The reconciliation trail — mismatches first, because those are the work. */
  async reconciliations(query: ReconListQueryDto) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.reconciliationRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          transaction: {
            select: {
              id: true,
              status: true,
              corridor: true,
              totalDebitMinor: true,
              sourceCurrency: true,
            },
          },
        },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.reconciliationRecord.count({ where }),
    ])
    return { items: items.map((record) => presentRecon(record)), total }
  }

  async ledgerEntries(query: LedgerQueryDto) {
    const where = {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.transactionId ? { transactionId: query.transactionId } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.accountType ? { account: { type: query.accountType } } : {}),
      ...(query.from || query.to
        ? {
            postedAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { postedAt: 'desc' },
        include: { account: true },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.ledgerEntry.count({ where }),
    ])
    return { items: items.map(presentLedgerEntry), total }
  }

  /** The dashboard numbers. */
  async stats() {
    const [byStatus, byCorridor, attention, openDisputes, mismatches, trial] =
      await Promise.all([
        this.prisma.transaction.groupBy({
          by: ['status'],
          _count: { _all: true },
          _sum: { totalDebitMinor: true },
        }),
        this.prisma.transaction.groupBy({
          by: ['corridor'],
          _count: { _all: true },
        }),
        this.prisma.transaction.count({
          where: { status: { in: [TxnStatus.DEEMED, TxnStatus.RISK_HELD] } },
        }),
        this.prisma.paymentDispute.count({
          where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
        }),
        this.prisma.reconciliationRecord.count({
          where: { status: ReconStatus.MISMATCH },
        }),
        this.ledger.trialBalance(),
      ])

    /**
     * Funds sitting in suspense.
     *
     * Read from the LEDGER, not summed from the transactions. The suspense balance is what we
     * are actually holding; a total derived from transaction rows is what we believe we are
     * holding, and the entire point of the trial balance is that those two can differ.
     */
    const suspense = (await this.ledger.accountBalances()).filter(
      (entry) => entry.account.type === 'SUSPENSE',
    )

    return {
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
        totalMinor: (row._sum.totalDebitMinor ?? 0n).toString(),
      })),
      byCorridor: byCorridor.map((row) => ({
        corridor: row.corridor,
        count: row._count._all,
      })),
      needsAttention: attention,
      openDisputes,
      openMismatches: mismatches,
      trialBalanceOk: trial.every((row) => row.balanced),
      suspense: suspense.map((entry) => ({
        currency: entry.account.currency,
        balanceMinor: entry.balance.toString(),
      })),
    }
  }

  // ── break-glass ───────────────────────────────────────────────────────────
  /**
   * Resolve a DEEMED transaction by hand.
   *
   * The two options are opposites and both are irreversible: SETTLE credits the beneficiary
   * and closes the ledger; REVERSE gives the money back to the sender. Guessing wrong pays
   * twice or not at all, which is exactly why the saga parks these instead of choosing for
   * itself — and why this demands an evidence reference rather than just a reason.
   */
  async resolveDeemed(
    transactionId: string,
    dto: ResolveDeemedDto,
    admin: { id: string },
  ): Promise<Transaction> {
    const transaction = await this.orchestrator.load(transactionId)
    if (transaction.status !== TxnStatus.DEEMED) {
      throw new ConflictException(
        'Only a transaction the network never confirmed can be resolved this way',
      )
    }

    const resolved =
      dto.resolution === 'SETTLE'
        ? await this.orchestrator.settle(transactionId, {
            status: 'SUCCESS',
            railCode: transaction.railCode,
          })
        : await this.orchestrator.releaseReserve(
            transactionId,
            `Resolved by an administrator: ${dto.reason}`,
            transaction.railCode,
            TxnStatus.REVERSED,
          )

    await this.prisma.reconciliationRecord.create({
      data: {
        transactionId,
        source: 'STATEMENT',
        railStatus: dto.resolution === 'SETTLE' ? 'SUCCESS' : 'FAILED',
        internalStatus: TxnStatus.DEEMED,
        status: ReconStatus.RESOLVED,
        // The evidence is part of the record, not just the reason. "A human decided" is not
        // an audit trail; "a human decided, citing this statement line" is.
        discrepancy: `Resolved manually against ${dto.evidenceRef}`,
        action: `admin_${dto.resolution.toLowerCase()}`,
        resolvedAt: new Date(),
        resolvedByAdminId: admin.id,
      },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: `txn.deemed_resolved_${dto.resolution.toLowerCase()}`,
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { evidenceRef: dto.evidenceRef, reason: dto.reason },
    })

    this.logger.warn(
      `[${this.resolveDeemed.name}] An administrator resolved a DEEMED transaction`,
      { transactionId, resolution: dto.resolution, adminId: admin.id },
    )
    return resolved
  }

  /**
   * Force a refund.
   *
   * Routed through {@link ReversalService} rather than posting entries directly, so an
   * admin-initiated refund obeys the same rules as every other: the rail leg goes first, the
   * remaining-refundable bound applies, and the operation is idempotent. An admin path that
   * bypassed those would be the one way to over-refund a transaction.
   */
  async manualRefund(
    transactionId: string,
    dto: ManualReversalDto,
    admin: { id: string },
  ) {
    const amountMinor = toMinor(dto.amountMinor)
    if (amountMinor <= 0n) {
      throw new BadRequestException('Refund amount must be greater than zero')
    }

    const reversal = await this.reversals.refund({
      transactionId,
      amountMinor,
      reason: dto.reason,
      actor: { type: ActorType.ADMIN, id: admin.id },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: 'txn.manual_refund',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: {
        reversalId: reversal.id,
        amountMinor: amountMinor.toString(),
        reason: dto.reason,
      },
    })

    this.logger.warn(`[${this.manualRefund.name}] Manual refund issued`, {
      transactionId,
      reversalId: reversal.id,
      adminId: admin.id,
    })
    return reversal
  }

  /** Force a reconciliation pass over one transaction, on demand. */
  async recheck(transactionId: string, admin: { id: string }) {
    const transaction = await this.orchestrator.load(transactionId)
    await this.reconciliation.reconcileOne(transaction)

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: 'txn.rechecked',
      entity: 'Transaction',
      entityId: transactionId,
    })
    return this.summarise(await this.orchestrator.load(transactionId))
  }

  // ── projection ────────────────────────────────────────────────────────────
  private summarise(transaction: Transaction) {
    return {
      id: transaction.id,
      userId: transaction.userId,
      type: transaction.type,
      direction: transaction.direction,
      corridor: transaction.corridor,
      rail: transaction.rail,
      provider: transaction.provider,
      status: transaction.status,
      needsAttention: needsHumanAttention(transaction.status),

      sourceCurrency: transaction.sourceCurrency,
      destCurrency: transaction.destCurrency,
      sourceAmountMinor: transaction.sourceAmount.toString(),
      destAmountMinor: transaction.destAmount.toString(),
      feeMinor: transaction.feeMinor.toString(),
      taxMinor: transaction.taxMinor.toString(),
      totalDebitMinor: transaction.totalDebitMinor.toString(),
      refundedMinor: transaction.refundedMinor.toString(),
      fxRateE8: transaction.fxRateE8?.toString() ?? null,

      // Masked even for admins. A console is the most-shared screen in an incident, and a
      // full VPA is a directly payable address — support staff never need it to do their job.
      counterparty: maskHandle(transaction.counterpartyHandle),
      counterpartyName: transaction.counterpartyName,
      purposeCode: transaction.purposeCode,

      railRef: transaction.railRef,
      utr: transaction.utr,
      railCode: transaction.railCode,
      failureReason: transaction.failureReason,

      riskScore: transaction.riskScore,
      riskFlags: transaction.riskFlags,
      statusCheckCount: transaction.statusCheckCount,
      nextPollAt: transaction.nextPollAt,

      createdAt: transaction.createdAt,
      submittedAt: transaction.submittedAt,
      completedAt: transaction.completedAt,
      updatedAt: transaction.updatedAt,
    }
  }
}
