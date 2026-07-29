import {
  buildPravaahId,
  peerAudience,
  PRESENTATION_TEMPLATES,
} from '@pravaah/schema'

import { PeerVerifyService } from '@/modules/passport/services/peer-verify.service'

import type { AppLogger } from '@pravaah/nestjs-logger'
import type { PrismaService } from '@/modules/database/prisma/prisma.service'

/**
 * Peer verification — the invariants that keep a person-to-person check honest.
 *
 * Every case below is something that, if it regressed, would leak a stranger's identity or
 * their score to somebody who never got permission for it. The database is stubbed and the
 * crypto is not exercised here (the SD-JWT machinery has its own suite in
 * `verification.service.spec.ts`) — what is under test is the CONSENT GATE and the
 * classification in front of it, which is where this feature can actually go wrong.
 */

const SCANNER_ID = '11111111-1111-4111-8111-111111111111'
/**
 * Minted, not written out by hand.
 *
 * The first draft of this file used the ID from the documentation and every test failed:
 * `PVH-4K7Q-M2XB-9T3F` is an illustrative string, not a checksum-valid identifier, and the
 * audience builder correctly refused it. Deriving one from the real generator is both the fix
 * and a check in its own right — a peer audience is only stable because the ID behind it is
 * self-verifying, so a fixture that skipped the checksum would be testing a different system.
 */
const SCANNER_PVH = buildPravaahId(Uint8Array.from([7, 3, 11, 29, 4, 18, 22, 9, 31, 14, 2]))
const HOLDER_ID = '22222222-2222-4222-8222-222222222222'
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333'
const CARD_REF = 'AbCdEfGhIjKlMnOpQrStUv'
const VERIFY_URL = `https://pravaah.app/api/v1/verify/card/${CARD_REF}`

const logger = {
  child: () => logger,
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as AppLogger

/**
 * A Prisma stub whose card/user tables can be reconfigured per test.
 *
 * Hand-rolled rather than `jest.mock`ed on the module, so a test that expects a query NOT to
 * happen can assert on the call count — which is how "a UPI payload never reaches the
 * database" is proved rather than asserted.
 */
function makePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  const card = {
    userId: HOLDER_ID,
    credentialId: CREDENTIAL_ID,
    status: 'ACTIVE',
    cardSerial: 'CARD-PR-IN-0000123-4',
  }
  const state = {
    card: card as Record<string, unknown> | null,
    holderSuspended: false,
    openRequest: null as Record<string, unknown> | null,
    ...overrides,
  }

  const prisma = {
    __state: state,
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === SCANNER_ID) {
          return { id: SCANNER_ID, pravaahId: SCANNER_PVH, kycStatus: 'VERIFIED' }
        }
        if (where.id === HOLDER_ID) {
          return {
            id: HOLDER_ID,
            isSuspended: state.holderSuspended,
            expoPushToken: null,
          }
        }
        return null
      }),
    },
    passportCard: { findUnique: jest.fn(async () => state.card) },
    verifierRequest: {
      findFirst: jest.fn(async () => state.openRequest),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'req-1',
        ...data,
      })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    credential: { findUnique: jest.fn(async () => null) },
  }
  return prisma as unknown as PrismaService & typeof prisma
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new PeerVerifyService(
    prisma,
    { walletRequestLink: (id: string) => `parvaahrn://passport/request/${id}` } as never,
    { send: jest.fn(async () => ({ sent: true })) } as never,
    { log: jest.fn(async () => undefined) } as never,
    logger,
  )
}

