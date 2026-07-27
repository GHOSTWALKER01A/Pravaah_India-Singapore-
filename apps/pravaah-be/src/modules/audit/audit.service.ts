import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { ActorType, Prisma } from 'generated/prisma/client'

export interface AuditEntry {
  actorType: ActorType
  actorId?: string | null
  action: string
  entity: string
  entityId?: string | null
  metadata?: Prisma.InputJsonValue
  ipAddress?: string | null
}

/**
 * Append-only audit trail. Writes must never break the request they describe,
 * so failures are logged and swallowed — the trail is best-effort observability,
 * not part of the transaction it records.
 */
@Injectable()
export class AuditService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AuditService.name })
  }

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ?? null,
          metadata: entry.metadata,
          ipAddress: entry.ipAddress ?? null,
        },
      })
    } catch (error) {
      this.logger.error(`Failed to write audit log for ${entry.action}`, {
        err: error,
      })
    }
  }
}
