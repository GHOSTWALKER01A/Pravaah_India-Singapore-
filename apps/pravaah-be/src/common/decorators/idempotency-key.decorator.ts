import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common'

import { IdempotencyKeySchema } from '@pravaah/schema'

import type { Request } from 'express'

/**
 * The `Idempotency-Key` header, validated.
 *
 * Required rather than optional on every money-moving endpoint, and that strictness is the
 * point. A client that forgets the header gets a 400 it will notice in development; a server
 * that quietly generated a key on its behalf would produce a DIFFERENT key for the retry,
 * which is precisely the case idempotency exists to prevent — the retry would be treated as
 * a new payment and the user would be debited twice.
 *
 * The minimum length in {@link IdempotencyKeySchema} guards the other failure mode: a client
 * sending `"1"` would collide across users' intents, and a colliding key does not error — it
 * silently replays somebody's earlier response.
 */
export const IdempotencyKey = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>()
    const raw = request.headers['idempotency-key']

    // A repeated header arrives as an array. Rejected rather than resolved by picking one:
    // two keys means two intents, and choosing between them is a guess about money.
    if (Array.isArray(raw)) {
      throw new BadRequestException('Send exactly one Idempotency-Key header')
    }
    if (!raw) {
      throw new BadRequestException(
        'An Idempotency-Key header is required so a retry cannot charge you twice',
      )
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

/** The caller's IP, for the fraud trail. */
export const ClientIp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>()
    return request.ip ?? request.socket?.remoteAddress ?? null
  },
)
