import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'

import { VerificationEventsService } from '@/modules/partner/services/verification-events.service'
import { compilePredicates } from '@/modules/partner/partner.state'

import type { AppLogger } from '@pravaah/nestjs-logger'
import type { PrismaService } from '@/modules/database/prisma/prisma.service'
import type { VerifierEventsRegistry } from '@/modules/passport/services/verifier-events.registry'
import type { ConsentReceiptService } from '@/modules/partner/services/consent-receipt.service'
import type { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import type { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'
import type { VerificationAbuseService } from '@/modules/partner/services/verification-abuse.service'
import type { PushService } from '@/modules/notifications/push.service'
import type { PassportConfig } from '@/modules/passport/passport.config'

/**
 * M7's observer on M3's handshake. Two jobs, two failure semantics:
 *
 *  - the consent gate (`beforeApprove`) must FAIL CLOSED — a share never goes to a
 *    suspended partner, and a risk engine that cannot answer is a "no";
 *  - the side effects (`process`) must be idempotent and must trust the ROW over the
 *    event, because an event is only a claim about the past.
 */

const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const PARTNER_ID = '55555555-5555-4555-8555-555555555555'
const USER_ID = '66666666-6666-4666-8666-666666666666'

const logger = {
  child: () => logger,
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as AppLogger

function approvedRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    partnerId: PARTNER_ID,
    userId: USER_ID,
    status: 'CONSUMED',
    purpose: 'Loan pre-check',
    requestedClaims: ['score_at_least_good', 'given_name'],
    predicates: compilePredicates([
      { claim: 'score_band', op: 'GTE', value: 'GOOD' },
    ]),
    externalRef: 'LOAN-42',
    apiKeyId: 'k-1',
    respondedAt: new Date('2026-09-01T10:00:00Z'),
    cancelledAt: null,
    consumedAt: new Date('2026-09-01T10:00:05Z'),
    expiresAt: new Date('2026-09-01T10:05:00Z'),
    resultJson: {
      claims: { score_at_least_good: true, score_scale: '300-900' },
      withheldClaims: ['given_name'],
      holderVerified: true,
      replayProtected: true,
    },
    partner: {
      id: PARTNER_ID,
      name: 'Lion City Lending',
      domain: 'lender.example.sg',
      retentionDays: 90,
      webhookUrl: 'https://hooks.lender.example.sg',
      webhookSecretEnc: 'v1:x:y:z',
      status: 'ACTIVE',
    },
    presentation: {
      id: 'pres-1',
      disclosedClaims: ['score_at_least_good'],
      presentedAt: new Date(),
    },
    ...overrides,
  }
}

function setup(
  opts: {
    partner?: Record<string, unknown> | null
    request?: Record<string, unknown> | null
    risk?: () => Promise<unknown>
  } = {},
) {
  const tx = { marker: 'tx' }
  const prisma = {
    verifierPartner: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.partner === undefined
            ? { status: 'ACTIVE', isActive: true }
            : opts.partner,
        ),
      ),
    },
    verifierRequest: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.request === undefined ? approvedRequest() : opts.request,
        ),
      ),
      findMany: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
    },
    partnerUsageEvent: {
      findMany: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
    },
    presentation: { findUnique: jest.fn(() => Promise.resolve(null)) },
    $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  }
  const registry = { register: jest.fn() }
  const usage = { record: jest.fn(() => Promise.resolve(1)) }
  const receipts = { issue: jest.fn(() => Promise.resolve(true)) }
  const webhooks = {
    enqueue: jest.fn(() => Promise.resolve(true)),
    kick: jest.fn(),
  }
  const push = { send: jest.fn(() => Promise.resolve({ sent: true })) }
  const passport = {
    walletRequestLink: (id: string) => `parvaahrn://passport/request/${id}`,
  }
  const abuse = {
    assessApproval: jest.fn(
      opts.risk ??
        (() =>
          Promise.resolve({
            decision: 'ALLOW',
            reasons: [],
            signals: [],
            score: 0,
          })),
    ),
  }

  const service = new VerificationEventsService(
    prisma as unknown as PrismaService,
    registry as unknown as VerifierEventsRegistry,
    usage as unknown as PartnerUsageService,
    receipts as unknown as ConsentReceiptService,
    webhooks as unknown as PartnerWebhookService,
    abuse as unknown as VerificationAbuseService,
    push as unknown as PushService,
    passport as unknown as PassportConfig,
    logger,
  )
  return {
    service,
    prisma,
    registry,
    usage,
    receipts,
    webhooks,
    abuse,
    push,
    tx,
  }
}

