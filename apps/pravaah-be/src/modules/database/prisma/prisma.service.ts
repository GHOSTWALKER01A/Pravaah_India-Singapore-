import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { Pool } from 'pg'
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
  private readonly pool: Pool
  private readonly poolMax: number

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>(ENV.DATABASE.URL)
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not defined in environment variables')
    }

    const max = poolSizeFor(databaseUrl)

    const pool = new Pool({
      connectionString: databaseUrl,
      max,
      // Release idle clients promptly, so the pooler slots go back between bursts.
      idleTimeoutMillis: 10_000,
      // node-postgres waits FOREVER for a free client by default. With a capped pool
      // a starved query must fail loudly instead of hanging a cron or a request.
      connectionTimeoutMillis: 20_000,
    })

    const adapter = new PrismaPg(pool)
    super({ adapter })
    this.pool = pool
    this.poolMax = max
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect()
      this.logger.log(
        `✅ Database connected successfully (pool max ${this.poolMax})`,
      )
    } catch (error) {
      this.logger.error('❌ Database connection failed', error)
      throw error
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
    await this.pool.end()
    this.logger.log('Database disconnected')
  }
}

/**
 * The pool's ceiling. `?connection_limit=N` in DATABASE_URL wins; otherwise 10.
 *
 * NOT a performance knob — a hard budget. The Supabase SESSION-mode pooler (port 5432,
 * which this app needs — see backend-conventions) admits only `pool_size` client
 * connections per database user, 15 on this project, shared by EVERY client: this
 * process, Prisma CLI (`db push`, migrate diff), ad-hoc tsx scripts, a second
 * instance, a deployed copy. The default used to be 50, and at :00/:30 about twenty
 * cron jobs fire in the same second, many with `Promise.all` — the pool grew past 15
 * and the pooler refused the overflow with EMAXCONNSESSION, failing unrelated jobs
 * at once. With a cap, the burst queues for a few hundred milliseconds instead.
 *
 * Keep it comfortably BELOW the pooler's pool_size, never at it: at the limit, the
 * first `prisma db push` or script you run while the server is busy is the one refused.
 */
const DEFAULT_POOL_MAX = 10

export function poolSizeFor(databaseUrl: string): number {
  const raw = new URL(databaseUrl).searchParams.get('connection_limit')
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_MAX
}
