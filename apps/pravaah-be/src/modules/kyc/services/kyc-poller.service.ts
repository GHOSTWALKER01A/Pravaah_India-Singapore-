import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { CheckStatus } from 'generated/prisma/client'

const STUCK_AFTER_MS = 30 * 60_000 // 30 minutes

/**
 * Safety net for checks that never receive their provider callback (e.g. the
 * user abandons DigiLocker). Expires long-PENDING checks so the profile can
 * settle to ACTION_REQUIRED on next re-evaluation instead of hanging forever.
 */
@Injectable()
export class KycPollerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: KycPollerService.name })
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS)
    const { count } = await this.prisma.kycCheck.updateMany({
      where: { status: CheckStatus.PENDING, updatedAt: { lt: cutoff } },
      data: { status: CheckStatus.EXPIRED },
    })
    if (count > 0) {
      this.logger.warn(`[${this.expireStuck.name}] Expired stuck checks`, {
        count,
      })
    }
  }
}
