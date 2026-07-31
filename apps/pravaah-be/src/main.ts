import { NestFactory } from '@nestjs/core'

import { createAppLogger } from '@pravaah/nestjs-logger'

import { AppModule } from '@/app.module'
import { configureApp } from '@/bootstrap'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Lets the webhook HMAC guard verify signatures over exact bytes.
    rawBody: true,
  })

  const logger = configureApp(app)

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
