import { SetMetadata } from '@nestjs/common'

export const CACHEABLE_METADATA = 'cache:cacheable'
export const CACHE_EVICT_METADATA = 'cache:evict'
export const CACHE_KEY_METADATA = 'cache:key'
export const CACHE_TTL_METADATA = 'cache:ttl'

export interface CacheableOptions {
  /** Cache key prefix. If omitted, auto-generated from class + method name. */
  key?: string
  /** Time to live in seconds. Falls back to the service default. */
  ttl?: number
  /** Extra key parts pulled from method args (by index) or request paths. */
  keyParams?: (string | number)[]
  /** Whether to cache null/undefined values. @default false */
  cacheNull?: boolean
}

export interface CacheEvictOptions {
  /** Cache key or pattern to evict. */
  key?: string
  /** Treat `key` as a pattern and evict all matches. @default false */
  pattern?: boolean
  /** Extra key parts pulled from method args. */
  keyParams?: (string | number)[]
  /** Evict before the method runs instead of after. @default false */
  beforeInvocation?: boolean
}

/**
 * Cache a handler's result.
 *
 * @example
 * `@Cacheable({ key: 'kyc:case', keyParams: ['params.id'], ttl: 60 })`
 */
export const Cacheable = (options: CacheableOptions = {}) =>
  SetMetadata(CACHEABLE_METADATA, options)

/**
 * Evict cache entries when a handler runs.
 *
 * @example `@CacheEvict({ key: 'kyc:case', keyParams: ['params.id'] })`
 */
export const CacheEvict = (options: CacheEvictOptions = {}) =>
  SetMetadata(CACHE_EVICT_METADATA, options)

/** Provide a fully custom cache key with `{0}` / `{params.id}` placeholders. */
export const CacheKey = (key: string) => SetMetadata(CACHE_KEY_METADATA, key)

/** Override TTL (seconds) for a single handler. */
export const CacheTTL = (ttl: number) => SetMetadata(CACHE_TTL_METADATA, ttl)
