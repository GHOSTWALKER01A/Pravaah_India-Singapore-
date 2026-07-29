import { Inject, Injectable, OnModuleInit } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { PASSPORT_ALG } from '@pravaah/schema'

import { decryptField, encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { ActorType, type IssuerKey } from 'generated/prisma/client'

import { PassportConfig } from '@/modules/passport/passport.config'
import {
  generateEs256KeyPair,
  importPrivateKey,
  importPublicKey,
  jwkThumbprint,
  type EcPrivateJwk,
  type EcPublicJwk,
} from '@/modules/passport/crypto/jose.util'

import type { KeyObject } from 'node:crypto'

/**
 * Issuer keys and the trust anchor — our analogue of the ICAO Public Key
 * Directory.
 *
 * A foreign lender trusts a Pravaah passport because they can fetch our public key
 * from a resolvable `did:web` and check the signature themselves. No bilateral
 * agreement, no integration, no call to us at presentation time. That property is
 * what this service exists to protect, and it dictates the two rules everything
 * here follows:
 *
 *  1. Exactly ONE key signs at a time.
 *  2. Rotated keys are never deleted while a credential they signed is still
 *     alive. Removing a public key from the JWKS breaks every credential it
 *     signed — rotation without that guarantee is just a mass revocation with
 *     extra steps.
 */
@Injectable()
export class KeyManagementService implements OnModuleInit {
  private readonly logger: AppLogger

  /**
   * Imported KeyObjects, cached by kid.
   *
   * Every verification imports a public key, and `createPublicKey` is not free —
   * a partner console verifying in a loop would otherwise re-derive the same
   * curve point on every request. Keys are immutable once written, so the cache
   * can never go stale; a rotation only ADDS an entry.
   */
  private readonly publicKeyCache = new Map<string, KeyObject>()
  private signingCache: { kid: string; key: KeyObject } | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PassportConfig,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: KeyManagementService.name })
  }

  /**
   * Ensure a signing key exists at boot.
   *
   * Self-provisioning rather than requiring a manual step, because the failure
   * mode of the alternative is silent: a deployment with no active key accepts
   * `POST /passport/issue` and fails at the signature, which reads to the user as
   * a broken app rather than a missing key.
   *
   * A key-generation failure is logged and swallowed. It must not stop the whole
   * application from booting — auth, KYC and consent do not depend on M3, and
   * taking them down over a passport key would turn one broken module into an
   * outage.
   */
  async onModuleInit(): Promise<void> {
    try {
      const active = await this.prisma.issuerKey.findFirst({
        where: { isActive: true },
      })
      if (!active) {
        const kid = await this.rotate({ reason: 'bootstrap' })
        this.logger.info(
          `[${this.onModuleInit.name}] Provisioned the first issuer signing key`,
          { kid },
        )
      }
    } catch (error) {
      this.logger.error(
        `[${this.onModuleInit.name}] Could not provision an issuer signing key — passport issuance will fail until this is fixed`,
        { err: error },
      )
    }
  }

  /**
   * Generate a new signing key and demote the current one.
   *
   * Both writes happen in ONE transaction. A crash between them would leave either
   * two active keys (so which one signs becomes a coin flip) or none (so issuance
   * stops), and both states are silent until someone tries to issue.
   */
  async rotate(opts: { reason: string; adminId?: string }): Promise<string> {
    const { publicJwk, privateJwk } = generateEs256KeyPair()
    // Time-based suffix so the kid is unique, ordered, and human-readable in a
    // JWS header — which is where an operator actually reads it during an
    // incident.
    const kid = `${this.config.did()}#key-${Date.now()}`

    await this.prisma.$transaction([
      this.prisma.issuerKey.updateMany({
        where: { isActive: true },
        data: { isActive: false, rotatedAt: new Date() },
      }),
      this.prisma.issuerKey.create({
        data: {
          kid,
          alg: PASSPORT_ALG,
          publicJwk,
          privateKeyEnc: encryptField(JSON.stringify(privateJwk)),
          isActive: true,
        },
      }),
    ])

    this.signingCache = null
    await this.audit.log({
      actorType: opts.adminId ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: opts.adminId ?? null,
      action: 'passport.key_rotated',
      entity: 'IssuerKey',
      metadata: { kid, reason: opts.reason },
    })
    this.logger.warn(`[${this.rotate.name}] Issuer signing key rotated`, {
      kid,
      reason: opts.reason,
    })
    return kid
  }

  /** The key that signs new credentials. */
  async activeSigningKey(): Promise<{
    kid: string
    keyId: string
    privateKey: KeyObject
  }> {
    const row = await this.prisma.issuerKey.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!row) {
      throw new Error(
        'No active issuer signing key — passport issuance is unavailable',
      )
    }

    if (this.signingCache?.kid === row.kid) {
      return { kid: row.kid, keyId: row.id, privateKey: this.signingCache.key }
    }
    const jwk = JSON.parse(decryptField(row.privateKeyEnc)) as EcPrivateJwk
    const privateKey = importPrivateKey(jwk)
    this.signingCache = { kid: row.kid, key: privateKey }
    return { kid: row.kid, keyId: row.id, privateKey }
  }

  /**
   * Resolve a `kid` from a JWS header to its public key.
   *
   * Returns null for an unknown kid rather than throwing: a token signed by a key
   * we do not publish is an ordinary "invalid" answer for a verifier, and the
   * verification path should say so precisely instead of surfacing a 500.
   */
  async publicKeyForKid(kid: string): Promise<KeyObject | null> {
    const cached = this.publicKeyCache.get(kid)
    if (cached) return cached

    const row = await this.prisma.issuerKey.findUnique({ where: { kid } })
    // A retired key is intentionally unresolvable: it is only retired once every
    // credential it signed has expired, so anything still presenting it is stale.
    if (!row || row.retiredAt) return null

    try {
      const key = importPublicKey(row.publicJwk as unknown as EcPublicJwk)
      this.publicKeyCache.set(kid, key)
      return key
    } catch (error) {
      this.logger.error(
        `[${this.publicKeyForKid.name}] Stored issuer public key is unusable`,
        { kid, err: error },
      )
      return null
    }
  }

  /**
   * The `did:web` DID document — the trust anchor a verifier resolves.
   *
   * EVERY non-retired key appears, active or not, and `assertionMethod` lists them
   * all. A verifier checking a credential signed six months ago needs the key from
   * six months ago; publishing only the current one would make rotation a
   * fleet-wide invalidation.
   */
  async didDocument(): Promise<Record<string, unknown>> {
    const did = this.config.did()
    const keys = await this.publishableKeys()

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1',
      ],
      id: did,
      verificationMethod: keys.map((key) => ({
        id: key.kid,
        type: 'JsonWebKey2020',
        controller: did,
        publicKeyJwk: {
          ...(key.publicJwk as unknown as EcPublicJwk),
          alg: key.alg,
          use: 'sig',
        },
      })),
      // Credentials are ASSERTIONS about the holder, so the keys that sign them
      // belong in assertionMethod. `authentication` is deliberately absent: this
      // DID never authenticates as itself, it only attests about others.
      assertionMethod: keys.map((key) => key.kid),
      service: [
        {
          id: `${did}#jwks`,
          type: 'JsonWebKeySet',
          serviceEndpoint: `${this.config.publicUrl()}/.well-known/jwks.json`,
        },
      ],
    }
  }

  /** The JWKS, for verifiers that prefer a plain key set to DID resolution. */
  async jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
    const keys = await this.publishableKeys()
    return {
      keys: keys.map((key) => ({
        ...(key.publicJwk as unknown as EcPublicJwk),
        kid: key.kid,
        alg: key.alg,
        use: 'sig',
      })),
    }
  }

  /** Admin view. Never includes a private key, whatever the caller's role. */
  async list(): Promise<
    Array<{
      id: string
      kid: string
      alg: string
      isActive: boolean
      thumbprint: string
      createdAt: Date
      rotatedAt: Date | null
      retiredAt: Date | null
      credentialCount: number
    }>
  > {
    const rows = await this.prisma.issuerKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { credentials: true } } },
    })
    return rows.map((row) => ({
      id: row.id,
      kid: row.kid,
      alg: row.alg,
      isActive: row.isActive,
      thumbprint: jwkThumbprint(row.publicJwk as unknown as EcPublicJwk),
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
      retiredAt: row.retiredAt,
      credentialCount: row._count.credentials,
    }))
  }

  /**
   * Retire keys whose every credential has expired.
   *
   * The condition is strict — no credential of ANY status still in the future —
   * because a REVOKED credential must still verify: a verifier has to be able to
   * check the signature before it can meaningfully reach the revocation check. A
   * signature it cannot verify at all yields "unknown issuer key", which reads as
   * a broken issuer rather than a revoked credential.
   */
  async retireExhaustedKeys(): Promise<number> {
    const candidates = await this.prisma.issuerKey.findMany({
      where: { isActive: false, retiredAt: null, rotatedAt: { not: null } },
      select: { id: true, kid: true },
    })
    if (!candidates.length) return 0

    let retired = 0
    for (const key of candidates) {
      const live = await this.prisma.credential.count({
        where: { issuerKeyId: key.id, expiresAt: { gt: new Date() } },
      })
      if (live > 0) continue

      await this.prisma.issuerKey.update({
        where: { id: key.id },
        data: { retiredAt: new Date() },
      })
      this.publicKeyCache.delete(key.kid)
      retired += 1
      this.logger.info(
        `[${this.retireExhaustedKeys.name}] Retired an exhausted issuer key`,
        { kid: key.kid },
      )
    }
    return retired
  }

  private publishableKeys(): Promise<IssuerKey[]> {
    return this.prisma.issuerKey.findMany({
      where: { retiredAt: null },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })
  }
}
