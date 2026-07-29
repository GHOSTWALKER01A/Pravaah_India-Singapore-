import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { RAIL_EVENT_RETENTION_MS } from '@/modules/payments/payments.config'
import { CollectService } from '@/modules/payments/services/collect.service'
import { FxService } from '@/modules/payments/services/fx.service'
import { IdempotencyService } from '@/modules/payments/services/idempotency.service'
import { MandateService } from '@/modules/payments/services/mandate.service'
import { RailEventService } from '@/modules/payments/services/rail-event.service'
import { ReconciliationService } from '@/modules/payments/services/reconciliation.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { TxnStatus } from 'generated/prisma/client'

/**
 * The safety nets.
 *
 * Every job here exists because something upstream can fail silently, and a payments system
 * whose only recovery path is a human noticing is a payments system that loses money at
 * night. Each is idempotent, bounded, and swallows its own errors — a scheduler that throws
 * takes the next tick down with it, and the next tick is the one holding somebody's money.
 *
 * In order of how much money each protects:
 *
 *  1. {@link reconcileDue} — asks the rail what actually happened. The late-settlement
 *     defence.
 *  2. {@link recoverStuckSagas} — re-drives transactions abandoned mid-saga by a crash.
 *  3. {@link replayRailEvents} — resolves webhooks that arrived before their transaction.
 *  4. {@link sweepUnresolved} — the slow, final pass over everything else.
 *  5. {@link verifyTrialBalance} — the alarm that says the ledger itself is wrong.
 *
 * The rest are housekeeping: expiring collects and mandates, notifying and executing AutoPay
 * debits, and clearing spent keys and quotes.
 */
