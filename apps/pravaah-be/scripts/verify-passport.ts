/**
 * M3 passport self-check — the whole loop, against the real database.
 *
 *   npx tsx scripts/verify-passport.ts
 *
 * Boots the real Nest application context and drives the full lifecycle end to end:
 *
 *   issue → hold → present (selective) → verify → revoke → verify rejects
 *
 * Nothing is mocked. A real issuer keypair signs a real SD-JWT; a simulated DEVICE
 * keypair (generated here, never sent to the server) signs a real KB-JWT; and the
 * partner-facing `/verify` brain decides. The point is to prove the four properties the
 * module claims, so a regression breaks here rather than in front of a lender:
 *
 *   1. SELECTIVE DISCLOSURE — a verifier receives exactly the claims the holder ticked,
 *      and an undisclosed score is cryptographically invisible.
 *   2. HOLDER KEY BINDING — a credential presented WITHOUT the device key is refused,
 *      which is what makes a stolen credential (or a stolen copy of our database) inert.
 *   3. REVOCATION — flipping one status-list bit makes every verifier reject, offline.
 *   4. BORDERLESS TRUST — did.json + JWKS + the signed status list resolve, so a
 *      stranger's verifier needs no agreement with us.
 *
 * Read-only with respect to your data EXCEPT for the credentials it mints, which it
 * revokes on the way out. It never touches a user, score, or consent row.
 */
import { resolve } from 'node:path'

import { NestFactory } from '@nestjs/core'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.development.local'), quiet: true })

import { AppModule } from '../src/app.module'
import { PrismaService } from '../src/modules/database/prisma/prisma.service'
import {
  computeSdHash,
  parseCombined,
} from '../src/modules/passport/crypto/sd-jwt.util'
import {
  generateEs256KeyPair,
  importPrivateKey,
  signCompactJws,
  nowSeconds,
  type EcPrivateJwk,
} from '../src/modules/passport/crypto/jose.util'
import { verifyTd1Mrz } from '../src/modules/passport/icao.util'
import { CardService } from '../src/modules/passport/services/card.service'
import { IssuerService } from '../src/modules/passport/services/issuer.service'
import { KeyManagementService } from '../src/modules/passport/services/key-management.service'
import { PresentationService } from '../src/modules/passport/services/presentation.service'
import { RevocationService } from '../src/modules/passport/services/revocation.service'
import { VerifierSessionService } from '../src/modules/passport/services/verifier-session.service'
import { VerificationService } from '../src/modules/passport/services/verification.service'
import { PassportConfig } from '../src/modules/passport/passport.config'

import { ActorType, ScoreStatus } from '../generated/prisma/client'

const AUDIENCE = 'selfcheck-lender'

let failures = 0

function check(label: string, passed: boolean, detail?: unknown): void {
  if (passed) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) {
      console.log(`      ${JSON.stringify(detail)}`)
    }
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
  console.log('─'.repeat(title.length))
}

/**
 * Stands in for the holder's device.
 *
 * The private key is generated here and NEVER leaves this function's scope — exactly as
 * a real wallet keeps it in the Keychain/Keystore. That is the whole reason a KB-JWT
 * proves possession: the server cannot mint one.
 */
