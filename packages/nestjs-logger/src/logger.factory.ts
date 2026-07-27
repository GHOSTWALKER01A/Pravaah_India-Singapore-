import pino, { type LoggerOptions } from 'pino'

import { resolveLoggerOptions } from './options'
import { PinoAppLogger } from './pino-app-logger'
import type { AppLogger, CommonLoggerOptionsInput } from './types'

export function createAppLogger(
  input: CommonLoggerOptionsInput = {},
): AppLogger {
  const options = resolveLoggerOptions(input)

  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: {
      service: options.serviceName,
    },
    timestamp: options.timestamp ? pino.stdTimeFunctions.isoTime : false,
    redact: {
      paths: options.redactPaths,
      remove: true,
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  }

  return new PinoAppLogger(pino(loggerOptions))
}
