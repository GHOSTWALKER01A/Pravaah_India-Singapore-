export interface ICacheService {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttl?: number): Promise<void>
  del(key: string): Promise<boolean>
  exists(key: string): Promise<boolean>
  getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttl?: number): Promise<T>
}

export const CACHE_SERVICE = Symbol('CACHE_SERVICE')
