import { createHash, timingSafeEqual } from 'node:crypto'

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { CacheService } from '@/modules/cache/cache.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  PartnerApiKeyStatus,
  PartnerStatus,
  type PartnerApiKey,
  type VerifierPartner,
} from 'generated/prisma/client'

/** Header a verifier presents its key in. `Authorization: Bearer <key>` also works. */
export const PARTNER_API_KEY_HEADER = 'x-pravaah-partner-key'

/** Budget for an M3 bootstrap key, which has no per-key limit column of its own. */
const LEGACY_KEY_RATE_LIMIT_PER_MIN = 120

/** `lastUsedAt` is observability; one write a minute per key is plenty. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000

/** How long the rate-limit store may take before the limit is skipped. */
const RATE_LIMIT_STORE_TIMEOUT_MS = 300

/** What this guard attaches to the request. */
export interface PartnerAuthContext {
  partner: VerifierPartner
  /** The M7 key used, or null when the partner authenticated with its M3 bootstrap key. */
  partnerApiKey: PartnerApiKey | null
  /**
   * The claims this CALL may request: the key's scopes intersected with the
   * partner's CURRENT approved scopes. Recomputed per request, so an admin
   * narrowing a partner narrows every key it holds at the next call.
   */
  partnerScopes: string[]
}

/**
 * Authenticates a registered verifier on the partner surfaces (M3's `/verify`,
 * M7's `/partner`) and attaches {@link PartnerAuthContext} to the request.
 *
 * Why the verify surface needs authentication at all, when the SD-JWT is already
 * self-proving: the AUDIENCE. A key binding proof is made out to one verifier, and
 * that binding is what stops a presentation captured at one lender being replayed at
 * another. An anonymous caller could name any audience it liked, which would make the
 * strongest replay defence in the credential a self-declared field.
 *
 * Two kinds of key are accepted, looked up in this order:
 *
 *  1. an M7 `PartnerApiKey` — scoped, rotatable, rate-limited, optionally expiring;
 *  2. the M3 bootstrap key stored on `VerifierPartner.apiKeyHash`, scoped to the
 *     partner's full approved scope.
 *
 * Either way the PARTNER must be ACTIVE. A suspended partner's keys are not revoked
 * (so reinstatement is instant) but they stop working immediately, which is what
 * "suspend" has to mean for a party that can ask holders for their data.
 */
