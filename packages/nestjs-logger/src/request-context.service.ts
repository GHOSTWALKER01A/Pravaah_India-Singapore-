import { Injectable } from '@nestjs/common'

import {
  getRequestContext,
  runWithRequestContext,
} from './request-context.store'
import type { RequestContext } from './types'

@Injectable()
export class RequestContextService {
  getContext(): RequestContext | undefined {
    return getRequestContext()
  }

  getRequestId(): string | undefined {
    return getRequestContext()?.requestId
  }

  run<T>(context: RequestContext, callback: () => T): T {
    return runWithRequestContext(context, callback)
  }
}
