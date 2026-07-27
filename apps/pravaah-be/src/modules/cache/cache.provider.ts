import { Logger, Provider } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import Redis, { RedisOptions } from 'ioredis'

import { ENV } from '@/constants/environment.constants'

export const CACHE_CLIENT = 'CACHE_CLIENT'

/**
 * Shared Redis/Valkey connection (ioredis). Lazy-connects and queues commands
 * while connecting, so the app boots even if the cache is briefly unavailable.
 */
export const CacheProvider: Provider = {
  provide: CACHE_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('CacheProvider')

    const cacheUrl = configService.get<string>(ENV.CACHE.URL)
    const cacheHost = configService.get<string>(ENV.CACHE.HOST, 'localhost')
    const cachePort = configService.get<number>(ENV.CACHE.PORT, 6379)
    const cachePassword = configService.get<string>(ENV.CACHE.PASSWORD)
    const cacheDb = configService.get<number>(ENV.CACHE.DB, 0)
    const cacheTlsEnabled =
      configService.get<string>(ENV.CACHE.TLS_ENABLED, 'false') === 'true'

    const options: RedisOptions = {
      host: cacheHost,
      port: cachePort,
      password: cachePassword,
      db: cacheDb,
      retryStrategy: (times: number): number | null => {
        if (times > 10) {
          logger.error('Cache connection failed after 10 retries')
          return null
        }
        const delay = Math.min(times * 50, 2000)
        logger.warn(`Cache reconnecting in ${delay}ms (attempt ${times})`)
        return delay
      },
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      enableOfflineQueue: true,
      connectTimeout: 10000,
      keepAlive: 30000,
      ...(cacheTlsEnabled && { tls: {} }),
    }

    const client = cacheUrl ? new Redis(cacheUrl, options) : new Redis(options)

    client.on('connect', () => logger.log('Cache client connecting...'))
    client.on('ready', () => logger.log('Cache client ready!'))
    client.on('error', (err: Error) =>
      logger.error(`Cache client error: ${err.message}`, err.stack),
    )
    client.on('close', () => logger.warn('Cache client connection closed'))
    client.on('reconnecting', (delay: number) =>
      logger.log(`Cache client reconnecting in ${delay}ms`),
    )

    logger.log('Cache client initialized successfully!')
    return client
  },
}
