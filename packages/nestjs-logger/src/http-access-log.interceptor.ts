import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import { type Observable, catchError, tap, throwError } from 'rxjs'

import { RequestContextService } from './request-context.service'
import { APP_LOGGER, LOGGER_OPTIONS } from './tokens'
import type { AppLogger, CommonLoggerOptions, HttpLogMeta } from './types'

type RequestLike = {
  method: string
  originalUrl?: string
  url?: string
}

type ResponseLike = {
  statusCode: number
}

@Injectable()
export class HttpAccessLogInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(LOGGER_OPTIONS) private readonly options: CommonLoggerOptions,
    private readonly requestContext: RequestContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.options.enableHttpLogs || context.getType() !== 'http') {
      return next.handle()
    }

    const startedAt = Date.now()
    const http = context.switchToHttp()
    const request = http.getRequest<RequestLike>()
    const response = http.getResponse<ResponseLike>()

    const method = request.method
    const path = this.sanitizePath(request.originalUrl ?? request.url ?? '')
    const requestId = this.requestContext.getRequestId()

    return next.handle().pipe(
      tap(() => {
        const meta = this.buildMeta({
          method,
          path,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          requestId,
        })
        this.logger.info('HTTP request completed', meta)
      }),
      catchError((error: unknown) => {
        const meta = this.buildMeta({
          method,
          path,
          statusCode: this.resolveStatusCode(error, response.statusCode),
          durationMs: Date.now() - startedAt,
          requestId,
          err: error,
        })
        this.logger.error('HTTP request failed', meta)
        return throwError(() => error)
      }),
    )
  }

  private resolveStatusCode(error: unknown, fallback: number): number {
    if (error instanceof HttpException) {
      return error.getStatus()
    }

    return fallback
  }

  private buildMeta(
    meta: HttpLogMeta & { err?: unknown },
  ): HttpLogMeta & { err?: unknown } {
    if (!meta.requestId) {
      const { requestId: _requestId, ...rest } = meta
      return rest
    }

    return meta
  }

  private sanitizePath(path: string): string {
    const queryIndex = path.indexOf('?')
    if (queryIndex === -1) {
      return path
    }

    return path.slice(0, queryIndex)
  }
}
