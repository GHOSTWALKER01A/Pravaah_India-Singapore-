import { randomUUID } from 'node:crypto'

import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'

import { runWithRequestContext } from './request-context.store'
import { LOGGER_OPTIONS } from './tokens'
import type { CommonLoggerOptions } from './types'

type RequestWithHeaders = {
  headers?: Record<string, string | string[] | undefined>
}

type ResponseWithSetHeader = {
  setHeader?: (name: string, value: string) => void
}

type NextFn = () => void

function getHeaderValue(
  headers: RequestWithHeaders['headers'],
  key: string,
): string | undefined {
  if (!headers) {
    return undefined
  }

  const value =
    headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()]
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

export function createRequestContextMiddleware(options?: {
  requestIdHeader?: string
}) {
  const requestIdHeader = (
    options?.requestIdHeader ?? 'x-request-id'
  ).toLowerCase()

  return function requestContextMiddleware(
    req: RequestWithHeaders,
    res: ResponseWithSetHeader,
    next: NextFn,
  ): void {
    const requestId =
      getHeaderValue(req.headers, requestIdHeader) ?? randomUUID()

    if (res.setHeader) {
      res.setHeader(requestIdHeader, requestId)
    }

    runWithRequestContext({ requestId }, next)
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly middleware: (
    req: RequestWithHeaders,
    res: ResponseWithSetHeader,
    next: NextFn,
  ) => void

  constructor(@Inject(LOGGER_OPTIONS) options: CommonLoggerOptions) {
    this.middleware = createRequestContextMiddleware({
      requestIdHeader: options.requestIdHeader,
    })
  }

  use(req: RequestWithHeaders, res: ResponseWithSetHeader, next: NextFn): void {
    this.middleware(req, res, next)
  }
}
