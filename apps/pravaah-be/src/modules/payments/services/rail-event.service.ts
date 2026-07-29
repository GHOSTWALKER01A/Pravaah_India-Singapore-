import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { RAIL_EVENT_MAX_REPLAY_ATTEMPTS } from '@/modules/payments/payments.config'
import type { RailWebhookEvent } from '@/modules/payments/providers/payment.provider'
import { CollectService } from '@/modules/payments/services/collect.service'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import { MandateService } from '@/modules/payments/services/mandate.service'
import { ReconciliationService } from '@/modules/payments/services/reconciliation.service'
import { ReversalService } from '@/modules/payments/services/reversal.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  RailEventStatus,
  ReversalStatus,
  TxnDirection,
  type RailEvent,
} from 'generated/prisma/client'

export type RailEventOutcome =
  'processed' | 'duplicate' | 'unmatched' | 'ignored'

/**
 * Inbound rail events — webhooks.
 *
 * A webhook is the fastest and least trustworthy of the three reconciliation inputs. Every
 * one of the following happens on a real rail, and each is handled explicitly rather than
 * assumed away:
 *
 *  - **Duplicates.** The same event delivered twice, or five times. Defended by the unique
 *    index on `(provider, eventId)` — the SECOND insert fails, which is the answer rather
 *    than an error.
 *  - **Out-of-order delivery.** A SUCCESS arriving before the PENDING that preceded it. The
 *    state machine refuses illegal transitions, so an old event cannot un-settle a
 *    transaction.
 *  - **Arrival BEFORE we knew the rail reference.** More common than anyone expects: the
 *    rail can call us back faster than our own commit of its HTTP response. Such an event is
 *    stored UNMATCHED and REPLAYED once the reference exists — dropping it as "unknown
 *    transaction" would discard the settlement notice for real money.
 *  - **Events for things we never sent.** Ignored, recorded, and left for a human. Acting on
 *    an unrecognised reference would be acting on somebody else's payment.
 *
 * The raw payload is stored field-encrypted and kept for over a year, because a chargeback
 * can arrive months later and is argued from the exact bytes the rail sent.
 */
