import type { LevelWithSilent } from 'pino'

export type LogMeta = Record<string, unknown>

export type HttpLogMeta = LogMeta & {
  method: string
  path: string
  statusCode: number
  durationMs: number
  requestId?: string
}

export interface AppLogger {
  info(message: string, meta?: LogMeta): void
  warn(message: string, meta?: LogMeta): void
  error(message: string, meta?: LogMeta): void
  debug(message: string, meta?: LogMeta): void
  verbose(message: string, meta?: LogMeta): void
  fatal(message: string, meta?: LogMeta): void
  child(bindings: LogMeta): AppLogger
}

export interface RequestContext {
  requestId: string
}

export interface CommonLoggerOptions {
  serviceName: string
  level: LevelWithSilent
  pretty: boolean
  redactPaths: string[]
  enableHttpLogs: boolean
  requestIdHeader: string
  timestamp: boolean
}

export type CommonLoggerOptionsInput = Partial<CommonLoggerOptions>
