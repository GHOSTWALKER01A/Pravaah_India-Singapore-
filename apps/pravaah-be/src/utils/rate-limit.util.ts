import { createHash } from 'crypto'

import { type ExecutionContext } from '@nestjs/common'

const HASH_ALGORITHM = 'sha256'

interface AuthPhoneRequestBody {
  countryCode?: unknown
  phone?: unknown
}

interface RateLimitRequest extends Record<string, unknown> {
  body?: AuthPhoneRequestBody
  ip?: string
  socket?: {
    remoteAddress?: string
  }
}

export function getAuthPhoneRateLimitTracker(
  _request: Record<string, unknown>,
  context: ExecutionContext,
): string {
  const request = context.switchToHttp().getRequest<RateLimitRequest>()
  const phone = getStringValue(request.body?.phone)
  const countryCode = getStringValue(request.body?.countryCode)

  if (!phone && !countryCode) {
    return `ip:${getRequestIp(request)}`
  }

  return `phone:${hashTracker(`${normalizeDigits(countryCode)}:${normalizeDigits(phone)}`)}`
}

function getRequestIp(request: RateLimitRequest): string {
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown'
}

function getStringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function hashTracker(value: string): string {
  return createHash(HASH_ALGORITHM).update(value).digest('hex')
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '')
}
