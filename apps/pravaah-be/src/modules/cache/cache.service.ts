import { Inject, Injectable, Logger } from '@nestjs/common'

import Redis from 'ioredis'

import { ICacheService } from '@/modules/cache/cache.interface'
import { CACHE_CLIENT } from '@/modules/cache/cache.provider'

export interface CacheOptions {
  ttl?: number
  keyPrefix?: string
}

@Injectable()
export class CacheService implements ICacheService {
  private readonly logger = new Logger(CacheService.name)
  private readonly defaultTtl: number = 300
  private readonly keyPrefix: string = 'pravaah:'

  constructor(@Inject(CACHE_CLIENT) private readonly cache: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.cache.get(this.buildKey(key))
      if (value === null) return null
      return JSON.parse(value) as T
    } catch (error) {
      this.logger.error(`Cache get error for key: ${key}`, error)
      return null
    }
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value)
      const expiration = ttl ?? this.defaultTtl
      await this.cache.setex(this.buildKey(key), expiration, serialized)
    } catch (error) {
      // Cache failures must never break the request path.
      this.logger.error(`Cache set error for key: ${key}`, error)
    }
  }

  async del(key: string): Promise<boolean> {
    try {
      const result = await this.cache.del(this.buildKey(key))
      return result > 0
    } catch (error) {
      this.logger.error(`Cache delete error for key: ${key}`, error)
      return false
    }
  }

  async delMultiple(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0
    try {
      return await this.cache.del(...keys.map((k) => this.buildKey(k)))
    } catch (error) {
      this.logger.error('Cache delete multiple error', error)
      return 0
    }
  }

  async delPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.cache.keys(this.buildKey(pattern))
      if (keys.length === 0) return 0
      const pipeline = this.cache.pipeline()
      keys.forEach((key) => pipeline.del(key))
      await pipeline.exec()
      return keys.length
    } catch (error) {
      this.logger.error(`Cache delete pattern error: ${pattern}`, error)
      return 0
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.cache.exists(this.buildKey(key))) === 1
    } catch (error) {
      this.logger.error(`Cache exists check error for key: ${key}`, error)
      return false
    }
  }

  async getTtl(key: string): Promise<number> {
    try {
      return await this.cache.ttl(this.buildKey(key))
    } catch (error) {
      this.logger.error(`Cache TTL error for key: ${key}`, error)
      return -1
    }
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    try {
      return (await this.cache.expire(this.buildKey(key), ttl)) === 1
    } catch (error) {
      this.logger.error(`Cache expire error for key: ${key}`, error)
      return false
    }
  }

  async increment(key: string, by = 1): Promise<number> {
    try {
      return await this.cache.incrby(this.buildKey(key), by)
    } catch (error) {
      this.logger.error(`Cache increment error for key: ${key}`, error)
      throw error
    }
  }

  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== null) return cached
    const value = await fetchFn()
    await this.set(key, value, ttl)
    return value
  }

  async reset(): Promise<void> {
    try {
      await this.cache.flushdb()
      this.logger.warn('Cache flushed - all keys deleted')
    } catch (error) {
      this.logger.error('Cache reset error', error)
      throw error
    }
  }

  getClient(): Redis {
    return this.cache
  }

  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`
  }
}
