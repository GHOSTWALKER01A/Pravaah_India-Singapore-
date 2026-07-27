import {
  DynamicModule,
  Global,
  Module,
  type Provider,
} from '@nestjs/common'

import { HttpAccessLogInterceptor } from './http-access-log.interceptor'
import { createAppLogger } from './logger.factory'
import { NestLoggerService } from './nest-logger.service'
import { resolveLoggerOptions } from './options'
import { RequestContextMiddleware } from './request-context.middleware'
import { RequestContextService } from './request-context.service'
import {
  APP_LOGGER,
  LOGGER_OPTIONS,
  NEST_LOGGER,
  REQUEST_CONTEXT,
  getLoggerToken,
} from './tokens'
import type {
  AppLogger,
  CommonLoggerOptions,
  CommonLoggerOptionsInput,
} from './types'

@Global()
@Module({})
export class CommonLoggerModule {
  static forRoot(options: CommonLoggerOptionsInput = {}): DynamicModule {
    const optionsProvider: Provider = {
      provide: LOGGER_OPTIONS,
      useValue: resolveLoggerOptions(options),
    }

    const appLoggerProvider: Provider = {
      provide: APP_LOGGER,
      inject: [LOGGER_OPTIONS],
      useFactory: (resolvedOptions: CommonLoggerOptions): AppLogger =>
        createAppLogger(resolvedOptions),
    }

    return {
      module: CommonLoggerModule,
      global: true,
      providers: [
        optionsProvider,
        appLoggerProvider,
        RequestContextService,
        RequestContextMiddleware,
        HttpAccessLogInterceptor,
        NestLoggerService,
        {
          provide: REQUEST_CONTEXT,
          useExisting: RequestContextService,
        },
        {
          provide: NEST_LOGGER,
          useExisting: NestLoggerService,
        },
      ],
      exports: [
        LOGGER_OPTIONS,
        APP_LOGGER,
        REQUEST_CONTEXT,
        NEST_LOGGER,
        RequestContextService,
        RequestContextMiddleware,
        HttpAccessLogInterceptor,
        NestLoggerService,
      ],
    }
  }

  static forFeature(context?: string): DynamicModule {
    const resolvedContext = context?.trim() || 'Feature'
    const loggerToken = getLoggerToken(resolvedContext)

    return {
      module: CommonLoggerModule,
      providers: [
        {
          provide: loggerToken,
          inject: [APP_LOGGER],
          useFactory: (logger: AppLogger): AppLogger =>
            logger.child({ context: resolvedContext }),
        },
      ],
      exports: [loggerToken],
    }
  }
}
