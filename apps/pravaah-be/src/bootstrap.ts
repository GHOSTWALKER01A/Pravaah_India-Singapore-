import { VersioningType, type INestApplication } from '@nestjs/common'

import {
  APP_LOGGER,
  NEST_LOGGER,
  createRequestContextMiddleware,
  type AppLogger,
} from '@pravaah/nestjs-logger'
import helmet from 'helmet'

import { WELL_KNOWN_ROUTES } from '@/modules/passport/passport.route'

/**
 * Everything that must be true of the app regardless of how it is being served.
 *
 * Shared by the long-lived server (`main.ts`) and the serverless handler
 * (`serverless.ts`) on purpose: a security header, a CORS rule or a route prefix
 * that exists in only one of the two entrypoints is a difference between what we
 * test locally and what strangers actually talk to.
 *
 * Returns the bootstrap-scoped logger so the caller can report readiness.
 */
export function configureApp(app: INestApplication): AppLogger {
  // Route all Nest + `new Logger(...)` output through pino, and stamp every
  // request with a correlation id available to every log line.
  app.useLogger(app.get(NEST_LOGGER))
  app.use(createRequestContextMiddleware())
  const logger = app.get<AppLogger>(APP_LOGGER).child({ context: 'Bootstrap' })

  app.use(helmet())
  app.enableCors({ credentials: true })

  // The M3 trust-anchor documents must NOT be prefixed. `did:web:pravaah.app`
  // resolves, by specification, to `https://pravaah.app/.well-known/did.json` — there
  // is no room in a DID for an `/api` segment. Served under the prefix, our DID
  // document would be unreachable by every conformant resolver, quietly reducing the
  // passport to something only Pravaah can verify and removing the whole point of M3.
  app.setGlobalPrefix('api', {
    exclude: Object.values(WELL_KNOWN_ROUTES).map((path) => `/${path}`),
  })
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  })

  return logger
}
