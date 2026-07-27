import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { PrismaPg } from '@prisma/adapter-pg'

import { ENV } from '@/constants/environment.constants'

import { PrismaClient } from 'generated/prisma/client'

/**
 * Prisma 7 client backed by the pg driver adapter. The connection string is
 * supplied at runtime through the adapter (the datasource block no longer
 * carries a `url` in Prisma 7 — migrations read it from `prisma.config.ts`).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name)

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>(ENV.DATABASE.URL)
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not defined in environment variables')
    }

    const adapter = new PrismaPg({ connectionString: databaseUrl })
    super({ adapter })
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect()
      this.logger.log('✅ Database connected successfully')
    } catch (error) {
      this.logger.error('❌ Database connection failed', error)
      throw error
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
    this.logger.log('Database disconnected')
  }
}
