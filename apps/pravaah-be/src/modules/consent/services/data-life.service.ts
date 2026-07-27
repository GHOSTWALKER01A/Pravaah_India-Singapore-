import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { ConsentStatus, FiDataStatus } from 'generated/prisma/client'

/**
 * Purpose limitation + retention enforcement. Hard-deleting FI data past its
 * data-life is a LEGAL obligation (DPDP/PDPA), not a nicety — so it runs on a
 * cron independent of any user action.
 */
@Injectable()
export class DataLifeService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DataLifeService.name })
  }

  @Cron(CronExpression.EVERY_HOUR)
  async enforceRetention(): Promise<void> {
    const now = new Date()

    // Hard-delete raw FI blobs past their data-life.
    const expiredRaw = await this.prisma.fiData.findMany({
      where: {
        status: { not: FiDataStatus.DELETED },
        dataLifeExpiresAt: { lt: now },
      },
      select: { id: true },
    })
    if (expiredRaw.length) {
      await this.prisma.fiData.updateMany({
        where: { id: { in: expiredRaw.map((x) => x.id) } },
        data: {
          status: FiDataStatus.DELETED,
          encryptedBlob: '',
          deletedAt: now,
        },
      })
    }

    // Delete expired normalised features.
    await this.prisma.fiNormalized.deleteMany({
      where: { dataLifeExpiresAt: { lt: now } },
    })

    // Expire consents whose data-retention window is over.
    await this.prisma.consent.updateMany({
      where: {
        status: ConsentStatus.ACTIVE,
        expiresAt: { lt: now },
      },
      data: { status: ConsentStatus.EXPIRED },
    })

    if (expiredRaw.length) {
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'data.retention.purged',
        entity: 'FiData',
        metadata: { count: expiredRaw.length },
      })
      this.logger.info('[enforceRetention] Purged expired FI data', {
        count: expiredRaw.length,
      })
    }
  }
}
