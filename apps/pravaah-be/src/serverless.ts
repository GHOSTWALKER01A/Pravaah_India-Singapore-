import type { IncomingMessage, ServerResponse } from 'node:http'

import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import express, { type Express } from 'express'

import { AppModule } from '@/app.module'
import { configureApp } from '@/bootstrap'

/**
 * Serverless entrypoint (Vercel).
 *
 * `main.ts` owns a port; a function invocation is handed a request that has
 * already been accepted for it. So this builds the same Nest app over an Express
 * instance we hold onto, calls `init()` instead of `listen()`, and lets the
 * platform do the socket work.
 *
 * The promise — not the resolved app — is what gets cached. Two requests landing
 * on one cold container both await the same bootstrap instead of racing to build
 * two Nest apps (two Prisma pools, two Redis clients) and having one silently win.
 */
let serverPromise: Promise<Express> | undefined

async function createServer(): Promise<Express> {
  const expressApp = express()

  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    {
      bufferLogs: true,
      // Lets the webhook HMAC guard verify signatures over exact bytes.
      rawBody: true,
    },
  )

  configureApp(app)
  await app.init()

  // `bufferLogs: true` parks every Nest log line in a static buffer that is only
  // drained by `listen()` — which a function never calls. Without this flush the
  // buffer is never detached, so framework logs (route mapping, init failures)
  // are swallowed for the life of the container and accumulate in memory.
  app.flushLogs()

  return expressApp
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!serverPromise) {
    // A failed bootstrap must not be cached. Without this reset, one bad cold
    // start (a database blip during `onModuleInit`, say) would pin the rejected
    // promise for the life of the container and every later request would fail
    // for a reason that had already gone away.
    serverPromise = createServer().catch((error: unknown) => {
      serverPromise = undefined
      throw error
    })
  }

  const server = await serverPromise
  server(req as express.Request, res as express.Response)
}
