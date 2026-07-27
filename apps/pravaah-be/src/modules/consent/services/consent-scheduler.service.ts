import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ConsentStatus,
  DataSessionStatus,
  FetchType,
} from 'generated/prisma/client'

import { DataSessionService } from '@/modules/consent/services/data-session.service'

/**
 * Safety nets that make the pipeline resilient to missed/late notifications:
 *  - re-poll sessions stuck PENDING/PARTIAL,
 *  - expire consents never approved before their consentExpiry,
 *  - create a fresh session for due PERIODIC consents.
 */
@Injectable()
export class ConsentSchedulerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: DataSessionService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ConsentSchedulerService.name })
  }

  /** Re-poll sessions stuck PENDING/PARTIAL (notification missed/late). */
  @Cron(CronExpression.EVERY_MINUTE)
  async repollSessions(): Promise<void> {
    const stuck = await this.prisma.dataSession.findMany({
      where: {
        status: {
          in: [DataSessionStatus.PENDING, DataSessionStatus.PARTIAL],
        },
        requestedAt: { lt: new Date(Date.now() - 60_000) },
      },
      take: 50,
    })
    for (const s of stuck) {
      await this.sessions.fetchAndStore(s.id).catch((e) => {
        this.logger.warn('[repollSessions] re-poll failed', {
          sessionId: s.id,
          err: e,
        })
      })
    }
  }

  /** Expire PENDING consents not approved before their consentExpiry. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async expirePending(): Promise<void> {
    const res = await this.prisma.consent.updateMany({
      where: {
        status: ConsentStatus.PENDING,
        consentExpiry: { lt: new Date() },
      },
      data: { status: ConsentStatus.EXPIRED },
    })
    if (res.count) {
      this.logger.info('[expirePending] Expired stale pending consents', {
        count: res.count,
      })
    }
  }

  /** PERIODIC consents: create a fresh data session on schedule. */
  @Cron(CronExpression.EVERY_HOUR)
  async periodicFetch(): Promise<void> {
    const due = await this.prisma.consent.findMany({
      where: {
        status: ConsentStatus.ACTIVE,
        fetchType: FetchType.PERIODIC,
      },
    })
    for (const c of due) {
      // (A production impl also respects frequencyUnit/Value + last-fetch time;
      //  session reuse in createSession keeps this idempotent within a window.)
      await this.sessions.createSession(c.id).catch(() => void 0)
    }
  }
}