const ctx = {
  requestId: REQUEST_ID,
  partnerId: PARTNER_ID,
  userId: USER_ID,
  revealClaims: ['score_at_least_good'],
}

describe('VerificationEventsService — the consent gate', () => {
  it('registers itself with M3 on boot', () => {
    const { service, registry } = setup()
    service.onModuleInit()
    expect(registry.register).toHaveBeenCalledWith(service)
  })

  it('stays out of peer checks entirely', async () => {
    const { service, prisma, abuse } = setup()
    await service.beforeApprove({ ...ctx, partnerId: null })
    expect(prisma.verifierPartner.findUnique).not.toHaveBeenCalled()
    expect(abuse.assessApproval).not.toHaveBeenCalled()
  })

  it('refuses a share to a suspended partner', async () => {
    const { service, abuse } = setup({
      partner: { status: 'SUSPENDED', isActive: false },
    })
    await expect(service.beforeApprove(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(abuse.assessApproval).not.toHaveBeenCalled()
  })

  it('refuses a share to a partner that no longer exists', async () => {
    const { service } = setup({ partner: null })
    await expect(service.beforeApprove(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('FAILS CLOSED when the risk engine cannot answer', async () => {
    const { service } = setup({
      risk: () => Promise.reject(new Error('database unreachable')),
    })
    await expect(service.beforeApprove(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
  })

  it.each(['HOLD', 'BLOCK'])(
    'stops the share on a %s decision',
    async (decision) => {
      const { service } = setup({
        risk: () => Promise.resolve({ decision, reasons: ['x'] }),
      })
      await expect(service.beforeApprove(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    },
  )

  it.each(['ALLOW', 'REVIEW', 'STEP_UP'])(
    'lets the share through on %s',
    async (decision) => {
      const { service } = setup({
        risk: () => Promise.resolve({ decision, reasons: [] }),
      })
      await expect(service.beforeApprove(ctx)).resolves.toBeUndefined()
    },
  )
})

describe('VerificationEventsService — facts to side effects', () => {
  it('meters, receipts and notifies an approval in ONE transaction', async () => {
    const { service, usage, receipts, webhooks, tx } = setup()
    await service.process('APPROVED', REQUEST_ID)

    expect(usage.record).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        kind: 'VERIFIED',
        dedupeKey: `${REQUEST_ID}:VERIFIED`,
        apiKeyId: 'k-1',
      }),
    ])
    expect(receipts.issue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        requestId: REQUEST_ID,
        userId: USER_ID,
        disclosedClaims: ['score_at_least_good'],
      }),
      expect.any(Date),
    )
    expect(webhooks.enqueue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: PARTNER_ID }),
      'verification.approved',
      expect.any(Object),
      `${REQUEST_ID}:VERIFIED`,
    )
    expect(webhooks.kick).toHaveBeenCalled()
  })

  it('sends predicate ANSWERS and claim NAMES — never a claim value — in the webhook', async () => {
    const { service, webhooks } = setup({
      request: approvedRequest({
        resultJson: {
          claims: { score_at_least_good: true, given_name: 'Arjun' },
          withheldClaims: [],
          holderVerified: true,
          replayProtected: true,
        },
        presentation: {
          id: 'pres-1',
          disclosedClaims: ['given_name', 'score_at_least_good'],
          presentedAt: new Date(),
        },
      }),
    })
    await service.process('APPROVED', REQUEST_ID)

    const payload = (webhooks.enqueue.mock.calls[0] as unknown[])[3] as Record<
      string,
      unknown
    >
    expect(payload.predicates).toEqual({ 'score_band:GTE:GOOD': true })
    expect(payload.disclosedClaims).toEqual([
      'given_name',
      'score_at_least_good',
    ])
    expect(JSON.stringify(payload)).not.toContain('Arjun')
  })

  it('trusts the row over the event — a stale APPROVED for a declined request does nothing', async () => {
    const { service, prisma, usage } = setup({
      request: approvedRequest({ status: 'DECLINED' }),
    })
    await service.process('APPROVED', REQUEST_ID)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(usage.record).not.toHaveBeenCalled()
  })

  it('meters and notifies a decline without issuing a receipt', async () => {
    const { service, usage, receipts, webhooks } = setup({
      request: approvedRequest({ status: 'DECLINED', presentation: null }),
    })
    await service.process('DECLINED', REQUEST_ID)
    expect(usage.record).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        kind: 'DECLINED',
        dedupeKey: `${REQUEST_ID}:DECLINED`,
      }),
    ])
    expect(receipts.issue).not.toHaveBeenCalled()
    expect((webhooks.enqueue.mock.calls[0] as unknown[])[2]).toBe(
      'verification.declined',
    )
  })

  it('ignores peer requests (no partner row)', async () => {
    const { service, usage } = setup({
      request: approvedRequest({ partner: null }),
    })
    await service.process('APPROVED', REQUEST_ID)
    expect(usage.record).not.toHaveBeenCalled()
  })

  it('does not kick the dispatcher when nothing new was enqueued (a replay)', async () => {
    const { service, webhooks } = setup()
    webhooks.enqueue.mockResolvedValueOnce(false)
    await service.process('APPROVED', REQUEST_ID)
    expect(webhooks.kick).not.toHaveBeenCalled()
  })
})

