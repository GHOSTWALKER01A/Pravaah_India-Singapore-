import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import Redis from 'ioredis'
import { Subject, type Observable } from 'rxjs'

import { CACHE_CLIENT } from '@/modules/cache/cache.provider'

export interface ReviewEvent {
  type: 'OPENED' | 'CLAIMED' | 'RESOLVED'
  caseId: string
  status?: string
  at: string
}

/** One Redis channel carries every review-queue change to all API instances. */
const CHANNEL = 'pravaah:review:events'

@Injectable()
export class ReviewEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: AppLogger
  private subscriber: Redis | null = null
  private readonly events$ = new Subject<ReviewEvent>()

  constructor(
    @Inject(CACHE_CLIENT) private readonly redis: Redis,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ReviewEventsService.name })
  }

  async onModuleInit(): Promise<void> {
    // A subscribed connection can't run normal commands, so use a duplicate.
    this.subscriber = this.redis.duplicate()
    this.subscriber.on('error', (e: Error) =>
      this.logger.error('Review events subscriber error', { err: e }),
    )
    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        this.events$.next(JSON.parse(message) as ReviewEvent)
      } catch {
        this.logger.warn('Dropped a malformed review event')
      }
    })
    try {
      await this.subscriber.subscribe(CHANNEL)
      this.logger.info('Subscribed to the review-events channel')
    } catch (e) {
      this.logger.error('Failed to subscribe to review events', { err: e })
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.events$.complete()
    if (this.subscriber) {
      try {
        await this.subscriber.quit()
      } catch {
        // best-effort teardown
      }
    }
  }

  /** Fire-and-forget publish; a cache outage must never break the write path. */
  async publish(event: Omit<ReviewEvent, 'at'>): Promise<void> {
    try {
      await this.redis.publish(
        CHANNEL,
        JSON.stringify({ ...event, at: new Date().toISOString() }),
      )
    } catch (e) {
      this.logger.error('Failed to publish a review event', { err: e })
    }
  }

  /** Live stream of review events for SSE consumers. */
  stream(): Observable<ReviewEvent> {
    return this.events$.asObservable()
  }
}
