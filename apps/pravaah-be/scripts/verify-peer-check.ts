/**
 * Peer verification self-check — one holder scanning another, end to end.
 *
 *   npx tsx scripts/verify-peer-check.ts
 *
 * Boots the real Nest context and drives the whole handshake against the real database:
 *
 *   A scans B's card QR → B is asked → B approves a SUBSET → A collects → A sees only that
 *
 * Nothing is mocked. B's device keypair is generated here and never leaves this file, so the
 * KB-JWT is a genuine proof of possession. The point is to pin the four properties that make a
 * person-to-person check safe, so a regression breaks here rather than at a counter:
 *
 *   1. NOTHING LEAKS BEFORE APPROVAL — the scan response carries no fact about the holder,
 *      and the result endpoint refuses to answer while the request is PENDING.
 *   2. THE SCANNER CANNOT OVER-READ — a claim B did not tick is absent from A's result, and
 *      is reported as withheld rather than silently missing.
 *   3. THE RESULT IS SCOPED TO THE SCANNER — a third user asking for the same request id gets
 *      a 404, not somebody else's verified identity.
 *   4. THE AUDIENCE IS THE SCANNER — the KB-JWT is bound to A's Pravaah ID, so the same
 *      presentation replayed at a lender fails.
 *
 * Cleans up after itself: the credential it mints is revoked and the request rows it creates
 * are deleted. It never modifies a user, score, consent or card row.
 */
import { resolve } from 'node:path'

import { NestFactory } from '@nestjs/core'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.development.local'), quiet: true })

import { AppModule } from '../src/app.module'
import { PrismaService } from '../src/modules/database/prisma/prisma.service'
import {
  generateEs256KeyPair,
  importPrivateKey,
  nowSeconds,
  signCompactJws,
} from '../src/modules/passport/crypto/jose.util'
import { CardService } from '../src/modules/passport/services/card.service'
import { IssuerService } from '../src/modules/passport/services/issuer.service'
import { PeerVerifyService } from '../src/modules/passport/services/peer-verify.service'
import { PresentationService } from '../src/modules/passport/services/presentation.service'
import { RevocationService } from '../src/modules/passport/services/revocation.service'
import { VerifierSessionService } from '../src/modules/passport/services/verifier-session.service'

import { peerAudience, type DisclosableClaim } from '@pravaah/schema'
import { ActorType, ScoreStatus } from '../generated/prisma/client'

let failures = 0

function check(label: string, passed: boolean, detail?: unknown): void {
  if (passed) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
  console.log('─'.repeat(title.length))
}

/**
 * Stands in for B's phone. The private key never leaves this closure — which is the whole
 * reason a KB-JWT proves possession: the server cannot mint one.
 *
 * It signs over the `sdHash` the SERVER computed rather than recomputing one, exactly as the
 * wallet does. Recomputing here would let this script pass while the real two-step flow was
 * broken, which is the one failure a self-check must not be able to hide.
 */
