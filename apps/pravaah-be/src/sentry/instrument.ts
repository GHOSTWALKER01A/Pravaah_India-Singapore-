import { resolve } from 'node:path'

import * as Sentry from '@sentry/nestjs'
import { config } from 'dotenv'

interface IntegrationOptions {
  enableLogs: boolean
  enableProfiling: boolean
}

type SentryIntegration = ReturnType<typeof Sentry.pinoIntegration>

function getEnvFiles(): string[] {
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development'

  return [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env.local', '.env']
}

function loadEnvFiles(): void {
  for (const file of getEnvFiles()) {
    config({ path: resolve(process.cwd(), file), override: false })
  }
}

function readBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase()
  if (!value) return defaultValue

  return ['1', 'true', 'yes', 'on'].includes(value)
}

function readSampleRate(key: string, defaultValue: number): number {
  const value = process.env[key]?.trim()
  if (!value) return defaultValue

  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed)) return defaultValue

  return Math.min(Math.max(parsed, 0), 1)
}

function getOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim()
  return value ? value : undefined
}

function buildIntegrations(options: IntegrationOptions): SentryIntegration[] {
  const integrations: SentryIntegration[] = []

  if (options.enableLogs) {
    integrations.push(
      Sentry.pinoIntegration({
        log: {
          levels: ['info', 'warn', 'error', 'fatal'],
        },
        error: {
          levels: ['error', 'fatal'],
          handled: true,
        },
      }),
    )
  }

  if (options.enableProfiling) {
    const { nodeProfilingIntegration } =
      require('@sentry/profiling-node') as typeof import('@sentry/profiling-node')

    integrations.push(nodeProfilingIntegration() as SentryIntegration)
  }

  return integrations
}

loadEnvFiles()

const dsn = getOptionalEnv('SENTRY_DSN')
const sentryEnabled = readBoolean('SENTRY_ENABLED', false) && dsn !== undefined

if (sentryEnabled) {
  const tracesSampleRate = readSampleRate('SENTRY_TRACES_SAMPLE_RATE', 0)
  const profileSessionSampleRate = readSampleRate(
    'SENTRY_PROFILE_SESSION_SAMPLE_RATE',
    0,
  )
  const enableProfiling = tracesSampleRate > 0 && profileSessionSampleRate > 0
  const enableLogs = readBoolean('SENTRY_ENABLE_LOGS', false)

  Sentry.init({
    dsn,
    environment: getOptionalEnv('SENTRY_ENVIRONMENT') ?? process.env.NODE_ENV,
    release: getOptionalEnv('SENTRY_RELEASE'),
    debug: readBoolean('SENTRY_DEBUG', false),
    sendDefaultPii: readBoolean('SENTRY_SEND_DEFAULT_PII', false),
    enableLogs,
    tracesSampleRate,
    integrations: buildIntegrations({ enableLogs, enableProfiling }),
    ...(enableProfiling
      ? {
          profileSessionSampleRate,
          profileLifecycle: 'trace' as const,
        }
      : {}),
  })
}