describe('VerificationEventsService — notifying the holder', () => {
  const created = (overrides: Record<string, unknown> = {}) => ({
    id: REQUEST_ID,
    partnerId: PARTNER_ID,
    apiKeyId: null,
    createdAt: new Date(),
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    user: { expoPushToken: 'ExponentPushToken[abc]' },
    partner: { name: 'Lion City Lending' },
    ...overrides,
  })

  it('pushes the named holder once, naming the organisation', async () => {
    const { service, push } = setup({ request: created() })
    await service.process('REQUEST_CREATED', REQUEST_ID)
    expect(push.send).toHaveBeenCalledTimes(1)
    const sent = (push.send.mock.calls[0] as unknown[])[0] as {
      token: string
      title: string
      data: Record<string, unknown>
    }
    expect(sent.token).toBe('ExponentPushToken[abc]')
    expect(sent.title).toBe('Lion City Lending is asking to verify you')
    expect(sent.data).toMatchObject({
      kind: 'passport.partner_request',
      requestId: REQUEST_ID,
    })
  })

  it('never re-notifies when the fact was already recorded (reconcile replay)', async () => {
    const { service, push, usage } = setup({ request: created() })
    usage.record.mockResolvedValueOnce(0)
    await service.process('REQUEST_CREATED', REQUEST_ID)
    expect(push.send).not.toHaveBeenCalled()
  })

  it('does not push for an open QR request with no holder, or one already closed', async () => {
    const open = setup({ request: created({ user: null }) })
    await open.service.process('REQUEST_CREATED', REQUEST_ID)
    expect(open.push.send).not.toHaveBeenCalled()

    const closed = setup({ request: created({ status: 'CANCELLED' }) })
    await closed.service.process('REQUEST_CREATED', REQUEST_ID)
    expect(closed.push.send).not.toHaveBeenCalled()
  })
})

describe('VerificationEventsService — reconciliation', () => {
  it('re-processes a terminal request whose fact was never recorded', async () => {
    const { service, prisma, usage } = setup()
    prisma.verifierRequest.findMany
      .mockResolvedValueOnce([{ id: REQUEST_ID, status: 'CONSUMED' }] as never)
      .mockResolvedValueOnce([] as never)
    // REQUEST_CREATED was recorded; VERIFIED was not.
    prisma.partnerUsageEvent.findMany.mockResolvedValueOnce([
      { verifierRequestId: REQUEST_ID, kind: 'REQUEST_CREATED' },
    ] as never)

    await expect(service.reconcile()).resolves.toBe(1)
    expect(usage.record).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ kind: 'VERIFIED' }),
    ])
  })

  it('leaves fully-recorded requests alone', async () => {
    const { service, prisma, usage } = setup()
    prisma.verifierRequest.findMany
      .mockResolvedValueOnce([{ id: REQUEST_ID, status: 'CONSUMED' }] as never)
      .mockResolvedValueOnce([] as never)
    prisma.partnerUsageEvent.findMany.mockResolvedValueOnce([
      { verifierRequestId: REQUEST_ID, kind: 'REQUEST_CREATED' },
      { verifierRequestId: REQUEST_ID, kind: 'VERIFIED' },
    ] as never)

    await expect(service.reconcile()).resolves.toBe(0)
    expect(usage.record).not.toHaveBeenCalled()
  })
})