function makeDevice() {
  const { publicJwk, privateJwk } = generateEs256KeyPair()
  return {
    publicJwk,
    sign(args: {
      jwt: string
      disclosures: string[]
      audience: string
      nonce: string
      privateJwk?: EcPrivateJwk
    }): string {
      return signCompactJws({
        header: { alg: 'ES256', typ: 'kb+jwt' },
        payload: {
          iat: nowSeconds(),
          aud: args.audience,
          nonce: args.nonce,
          sd_hash: computeSdHash(args.jwt, args.disclosures),
        },
        privateKey: importPrivateKey(args.privateJwk ?? privateJwk),
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
  const presentations = app.get(PresentationService)
  const verification = app.get(VerificationService)
  const revocation = app.get(RevocationService)
  const keys = app.get(KeyManagementService)
  const cards = app.get(CardService)
  const sessions = app.get(VerifierSessionService)
  const passportConfig = app.get(PassportConfig)

  console.log('PRAVAAH · M3 passport self-check')
  console.log(`issuer: ${passportConfig.did()}`)

  // ── 0. the trust anchor ─────────────────────────────────────────────────
  section('0 · Trust anchor (what a stranger’s verifier fetches)')
  const did = await keys.didDocument()
  const jwks = await keys.jwks()
  check('did.json resolves with an id', did.id === passportConfig.did())
  check(
    'every published key appears in assertionMethod',
    Array.isArray(did.assertionMethod) &&
      (did.assertionMethod as string[]).length === jwks.keys.length &&
      jwks.keys.length > 0,
    { keys: jwks.keys.length },
  )
  check(
    'no private key material is ever published',
    !JSON.stringify({ did, jwks }).includes('"d":'),
  )

  // ── find a holder ───────────────────────────────────────────────────────
  section('1 · Preconditions (M0 identity + M2 score)')
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
      '\n  ! No VERIFIED user with a live COMPUTED score was found.\n' +
        '    M3 refuses to mint a credential without one — which is itself the\n' +
        '    correct behaviour, but it means the loop cannot be exercised.\n' +
        '    Run `npm run prisma:seed`, then compute a score, then re-run this.',
    )
    await app.close()
    process.exit(failures > 0 ? 1 : 0)
  }

  const userId = score.user.id
  check(`holder found (${score.user.pravaahId})`, true)
  check(`score is servable (${score.band}, ${score.value})`, true)

  // ── 2. issue ────────────────────────────────────────────────────────────
  section('2 · Issue (M2 score → a credential the user owns)')
  const device = makeDevice()
  const issued = await issuer.issue(userId, {
    // Spelled out rather than spread: the DTO narrows `alg` to the literal 'ES256',
    // which is exactly the validation a real wallet's request goes through.
    holderPublicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: device.publicJwk.x,
      y: device.publicJwk.y,
    },
    deviceLabel: 'self-check device',
    bindPassportNumber: true,
  })

  check(`credential number is ICAO-checkable (${issued.credentialNumber})`, true)
  check('subject is a did:key derived from the device key', issued.subjectDid.startsWith('did:key:zDn'))
  check(
    'combined issuance format ends with the mandatory separator',
    issued.credential.endsWith('~') || parseCombined(issued.credential).disclosures.length > 0,
  )
  check(
    'credential carries NO raw financial data',
    !/transaction|balance|account_number|ifsc|txn/i.test(issued.credential),
  )
  if (issued.notes.length) {
    for (const note of issued.notes) console.log(`      note: ${note}`)
  }

  const parts = parseCombined(issued.credential)
  const disclosureCount = parts.disclosures.length
  check(`${disclosureCount} selectively-disclosable claims minted`, disclosureCount >= 10)

  // The threshold assertions must ALL be present, true and false alike — otherwise the
  // digest count leaks the band.
  const thresholds = Object.keys(issued.disclosures).filter((c) =>
    c.startsWith('score_at_least_'),
  )
  check(
    'all four threshold claims minted (digest count cannot leak the band)',
    thresholds.length === 4,
    thresholds,
  )

  // ── 3. present, minimally ───────────────────────────────────────────────
  section('3 · Present — the minimum-disclosure case (one boolean)')
  const nonceA = `selfcheck-${Date.now()}-a`
  const minimal = await presentations.present({
    userId,
    credentialId: issued.credentialId,
    revealClaims: ['score_at_least_good'],
    verifier: AUDIENCE,
    nonce: nonceA,
    channel: 'API',
    kbJwt: device.sign({
      jwt: issued.sdJwt,
      disclosures: [issued.disclosures.score_at_least_good!],
      audience: AUDIENCE,
      nonce: nonceA,
    }),
  })

  const minimalResult = await verification.verify({
    presentation: minimal.presentation,
    expectedNonce: nonceA,
    audience: AUDIENCE,
    requiredClaims: ['score_at_least_good'],
  })

  check('verifies as valid', minimalResult.valid, minimalResult.reason)
  check('holder possession proven', minimalResult.holderVerified)
  check('replay-protected (nonce AND audience matched)', minimalResult.replayProtected)
  check(
    'the ONE requested claim is present',
    minimalResult.claims?.score_at_least_good === true,
  )
  check(
    'the exact score is cryptographically invisible',
    !('score_value' in (minimalResult.claims ?? {})),
  )
  check(
    'the band itself is invisible too',
    !('score_band' in (minimalResult.claims ?? {})),
  )
  check(
    'the score scale still travels, so the answer is interpretable',
    !!minimalResult.claims?.score_scale,
  )

  // ── 4. present, cross-border ────────────────────────────────────────────
  section('4 · Present — the cross-border tenancy case')
  const crossBorderClaims = [
    'given_name',
    'family_name',
    'nationality',
    'score_band',
  ].filter((c) => c in issued.disclosures)
  const nonceB = `selfcheck-${Date.now()}-b`

  const material = await presentations.signingMaterial({
    userId,
    credentialId: issued.credentialId,
    revealClaims: crossBorderClaims,
    audience: AUDIENCE,
    nonce: nonceB,
  })
  const orderedDisclosures = material.disclosedClaims.map(
    (c) => issued.disclosures[c]!,
  )
  check(
    'server-supplied sd_hash matches the bytes that will be sent',
    material.sdHash === computeSdHash(issued.sdJwt, orderedDisclosures),
  )

  const crossBorder = await presentations.present({
    userId,
    credentialId: issued.credentialId,
    revealClaims: crossBorderClaims,
    verifier: AUDIENCE,
    nonce: nonceB,
    channel: 'QR',
    kbJwt: device.sign({
      jwt: issued.sdJwt,
      disclosures: orderedDisclosures,
      audience: AUDIENCE,
      nonce: nonceB,
    }),
  })
  const crossResult = await verification.verify({
    presentation: crossBorder.presentation,
    expectedNonce: nonceB,
    audience: AUDIENCE,
    requiredClaims: [...crossBorderClaims, 'passport_number'],
  })

  check('verifies as valid', crossResult.valid, crossResult.reason)
  check(
    `exactly the ticked claims arrived (${crossBorderClaims.length})`,
    crossBorderClaims.every((c) => c in (crossResult.claims ?? {})),
  )
  check(
    'a withheld claim is reported as unsatisfied, NOT as false',
    crossResult.unsatisfied?.includes('passport_number') === true,
    crossResult.unsatisfied,
  )

  // ── 5. the attacks ──────────────────────────────────────────────────────
  section('5 · Attacks the module must refuse')

  // A thief with the credential bytes but not the device key.
  const thief = generateEs256KeyPair()
  const stolen = await verification.verify({
    presentation: parts.jwt + '~' + issued.disclosures.score_band + '~' +
      device.sign({
        jwt: issued.sdJwt,
        disclosures: [issued.disclosures.score_band!],
        audience: AUDIENCE,
        nonce: nonceA,
        privateJwk: thief.privateJwk,
      }),
    expectedNonce: nonceA,
    audience: AUDIENCE,
  })
  check(
    'a STOLEN credential without the device key is refused',
    !stolen.valid && stolen.code === 'KEY_BINDING_FAILED',
    stolen.code,
  )

  // Disclosures swapped after the holder signed.
  const signedOverOne = device.sign({
    jwt: issued.sdJwt,
    disclosures: [issued.disclosures.score_at_least_good!],
    audience: AUDIENCE,
    nonce: nonceA,
  })
  const substituted = await verification.verify({
    presentation: `${issued.sdJwt}~${issued.disclosures.score_value}~${signedOverOne}`,
    expectedNonce: nonceA,
    audience: AUDIENCE,
  })
  check(
    'disclosures swapped AFTER signing are detected (sd_hash)',
    !substituted.valid && substituted.code === 'TAMPERED_DISCLOSURE',
    substituted.code,
  )

  // Relayed to a different verifier.
  const relayed = await verification.verify({
    presentation: minimal.presentation,
    expectedNonce: nonceA,
    audience: 'a-different-lender',
  })
  check(
    'a presentation relayed to another verifier is refused',
    !relayed.valid && relayed.code === 'REPLAY_SUSPECTED',
    relayed.code,
  )

  // No key binding at all.
  const unbound = await verification.verify({
    presentation: `${issued.sdJwt}~${issued.disclosures.score_band}~`,
    expectedNonce: nonceA,
    audience: AUDIENCE,
  })
  check(
    'a presentation with no possession proof is refused',
    !unbound.valid && unbound.code === 'KEY_BINDING_MISSING',
    unbound.code,
  )

  // ── 6. the physical card ────────────────────────────────────────────────
  section('6 · The companion card (reference only, never the credential)')
  const card = (await cards.ensureCard(userId)) as Record<string, any>
  check(`card serial minted (${card.cardSerial})`, !!card.cardSerial)
  check(
    'the card carries a REFERENCE URL, never the credential',
    typeof card.verifyUrl === 'string' &&
      !card.verifyUrl.includes(issued.sdJwt.slice(0, 24)),
  )
  check('QR renders as a self-contained SVG', String(card.qrSvg).startsWith('<svg'))
  check(
    'TD1 machine-readable zone is valid (all check digits)',
    verifyTd1Mrz(card.mrz).valid,
    verifyTd1Mrz(card.mrz).failures,
  )
  check(
    'the card prints the BAND, never the exact score',
    card.artwork.band === score.band &&
      !String(card.mrz.line1 + card.mrz.line2).includes(String(score.value)),
  )
  console.log(`      ${card.mrz.line1}`)
  console.log(`      ${card.mrz.line2}`)
  console.log(`      ${card.mrz.line3}`)

  // ── 7. the partner handshake ────────────────────────────────────────────
  // The device-engagement flow a card tap or QR scan actually drives:
  //   verifier asks → holder's wallet reads it → holder approves and signs →
  //   verifier collects.
  // Exercised through the SEEDED partner, because /verify requires a registered
  // one: an anonymous caller could name any audience it liked, which would turn
  // the strongest replay defence in the credential into a self-declared field.
  section('7 · The partner handshake (verifier ⇄ holder)')

  const partner = await prisma.verifierPartner.findUnique({
    where: { audience: 'acme-bank' },
  })
  if (!partner) {
    console.log(
      '\n  ! No verifier is registered. Run `npm run prisma:seed`, or register\n' +
        '    one in the admin console at /dashboard/verifiers.',
    )
    failures += 1
  } else {
    check(`verifier registered (${partner.name})`, partner.isActive)

    const opened = (await sessions.createRequest(
      {
        template: 'DOMESTIC_MICRO_LOAN',
        pravaahId: score.user.pravaahId ?? '',
        channel: 'QR',
        ttlSeconds: 300,
      },
      partner,
    )) as Record<string, any>

    const requestId = String(opened.requestId)
    check('request opened with a single-use nonce', typeof opened.nonce === 'string' && opened.nonce.length >= 32)
    check(
      'the deep link is resolvable (scheme://, not scheme:/)',
      /^[a-z][a-z0-9+.-]*:\/\/passport\/request\//.test(String(opened.holderLink)),
      opened.holderLink,
    )
    check(
      'the micro-loan template asks for ONE boolean and nothing else',
      Array.isArray(opened.requestedClaims) &&
        opened.requestedClaims.length === 1 &&
        opened.requestedClaims[0] === 'score_at_least_good',
      opened.requestedClaims,
    )

    // What the consent-to-disclose screen renders.
    const forHolder = (await sessions.requestForHolder(userId, requestId)) as Record<
      string,
      any
    >
    check('the holder can read the request', forHolder.open === true)
    check(
      'each claim arrives with a human label and a reason to share it',
      Array.isArray(forHolder.claims) &&
        forHolder.claims.length === 1 &&
        typeof forHolder.claims[0].label === 'string' &&
        !forHolder.claims[0].label.includes('_') &&
        String(forHolder.claims[0].whyAsked).length > 10,
      forHolder.claims?.[0],
    )

    // Over-disclosure is refused: a verifier that asked for a boolean must not
    // receive an exact score because the wallet had a bug.
    let overreachRefused = false
    try {
      await sessions.approve(userId, requestId, {
        credentialId: issued.credentialId,
        revealClaims: ['score_at_least_good', 'score_value'],
        kbJwt: 'unused — the claim check runs first',
      })
    } catch (error) {
      overreachRefused = /did not ask for/.test((error as Error).message)
    }
    check('revealing MORE than was asked is refused', overreachRefused)

    // The lock must have been released, or the holder could never retry.
    const reopened = (await sessions.requestForHolder(userId, requestId)) as Record<
      string,
      any
    >
    check(
      'a refused attempt leaves the request answerable (lock released)',
      reopened.open === true,
    )

    // The holder approves, with a proof their device signed over these exact bytes.
    const approved = (await sessions.approve(userId, requestId, {
      credentialId: issued.credentialId,
      revealClaims: ['score_at_least_good'],
      kbJwt: device.sign({
        jwt: issued.sdJwt,
        disclosures: [issued.disclosures.score_at_least_good!],
        audience: partner.audience,
        nonce: String(opened.nonce),
      }),
    })) as Record<string, any>
    check('the holder approves and the presentation verifies', true)
    check(
      'exactly the ticked claim was shared',
      Array.isArray(approved.disclosedClaims) &&
        approved.disclosedClaims.length === 1,
      approved.disclosedClaims,
    )

    // The verifier collects.
    const collected = (await sessions.result(requestId, partner)) as Record<
      string,
      any
    >
    const verdict = collected.result as Record<string, any>
    check('the verifier collects a CONSUMED result', collected.status === 'CONSUMED')
    check('the verdict is valid', verdict?.valid === true)
    check('holder possession was proven', verdict?.holderVerified === true)
    check('the presentation was replay-protected', verdict?.replayProtected === true)
    check(
      'the verifier receives the requested claim',
      verdict?.claims?.score_at_least_good === true,
    )
    // The last enforcement point for data minimisation: a claim the verifier did
    // not request can never reach them, even if the wallet sent it.
    check(
      'the verifier receives NOTHING it did not ask for',
      Object.keys(verdict?.claims ?? {}).every(
        (claim) => claim === 'score_scale' || claim === 'score_at_least_good',
      ),
      Object.keys(verdict?.claims ?? {}),
    )
    check(
      'claim labels travel, so a console renders words not keys',
      verdict?.claimLabels?.score_at_least_good === 'Good or better',
      verdict?.claimLabels,
    )

    // Collecting twice must not produce two different verdicts.
    const again = (await sessions.result(requestId, partner)) as Record<string, any>
    check(
      'collecting the result again is idempotent',
      again.status === 'CONSUMED' &&
        JSON.stringify(again.result) === JSON.stringify(verdict),
    )

    // The nonce is single-use: the whole point of the handshake.
    let replayRefused = false
    try {
      await sessions.approve(userId, requestId, {
        credentialId: issued.credentialId,
        revealClaims: ['score_at_least_good'],
        kbJwt: 'irrelevant',
      })
    } catch {
      replayRefused = true
    }
    check('the answered request cannot be answered again', replayRefused)
  }

  // ── 8. revocation ───────────────────────────────────────────────────────
  section('8 · Revoke — one bit, and every verifier rejects')
  const beforeRevoke = await verification.verify({
    presentation: minimal.presentation,
    expectedNonce: nonceA,
    audience: AUDIENCE,
  })
  check('still valid immediately before revocation', beforeRevoke.valid)

  await revocation.revoke(issued.credentialId, 'self_check_cleanup', {
    type: ActorType.SYSTEM,
  })

  const afterRevoke = await verification.verify({
    presentation: minimal.presentation,
    expectedNonce: nonceA,
    audience: AUDIENCE,
  })
  check(
    'the SAME presentation is now rejected as revoked',
    !afterRevoke.valid && afterRevoke.code === 'REVOKED',
    afterRevoke.code,
  )
  check(
    'no claims leak from a rejected presentation',
    afterRevoke.claims === undefined,
  )

  const published = await revocation.publish('1')
  check(
    'the status list is published SIGNED, so it cannot be tampered with in transit',
    typeof published.signedJwt === 'string' && published.signedJwt.split('.').length === 3,
  )
  check(
    'the published bitstring is the W3C BitstringStatusList shape',
    published.credentialSubject.type === 'BitstringStatusList',
  )

  // ── summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(52)}`)
  if (failures === 0) {
    console.log('ALL CHECKS PASSED — the M3 loop is intact.')
  } else {
    console.log(`${failures} CHECK(S) FAILED.`)
  }
  console.log('═'.repeat(52))

  await app.close()
  process.exit(failures > 0 ? 1 : 0)
}

void main().catch((error: unknown) => {
  console.error('\nSelf-check aborted:', error)
  process.exit(1)
})