describe('PeerVerifyService.scan — what counts as a passport code', () => {
  it.each([
    ['the printed card URL', VERIFY_URL],
    ['the same URL without a scheme', `pravaah.app/api/v1/verify/card/${CARD_REF}`],
    ['an ngrok tunnel URL', `https://1a2b-34-56.ngrok-free.app/api/v1/verify/card/${CARD_REF}`],
    ['a URL with a trailing slash', `${VERIFY_URL}/`],
    ['a URL with a query string', `${VERIFY_URL}?template=IDENTITY_ONLY`],
  ])('recognises %s', async (_label, payload) => {
    const prisma = makePrisma()
    const result = await makeService(prisma).scan(SCANNER_ID, {
      payload,
      ttlSeconds: 180,
    })
    expect(result.kind).toBe('PASSPORT')
  })

  /**
   * The EMVCo case is not hypothetical — it is the bug this suite found.
   *
   * An earlier classifier accepted a bare `[A-Za-z0-9_-]{20,44}` token as a card reference,
   * and a real EMVCo payment payload matches that shape exactly. A bare reference is now
   * refused outright, because nothing in the system emits one: the NFC tag is written with
   * the same verify URL the QR carries.
   */
  it.each([
    ['a UPI intent', 'upi://pay?pa=someone@bank&pn=Someone&cu=INR&am=100'],
    ['an EMVCo payment payload', '00020101021226580014A0000005240101'],
    ['a bare token that merely looks like a reference', CARD_REF],
    ['a plain URL', 'https://example.com/hello'],
    ['a lookalike path with too short a reference', 'https://pravaah.app/api/v1/verify/card/abc'],
    ['empty-ish junk', '....'],
  ])('reports %s as NOT_PASSPORT', async (_label, payload) => {
    const prisma = makePrisma()
    const result = await makeService(prisma).scan(SCANNER_ID, {
      payload,
      ttlSeconds: 180,
    })
    expect(result.kind).toBe('NOT_PASSPORT')
  })

  /**
   * The payments scan is the overwhelmingly common one, and it must not pay for this
   * feature. A payload that cannot be a passport is rejected on shape alone, before the
   * scanner is even looked up.
   */
  it('never touches the database for a payment payload', async () => {
    const prisma = makePrisma()
    await makeService(prisma).scan(SCANNER_ID, {
      payload: 'upi://pay?pa=someone@bank',
      ttlSeconds: 180,
    })
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(prisma.passportCard.findUnique).not.toHaveBeenCalled()
  })

  /**
   * An unknown reference is NOT_PASSPORT rather than "no such card".
   *
   * Distinguishing the two would let a scanner walk the reference space and learn which
   * codes exist — a slow oracle, but an oracle.
   */
  it('does not confirm whether an unknown reference exists', async () => {
    const prisma = makePrisma({ card: null })
    const result = await makeService(prisma).scan(SCANNER_ID, {
      payload: VERIFY_URL,
      ttlSeconds: 180,
    })
    expect(result.kind).toBe('NOT_PASSPORT')
  })
})

