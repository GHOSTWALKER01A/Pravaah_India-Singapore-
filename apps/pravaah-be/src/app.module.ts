import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { ScheduleModule } from '@nestjs/schedule'

import {
  CommonLoggerModule,
  HttpAccessLogInterceptor,
} from '@pravaah/nestjs-logger'

import { AppController } from '@/app.controller'
import { AppService } from '@/app.service'
import { CacheInterceptor } from '@/common/interceptors/cache.interceptor'
import { AuditModule } from '@/modules/audit/audit.module'
import { AuthCoreModule } from '@/modules/auth/auth-core.module'
import { AuthModule } from '@/modules/auth/auth.module'
import { CacheCoreModule } from '@/modules/cache/cache.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'
import { PrismaModule } from '@/modules/database/prisma/prisma.module'
import { SupabaseModule } from '@/modules/database/supabase/supabase.module'
import { ConsentModule } from '@/modules/consent/consent.module'
import { KycModule } from '@/modules/kyc/kyc.module'
import { ScoringModule } from '@/modules/scoring/scoring.module'
import { UsersModule } from '@/modules/users/users.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [
        '.env.development.local',
        '.env.staging.local',
        '.env.production.local',
      ],
      isGlobal: true,
    }),
    CommonLoggerModule.forRoot({ serviceName: 'pravaah-be' }),
    ScheduleModule.forRoot(),
    CacheCoreModule,
    PrismaModule,
    SupabaseModule,
    NotificationsModule,
    AuthCoreModule,
    AuditModule,
    UsersModule,
    AuthModule,
    KycModule,
    ConsentModule,
    ScoringModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpAccessLogInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
  ],
})
export class AppModule {}