@Injectable()
export class PartnerApiKeyGuard implements CanActivate {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerApiKeyGuard.name })
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    const request = http.getRequest<
      {
        headers: Record<string, string | string[] | undefined>
      } & Partial<PartnerAuthContext>
    >()
    const response = http.getResponse<{
      setHeader?: (name: string, value: string) => void
    }>()

    const presented = readPresentedKey(request.headers)
    if (!presented) {
      throw new UnauthorizedException(
        `Missing ${PARTNER_API_KEY_HEADER} header (or Authorization: Bearer <key>)`,
      )
    }

    // Looked up by HASH, so the plaintext key is never stored and never compared
    // against something stored. The lookup is an indexed equality on a digest, which
    // leaks nothing timing-wise about the key itself.
    const hash = createHash('sha256').update(presented).digest('hex')

    const resolved =
      (await this.resolveScopedKey(hash)) ??
      (await this.resolveBootstrapKey(hash))
    if (!resolved) {
      throw new UnauthorizedException('Invalid, expired or revoked partner key')
    }

    const { partner, key } = resolved
    if (partner.status !== PartnerStatus.ACTIVE || !partner.isActive) {
      // A valid key for a non-active partner is a 403, not a 401: the caller IS who
      // they say they are, and telling them why lets an honest integrator stop retrying.
      throw new ForbiddenException(
        partner.status === PartnerStatus.PENDING_APPROVAL
          ? 'This partner has not been approved yet'
          : `This partner is ${partner.status.toLowerCase()} and cannot verify`,
      )
    }

    await this.enforceRateLimit(
      key ? `key:${key.id}` : `partner:${partner.id}`,
      key?.rateLimitPerMin ?? LEGACY_KEY_RATE_LIMIT_PER_MIN,
      response,
    )

    const allowed = new Set(partner.allowedScopes)
    request.partner = partner
    request.partnerApiKey = key
    request.partnerScopes = key
      ? key.scopes.filter((scope) => allowed.has(scope))
      : [...partner.allowedScopes]

    this.touch(partner, key)
    return true
  }

  private async resolveScopedKey(
    hash: string,
  ): Promise<{ partner: VerifierPartner; key: PartnerApiKey } | null> {
    const row = await this.prisma.partnerApiKey.findUnique({
      where: { keyHash: hash },
      include: { partner: true },
    })
    if (!row || !safeEqual(row.keyHash, hash)) return null
    if (row.status !== PartnerApiKeyStatus.ACTIVE) return null
    // A rotated-out key keeps working until its grace period ends, then stops here
    // even if the sweep that marks it REVOKED has not run yet.
    if (row.expiresAt && row.expiresAt <= new Date()) return null

    const { partner, ...key } = row
    return { partner, key }
  }

  private async resolveBootstrapKey(
    hash: string,
  ): Promise<{ partner: VerifierPartner; key: null } | null> {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { apiKeyHash: hash },
    })
    // Constant-time confirmation of the digest we just matched. The database lookup
    // has already decided, so this is belt-and-braces against a future refactor that
    // replaces the unique lookup with a scan — where a `===` would become a genuine
    // timing oracle.
    if (!partner?.apiKeyHash || !safeEqual(partner.apiKeyHash, hash))
      return null
    return { partner, key: null }
  }

  /**
   * Fixed-window limit in the shared cache, so it holds across instances.
   *
   * FAILS OPEN when the cache is unreachable, deliberately and loudly: this limit
   * protects our CPU, not anybody's data — every authorisation decision above has
   * already been made against the database. Failing closed would turn a Redis blip
   * into an outage for every partner at once.
   */
  private async enforceRateLimit(
    bucket: string,
    limitPerMin: number,
    response: { setHeader?: (name: string, value: string) => void },
  ): Promise<void> {
    const windowStart = Math.floor(Date.now() / 60_000)
    const cacheKey = `partner-rl:${bucket}:${windowStart}`
    let count: number
    try {
      // Bounded, because the shared ioredis client is configured to QUEUE commands
      // while reconnecting (`maxRetriesPerRequest: null`). Unbounded, a Redis outage
      // would not fail this call — it would hang every partner request for as long as
      // the reconnect loop runs.
      count = await withTimeout(
        this.cache.increment(cacheKey),
        RATE_LIMIT_STORE_TIMEOUT_MS,
      )
      if (count === 1) void this.cache.expire(cacheKey, 120)
    } catch (error) {
      this.logger.warn(
        `[${this.enforceRateLimit.name}] Rate-limit store unavailable — allowing the call`,
        { bucket, err: error },
      )
      return
    }

    response.setHeader?.('X-RateLimit-Limit', String(limitPerMin))
    response.setHeader?.(
      'X-RateLimit-Remaining',
      String(Math.max(0, limitPerMin - count)),
    )
    if (count > limitPerMin) {
      const retryAfter = 60 - Math.floor((Date.now() / 1000) % 60)
      response.setHeader?.('Retry-After', String(retryAfter))
      throw new HttpException(
        `Rate limit of ${limitPerMin} requests/minute exceeded for this key`,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  /** Fire-and-forget observability. Must never fail a call that is otherwise fine. */
  private touch(partner: VerifierPartner, key: PartnerApiKey | null): void {
    const now = Date.now()
    const stale = (at: Date | null) =>
      !at || now - at.getTime() > LAST_USED_WRITE_INTERVAL_MS

    if (key && stale(key.lastUsedAt)) {
      void this.prisma.partnerApiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined)
    }
    if (stale(partner.lastUsedAt)) {
      void this.prisma.verifierPartner
        .update({ where: { id: partner.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined)
    }
  }
}

function readPresentedKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const direct = headers[PARTNER_API_KEY_HEADER]
  const fromHeader = Array.isArray(direct) ? direct[0] : direct
  if (fromHeader?.trim()) return fromHeader.trim()

  const auth = headers.authorization
  const bearer = Array.isArray(auth) ? auth[0] : auth
  const match = bearer?.match(/^Bearer\s+(pvk_[A-Za-z0-9_-]+)$/)
  // Only a `pvk_`-shaped bearer is taken as a partner key. A user's session JWT sent
  // to a partner route must be refused as "no partner key", not hashed and looked up.
  return match?.[1] ?? null
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, which would itself be a signal.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