@Injectable()
export class RailEventService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly reversals: ReversalService,
    private readonly collects: CollectService,
    private readonly mandates: MandateService,
    private readonly reconciliation: ReconciliationService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: RailEventService.name })
  }

  /**
   * Record and process one event.
   *
   * The record is written FIRST, and its unique index is what makes the whole path
   * idempotent. Processing first and recording afterwards would leave a window in which a
   * duplicate delivery gets processed twice — and for a settlement event, twice means a
   * beneficiary credited twice.
   */
  async ingest(params: {
    provider: string
    rawBody: string
    signatureVerified: boolean
    event: RailWebhookEvent
  }): Promise<{ outcome: RailEventOutcome; railEventId: string | null }> {
    const { provider, rawBody, signatureVerified, event } = params

    let record: RailEvent
    try {
      record = await this.prisma.railEvent.create({
        data: {
          provider,
          eventId: event.eventId,
          railRef: event.railRef ?? null,
          utr: event.utr ?? null,
          kind: event.kind,
          status: RailEventStatus.RECEIVED,
          // Encrypted at rest: a rail payload carries a payee's name, address and amount.
          payloadEnc: encryptField(rawBody),
          signatureVerified,
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        /**
         * Already seen. The single most important line in this file.
         *
         * Returning early — rather than reprocessing — is what stops a rail that retries
         * its callback from settling the same transaction twice.
         */
        this.logger.info(`[${this.ingest.name}] Duplicate rail event ignored`, {
          provider,
          eventId: event.eventId,
        })
        return { outcome: 'duplicate', railEventId: null }
      }
      throw error
    }

    const outcome = await this.process(record, event)
    return { outcome, railEventId: record.id }
  }

  /**
   * Act on an event.
   *
   * All settlement decisions delegate to `applyRailOutcome`, which is the single place a
   * transaction's outcome is decided. A webhook handler with its own copy of that logic
   * would eventually disagree with the reconciler, and the disagreement would be a double
   * credit.
   */
  private async process(
    record: RailEvent,
    event: RailWebhookEvent,
  ): Promise<RailEventOutcome> {
    try {
      switch (event.kind) {
        case 'collect':
          return await this.processCollect(record, event)
        case 'mandate':
          return await this.processMandate(record, event)
        case 'refund':
          return await this.processRefund(record, event)
        default:
          return await this.processPayment(record, event)
      }
    } catch (error) {
      await this.prisma.railEvent
        .update({
          where: { id: record.id },
          data: {
            attempts: { increment: 1 },
            lastError:
              error instanceof Error
                ? error.message.slice(0, 500)
                : 'Unknown failure',
          },
        })
        .catch(() => void 0)

      this.logger.error(`[${this.process.name}] Rail event processing failed`, {
        railEventId: record.id,
        kind: event.kind,
        err: error,
      })
      // Rethrown so the webhook controller answers non-2xx and the rail retries — a
      // failure we swallowed would be a settlement notice we silently dropped.
      throw error
    }
  }

  private async processPayment(
    record: RailEvent,
    event: RailWebhookEvent,
  ): Promise<RailEventOutcome> {
    const transaction = await this.findTransaction(event)

    if (!transaction) {
      /**
       * We do not know this reference. Two very different reasons.
       *
       * Either the event beat our own commit of the rail's response (a race we win by
       * replaying later), or it is genuinely not ours. Both are stored UNMATCHED rather
       * than discarded: the replay sweep will resolve the first, and the second becomes a
       * visible row for a human instead of a dropped notification.
       */
      await this.markUnmatched(record)
      this.logger.warn(
        `[${this.processPayment.name}] Rail event has no matching transaction yet — will replay`,
        { railEventId: record.id, railRef: event.railRef },
      )
      return 'unmatched'
    }

    await this.reconciliation.recordWebhook({
      transaction,
      railStatus: event.status,
      railCode: event.railCode,
      railAmountMinor: event.amountMinor,
    })

    // An inbound transaction (a topup, or an approved collect) is a CREDIT, not a payout —
    // there is no reserve to settle out of, so it takes the inbound path.
    if (transaction.direction === TxnDirection.INBOUND) {
      if (event.status === 'SUCCESS') {
        await this.orchestrator.settleInbound(transaction.id, {
          status: 'SUCCESS',
          railCode: event.railCode,
          utr: event.utr,
        })
      } else if (event.status === 'FAILED') {
        await this.orchestrator.markFailed(
          transaction.id,
          'The payer’s bank could not complete this',
          event.railCode ?? null,
        )
      }
    } else {
      await this.orchestrator.applyRailOutcome(transaction.id, {
        status: event.status,
        railCode: event.railCode,
        utr: event.utr,
        amountMinor: event.amountMinor,
      })
    }

    await this.markMatched(record, transaction.id)
    return 'processed'
  }

  private async processCollect(
    record: RailEvent,
    event: RailWebhookEvent,
  ): Promise<RailEventOutcome> {
    const decision =
      event.status === 'SUCCESS'
        ? 'APPROVED'
        : event.railCode === 'U69'
          ? 'EXPIRED'
          : event.railCode === 'ZA'
            ? 'DECLINED'
            : 'FAILED'

    const collect = await this.collects.applyRailDecision({
      railRef: event.railRef ?? event.objectRef,
      decision,
      railCode: event.railCode,
      utr: event.utr,
      reason: event.railCode ? `Rail code ${event.railCode}` : null,
    })

    if (!collect) {
      await this.markUnmatched(record)
      return 'unmatched'
    }
    await this.markMatched(record, collect.transactionId)
    return 'processed'
  }

  private async processMandate(
    record: RailEvent,
    event: RailWebhookEvent,
  ): Promise<RailEventOutcome> {
    const mandate = await this.mandates.applyRailDecision({
      railRef: event.railRef,
      approved: event.status === 'SUCCESS',
      umn: event.objectRef,
      reason: event.railCode ? `Rail code ${event.railCode}` : null,
    })

    if (!mandate) {
      await this.markUnmatched(record)
      return 'unmatched'
    }
    await this.markMatched(record, null)
    return 'processed'
  }

  /**
   * A refund the rail has confirmed.
   *
   * This is the event that completes a PENDING reversal — the point at which our ledger is
   * finally allowed to say the money came back. Until it arrives, the reversal stays PENDING
   * and the wallet is not credited, because crediting on a refund still in flight would
   * leave the user with money nobody funded if the rail's refund later failed.
   */
  private async processRefund(
    record: RailEvent,
    event: RailWebhookEvent,
  ): Promise<RailEventOutcome> {
    const reversal = event.railRef
      ? await this.prisma.reversal.findFirst({
          where: { railRef: event.railRef, status: ReversalStatus.PENDING },
        })
      : null

    if (!reversal) {
      await this.markUnmatched(record)
      return 'unmatched'
    }

    if (event.status === 'SUCCESS') {
      await this.reversals.completeReversal(reversal.id)
    } else if (event.status === 'FAILED') {
      await this.prisma.reversal.update({
        where: { id: reversal.id },
        data: {
          status: ReversalStatus.FAILED,
          failureReason: `Rail declined the refund (${event.railCode ?? 'no code'})`,
        },
      })
      this.logger.error(
        `[${this.processRefund.name}] The rail declined a refund — needs a human`,
        { reversalId: reversal.id, railCode: event.railCode },
      )
    }

    await this.markMatched(record, reversal.transactionId)
    return 'processed'
  }

  /**
   * Replay events that arrived before their transaction existed.
   *
   * The other half of the race described on {@link processPayment}. Each attempt is counted,
   * and after the budget is exhausted the event is IGNORED — but visibly, as a row with a
   * status, not by being forgotten.
   */
  async replayUnmatched(limit = 100): Promise<number> {
    const pending = await this.prisma.railEvent.findMany({
      where: {
        status: RailEventStatus.UNMATCHED,
        attempts: { lt: RAIL_EVENT_MAX_REPLAY_ATTEMPTS },
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    })

    let replayed = 0
    for (const record of pending) {
      const transaction = await this.findTransaction({
        railRef: record.railRef ?? undefined,
        utr: record.utr ?? undefined,
      })

      if (!transaction) {
        await this.prisma.railEvent.update({
          where: { id: record.id },
          data: { attempts: { increment: 1 } },
        })
        continue
      }

      /**
       * The reference now resolves.
       *
       * The event is re-run through reconciliation rather than replayed from the stored
       * payload: by now the rail's CURRENT answer is more authoritative than a webhook we
       * could not match minutes ago, and asking is cheap compared with acting on stale
       * information about somebody's money.
       */
      try {
        await this.reconciliation.reconcileOne(transaction)
        await this.markMatched(record, transaction.id)
        replayed += 1
      } catch (error) {
        await this.prisma.railEvent.update({
          where: { id: record.id },
          data: {
            attempts: { increment: 1 },
            lastError:
              error instanceof Error ? error.message.slice(0, 500) : 'unknown',
          },
        })
      }
    }

    // Out of attempts. Marked IGNORED so it leaves the replay queue but stays queryable —
    // an event nobody could match is exactly what an operator needs to see.
    const exhausted = await this.prisma.railEvent.updateMany({
      where: {
        status: RailEventStatus.UNMATCHED,
        attempts: { gte: RAIL_EVENT_MAX_REPLAY_ATTEMPTS },
      },
      data: { status: RailEventStatus.IGNORED, processedAt: new Date() },
    })
    if (exhausted.count > 0) {
      this.logger.error(
        `[${this.replayUnmatched.name}] Rail events could not be matched and were abandoned`,
        { count: exhausted.count },
      )
    }

    return replayed
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * Find the transaction an event refers to.
   *
   * By `railRef` first, then by `utr`. The fallback earns its place: some rails omit their
   * own reference on a settlement callback and send only the UTR, and a lookup that gave up
   * without trying it would leave real settlements unmatched.
   */
  private async findTransaction(event: { railRef?: string; utr?: string }) {
    if (event.railRef) {
      const byRef = await this.prisma.transaction.findUnique({
        where: { railRef: event.railRef },
      })
      if (byRef) return byRef
    }
    if (event.utr) {
      return this.prisma.transaction.findUnique({ where: { utr: event.utr } })
    }
    return null
  }

  private async markMatched(
    record: RailEvent,
    transactionId: string | null,
  ): Promise<void> {
    await this.prisma.railEvent
      .update({
        where: { id: record.id },
        data: {
          status: RailEventStatus.MATCHED,
          transactionId,
          processedAt: new Date(),
        },
      })
      .catch(() => void 0)
  }

  private async markUnmatched(record: RailEvent): Promise<void> {
    await this.prisma.railEvent
      .update({
        where: { id: record.id },
        data: {
          status: RailEventStatus.UNMATCHED,
          attempts: { increment: 1 },
        },
      })
      .catch(() => void 0)
  }
}
