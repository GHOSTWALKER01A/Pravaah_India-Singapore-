import { randomBytes, createHash } from 'node:crypto'

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  CredentialListQueryDto,
  RegisterPartnerDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CredentialStatus,
  Prisma,
} from 'generated/prisma/client'

/**
 * Admin oversight for M3 — the credential-risk surface.
 *
 * Everything here is read-mostly on purpose. The destructive actions (revoke,
 * suspend, resume, key rotation) live in {@link RevocationService} and
 * {@link KeyManagementService} so there is exactly one implementation of each,
 * whether it is a user, an admin, or a scheduler asking. An admin console with its
 * own revocation path is an admin console that eventually revokes differently.
 *
 * The one thing this service is strict about: no projection here ever decrypts a
 * credential. An admin has a legitimate need to see WHICH credentials exist and what
 * state they are in; they have no need to see the claims inside one, and the
 * cleartext disclosures are the holder's, not ours to browse.
 */
@Injectable()
export class PassportAdminService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PassportAdminService.name })
  }

  async list(query: CredentialListQueryDto): Promise<{
    items: Array<Record<string, unknown>>
    total: number
    limit: number
    offset: number
  }> {
    const where: Prisma.CredentialWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.passportBound !== undefined
        ? { passportBound: query.passportBound }
        : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    }

    const [rows, total] = await Promise.all([
      this.prisma.credential.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          credentialNumber: true,
          status: true,
          scoreBand: true,
          dataRails: true,
          passportBound: true,
          deviceLabel: true,
          issuedAt: true,
          expiresAt: true,
          revokedAt: true,
          revokeReason: true,
          // The PUBLIC user identifier, never the row UUID: an admin list is a
          // surface that gets screenshotted, and a UUID there publishes a database key.
          user: { select: { pravaahId: true, primaryCountry: true } },
          issuerKey: { select: { kid: true } },
          _count: { select: { presentations: true } },
        },
      }),
      this.prisma.credential.count({ where }),
    ])

    return {
      items: rows.map((row) => ({
        id: row.id,
        credentialNumber: row.credentialNumber,
        status: row.status,
        scoreBand: row.scoreBand,
        dataRails: row.dataRails,
        passportBound: row.passportBound,
        deviceLabel: row.deviceLabel,
        pravaahId: row.user.pravaahId,
        country: row.user.primaryCountry,
        issuerKid: row.issuerKey.kid,
        presentationCount: row._count.presentations,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        revokeReason: row.revokeReason,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    }
  }

  /**
   * One credential in full.
   *
   * Includes the supersede chain and the presentation log, because the two questions
   * an investigator actually asks are "which credential was live on this date?" and
   * "who has this been shown to?". Neither is answerable from a single row.
   */
  async detail(credentialId: string): Promise<Record<string, unknown>> {
    const credential = await this.prisma.credential.findUnique({
      where: { id: credentialId },
      include: {
        user: { select: { pravaahId: true, primaryCountry: true, kycStatus: true } },
        issuerKey: { select: { kid: true, isActive: true, retiredAt: true } },
        statusList: { select: { uri: true, version: true } },
        score: {
          select: {
            id: true,
            band: true,
            confidence: true,
            coverageScore: true,
            computedAt: true,
            status: true,
            modelVersion: { select: { name: true, version: true } },
          },
        },
        supersedes: {
          select: { id: true, credentialNumber: true, revokedAt: true },
        },
        supersededBy: {
          select: { id: true, credentialNumber: true, issuedAt: true },
        },
        cards: {
          select: {
            cardSerial: true,
            status: true,
            nfcWritten: true,
            issuedAt: true,
            lastVerifiedAt: true,
          },
        },
        presentations: {
          orderBy: { presentedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            verifierAudience: true,
            disclosedClaims: true,
            channel: true,
            valid: true,
            kbVerified: true,
            failureReason: true,
            presentedAt: true,
            partner: { select: { name: true, country: true } },
          },
        },
      },
    })
    if (!credential) throw new NotFoundException('Credential not found')

    return {
      id: credential.id,
      credentialNumber: credential.credentialNumber,
      vct: credential.vct,
      status: credential.status,
      // The subject DID and the key thumbprint identify the DEVICE, which is what an
      // investigation into a suspected credential theft needs. The public key itself
      // is included because it is public by construction — it is in every credential.
      subjectDid: credential.subjectDid,
      holderJwkThumbprint: credential.holderJwkThumbprint,
      deviceLabel: credential.deviceLabel,
      scoreBand: credential.scoreBand,
      dataRails: credential.dataRails,
      passportBound: credential.passportBound,
      // Claim NAMES only. The signed credential and its cleartext disclosures stay
      // encrypted: an admin needs to know a passport asserts a nationality, not what
      // that nationality is.
      claimKeys: credential.claimKeys,
      statusList: {
        uri: credential.statusList.uri,
        index: credential.statusListIndex,
        version: credential.statusList.version,
      },
      issuerKey: credential.issuerKey,
      pravaahId: credential.user.pravaahId,
      country: credential.user.primaryCountry,
      kycStatus: credential.user.kycStatus,
      score: credential.score,
      chain: {
        supersedes: credential.supersedes,
        supersededBy: credential.supersededBy,
      },
      card: credential.cards[0] ?? null,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      revokedAt: credential.revokedAt,
      revokeReason: credential.revokeReason,
      presentations: credential.presentations.map((p) => ({
        id: p.id,
        verifier: p.partner?.name ?? p.verifierAudience,
        verifierCountry: p.partner?.country ?? null,
        disclosedClaims: p.disclosedClaims,
        channel: p.channel,
        valid: p.valid,
        holderVerified: p.kbVerified,
        failureReason: p.failureReason,
        presentedAt: p.presentedAt,
      })),
    }
  }

  /** The append-only trail for one credential. */
  async auditTrail(credentialId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'Credential', entityId: credentialId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        action: true,
        actorType: true,
        actorId: true,
        metadata: true,
        createdAt: true,
      },
    })
    return rows
  }

  /**
   * Register a verifier.
   *
   * The API key is returned ONCE, in this response, and only its sha256 is stored. A
   * key we can re-read is a key that leaks with the database, and a partner who loses
   * theirs gets a new one rather than a copy of the old.
   */
  async registerPartner(
    dto: RegisterPartnerDto,
    adminId: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.prisma.verifierPartner.findUnique({
      where: { audience: dto.audience },
    })
    if (existing) {
      // The audience is baked into every key binding proof made out to this partner,
      // so it cannot be reassigned: doing so would let a new partner accept
      // presentations intended for the old one.
      throw new ConflictException(
        `A verifier is already registered with the audience "${dto.audience}"`,
      )
    }

    const apiKey = `pvk_${randomBytes(24).toString('base64url')}`
    const partner = await this.prisma.verifierPartner.create({
      data: {
        name: dto.name,
        audience: dto.audience,
        apiKeyHash: createHash('sha256').update(apiKey).digest('hex'),
        contactEmail: dto.contactEmail ?? null,
        country: dto.country ?? null,
      },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: adminId,
      action: 'passport.partner_registered',
      entity: 'VerifierPartner',
      entityId: partner.id,
      metadata: {
        name: partner.name,
        audience: partner.audience,
        country: partner.country,
      },
    })
    this.logger.info(
      `[${this.registerPartner.name}] Verifier partner registered`,
      { partnerId: partner.id, audience: partner.audience },
    )

    return {
      id: partner.id,
      name: partner.name,
      audience: partner.audience,
      country: partner.country,
      createdAt: partner.createdAt,
      apiKey,
      warning:
        'This is the only time this key will be shown. Store it securely — we keep only a hash.',
    }
  }

  async listPartners(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.verifierPartner.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        audience: true,
        country: true,
        contactEmail: true,
        isActive: true,
        createdAt: true,
        lastUsedAt: true,
        _count: { select: { presentations: true, requests: true } },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      audience: row.audience,
      country: row.country,
      contactEmail: row.contactEmail,
      isActive: row.isActive,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      requestCount: row._count.requests,
      presentationCount: row._count.presentations,
    }))
  }

  /**
   * Deactivate a verifier.
   *
   * Deactivated rather than deleted. Their presentations are in holders' share
   * histories, and deleting the row would turn "Acme Bank saw your score band" into
   * an opaque audience string in the one place a user goes to understand what they
   * shared.
   */
  async deactivatePartner(
    partnerId: string,
    adminId: string,
  ): Promise<Record<string, unknown>> {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
    })
    if (!partner) throw new NotFoundException('Verifier not found')

    await this.prisma.verifierPartner.update({
      where: { id: partnerId },
      data: { isActive: false },
    })
    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: adminId,
      action: 'passport.partner_deactivated',
      entity: 'VerifierPartner',
      entityId: partnerId,
      metadata: { name: partner.name, audience: partner.audience },
    })
    return { id: partnerId, isActive: false }
  }

  /**
   * Operational overview.
   *
   * The failure counts matter more than the success counts: a spike in invalid
   * presentations against one credential is the signal a credential-theft attempt
   * produces, and it is invisible in a dashboard that only plots issuance.
   */
  async stats(): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - 30 * 86_400_000)

    const [byStatus, presentations, failed, partners, keys, cards] =
      await Promise.all([
        this.prisma.credential.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.presentation.count({ where: { presentedAt: { gte: since } } }),
        this.prisma.presentation.count({
          where: { presentedAt: { gte: since }, valid: false },
        }),
        this.prisma.verifierPartner.count({ where: { isActive: true } }),
        this.prisma.issuerKey.count({ where: { retiredAt: null } }),
        this.prisma.passportCard.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
      ])

    const credentialCounts = Object.fromEntries(
      Object.values(CredentialStatus).map((status) => [
        status,
        byStatus.find((row) => row.status === status)?._count._all ?? 0,
      ]),
    )

    return {
      credentials: credentialCounts,
      credentialsTotal: Object.values(credentialCounts).reduce(
        (a, b) => a + b,
        0,
      ),
      last30Days: {
        presentations,
        failedPresentations: failed,
        failureRate:
          presentations > 0 ? Number((failed / presentations).toFixed(3)) : 0,
      },
      activePartners: partners,
      publishedKeys: keys,
      cards: Object.fromEntries(
        cards.map((row) => [row.status, row._count._all]),
      ),
    }
  }
}
