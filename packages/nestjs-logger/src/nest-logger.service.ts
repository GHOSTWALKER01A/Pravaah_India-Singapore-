import { Inject, Injectable, type LoggerService } from '@nestjs/common'

import { APP_LOGGER } from './tokens'
import type { AppLogger, LogMeta } from './types'

function stringifyMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message
  }

  try {
    return JSON.stringify(message)
  } catch {
    return String(message)
  }
}

function buildContextMeta(context?: string): LogMeta | undefined {
  if (!context) {
    return undefined
  }

  return { context }
}

/**
 * Adapts our {@link AppLogger} to Nest's `LoggerService` so that
 * `app.useLogger(...)` routes ALL framework + `new Logger(...)` output through
 * pino — existing `Logger` usage gets structured logging for free.
 */
@Injectable()
export class NestLoggerService implements LoggerService {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  log(message: unknown, context?: string): void {
    this.logger.info(stringifyMessage(message), buildContextMeta(context))
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn(stringifyMessage(message), buildContextMeta(context))
  }

  error(message: unknown, trace?: string, context?: string): void {
    const meta: LogMeta = {
      ...(context ? { context } : {}),
      ...(trace ? { trace } : {}),
    }

    this.logger.error(
      stringifyMessage(message),
      Object.keys(meta).length > 0 ? meta : undefined,
    )
  }

  debug?(message: unknown, context?: string): void {
    this.logger.debug(stringifyMessage(message), buildContextMeta(context))
  }

  verbose?(message: unknown, context?: string): void {
    this.logger.verbose(stringifyMessage(message), buildContextMeta(context))
  }

  fatal?(message: unknown, trace?: string, context?: string): void {
    const meta: LogMeta = {
      ...(context ? { context } : {}),
      ...(trace ? { trace } : {}),
      fatal: true,
    }

    this.logger.fatal(stringifyMessage(message), meta)
  }
}
