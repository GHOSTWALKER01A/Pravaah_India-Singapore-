import type { KeyObject } from 'node:crypto'

import { PASSPORT_ALG, SD_JWT_VC_TYP, KB_JWT_TYP } from '@pravaah/schema'

import {
  b64uEncode,
  generateEs256KeyPair,
  importPrivateKey,
  importPublicKey,
  nowSeconds,
  signCompactJws,
  type EcPrivateJwk,
  type EcPublicJwk,
} from '@/modules/passport/crypto/jose.util'
import {
  buildSdJwtPayload,
  computeSdHash,
  makeDisclosure,
  serializePresentation,
  type Disclosure,
} from '@/modules/passport/crypto/sd-jwt.util'
import { PassportConfig } from '@/modules/passport/passport.config'
import { VerificationService } from '@/modules/passport/services/verification.service'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'

import type { PrismaService } from '@/modules/database/prisma/prisma.service'
import type { AppLogger } from '@pravaah/nestjs-logger'

/**
 * End-to-end verification, driven through the REAL crypto primitives.
 *
 * An issuer keypair, a holder keypair, a genuine SD-JWT, real salted disclosures, and a
 * genuine device-signed KB-JWT — only the database and the key registry are stubbed.
 * That is deliberate: mocking the signatures would test nothing, and every case below is
 * an attack the module exists to stop.
 */

const ISSUER_DID = 'did:web:pravaah.app'
const STATUS_URI = 'https://pravaah.app/api/v1/status/1'
const STATUS_INDEX = 42
const AUDIENCE = 'acme-bank'
const NONCE = 'nonce-0123456789abcdef'
const KID = `${ISSUER_DID}#key-1`

