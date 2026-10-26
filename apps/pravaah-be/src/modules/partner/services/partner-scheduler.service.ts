import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ConsentReceiptService } from '@/modules/partner/services/consent-receipt.service'
import { PartnerApiKeyService } from '@/modules/partner/services/partner-api-key.service'
import { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'
import { VerificationEventsService } from '@/modules/partner/services/verification-events.service'

/**
 * M7's safety nets.
 *
 * Every job is independently guarded — a throw inside one handler must not stop
 * the others — and guarded against overlapping itself, because a slow run at
 * ~330ms per query can outlast its own interval. Each job is ALSO idempotent, so
 * two instances running the same schedule is wasteful, never harmful: webhook
 * deliveries are leased, facts are keyed, purges are conditional.
 *
 * The same caveat as every scheduler in this app: on a serverless deploy nothing
 * here runs unless an external cron calls in.
 */
@Injectable()
export class PartnerSchedulerService {
  private readonly logger: AppLogger
  private readonly running = new Set<string>()

  constructor(
    private readonly webhooks: PartnerWebhookService,
    private readonly events: VerificationEventsService,
    private readonly receipts: ConsentReceiptService,
    private readonly keys: PartnerApiKeyService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerSchedulerService.name })
  }

  /** Deliver due webhooks. Frequent, because a partner is waiting on it. */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'partner:webhooks' })
  async dispatchWebhooks(): Promise<void> {
    await this.guarded('webhooks', async () => {
      const { attempted, delivered } = await this.webhooks.dispatchDue()
      if (attempted)
        this.logger.info('[partner:webhooks] Dispatch run', {
          attempted,
          delivered,
        })
    })
  }

  /** Process handshake facts the event path missed. The guarantee behind the fast path. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'partner:reconcile' })
  async reconcile(): Promise<void> {
    await this.guarded('reconcile', async () => {
      const processed = await this.events.reconcile()
      if (processed) {
        // Non-zero means the event path dropped something — worth a warning.
        this.logger.warn('[partner:reconcile] Recovered unprocessed facts', {
          processed,
        })
      }
    })
  }

  /** Retention: redact disclosures past their consent term; retire expired keys. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'partner:retention' })
  async retention(): Promise<void> {
    await this.guarded('retention', async () => {
      const purged = await this.receipts.purgeDue()
      const expiredKeys = await this.keys.sweepExpired()
      if (purged || expiredKeys) {
        this.logger.info('[partner:retention] Retention run', {
          purged,
          expiredKeys,
        })
      }
    })
  }

  private async guarded(job: string, run: () => Promise<void>): Promise<void> {
    if (this.running.has(job)) return
    this.running.add(job)
    try {
      await run()
    } catch (error) {
      this.logger.error(`[partner:${job}] Job failed`, { err: error })
    } finally {
      this.running.delete(job)
    }
  }
}