@Injectable()
export class PaymentSchedulerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly railEvents: RailEventService,
    private readonly collects: CollectService,
    private readonly mandates: MandateService,
    private readonly idempotency: IdempotencyService,
    private readonly fx: FxService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentSchedulerService.name })
  }

  /**
   * Poll the rail about every transaction that is due a check.
   *
   * Every minute, but the WORK is bounded by `nextPollAt` rather than by the interval — so
   * running often costs nothing and simply means a settlement is noticed sooner. The
   * status-check budget lives on the row, which is what keeps us inside NPCI's limits no
   * matter how frequently this fires.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileDue(): Promise<void> {
    await this.guard('reconcileDue', async () => {
      const summary = await this.reconciliation.reconcileDue()
      if (summary.checked === 0) return

      const level = summary.lateSettlements > 0 ? 'error' : 'info'
      const message =
        summary.lateSettlements > 0
          ? '[reconcileDue] LATE SETTLEMENTS corrected — money that would otherwise have been lost'
          : '[reconcileDue] Reconciliation pass complete'

      if (level === 'error') this.logger.error(message, { ...summary })
      else this.logger.info(message, { ...summary })
    })
  }

  /**
   * Re-drive transactions a crash abandoned mid-saga.
   *
   * The rows this finds are the dangerous ones: VALIDATED with no reserve, or RESERVED with
   * no rail reference. In both cases money is either uncommitted or locked in suspense with
   * nothing progressing it, and nobody is watching. Re-driving is safe because every step of
   * the saga is guarded by its own precondition and the rail dedupes on our idempotency key.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStuckSagas(): Promise<void> {
    await this.guard('recoverStuckSagas', async () => {
      const stuck = await this.prisma.transaction.findMany({
        where: {
          status: { in: [TxnStatus.VALIDATED, TxnStatus.RESERVED] },
          // A grace period, so a transfer being driven RIGHT NOW by its own request is not
          // picked up and driven a second time concurrently.
          updatedAt: { lt: new Date(Date.now() - 120_000) },
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
        select: { id: true, status: true },
      })

      for (const transaction of stuck) {
        this.logger.warn(
          `[${this.recoverStuckSagas.name}] Re-driving a transfer stuck mid-saga`,
          { transactionId: transaction.id, status: transaction.status },
        )
        await this.orchestrator
          .drive(transaction.id)
          .catch((error: unknown) => {
            this.logger.error(
              `[${this.recoverStuckSagas.name}] Recovery drive failed`,
              { transactionId: transaction.id, err: error },
            )
          })
      }
    })
  }

  /** Resolve webhooks that arrived before we had persisted the rail reference. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async replayRailEvents(): Promise<void> {
    await this.guard('replayRailEvents', async () => {
      const replayed = await this.railEvents.replayUnmatched()
      if (replayed > 0) {
        this.logger.info(
          `[${this.replayRailEvents.name}] Matched rail events that had arrived early`,
          { count: replayed },
        )
      }
    })
  }

  /**
   * The statement sweep — slower, wider, final.
   *
   * Covers the rows every faster path gave up on, including DEEMED ones a human has not yet
   * looked at. Hourly, because it is the pass that catches a settlement nothing else did and
   * an extra hour of certainty is worth more than the query cost.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepUnresolved(): Promise<void> {
    await this.guard('sweepUnresolved', async () => {
      const summary = await this.reconciliation.sweepUnresolved()
      if (summary.checked > 0) {
        this.logger.info(
          `[${this.sweepUnresolved.name}] Statement sweep complete`,
          {
            ...summary,
          },
        )
      }
    })
  }

  /**
   * Check the trial balance.
   *
   * Since every posting set is validated as balanced before it is written, a non-zero result
   * cannot come from a bad posting — it means entries reached the table without passing
   * through the ledger service at all. That is the class of change that loses money quietly,
   * which is why this logs at error level and writes an audit row rather than reporting a
   * metric somebody may or may not look at.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async verifyTrialBalance(): Promise<void> {
    await this.guard('verifyTrialBalance', async () => {
      const { balanced, rows } = await this.reconciliation.verifyTrialBalance()
      if (!balanced) {
        this.logger.error(
          `[${this.verifyTrialBalance.name}] TRIAL BALANCE BROKEN — the ledger no longer nets to zero`,
          {
            rows: rows.map((row) => ({
              currency: row.currency,
              net: row.net.toString(),
            })),
          },
        )
      }
    })
  }

  /** Expire collects nobody answered, and mandates past their end date. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireStale(): Promise<void> {
    await this.guard('expireStale', async () => {
      await this.collects.expireStale()
      await this.mandates.expireStale()
    })
  }

  /**
   * Send AutoPay pre-debit notices.
   *
   * Hourly, and it must run well ahead of the debit: stamping `notifiedAt` is what UNLOCKS
   * the debit, and NPCI requires 24 hours between the two. A notice sent late does not delay
   * the customer's warning, it delays the payment — which is the correct failure direction.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async notifyMandates(): Promise<void> {
    await this.guard('notifyMandates', async () => {
      const notified = await this.mandates.notifyDue()
      if (notified > 0) {
        this.logger.info(
          `[${this.notifyMandates.name}] Pre-debit notices sent`,
          { count: notified },
        )
      }
    })
  }

  /** Execute the AutoPay debits whose notice period has elapsed. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async executeMandates(): Promise<void> {
    await this.guard('executeMandates', async () => {
      const executed = await this.mandates.executeDue()
      if (executed > 0) {
        this.logger.info(
          `[${this.executeMandates.name}] AutoPay debits executed`,
          {
            count: executed,
          },
        )
      }
    })
  }

  /**
   * Housekeeping.
   *
   * Idempotency keys and unused quotes are dropped once they can no longer be replayed;
   * rail-event payloads are kept far longer, because a chargeback can arrive months later and
   * the encrypted blob is the only primary evidence we hold.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    await this.guard('purge', async () => {
      const keys = await this.idempotency.purgeExpired()
      const quotes = await this.fx.purgeExpired()
      const events = await this.prisma.railEvent.deleteMany({
        where: {
          receivedAt: { lt: new Date(Date.now() - RAIL_EVENT_RETENTION_MS) },
        },
      })
      this.logger.info(`[${this.purge.name}] Housekeeping complete`, {
        idempotencyKeys: keys,
        fxQuotes: quotes,
        railEvents: events.count,
      })
    })
  }

  /**
   * Run a job, absorbing its failures.
   *
   * A scheduled job that throws kills the tick and, with `@nestjs/schedule`, leaves nothing
   * to notice it. The next tick is the one that might catch a late settlement, so every job
   * here fails loudly in the log and quietly to the scheduler.
   */
  private async guard(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      this.logger.error(`[${name}] Scheduled payment job failed`, {
        err: error,
      })
    }
  }
}
