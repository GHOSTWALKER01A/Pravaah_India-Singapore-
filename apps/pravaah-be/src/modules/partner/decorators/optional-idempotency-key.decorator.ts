import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common'

import { IdempotencyKeySchema } from '@pravaah/schema'

import type { Request } from 'express'

/**
 * The `Idempotency-Key` header, validated when present.
 *
 * OPTIONAL here, unlike the money routes' `@IdempotencyKey()`, because opening a
 * verification moves no money: a partner that omits the key and retries opens a
 * second request, which costs it nothing and the holder one extra prompt. A partner
 * that sends one gets exact replay semantics. When sent, it is held to the same
 * rules — one header, well-formed — because a malformed key silently ignored would
 * be a retry the partner BELIEVED was safe.
 */
export const OptionalIdempotencyKey = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | null => {
    const raw = ctx.switchToHttp().getRequest<Request>().headers[
      'idempotency-key'
    ]
    if (raw === undefined || raw === '') return null
    if (Array.isArray(raw)) {
      throw new BadRequestException('Send exactly one Idempotency-Key header')
    }
    const parsed = IdempotencyKeySchema.safeParse(raw)
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Invalid Idempotency-Key',
      )
    }
    return parsed.data
  },
)