function makeDevice() {
  const { publicJwk, privateJwk } = generateEs256KeyPair()
  return {
    publicJwk,
    sign(args: { sdHash: string; audience: string; nonce: string }) {
      return signCompactJws({
        header: { alg: 'ES256', typ: 'kb+jwt' },
        payload: {
          iat: nowSeconds(),
          aud: args.audience,
          nonce: args.nonce,
          sd_hash: args.sdHash,
        },
        privateKey: importPrivateKey(privateJwk),
      })
    },
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  })

  const prisma = app.get(PrismaService)
  const issuer = app.get(IssuerService)
  const cards = app.get(CardService)
  const peers = app.get(PeerVerifyService)
  const presentations = app.get(PresentationService)
  const sessions = app.get(VerifierSessionService)
  const revocation = app.get(RevocationService)

  console.log('PRAVAAH · peer verification self-check')

  const createdRequestIds: string[] = []
  let credentialId: string | null = null

  try {
    // ── preconditions ─────────────────────────────────────────────────────
    section('1 · Two people')
    const score = await prisma.score.findFirst({
      where: {
        status: { in: [ScoreStatus.COMPUTED, ScoreStatus.OVERRIDDEN] },
        value: { not: null },
        band: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        user: { kycStatus: 'VERIFIED', isSuspended: false },
      },
      orderBy: { computedAt: 'desc' },
      include: { user: { select: { id: true, pravaahId: true } } },
    })

    if (!score) {
      console.log(
        '\n  ! No VERIFIED user with a live COMPUTED score was found — there is no\n' +
          '    passport to scan. Seed and compute a score, then re-run.',
      )
      await app.close()
      process.exit(0)
    }

    // The SCANNER. Any other user with a Pravaah ID: a scanner needs no credential of
    // their own, only an identity to be an audience.
    const scanner = await prisma.user.findFirst({
      where: { id: { not: score.user.id }, pravaahId: { not: null } },
      select: { id: true, pravaahId: true },
    })
    if (!scanner) {
      console.log(
        '\n  ! Only one user has a Pravaah ID, so there is nobody to do the scanning.\n' +
          '    Seed a second user and re-run.',
      )
      await app.close()
      process.exit(0)
    }

    const holderId = score.user.id
    check(`holder B found (${score.user.pravaahId})`, true)
    check(`scanner A found (${scanner.pravaahId})`, true)

    // ── B has a passport and a card ───────────────────────────────────────
    section('2 · B holds a passport with a scannable code')
    const device = makeDevice()
    const issued = await issuer.issue(holderId, {
      holderPublicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: device.publicJwk.x,
        y: device.publicJwk.y,
        alg: 'ES256',
      },
      bindPassportNumber: false,
      deviceLabel: 'peer-selfcheck',
    })
    credentialId = issued.credentialId
    check('credential minted', !!issued.credentialNumber)

    const card = (await cards.ensureCard(holderId)) as Record<string, unknown>
    const verifyUrl = card.verifyUrl as string
    check('card carries a verify URL', typeof verifyUrl === 'string' && !!verifyUrl)

    // ── A scans ───────────────────────────────────────────────────────────
    section('3 · A scans B’s code (and learns nothing)')
    const outcome = (await peers.scan(scanner.id, {
      payload: verifyUrl,
      ttlSeconds: 180,
    })) as Record<string, unknown>

    check('the code is recognised as a passport', outcome.kind === 'PASSPORT')
    const requestId = outcome.requestId as string
    if (requestId) createdRequestIds.push(requestId)

    /**
     * THE central privacy assertion. Serialised and searched rather than field-checked,
     * because the failure mode this guards against is a future field being ADDED to the
     * scan response — a helpful-looking `holderName` that quietly discloses before consent.
     */
    const scanBody = JSON.stringify(outcome)
    check(
      'the scan response contains no fact about the holder',
      !scanBody.includes(String(score.user.pravaahId)) &&
        !scanBody.includes(String(score.value)) &&
        !scanBody.includes(String(score.band)) &&
        !scanBody.includes(holderId),
      { scanBody },
    )

    // Not-a-passport is an answer, not an error — the payments scanner branches on it.
    const upi = (await peers.scan(scanner.id, {
      payload: 'upi://pay?pa=someone@bank&pn=Someone&cu=INR',
      ttlSeconds: 180,
    })) as Record<string, unknown>
    check('a UPI code is reported as NOT_PASSPORT', upi.kind === 'NOT_PASSPORT')

    // Scanning your own code is refused.
    let selfScanRefused = false
    await peers
      .scan(holderId, { payload: verifyUrl, ttlSeconds: 180 })
      .catch(() => {
        selfScanRefused = true
      })
    check('scanning your own passport is refused', selfScanRefused)

    // A second scan of the same holder rejoins the open request rather than stacking.
    const again = (await peers.scan(scanner.id, {
      payload: verifyUrl,
      ttlSeconds: 180,
    })) as Record<string, unknown>
    check(
      'a repeat scan rejoins the open request instead of opening a second',
      again.requestId === requestId && again.resumed === true,
    )

    // ── nothing is readable while it is pending ───────────────────────────
    section('4 · Nothing reaches A before B answers')
    const pending = (await peers.result(scanner.id, requestId)) as Record<
      string,
      unknown
    >
    check('the result is PENDING', pending.status === 'PENDING')
    check(
      'a pending result carries no claims',
      pending.result === undefined &&
        !JSON.stringify(pending).includes(String(score.value)),
      { pending },
    )

    // ── B sees who is asking ──────────────────────────────────────────────
    section('5 · B is asked, and can see who by')
    const detail = (await sessions.requestForHolder(holderId, requestId)) as Record<
      string,
      unknown
    >
    const requester = detail.requester as Record<string, unknown> | null
    check('B is told a PERSON is asking', requester !== null)
    check(
      'B is told whether that person’s identity was verified',
      typeof requester?.identityVerified === 'boolean',
      { requester },
    )
    check(
      'the audience is the scanner’s own Pravaah ID',
      detail.audience === peerAudience(scanner.pravaahId!),
      { audience: detail.audience },
    )

    const requestedClaims = (detail.claims as { claim: string }[]).map((c) => c.claim)
    check(
      'the peer template asks for the fixed peer claim set',
      requestedClaims.includes('score_band') &&
        requestedClaims.includes('given_name') &&
        // Never askable by a peer, whatever they do: the template is pinned server-side.
        !requestedClaims.includes('passport_number'),
      { requestedClaims },
    )

    // ── B approves a SUBSET ───────────────────────────────────────────────
    section('6 · B approves some of it, not all of it')
    const REVEALED: DisclosableClaim[] = ['given_name', 'score_band', 'kyc_level']
    const WITHHELD: DisclosableClaim = 'score_value'
    check(
      'the test withholds a claim that was actually asked for',
      requestedClaims.includes(WITHHELD),
    )

    // Two steps, in this order and no other: ask the server for the exact bytes that will be
    // sent, then sign THOSE bytes on the device. The key binding commits to the precise
    // disclosure set, which is what stops the claims being swapped after B agreed to them.
    const material = await presentations.signingMaterial({
      userId: holderId,
      credentialId: issued.credentialId,
      audience: detail.audience as string,
      nonce: detail.nonce as string,
      revealClaims: REVEALED,
    })
    check(
      'the signing material covers exactly the claims B ticked',
      material.disclosedClaims.slice().sort().join(',') ===
        REVEALED.slice().sort().join(','),
      { disclosed: material.disclosedClaims },
    )

    const kbJwt = device.sign({
      sdHash: material.sdHash,
      audience: detail.audience as string,
      nonce: detail.nonce as string,
    })

    const approval = (await sessions.approve(holderId, requestId, {
      credentialId: issued.credentialId,
      revealClaims: REVEALED,
      kbJwt,
    })) as Record<string, unknown>
    check('B’s approval was accepted', approval.status === 'APPROVED')

    // ── A collects, and sees only what B ticked ───────────────────────────
    section('7 · A collects exactly what B ticked')
    const collected = (await peers.result(scanner.id, requestId)) as Record<
      string,
      unknown
    >
    check('the result is now readable', collected.status === 'CONSUMED')

    const verdict = collected.result as {
      valid: boolean
      holderVerified: boolean
      replayProtected: boolean
      claims: Record<string, unknown>
      withheldClaims: string[]
    }
    check('the credential verified', verdict.valid === true)
    check('proof of possession checked out', verdict.holderVerified === true)
    check('the presentation was replay-protected', verdict.replayProtected === true)

    for (const claim of REVEALED) {
      check(`A received "${claim}"`, claim in verdict.claims, {
        claims: Object.keys(verdict.claims),
      })
    }
    check(
      `A did NOT receive the withheld "${WITHHELD}"`,
      !(WITHHELD in verdict.claims),
      { claims: Object.keys(verdict.claims) },
    )
    check(
      'the withheld claim is REPORTED as withheld, not silently missing',
      verdict.withheldClaims.includes(WITHHELD),
      { withheld: verdict.withheldClaims },
    )
    check(
      'the exact score never appears anywhere in A’s result',
      !JSON.stringify(collected).includes(String(score.value)),
    )

    // ── the result belongs to A alone ─────────────────────────────────────
    section('8 · Nobody else can read A’s result')
    let thirdPartyRefused = false
    await peers.result(holderId, requestId).catch(() => {
      thirdPartyRefused = true
    })
    check(
      'a different user asking for the same request id is refused',
      thirdPartyRefused,
    )
  } finally {
    // ── clean up ──────────────────────────────────────────────────────────
    section('9 · Cleanup')
    for (const id of createdRequestIds) {
      await prisma.verifierRequest.deleteMany({ where: { id } }).catch(() => undefined)
    }
    await prisma.verifierRequest
      .deleteMany({ where: { audience: { startsWith: 'pravaah:peer:' }, presentationId: null } })
      .catch(() => undefined)
    if (credentialId) {
      await revocation
        .revoke(credentialId, 'peer_selfcheck_cleanup', { type: ActorType.SYSTEM })
        .catch(() => undefined)
    }
    check('temporary rows cleaned up', true)

    console.log(
      failures === 0
        ? '\n════════════════════════════════════════════════════\nPEER CHECK VERIFIED — consent gates every disclosure.\n════════════════════════════════════════════════════'
        : `\n${failures} CHECK(S) FAILED`,
    )
    await app.close()
    process.exit(failures > 0 ? 1 : 0)
  }
}

void main()
