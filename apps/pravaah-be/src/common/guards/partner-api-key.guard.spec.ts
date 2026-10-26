import { createHash } from 'node:crypto'

import {
  ForbiddenException,
  HttpException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common'

import {
  PartnerApiKeyGuard,
  type PartnerAuthContext,
} from '@/common/guards/partner-api-key.guard'

import type { AppLogger } from '@pravaah/nestjs-logger'
import type { CacheService } from '@/modules/cache/cache.service'
import type { PrismaService } from '@/modules/database/prisma/prisma.service'

/**
 * The partner guard decides who may ask holders for their data. Every case here is
 * a way that decision could go wrong: an expired or revoked key still working, a
 * suspended partner still verifying, a narrow key acting with its partner's full
 * scope, or a rate-limit store outage turning into a partner-wide outage.
 */

const SCOPED_KEY = 'pvk_live_scopedkeyscopedkeyscopedkeyscopedkeyscopedkey0'
const BOOTSTRAP_KEY = 'pvk_dev_acme_bank_do_not_use_in_production'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

const logger = {
  child: () => logger,
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as AppLogger

function partner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: 'Acme',
    audience: 'acme-bank',
    status: 'ACTIVE',
    isActive: true,
    apiKeyHash: sha(BOOTSTRAP_KEY),
    allowedScopes: ['score_at_least_good', 'given_name', 'score_value'],
    lastUsedAt: new Date(),
    ...overrides,
  }
}

function scopedKeyRow(
  overrides: Record<string, unknown> = {},
  partnerOverrides = {},
) {
  return {
    id: 'k-1',
    partnerId: 'p-1',
    keyHash: sha(SCOPED_KEY),
    // `birth_date` is on the key but NOT approved for the partner — it must drop out.
    scopes: ['score_at_least_good', 'birth_date'],
    status: 'ACTIVE',
    rateLimitPerMin: 60,
    expiresAt: null,
    lastUsedAt: new Date(),
    partner: partner(partnerOverrides),
    ...overrides,
  }
}

function setup(
  opts: {
    keyRow?: Record<string, unknown> | null
    bootstrap?: Record<string, unknown> | null
    count?: number | Promise<number>
  } = {},
) {
  const prisma = {
    partnerApiKey: {
      findUnique: jest.fn(() => Promise.resolve(opts.keyRow ?? null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    verifierPartner: {
      findUnique: jest.fn(() => Promise.resolve(opts.bootstrap ?? null)),
      update: jest.fn(() => Promise.resolve({})),
    },
  }
  const cache = {
    increment: jest.fn(() => Promise.resolve(opts.count ?? 1)),
    expire: jest.fn(() => Promise.resolve(true)),
  }
  const guard = new PartnerApiKeyGuard(
    prisma as unknown as PrismaService,
    cache as unknown as CacheService,
    logger,
  )
  return { guard, prisma, cache }
}

function context(headers: Record<string, string>) {
  const request: Record<string, unknown> & { headers: Record<string, string> } =
    { headers }
  const response = { setHeader: jest.fn() }
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext
  return { ctx, request: request as unknown as PartnerAuthContext, response }
}

describe('PartnerApiKeyGuard', () => {
  it('refuses a call with no key', async () => {
    const { guard } = setup()
    await expect(guard.canActivate(context({}).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('narrows a scoped key to what the partner is CURRENTLY approved for', async () => {
    const { guard } = setup({ keyRow: scopedKeyRow() })
    const { ctx, request } = context({ 'x-pravaah-partner-key': SCOPED_KEY })

    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(request.partnerApiKey?.id).toBe('k-1')
    expect(request.partnerScopes).toEqual(['score_at_least_good'])
  })

  it('accepts a pvk_ key as a Bearer token', async () => {
    const { guard } = setup({ keyRow: scopedKeyRow() })
    await expect(
      guard.canActivate(context({ authorization: `Bearer ${SCOPED_KEY}` }).ctx),
    ).resolves.toBe(true)
  })

  it('does not hash-and-look-up a user session JWT sent as a Bearer token', async () => {
    const { guard, prisma } = setup({ keyRow: scopedKeyRow() })
    await expect(
      guard.canActivate(
        context({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' }).ctx,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    expect(prisma.partnerApiKey.findUnique).not.toHaveBeenCalled()
  })

  it('refuses a key past its expiry even before the sweep marks it revoked', async () => {
    const { guard } = setup({
      keyRow: scopedKeyRow({ expiresAt: new Date(Date.now() - 1_000) }),
    })
    await expect(
      guard.canActivate(context({ 'x-pravaah-partner-key': SCOPED_KEY }).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('refuses a revoked key', async () => {
    const { guard } = setup({ keyRow: scopedKeyRow({ status: 'REVOKED' }) })
    await expect(
      guard.canActivate(context({ 'x-pravaah-partner-key': SCOPED_KEY }).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('stops a SUSPENDED partner at once, whatever its keys say', async () => {
    const { guard } = setup({
      keyRow: scopedKeyRow({}, { status: 'SUSPENDED', isActive: false }),
    })
    await expect(
      guard.canActivate(context({ 'x-pravaah-partner-key': SCOPED_KEY }).ctx),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('falls back to the M3 bootstrap key, scoped to the partner’s approval', async () => {
    const { guard } = setup({ bootstrap: partner() })
    const { ctx, request } = context({ 'x-pravaah-partner-key': BOOTSTRAP_KEY })

    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(request.partnerApiKey).toBeNull()
    expect(request.partnerScopes).toEqual([
      'score_at_least_good',
      'given_name',
      'score_value',
    ])
  })

  it('answers 429 with Retry-After once a key exceeds its own limit', async () => {
    const { guard } = setup({
      keyRow: scopedKeyRow({ rateLimitPerMin: 5 }),
      count: 6,
    })
    const { ctx, response } = context({ 'x-pravaah-partner-key': SCOPED_KEY })

    const failure = await guard
      .canActivate(ctx)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HttpException)
    expect((failure as HttpException).getStatus()).toBe(429)
    expect(response.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      expect.any(String),
    )
  })

  it('fails OPEN when the rate-limit store hangs, instead of hanging every partner', async () => {
    const { guard } = setup({
      keyRow: scopedKeyRow(),
      count: new Promise<number>(() => undefined), // never resolves
    })
    const started = Date.now()
    await expect(
      guard.canActivate(context({ 'x-pravaah-partner-key': SCOPED_KEY }).ctx),
    ).resolves.toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
