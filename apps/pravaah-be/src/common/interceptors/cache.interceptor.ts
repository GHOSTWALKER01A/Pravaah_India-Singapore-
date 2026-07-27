import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { Observable, of } from 'rxjs'
import { tap } from 'rxjs/operators'

import { CacheService } from '@/modules/cache/cache.service'
import {
  CACHEABLE_METADATA,
  CACHE_EVICT_METADATA,
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
  CacheableOptions,
  CacheEvictOptions,
} from '@/common/decorators/cache.decorator'

/**
 * Decorator-driven caching for HTTP handlers. Reads `@Cacheable` / `@CacheEvict`
 * metadata and short-circuits the handler on a cache hit. Registered globally
 * as an APP_INTERCEPTOR, so it is a no-op on handlers without the decorators.
 */
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheInterceptor.name)

  constructor(
    private readonly cacheService: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    // Only HTTP requests carry the request shape this interceptor relies on.
    if (context.getType() !== 'http') {
      return next.handle()
    }

    const request = context.switchToHttp().getRequest()
    const handler = context.getHandler()
    const classRef = context.getClass()

    const cacheableOptions = this.reflector.get<CacheableOptions>(
      CACHEABLE_METADATA,
      handler,
    )
    const evictOptions = this.reflector.get<CacheEvictOptions>(
      CACHE_EVICT_METADATA,
      handler,
    )

    // Fast path: handler has neither decorator.
    if (!cacheableOptions && !evictOptions) {
      return next.handle()
    }

    const customKey = this.reflector.get<string>(CACHE_KEY_METADATA, handler)
    const customTtl = this.reflector.get<number>(CACHE_TTL_METADATA, handler)

    const args = this.extractMethodArgs(context)
    const methodName = handler.name

    if (evictOptions?.beforeInvocation) {
      await this.handleCacheEviction(
        evictOptions,
        args,
        request,
        classRef,
        methodName,
      )
    }

    if (cacheableOptions) {
      const cacheKey = this.buildCacheKey(
        cacheableOptions,
        customKey,
        args,
        request,
        classRef,
        methodName,
      )
      const ttl = customTtl ?? cacheableOptions.ttl

      const cachedValue = await this.cacheService
        .get(cacheKey)
        .catch((error) => {
          this.logger.warn(
            `Cache get failed for key: ${cacheKey}, proceeding without cache`,
            error?.message,
          )
          return null
        })

      if (cachedValue !== null) {
        this.logger.debug(`Cache HIT for key: ${cacheKey}`)
        return of(cachedValue)
      }

      this.logger.debug(`Cache MISS for key: ${cacheKey}`)

      return next.handle().pipe(
        tap(async (data) => {
          const shouldCache =
            cacheableOptions.cacheNull === true ||
            (data !== null && data !== undefined)
          if (shouldCache) {
            await this.cacheService.set(cacheKey, data, ttl).catch((error) => {
              this.logger.error(
                `Failed to cache result for key: ${cacheKey}`,
                error,
              )
            })
          }
        }),
      )
    }

    return next.handle().pipe(
      tap(async () => {
        if (evictOptions && !evictOptions.beforeInvocation) {
          await this.handleCacheEviction(
            evictOptions,
            args,
            request,
            classRef,
            methodName,
          )
        }
      }),
    )
  }

  private extractMethodArgs(context: ExecutionContext): unknown[] {
    const request = context.switchToHttp().getRequest()
    const params = Object.values(request.params || {})
    const query = Object.values(request.query || {})
    const body = request.body ? [request.body] : []
    return [...params, ...query, ...body]
  }

  private buildCacheKey(
    options: CacheableOptions,
    customKey: string | undefined,
    args: unknown[],
    request: Record<string, unknown>,
    classRef: { name: string },
    methodName: string,
  ): string {
    if (customKey) {
      return this.replaceKeyPlaceholders(customKey, args, request)
    }

    if (options.key) {
      const params = this.extractKeyParams(
        options.keyParams || [],
        args,
        request,
      )
      return params.length > 0 ? `${options.key}:${params.join(':')}` : options.key
    }

    const className = classRef.name
      .toLowerCase()
      .replace('controller', '')
      .replace('service', '')
    const baseKey = `${className}:${methodName}`
    const params = this.extractKeyParams(options.keyParams || [], args, request)
    return params.length > 0 ? `${baseKey}:${params.join(':')}` : baseKey
  }

  private extractKeyParams(
    keyParams: (string | number)[],
    args: unknown[],
    request: Record<string, unknown>,
  ): string[] {
    if (keyParams.length === 0) {
      const params: string[] = []
      const reqParams = request.params as Record<string, unknown> | undefined
      const reqQuery = request.query as Record<string, unknown> | undefined
      if (reqParams) {
        Object.values(reqParams).forEach((param) => {
          if (param !== undefined && param !== null) params.push(String(param))
        })
      }
      if (reqQuery && Object.keys(reqQuery).length > 0) {
        params.push(JSON.stringify(reqQuery))
      }
      return params
    }

    return keyParams
      .map((param) => {
        if (typeof param === 'number') {
          const value = args[param]
          if (value !== undefined && value !== null) {
            return typeof value === 'object'
              ? this.hashObject(value)
              : String(value)
          }
          return ''
        }
        const parts = param.split('.')
        let value: unknown = request
        for (const part of parts) {
          if (value && typeof value === 'object') {
            value = (value as Record<string, unknown>)[part]
          } else {
            return ''
          }
        }
        if (value !== undefined && value !== null) {
          return typeof value === 'object'
            ? this.hashObject(value)
            : String(value)
        }
        return ''
      })
      .filter((p) => p !== '')
  }

  private hashObject(obj: unknown): string {
    try {
      const record = obj as Record<string, unknown>
      const sorted = Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key]
          return acc
        }, {})
      return JSON.stringify(sorted)
    } catch {
      return String(obj)
    }
  }

  private replaceKeyPlaceholders(
    key: string,
    args: unknown[],
    request: Record<string, unknown>,
  ): string {
    key = key.replace(/{(\d+)}/g, (match, index) => {
      const arg = args[parseInt(index, 10)]
      if (arg === undefined || arg === null) return match
      return typeof arg === 'object' ? this.hashObject(arg) : String(arg)
    })

    key = key.replace(/{([^}]+)}/g, (match, path) => {
      const parts = path.split('.')
      let value: unknown = request
      for (const part of parts) {
        if (value && typeof value === 'object') {
          value = (value as Record<string, unknown>)[part]
        } else {
          return match
        }
      }
      if (value !== undefined && value !== null) {
        return typeof value === 'object' ? this.hashObject(value) : String(value)
      }
      return match
    })

    return key
  }

  private async handleCacheEviction(
    options: CacheEvictOptions,
    args: unknown[],
    request: Record<string, unknown>,
    classRef: { name: string },
    methodName: string,
  ): Promise<void> {
    try {
      let key: string
      if (options.key) {
        const params = this.extractKeyParams(
          options.keyParams || [],
          args,
          request,
        )
        key =
          params.length > 0 ? `${options.key}:${params.join(':')}` : options.key
      } else {
        const className = classRef.name
          .toLowerCase()
          .replace('controller', '')
          .replace('service', '')
        const params = this.extractKeyParams(
          options.keyParams || [],
          args,
          request,
        )
        key =
          params.length > 0
            ? `${className}:${methodName}:${params.join(':')}`
            : `${className}:${methodName}`
      }

      if (options.pattern) {
        const deletedCount = await this.cacheService
          .delPattern(key)
          .catch(() => 0)
        this.logger.debug(`Evicted ${deletedCount} keys matching pattern: ${key}`)
      } else {
        const deleted = await this.cacheService.del(key).catch(() => false)
        if (deleted) this.logger.debug(`Evicted cache key: ${key}`)
      }
    } catch (error) {
      // Eviction failures must never break the request path.
      this.logger.error('Cache eviction failed', error)
    }
  }
}
