import type { CommonLoggerOptions, CommonLoggerOptionsInput } from './types'

const DEFAULT_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
]

const DEFAULT_REQUEST_ID_HEADER = 'x-request-id'

function resolveLogLevel(): CommonLoggerOptions['level'] {
  const level = process.env.LOG_LEVEL?.trim()
  if (level) {
    return level as CommonLoggerOptions['level']
  }

  return 'info'
}

function resolvePrettyDefault(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'development'
}

export function resolveLoggerOptions(
  input: CommonLoggerOptionsInput = {},
): CommonLoggerOptions {
  return {
    serviceName: input.serviceName ?? process.env.SERVICE_NAME ?? 'nestjs-app',
    level: input.level ?? resolveLogLevel(),
    pretty: input.pretty ?? resolvePrettyDefault(),
    redactPaths: input.redactPaths ?? DEFAULT_REDACT_PATHS,
    enableHttpLogs: input.enableHttpLogs ?? true,
    requestIdHeader: input.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER,
    timestamp: input.timestamp ?? true,
  }
}
