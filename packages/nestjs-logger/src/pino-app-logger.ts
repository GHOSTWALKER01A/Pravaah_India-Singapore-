import type { Logger as PinoLogger } from 'pino'

import { getRequestContext } from './request-context.store'
import type { AppLogger, LogMeta } from './types'

function hasKeys(meta: LogMeta | undefined): meta is LogMeta {
  return Boolean(meta && Object.keys(meta).length > 0)
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: PinoLogger) {}

  info(message: string, meta?: LogMeta): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: LogMeta): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: LogMeta): void {
    this.write('error', message, meta)
  }

  debug(message: string, meta?: LogMeta): void {
    this.write('debug', message, meta)
  }

  verbose(message: string, meta?: LogMeta): void {
    this.write('trace', message, meta)
  }

  fatal(message: string, meta?: LogMeta): void {
    this.write('fatal', message, meta)
  }

  child(bindings: LogMeta): AppLogger {
    return new PinoAppLogger(this.logger.child(bindings))
  }

  private write(
    level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal',
    message: string,
    meta?: LogMeta,
  ): void {
    const requestId = getRequestContext()?.requestId
    const mergedMeta: LogMeta | undefined =
      requestId && !meta?.requestId ? { requestId, ...meta } : meta

    if (hasKeys(mergedMeta)) {
      this.logger[level](mergedMeta, message)
      return
    }

    this.logger[level](message)
  }
}