describe('PeerVerifyService.scan — the consent gate', () => {
  it('discloses nothing about the holder in the scan response', async () => {
    const prisma = makePrisma()
    const result = await makeService(prisma).scan(SCANNER_ID, {
      payload: VERIFY_URL,
      ttlSeconds: 180,
    })

    // Serialised and searched rather than field-checked, because the regression this
    // guards against is a future field being ADDED — a helpful-looking `holderName` that
    // quietly discloses before consent.
    const body = JSON.stringify(result)
    expect(body).not.toContain(HOLDER_ID)
    expect(body).not.toContain(CREDENTIAL_ID)
    expect(body).not.toContain('CARD-PR-IN')
    // The reference itself is not echoed either: it is the holder's, not the scanner's.
    expect(body).not.toContain(CARD_REF)
  })

  it('binds the request to the scanner’s own Pravaah ID as the audience', async () => {
    const prisma = makePrisma()
    await makeService(prisma).scan(SCANNER_ID, { payload: VERIFY_URL, ttlSeconds: 180 })

    const created = prisma.verifierRequest.create.mock.calls[0]![0] as {
      data: Record<string, unknown>
    }
    expect(created.data.audience).toBe(peerAudience(SCANNER_PVH))
    expect(created.data.requestedByUserId).toBe(SCANNER_ID)
    // No partner: a person is not an institution, and `partnerId` staying null is what the
    // result read keys off to scope to the scanner instead.
    expect(created.data.partnerId).toBeNull()
  })

  /**
   * The peer template is pinned server-side and is not a parameter.
   *
   * Letting the scanner name a template would mean any user could aim `CROSS_BORDER_RENTAL`
   * at a stranger and ask for their passport number.
   */
  it('always asks for exactly the peer template, and never for a passport number', async () => {
    const prisma = makePrisma()
    await makeService(prisma).scan(SCANNER_ID, { payload: VERIFY_URL, ttlSeconds: 180 })

    const created = prisma.verifierRequest.create.mock.calls[0]![0] as {
      data: { requestedClaims: string[]; template: string }
    }
    expect(created.data.template).toBe('PEER_INTRODUCTION')
    expect(created.data.requestedClaims).toEqual([
      ...PRESENTATION_TEMPLATES.PEER_INTRODUCTION.claims,
    ])
    expect(created.data.requestedClaims).not.toContain('passport_number')
    expect(created.data.requestedClaims).not.toContain('birth_date')
  })

  it('refuses a scan of your own passport', async () => {
    const prisma = makePrisma()
    // The card belongs to the scanner this time.
    ;(prisma as unknown as { __state: { card: Record<string, unknown> } }).__state.card = {
      userId: SCANNER_ID,
      credentialId: CREDENTIAL_ID,
      status: 'ACTIVE',
      cardSerial: 'CARD-SELF',
    }
    await expect(
      makeService(prisma).scan(SCANNER_ID, { payload: VERIFY_URL, ttlSeconds: 180 }),
    ).rejects.toThrow(/your own passport/i)
  })

  it('refuses a card its owner reported lost', async () => {
    const prisma = makePrisma({
      card: {
        userId: HOLDER_ID,
        credentialId: CREDENTIAL_ID,
        status: 'LOST',
        cardSerial: 'CARD-LOST',
      },
    })
    await expect(
      makeService(prisma).scan(SCANNER_ID, { payload: VERIFY_URL, ttlSeconds: 180 }),
    ).rejects.toThrow(/switched off/i)
  })

  it('refuses to raise a request against a suspended holder', async () => {
    const prisma = makePrisma({ holderSuspended: true })
    await expect(
      makeService(prisma).scan(SCANNER_ID, { payload: VERIFY_URL, ttlSeconds: 180 }),
    ).rejects.toThrow(/cannot be checked/i)
  })

  /**
   * A camera fires on every frame and a person taps twice. Neither may leave the holder
   * with a stack of identical prompts and no way to tell which one the person in front of
   * them is waiting on.
   */
  it('rejoins an already-open request instead of stacking a second', async () => {
    const prisma = makePrisma({
      openRequest: {
        id: 'existing-req',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
        requestedClaims: [...PRESENTATION_TEMPLATES.PEER_INTRODUCTION.claims],
        purpose: PRESENTATION_TEMPLATES.PEER_INTRODUCTION.purpose,
      },
    })
    const result = (await makeService(prisma).scan(SCANNER_ID, {
      payload: VERIFY_URL,
      ttlSeconds: 180,
    })) as Record<string, unknown>

    expect(result.requestId).toBe('existing-req')
    expect(result.resumed).toBe(true)
    expect(prisma.verifierRequest.create).not.toHaveBeenCalled()
  })
})

