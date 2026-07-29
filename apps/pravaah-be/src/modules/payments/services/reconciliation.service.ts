import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import {
  hasFundsInSuspense,
  isSettled,
  needsReconciliation,
  nextPollAt,
} from '@/modules/payments/payments.state'
import { classifyRailCode } from '@/modules/payments/providers/upi-response-codes'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { LedgerService } from '@/modules/payments/services/ledger.service'
import { ReversalService } from '@/modules/payments/services/reversal.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  ReconSource,
  ReconStatus,
  TxnStatus,
  type Transaction,
} from 'generated/prisma/client'

export interface ReconciliationSummary {
  checked: number
  matched: number
  corrected: number
  lateSettlements: number
  refunded: number
  deemed: number
  skipped: number
}

/**
 * Reconciliation — the single most important background process in the product.
 *
 * Everything else in M4 protects against OUR mistakes: idempotency stops a duplicate
 * request, the ledger stops an unbalanced posting, the row lock stops a double spend.
 * This protects against the rail disagreeing with us, which is the failure nothing
 * internal can catch.
 *
 * The case it exists for, stated plainly: **we timed out, marked a transfer FAILED, and
 * the rail settled it anyway.** The sender has their money back, the beneficiary has the
 * payment, and nobody funded it. It is the most expensive single event in payments, it
 * happens on every real rail, and the only defence is to keep asking and be willing to
 * correct ourselves. That is why `needsReconciliation` includes FAILED — the obvious
 * reading ("it failed, we're done") is precisely what loses the money.
 *
 * Three inputs, in descending order of speed and ascending order of authority:
 *
 *  - **Webhooks** — fastest, least trustworthy (can be missed, duplicated, or arrive out
 *    of order). Handled by the webhook controller, recorded here.
 *  - **Status polls** — bounded by NPCI's check budget, so used sparingly and with backoff.
 *  - **Statement sweeps** — slowest and final. What the rail's own record says happened.
 *
 * Every check is recorded, append-only. "The rail said PENDING at 10:00, PENDING at
 * 10:02, and SUCCESS at 10:05 after we had already given up" is the entire story of a
 * late-settlement incident, and an upsert would leave only its last frame.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderFactory,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly reversals: ReversalService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ReconciliationService.name })
  }

  /**
   * Poll every transaction that is due a status check.
   *
   * Selection is driven by `nextPollAt` rather than by an age window, which is what keeps
   * us inside NPCI's status-check budget. A cron that simply re-asked about everything
   * older than 90 seconds would query the same stuck transaction sixty times an hour and
   * get the PSP throttled — turning one stuck transfer into every transfer stuck.
   */
  async reconcileDue(limit = 100): Promise<ReconciliationSummary> {
    const now = new Date()
    const due = await this.prisma.transaction.findMany({
      where: {
        status: {
          in: [
            TxnStatus.SUBMITTED,
            TxnStatus.PENDING,
            // FAILED is here on purpose. See the class comment.
            TxnStatus.FAILED,
            TxnStatus.RESERVED,
          ],
        },
        nextPollAt: { not: null, lte: now },
      },
      orderBy: { nextPollAt: 'asc' },
      take: limit,
    })

    const summary: ReconciliationSummary = {
      checked: 0,
      matched: 0,
      corrected: 0,
      lateSettlements: 0,
      refunded: 0,
      deemed: 0,
      skipped: 0,
    }

    for (const transaction of due) {
      try {
        await this.reconcileOne(transaction, summary)
      } catch (error) {
        // One bad row must not stop the sweep — the next transaction in the list may be
        // the one holding somebody's money.
        this.logger.error(
          `[${this.reconcileDue.name}] Reconciliation failed for one transaction`,
          { transactionId: transaction.id, err: error },
        )
      }
    }

    return summary
  }

  /**
   * Reconcile one transaction against the rail.
   *
   * The correction logic is short because all of it delegates to
   * `applyRailOutcome` — the single place a settlement decision is made. Four callers
   * with four copies of "when may this settle?" would eventually disagree, and the
   * disagreement would be a double credit.
   */
  async reconcileOne(
    transaction: Transaction,
    summary?: ReconciliationSummary,
  ): Promise<void> {
    if (summary) summary.checked++

    /**
     * A RESERVED transaction with no rail reference: the submit never got an answer.
     *
     * Re-submitted rather than polled, because there is nothing to poll — and the rail
     * treats it as the same payment thanks to the idempotency key. This is the recovery
     * path for a crash (or a timeout) between the reserve and the rail's response.
     */
    if (!transaction.railRef) {
      if (transaction.status === TxnStatus.RESERVED) {
        await this.retrySubmit(transaction, summary)
        return
      }
      if (summary) summary.skipped++
      await this.clearPoll(transaction.id)
      return
    }

    if (!needsReconciliation(transaction.status)) {
      if (summary) summary.skipped++
      await this.clearPoll(transaction.id)
      return
    }

    const provider = this.providers.byName(transaction.provider)
    const result = await provider.status(transaction.railRef, transaction.id)

    if (!result.ok) {
      /**
       * The rail is unreachable. Nothing changes, and NO check is spent.
       *
       * "I could not ask" is not "I asked and got no answer", and burning a status-check
       * from the budget for a failed HTTP call would push a transaction to DEEMED because
       * of our own network rather than the rail's silence.
       */
      this.logger.warn(
        `[${this.reconcileOne.name}] Rail unreachable — will retry`,
        { transactionId: transaction.id, reason: result.error.code },
      )
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { nextPollAt: nextPollAt(transaction.statusCheckCount) },
      })
      return
    }

    const railStatus = result.value.status
    const classification = classifyRailCode(result.value.railCode)
    const matched = this.statusesAgree(transaction.status, railStatus)

    await this.record({
      transaction,
      source: ReconSource.POLL,
      railStatus,
      railCode: result.value.railCode ?? null,
      railAmountMinor: result.value.amountMinor ?? null,
      status: matched ? ReconStatus.MATCHED : ReconStatus.MISMATCH,
      discrepancy: matched
        ? null
        : `Rail says ${railStatus}, we say ${transaction.status}`,
    })

    // The check is spent whether or not it changed anything — the rail answered.
    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        statusCheckCount: { increment: 1 },
        nextPollAt: nextPollAt(transaction.statusCheckCount + 1),
      },
    })

    if (matched) {
      if (summary) summary.matched++
      // A matched PENDING that is out of budget and out of time becomes DEEMED.
      await this.deemIfExhausted(transaction.id, summary)
      return
    }

    // ── the corrections ─────────────────────────────────────────────────────
    if (railStatus === 'SUCCESS' && !isSettled(transaction.status)) {
      /**
       * THE case. The rail settled something we did not think had settled.
       *
       * Includes the "we already marked it FAILED and refunded the sender" variant, which
       * `settle` books as a RECOVERY against a receivable rather than as a normal payout.
       */
      const wasGivenUp =
        transaction.status === TxnStatus.FAILED ||
        transaction.status === TxnStatus.REVERSED ||
        transaction.status === TxnStatus.REFUNDED

      this.logger.error(
        `[${this.reconcileOne.name}] LATE SETTLEMENT — the rail settled a transaction we had ${wasGivenUp ? 'given up on' : 'not confirmed'}`,
        { transactionId: transaction.id, previousStatus: transaction.status },
      )

      await this.orchestrator.applyRailOutcome(transaction.id, {
        status: 'SUCCESS',
        railCode: result.value.railCode,
        utr: result.value.utr,
        amountMinor: result.value.amountMinor,
      })
      await this.resolveRecord(transaction.id, 'settled_from_rail_success')

      if (summary) {
        summary.corrected++
        if (wasGivenUp) summary.lateSettlements++
      }
      return
    }

    if (railStatus === 'FAILED' && classification.outcome !== 'DEEMED') {
      if (hasFundsInSuspense(transaction.status)) {
        // Money is still ours to give back — release the reserve.
        await this.orchestrator.applyRailOutcome(transaction.id, {
          status: 'FAILED',
          railCode: result.value.railCode,
        })
        await this.resolveRecord(transaction.id, 'reserve_released')
        if (summary) summary.corrected++
        return
      }

      if (isSettled(transaction.status)) {
        /**
         * We settled it; the rail now says it failed.
         *
         * The money is coming back off the rail, so a refund is raised with
         * `railAlreadyReturned` — asking the rail to reverse a payment it has already
         * reversed would either be rejected or return the funds twice.
         */
        this.logger.error(
          `[${this.reconcileOne.name}] Rail reports FAILED for a settled transaction — refunding the sender`,
          { transactionId: transaction.id },
        )
        await this.reversals
          .refundRailFailure(transaction.id, 'rail_reported_failure')
          .catch((error: unknown) => {
            this.logger.error(
              `[${this.reconcileOne.name}] Automatic refund failed — escalating`,
              { transactionId: transaction.id, err: error },
            )
          })
        await this.resolveRecord(transaction.id, 'refunded_rail_failure')
        if (summary) summary.refunded++
        return
      }
    }

    // Still pending as far as the rail is concerned, or a DEEMED-classified code.
    await this.deemIfExhausted(transaction.id, summary)
  }

  /**
   * Record a webhook's claim, so it appears in the same audit trail as a poll.
   *
   * The webhook controller acts on the event immediately; this exists so that "how did we
   * learn this?" is answerable months later. A settlement whose only trace is an
   * application log line is a settlement nobody can reconstruct during a dispute.
   */
  async recordWebhook(params: {
    transaction: Transaction
    railStatus: 'SUCCESS' | 'FAILED' | 'PENDING'
    railCode?: string | null
    railAmountMinor?: bigint | null
  }): Promise<void> {
    const matched = this.statusesAgree(
      params.transaction.status,
      params.railStatus,
    )
    await this.record({
      transaction: params.transaction,
      source: ReconSource.WEBHOOK,
      railStatus: params.railStatus,
      railCode: params.railCode ?? null,
      railAmountMinor: params.railAmountMinor ?? null,
      status: matched ? ReconStatus.MATCHED : ReconStatus.MISMATCH,
      discrepancy: matched
        ? null
        : `Webhook says ${params.railStatus}, we say ${params.transaction.status}`,
    })
  }

  /**
   * Re-submit a transaction whose reserve is held but which has no rail reference.
   *
   * Safe because the rail dedupes on our idempotency key: if the original request DID
   * reach it, this returns the same reference rather than creating a second payment. That
   * property is the entire reason the key is passed to the rail at all.
   */
  private async retrySubmit(
    transaction: Transaction,
    summary?: ReconciliationSummary,
  ): Promise<void> {
    if (this.orchestrator.shouldBeDeemed(transaction)) {
      await this.orchestrator.markDeemed(
        transaction.id,
        transaction.railCode,
        'The payment network never confirmed whether this was received.',
      )
      if (summary) summary.deemed++
      return
    }

    this.logger.warn(
      `[${this.retrySubmit.name}] Re-submitting a transfer the rail never acknowledged`,
      { transactionId: transaction.id, attempt: transaction.statusCheckCount },
    )
    await this.orchestrator.drive(transaction.id).catch((error: unknown) => {
      this.logger.error(`[${this.retrySubmit.name}] Re-submit failed`, {
        transactionId: transaction.id,
        err: error,
      })
    })
    if (summary) summary.corrected++
  }

  private async deemIfExhausted(
    transactionId: string,
    summary?: ReconciliationSummary,
  ): Promise<void> {
    const transaction = await this.orchestrator.load(transactionId)
    if (!this.orchestrator.shouldBeDeemed(transaction)) return

    await this.orchestrator.markDeemed(
      transactionId,
      transaction.railCode,
      'The payment network did not confirm this within the status-check window.',
    )
    await this.record({
      transaction,
      source: ReconSource.POLL,
      railStatus: 'PENDING',
      railCode: transaction.railCode,
      railAmountMinor: null,
      status: ReconStatus.ESCALATED,
      discrepancy: 'Status-check budget exhausted with no final answer',
      action: 'deemed',
    })
    if (summary) summary.deemed++
  }

  // ── the daily statement sweep ─────────────────────────────────────────────
  /**
   * The final authority: sweep everything still unresolved and ask the rail once more.
   *
   * Deliberately not budget-limited the same way, because this runs rarely and covers the
   * rows that fell through every other path — including DEEMED ones a human has not yet
   * looked at. In production this is where a settlement FILE would be parsed rather than
   * the status API polled; the correction logic is identical either way, which is why it
   * reuses `reconcileOne`.
   */
  async sweepUnresolved(limit = 200): Promise<ReconciliationSummary> {
    const stale = await this.prisma.transaction.findMany({
      where: {
        status: {
          in: [
            TxnStatus.SUBMITTED,
            TxnStatus.PENDING,
            TxnStatus.DEEMED,
            TxnStatus.FAILED,
          ],
        },
        railRef: { not: null },
        updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1_000) },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })

    const summary: ReconciliationSummary = {
      checked: 0,
      matched: 0,
      corrected: 0,
      lateSettlements: 0,
      refunded: 0,
      deemed: 0,
      skipped: 0,
    }

    for (const transaction of stale) {
      // A DEEMED row is polled again here even though `needsReconciliation` allows it and
      // `nextPollAt` is null: the sweep is exactly the mechanism that resolves a
      // transaction the fast path gave up on.
      try {
        await this.reconcileOne(transaction, summary)
      } catch (error) {
        this.logger.error(
          `[${this.sweepUnresolved.name}] Sweep failed for one row`,
          {
            transactionId: transaction.id,
            err: error,
          },
        )
      }
    }

    if (summary.lateSettlements > 0) {
      this.logger.error(
        `[${this.sweepUnresolved.name}] The statement sweep found late settlements`,
        { count: summary.lateSettlements },
      )
    }
    return summary
  }

  /**
   * Verify the trial balance and raise the alarm if it is broken.
   *
   * Since every posting set is validated as balanced, a non-zero trial balance cannot
   * come from a bad posting — it means entries reached the table WITHOUT passing through
   * `LedgerService.post`: a raw SQL fix, a migration, a direct database edit. That is
   * exactly the class of change that loses money quietly, which is why this is the one
   * number an operator should be paged about.
   */
  async verifyTrialBalance(): Promise<{
    balanced: boolean
    rows: Awaited<ReturnType<LedgerService['trialBalance']>>
  }> {
    const rows = await this.ledger.trialBalance()
    const balanced = rows.every((row) => row.balanced)

    if (!balanced) {
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'ledger.trial_balance_broken',
        entity: 'LedgerEntry',
        metadata: {
          rows: rows.map((row) => ({
            currency: row.currency,
            net: row.net.toString(),
          })),
        },
      })
    }
    return { balanced, rows }
  }

  // ── record keeping ────────────────────────────────────────────────────────
  private async record(params: {
    transaction: Transaction
    source: ReconSource
    railStatus: string
    railCode: string | null
    railAmountMinor: bigint | null
    status: ReconStatus
    discrepancy: string | null
    action?: string
  }): Promise<void> {
    await this.prisma.reconciliationRecord
      .create({
        data: {
          transactionId: params.transaction.id,
          source: params.source,
          railStatus: params.railStatus,
          railCode: params.railCode,
          railAmountMinor: params.railAmountMinor,
          internalStatus: params.transaction.status,
          status: params.status,
          discrepancy: params.discrepancy,
          action: params.action ?? null,
        },
      })
      .catch((error: unknown) => {
        // Best-effort. Failing to write the audit row must never abort the correction it
        // was describing — the money matters more than the note about the money.
        this.logger.error(
          `[${this.record.name}] Could not record a reconciliation`,
          {
            transactionId: params.transaction.id,
            err: error,
          },
        )
      })
  }

  /** Close out the open mismatches for a transaction we have now corrected. */
  private async resolveRecord(
    transactionId: string,
    action: string,
  ): Promise<void> {
    await this.prisma.reconciliationRecord
      .updateMany({
        where: { transactionId, status: ReconStatus.MISMATCH },
        data: { status: ReconStatus.RESOLVED, action, resolvedAt: new Date() },
      })
      .catch(() => void 0)
  }

  private async clearPoll(transactionId: string): Promise<void> {
    await this.prisma.transaction
      .update({ where: { id: transactionId }, data: { nextPollAt: null } })
      .catch(() => void 0)
  }

  /**
   * Whether our status and the rail's mean the same thing.
   *
   * A mapping, not a string comparison: the rail has three states and we have fourteen.
   * `SUBMITTED` and `PENDING` both mean "the rail has it and is working on it", so a rail
   * answer of PENDING against either is agreement, not a discrepancy to correct.
   */
  private statusesAgree(
    internal: TxnStatus,
    railStatus: 'SUCCESS' | 'FAILED' | 'PENDING',
  ): boolean {
    switch (railStatus) {
      case 'SUCCESS':
        return isSettled(internal)
      case 'FAILED':
        return (
          internal === TxnStatus.FAILED ||
          internal === TxnStatus.REVERSED ||
          internal === TxnStatus.EXPIRED
        )
      case 'PENDING':
        return (
          internal === TxnStatus.SUBMITTED ||
          internal === TxnStatus.PENDING ||
          internal === TxnStatus.RESERVED ||
          // DEEMED IS our representation of "the rail has not answered", so a PENDING
          // rail response is consistent with it rather than a mismatch to act on.
          internal === TxnStatus.DEEMED
        )
    }
  }
}
