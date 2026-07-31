import { VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

import {
  APP_LOGGER,
  NEST_LOGGER,
  createAppLogger,
  createRequestContextMiddleware,
  type AppLogger,
} from '@pravaah/nestjs-logger'
import helmet from 'helmet'

import { AppModule } from '@/app.module'
import { WELL_KNOWN_ROUTES } from '@/modules/passport/passport.route'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Lets the webhook HMAC guard verify signatures over exact bytes.
    rawBody: true,
  })

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

  // Nest only listens for SIGTERM/SIGINT once this is called. Without it, a
  // container restart kills the process outright and `PrismaService.onModuleDestroy`
  // never runs — abandoning up to `connection_limit` Postgres connections per
  // instance, which then linger server-side until Postgres times them out. Hosts
  // redeploy and restart constantly, so those leaks accumulate.
  app.enableShutdownHooks()

  // Vercel's NestJS runtime waits for the server to listen on PORT, so this file
  // stays the single entrypoint for local, container and serverless deploys alike.
  const port = Number(process.env.PORT ?? 8000)
  // Bind to 0.0.0.0 (all IPv4 interfaces) so physical devices on the LAN can
  // reach the dev server. A bare listen(port) binds to the IPv6 wildcard (::)
  // only on Windows, which refuses IPv4 LAN connections from the phone.
  await app.listen(port, '0.0.0.0')
  logger.info('PRAVAAH backend started', { port })
}

void bootstrap().catch((error: unknown) => {
  const logger = createAppLogger({ serviceName: 'pravaah-be' }).child({
    context: 'Bootstrap',
  })
  logger.fatal('Failed to bootstrap PRAVAAH backend', { err: error })
  process.exit(1)
})