describe('PeerVerifyService.result — who may read it', () => {
  const base = {
    id: 'req-1',
    requestedByUserId: SCANNER_ID,
    expiresAt: new Date(Date.now() + 60_000),
    resultJson: { valid: true, claims: { score_band: 'GOOD' } },
    user: { primaryCountry: 'INDIA' },
  }

  it('refuses a request raised by somebody else', async () => {
    const prisma = makePrisma()
    prisma.verifierRequest.findUnique = jest.fn(async () => ({
      ...base,
      status: 'CONSUMED',
      requestedByUserId: 'someone-else',
    })) as never

    await expect(makeService(prisma).result(SCANNER_ID, 'req-1')).rejects.toThrow(
      /not found/i,
    )
  })

  /** A pending request must not carry a partial verdict — there is nothing to carry yet. */
  it('returns no claims while the holder has not answered', async () => {
    const prisma = makePrisma()
    prisma.verifierRequest.findUnique = jest.fn(async () => ({
      ...base,
      status: 'PENDING',
    })) as never

    const result = (await makeService(prisma).result(SCANNER_ID, 'req-1')) as Record<
      string,
      unknown
    >
    expect(result.status).toBe('PENDING')
    expect(result.result).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('GOOD')
  })

  it('reports a declined request as a decision, not an error', async () => {
    const prisma = makePrisma()
    prisma.verifierRequest.findUnique = jest.fn(async () => ({
      ...base,
      status: 'DECLINED',
    })) as never

    const result = (await makeService(prisma).result(SCANNER_ID, 'req-1')) as Record<
      string,
      unknown
    >
    expect(result.status).toBe('DECLINED')
    expect(result.result).toBeUndefined()
  })

  it('expires a stale pending request rather than leaving it open forever', async () => {
    const prisma = makePrisma()
    prisma.verifierRequest.findUnique = jest.fn(async () => ({
      ...base,
      status: 'PENDING',
      expiresAt: new Date(Date.now() - 1000),
    })) as never

    const result = (await makeService(prisma).result(SCANNER_ID, 'req-1')) as Record<
      string,
      unknown
    >
    expect(result.status).toBe('EXPIRED')
    expect(prisma.verifierRequest.update).toHaveBeenCalled()
  })

  it('hands over the cached verdict once approved', async () => {
    const prisma = makePrisma()
    prisma.verifierRequest.findUnique = jest.fn(async () => ({
      ...base,
      status: 'APPROVED',
    })) as never

    const result = (await makeService(prisma).result(SCANNER_ID, 'req-1')) as Record<
      string,
      unknown
    >
    expect(result.status).toBe('CONSUMED')
    expect(result.result).toEqual(base.resultJson)
  })
})

describe('PeerVerifyService.describeRequester — what the holder is told', () => {
  it('never exposes the scanner’s score or identifiers', async () => {
    const prisma = makePrisma()
    prisma.user.findUnique = jest.fn(async () => ({
      primaryCountry: 'INDIA',
      kycStatus: 'VERIFIED',
      kycProfile: { verifiedName: 'Arjun Sharma' },
    })) as never

    const requester = await makeService(prisma).describeRequester(SCANNER_ID)
    expect(requester).toEqual({
      name: 'Arjun Sharma',
      givenName: 'Arjun',
      familyName: 'Sharma',
      country: 'INDIA',
      identityVerified: true,
    })
    // A request to see somebody's reputation is not itself a reason to disclose the
    // asker's.
    expect(JSON.stringify(requester)).not.toContain('PVH-')
  })

  /**
   * An unverified scanner is surfaced as such rather than given a name.
   *
   * That is the single strongest reason for a holder to decline, and a name they could
   * not have earned would be an impersonation primitive.
   */
  it('reports an unverified scanner as unverified, with no name', async () => {
    const prisma = makePrisma()
    prisma.user.findUnique = jest.fn(async () => ({
      primaryCountry: 'SINGAPORE',
      kycStatus: 'IN_PROGRESS',
      kycProfile: null,
    })) as never

    const requester = await makeService(prisma).describeRequester(SCANNER_ID)
    expect(requester).toMatchObject({ name: null, identityVerified: false })
  })

  it('returns null when the request had no scanner (a partner asked)', async () => {
    const prisma = makePrisma()
    await expect(makeService(prisma).describeRequester(null)).resolves.toBeNull()
  })
})
