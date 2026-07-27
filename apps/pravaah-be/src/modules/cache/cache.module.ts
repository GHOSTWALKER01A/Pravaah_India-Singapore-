import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { CACHE_CLIENT, CacheProvider } from '@/modules/cache/cache.provider'
import { CacheService } from '@/modules/cache/cache.service'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [CacheProvider, CacheService],
  exports: [CacheService, CACHE_CLIENT],
})
export class CacheCoreModule {}