describe('VerificationService', () => {
  const issuer = generateEs256KeyPair()
  const holder = generateEs256KeyPair()

  let service: VerificationService
  let revoked: boolean

  /** Only the credential-number correlation lookup is ever reached. */
  const prisma = {
    credential: { findUnique: jest.fn().mockResolvedValue({ id: 'cred-1' }) },
  } as unknown as PrismaService

  const keys = {
    publicKeyForKid: async (kid: string): Promise<KeyObject | null> =>
      kid === KID ? importPublicKey(issuer.publicJwk) : null,
  } as unknown as KeyManagementService

  const revocation = {
    isRevoked: async (uri: string, index: number): Promise<boolean> =>
      revoked && uri === STATUS_URI && index === STATUS_INDEX,
  } as unknown as RevocationService

  const config = {
    did: () => ISSUER_DID,
    vct: () => 'https://pravaah.app/credentials/financial-reputation-passport/v1',
  } as unknown as PassportConfig

  const logger = {
    child: () => logger,
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as AppLogger

  beforeEach(() => {
    revoked = false
    service = new VerificationService(prisma, keys, revocation, config, logger)
  })

  // ── fixtures ──────────────────────────────────────────────────────────────
  interface Credential {
    jwt: string
    disclosures: Record<string, Disclosure>
  }

  function issueCredential(
    overrides: {
      expiresIn?: number
      holderJwk?: EcPublicJwk
      typ?: string
      signWith?: EcPrivateJwk
      kid?: string
      issuer?: string
      omitStatus?: boolean
    } = {},
  ): Credential {
    const claims: Record<string, unknown> = {
      given_name: 'Asha',
      family_name: 'Sharma',
      nationality: 'IN',
      score_value: 742,
      score_band: 'VERY_GOOD',
      score_at_least_fair: true,
      score_at_least_good: true,
      score_at_least_very_good: true,
      score_at_least_excellent: false,
      confidence: 0.81,
      passport_number: 'XXXXXX789',
    }

    const disclosures: Record<string, Disclosure> = {}
    for (const [name, value] of Object.entries(claims)) {
      disclosures[name] = makeDisclosure(name, value)
    }

    const issuedAt = nowSeconds()
    const payload = buildSdJwtPayload({
      issuer: overrides.issuer ?? ISSUER_DID,
      vct: config.vct(),
      subjectDid: 'did:key:zDnTest',
      holderPublicJwk: overrides.holderJwk ?? holder.publicJwk,
      issuedAt,
      expiresAt: issuedAt + (overrides.expiresIn ?? 3600),
      statusList: { uri: STATUS_URI, index: STATUS_INDEX },
      visibleClaims: {
        document_type: 'FINANCIAL_REPUTATION_PASSPORT',
        issuing_authority: 'PRAVAAH',
        credential_number: 'PR-IN-0000123-4',
        score_scale: { min: 300, max: 900 },
      },
      sdDigests: Object.values(disclosures).map((d) => d.digest),
    })

    if (overrides.omitStatus) delete payload.status

    return {
      jwt: signCompactJws({
        header: {
          alg: PASSPORT_ALG,
          typ: overrides.typ ?? SD_JWT_VC_TYP,
          kid: overrides.kid ?? KID,
        },
        payload,
        privateKey: importPrivateKey(overrides.signWith ?? issuer.privateJwk),
      }),
      disclosures,
    }
  }

  /** What the holder's device does: sign over the exact presentation bytes. */
  function signKeyBinding(args: {
    jwt: string
    disclosures: string[]
    audience?: string
    nonce?: string
    privateJwk?: EcPrivateJwk
    iat?: number
    typ?: string
    sdHashOverride?: string
  }): string {
    return signCompactJws({
      header: { alg: PASSPORT_ALG, typ: args.typ ?? KB_JWT_TYP },
      payload: {
        iat: args.iat ?? nowSeconds(),
        aud: args.audience ?? AUDIENCE,
        nonce: args.nonce ?? NONCE,
        sd_hash:
          args.sdHashOverride ?? computeSdHash(args.jwt, args.disclosures),
      },
      privateKey: importPrivateKey(args.privateJwk ?? holder.privateJwk),
    })
  }

  /** `null` overrides mean "present with NO key binding proof at all". */
  type KbOverrides = Omit<
    Parameters<typeof signKeyBinding>[0],
    'jwt' | 'disclosures'
  >

  function present(
    credential: Credential,
    reveal: string[],
    kbOverrides: KbOverrides | null = {},
  ): string {
    const encoded = reveal.map((name) => credential.disclosures[name]!.encoded)
    const kbJwt =
      kbOverrides === null
        ? undefined
        : signKeyBinding({
            ...kbOverrides,
            jwt: credential.jwt,
            disclosures: encoded,
          })
    return serializePresentation(credential.jwt, encoded, kbJwt)
  }

  // ── the happy path ────────────────────────────────────────────────────────
  it('verifies a genuine presentation and returns ONLY the disclosed claims', async () => {
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band', 'given_name']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(true)
    expect(result.holderVerified).toBe(true)
    expect(result.replayProtected).toBe(true)
    expect(result.credentialNumber).toBe('PR-IN-0000123-4')

    expect(result.claims).toMatchObject({
      score_band: 'VERY_GOOD',
      given_name: 'Asha',
    })
    // Everything the holder withheld is a salted digest and nothing else.
    expect(result.claims).not.toHaveProperty('score_value')
    expect(result.claims).not.toHaveProperty('passport_number')
    expect(result.claims).not.toHaveProperty('family_name')
  })

  it('carries score_scale in the clear so a disclosed band is interpretable', async () => {
    // "VERY_GOOD" is a meaningless token to a foreign lender without the cutoffs. The
    // scale describes the MODEL, never the holder, so it costs no privacy.
    const result = await service.verify({
      presentation: present(issueCredential(), ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })
    expect(result.claims?.score_scale).toEqual({ min: 300, max: 900 })
  })

  it('proves the minimum-disclosure case: one boolean, nothing else', async () => {
    // The strongest privacy claim in the product, and a real credit decision.
    const result = await service.verify({
      presentation: present(issueCredential(), ['score_at_least_good']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
      requiredClaims: ['score_at_least_good'],
    })

    expect(result.valid).toBe(true)
    expect(result.claims?.score_at_least_good).toBe(true)
    expect(result.unsatisfied).toEqual([])
    expect(Object.keys(result.claims ?? {})).toEqual(
      expect.arrayContaining(['score_at_least_good']),
    )
    expect(result.claims).not.toHaveProperty('score_band')
  })

  it('reports a withheld claim as unsatisfied rather than as false', async () => {
    // THE dangerous conflation: reading absence as `false` would decline an applicant
    // who is excellent and simply chose not to answer.
    const result = await service.verify({
      presentation: present(issueCredential(), ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
      requiredClaims: ['score_band', 'passport_number'],
    })

    expect(result.valid).toBe(true)
    expect(result.unsatisfied).toEqual(['passport_number'])
  })

  it('accepts a presentation with zero disclosures', async () => {
    // Still proves "PRAVAAH issued a live passport to the holder of this device".
    const result = await service.verify({
      presentation: present(issueCredential(), []),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })
    expect(result.valid).toBe(true)
    expect(result.holderVerified).toBe(true)
  })

  it('accepts the pre-split shape as well as the combined string', async () => {
    const credential = issueCredential()
    const disclosures = [credential.disclosures.score_band!.encoded]
    const result = await service.verify({
      sdJwt: credential.jwt,
      disclosures,
      kbJwt: signKeyBinding({ jwt: credential.jwt, disclosures }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })
    expect(result.valid).toBe(true)
  })

  // ── 1. issuer signature ───────────────────────────────────────────────────
  it('rejects a credential signed by a key we do not publish', async () => {
    const forged = issueCredential({
      signWith: generateEs256KeyPair().privateJwk,
      kid: 'did:web:evil.example#key-1',
    })
    const result = await service.verify({
      presentation: present(forged, ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('UNKNOWN_ISSUER_KEY')
  })

  it('rejects a credential whose signature does not verify under our own key', async () => {
    // Right `kid`, wrong signing key: the exact shape of an attacker who read our JWKS
    // and assumed naming the key was enough.
    const forged = issueCredential({
      signWith: generateEs256KeyPair().privateJwk,
    })
    const result = await service.verify({
      presentation: present(forged, ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('BAD_ISSUER_SIGNATURE')
  })

  it('rejects an altered score, even with every other field intact', async () => {
    const credential = issueCredential()
    const [header, payloadB64, signature] = credential.jwt.split('.')
    const payload = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    payload.credential_number = 'PR-IN-9999999-9'
    const tampered = `${header}.${b64uEncode(JSON.stringify(payload))}.${signature}`

    const result = await service.verify({
      presentation: serializePresentation(tampered, [], undefined),
    })
    expect(result.valid).toBe(false)
    expect(result.code).toBe('BAD_ISSUER_SIGNATURE')
  })

  // ── 2. type confusion ─────────────────────────────────────────────────────
  it('rejects a correctly-signed token that is not typed as an SD-JWT VC', async () => {
    // A cross-protocol confusion attack: our own signing key also signs status-list
    // credentials and session tokens. Only `dc+sd-jwt` may be read as a passport.
    const wrongType = issueCredential({ typ: 'JWT' })
    const result = await service.verify({
      presentation: present(wrongType, ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('WRONG_TYPE')
  })

  // ── 3. validity window ────────────────────────────────────────────────────
  it('rejects an expired credential', async () => {
    // Past the 120s skew allowance, so this is a genuine expiry rather than clock drift.
    const stale = issueCredential({ expiresIn: -600 })
    const result = await service.verify({
      presentation: present(stale, ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('EXPIRED')
  })

  it('tolerates small clock skew rather than failing a healthy phone', async () => {
    // A device thirty seconds fast must not read as broken to its owner.
    const edge = issueCredential({ expiresIn: -30 })
    const result = await service.verify({
      presentation: present(edge, ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })
    expect(result.valid).toBe(true)
  })

  // ── 4. revocation ─────────────────────────────────────────────────────────
  it('rejects a revoked credential', async () => {
    revoked = true
    const result = await service.verify({
      presentation: present(issueCredential(), ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('REVOKED')
    // No claims leak from a rejected presentation.
    expect(result.claims).toBeUndefined()
  })

  it('rejects a credential carrying no revocation reference at all', async () => {
    // Nothing can show such a credential is live, so it cannot be accepted.
    const result = await service.verify({
      presentation: present(issueCredential({ omitStatus: true }), ['score_band']),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })
    expect(result.valid).toBe(false)
    expect(result.code).toBe('MALFORMED')
  })

  // ── 5. disclosure integrity ───────────────────────────────────────────────
  it('rejects a claim invented by the holder', async () => {
    const credential = issueCredential()
    const forged = makeDisclosure('score_value', 900)
    const disclosures = [
      credential.disclosures.score_band!.encoded,
      forged.encoded,
    ]

    const result = await service.verify({
      presentation: serializePresentation(
        credential.jwt,
        disclosures,
        signKeyBinding({ jwt: credential.jwt, disclosures }),
      ),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('TAMPERED_DISCLOSURE')
  })

  it('rejects the WHOLE presentation when any single disclosure is bad', async () => {
    // Accepting the good ones and ignoring the rest would let an attacker append a
    // forged claim and rely on the verifier reading only the claims it cared about.
    const credential = issueCredential()
    const disclosures = [
      credential.disclosures.score_band!.encoded,
      makeDisclosure('kyc_level', 'GOV_DOC+LIVENESS').encoded,
    ]

    const result = await service.verify({
      presentation: serializePresentation(
        credential.jwt,
        disclosures,
        signKeyBinding({ jwt: credential.jwt, disclosures }),
      ),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.claims).toBeUndefined()
  })

  it('rejects a disclosure lifted from another holder’s credential', async () => {
    const mine = issueCredential()
    const theirs = issueCredential()
    const disclosures = [theirs.disclosures.score_value!.encoded]

    const result = await service.verify({
      presentation: serializePresentation(
        mine.jwt,
        disclosures,
        signKeyBinding({ jwt: mine.jwt, disclosures }),
      ),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('TAMPERED_DISCLOSURE')
  })

  // ── 6. holder key binding ─────────────────────────────────────────────────
  it('rejects a STOLEN credential presented without the holder’s device', async () => {
    // The keystone. Someone who exfiltrates a credential — from a phone backup, or from
    // our own database — cannot present it, because they do not have the key in `cnf`.
    const credential = issueCredential()
    const thief = generateEs256KeyPair()
    const result = await service.verify({
      presentation: present(credential, ['score_band'], {
        privateJwk: thief.privateJwk,
      }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('KEY_BINDING_FAILED')
  })

  it('refuses a presentation with no key binding when replay protection was asked for', async () => {
    // A verifier that issued a nonce is expecting proof of possession. Returning
    // `valid: true` with `holderVerified: false` would invite them to miss that.
    const result = await service.verify({
      presentation: present(issueCredential(), ['score_band'], null),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('KEY_BINDING_MISSING')
  })

  it('rejects a KB-JWT with the wrong type', async () => {
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band'], {
        typ: 'JWT',
      }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('KEY_BINDING_FAILED')
  })

  it('detects disclosures swapped AFTER the holder signed', async () => {
    // The `sd_hash` defence. Without it the signed proof could be kept while the
    // disclosure set was replaced — turning a credential that revealed one boolean into
    // one that revealed an exact score, with the holder's signature still attached.
    const credential = issueCredential()
    const signedOver = [credential.disclosures.score_at_least_good!.encoded]
    const kbJwt = signKeyBinding({ jwt: credential.jwt, disclosures: signedOver })

    const substituted = [
      credential.disclosures.score_value!.encoded,
      credential.disclosures.passport_number!.encoded,
    ]
    const result = await service.verify({
      presentation: serializePresentation(credential.jwt, substituted, kbJwt),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('TAMPERED_DISCLOSURE')
    expect(result.reason).toMatch(/altered in transit/)
  })

  it('rejects a presentation relayed to a DIFFERENT verifier', async () => {
    // A presentation captured at one lender must be useless at another.
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band'], {
        audience: 'other-lender',
      }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('REPLAY_SUSPECTED')
  })

  it('rejects a replayed nonce at the SAME verifier', async () => {
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band'], {
        nonce: 'a-nonce-from-an-earlier-exchange',
      }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('REPLAY_SUSPECTED')
  })

  it('rejects a stale key binding proof', async () => {
    // Five minutes is the whole window an honest tap-and-approve needs. Anything older
    // is a captured proof being reused.
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band'], {
        iat: nowSeconds() - 3600,
      }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('REPLAY_SUSPECTED')
  })

  it('rejects a key binding proof dated in the future', async () => {
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band'], {
        iat: nowSeconds() + 3600,
      }),
      expectedNonce: NONCE,
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(false)
    expect(result.code).toBe('KEY_BINDING_FAILED')
  })

  it('flags a presentation as NOT replay-protected when the verifier omitted a nonce', async () => {
    // A matching audience with no nonce can still be replayed at the same verifier, so
    // only both together count. The flag is how an integrator learns that.
    const credential = issueCredential()
    const result = await service.verify({
      presentation: present(credential, ['score_band']),
      audience: AUDIENCE,
    })

    expect(result.valid).toBe(true)
    expect(result.holderVerified).toBe(true)
    expect(result.replayProtected).toBe(false)
  })

  // ── malformed input ───────────────────────────────────────────────────────
  it('answers malformed input with a verdict, never an exception', async () => {
    for (const presentation of ['', 'not-a-credential', 'a.b.c~~', '~~~']) {
      const result = await service.verify({ presentation })
      expect(result.valid).toBe(false)
      expect(result.code).toBeDefined()
    }
  })

  it('rejects an unsupported digest algorithm', async () => {
    const credential = issueCredential()
    const [header, payloadB64] = credential.jwt.split('.')
    const payload = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    payload._sd_alg = 'sha-1'
    // Re-signed properly, so this tests the algorithm check rather than the signature.
    const resigned = signCompactJws({
      header: { alg: PASSPORT_ALG, typ: SD_JWT_VC_TYP, kid: KID },
      payload,
      privateKey: importPrivateKey(issuer.privateJwk),
    })
    expect(header).toBeDefined()

    const result = await service.verify({
      presentation: serializePresentation(resigned, [], undefined),
    })
    expect(result.valid).toBe(false)
    expect(result.code).toBe('MALFORMED')
    expect(result.reason).toMatch(/digest algorithm/)
  })
})
