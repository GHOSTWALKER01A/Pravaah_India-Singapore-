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

  app.setGlobalPrefix('api')
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  })

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
