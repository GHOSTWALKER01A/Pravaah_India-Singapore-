import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  TrustRegistryEntryDto,
  UpdateTrustRegistryEntryDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { PassportConfig } from '@/modules/passport/passport.config'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import { ActorType, type TrustRegistryEntry } from 'generated/prisma/client'

/** How long an accept/distrust decision is cached in-process. */
const CACHE_TTL_MS = 30_000

export type IssuerTrust =
  | { accepted: true; entry: TrustRegistryEntry; nativelyVerifiable: boolean }
  | { accepted: false; reason: 'UNKNOWN_ISSUER' | 'DISTRUSTED_ISSUER' }

/**
 * Which issuers the platform accepts presentations from.
 *
 * The registry is the FIRST gate of every M7 verification, before any signature is
 * checked: an issuer we do not trust is rejected without spending an EC verify on
 * it. It is also the incident kill switch — flipping `accepted` off for an issuer
 * makes every verification naming it fail closed within {@link CACHE_TTL_MS},
 * without touching a single credential.
 *
 * PRAVAAH's own `did:web` is registered on boot (`isSelf`). It is the only issuer
 * whose credentials this deployment can verify natively, because it is the only one
 * whose keys and status lists we hold. Another issuer can be ACCEPTED — the
 * cross-border trust decision is real and auditable — but verifying it needs the
 * resolver that fetches a remote JWKS and status list, which is the documented
 * production swap point. Until then such a presentation is refused with an explicit
 * `ISSUER_NOT_RESOLVABLE`, never silently passed.
 */
@Injectable()
export class TrustRegistryService implements OnModuleInit {
  private readonly logger: AppLogger
  private readonly cache = new Map<string, { at: number; trust: IssuerTrust }>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly passport: PassportConfig,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: TrustRegistryService.name })
  }

  /**
   * Register PRAVAAH itself. Best-effort: a database that is unreachable at boot
   * must not stop the app starting — `check` registers the self entry lazily on
   * first use instead, so our own credentials keep verifying either way.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureSelf()
    } catch (error) {
      this.logger.warn(
        `[${this.onModuleInit.name}] Could not register the self issuer yet`,
        { err: error },
      )
    }
  }

  async ensureSelf(): Promise<TrustRegistryEntry> {
    const did = this.passport.did()
    const jwksUri = `${this.passport.publicUrl()}/.well-known/jwks.json`
    // `accepted` is deliberately NOT in `update`: an admin who distrusted our own
    // issuer during an incident must not have that undone by the next deploy.
    return this.prisma.trustRegistryEntry.upsert({
      where: { issuerDid: did },
      create: {
        issuerDid: did,
        issuerName: 'PRAVAAH',
        country: 'IN',
        jwksUri,
        accepted: true,
        isSelf: true,
        note: 'This deployment’s own issuer. Registered automatically.',
      },
      update: { isSelf: true, jwksUri },
    })
  }

  /** The trust decision for one issuer. Cached briefly; see {@link CACHE_TTL_MS}. */
  async check(issuerDid: string): Promise<IssuerTrust> {
    const cached = this.cache.get(issuerDid)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.trust

    const selfDid = this.passport.did()
    let entry = await this.prisma.trustRegistryEntry.findUnique({
      where: { issuerDid },
    })
    // Boot registration failed (or the domain changed since): register lazily.
    if (!entry && issuerDid === selfDid) entry = await this.ensureSelf()

    const trust: IssuerTrust = !entry
      ? { accepted: false, reason: 'UNKNOWN_ISSUER' }
      : !entry.accepted
        ? { accepted: false, reason: 'DISTRUSTED_ISSUER' }
        : {
            accepted: true,
            entry,
            nativelyVerifiable: issuerDid === selfDid,
          }

    this.cache.set(issuerDid, { at: Date.now(), trust })
    return trust
  }

  list(): Promise<TrustRegistryEntry[]> {
    return this.prisma.trustRegistryEntry.findMany({
      orderBy: [{ isSelf: 'desc' }, { createdAt: 'asc' }],
    })
  }

  async add(
    dto: TrustRegistryEntryDto,
    adminId: string,
  ): Promise<TrustRegistryEntry> {
    if (dto.issuerDid === this.passport.did()) {
      throw new BadRequestException(
        'This deployment’s own issuer is registered automatically',
      )
    }
    try {
      const entry = await this.prisma.trustRegistryEntry.create({
        data: {
          issuerDid: dto.issuerDid,
          issuerName: dto.issuerName,
          country: dto.country,
          jwksUri: dto.jwksUri ?? null,
          note: dto.note ?? null,
          accepted: true,
          addedById: adminId,
        },
      })
      this.cache.delete(entry.issuerDid)
      await this.audit.log({
        actorType: ActorType.ADMIN,
        actorId: adminId,
        action: 'partner.trust_issuer_added',
        entity: 'TrustRegistryEntry',
        entityId: entry.id,
        metadata: { issuerDid: entry.issuerDid, country: entry.country },
      })
      return entry
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `${dto.issuerDid} is already in the trust registry`,
        )
      }
      throw error
    }
  }

  async update(
    entryId: string,
    dto: UpdateTrustRegistryEntryDto,
    adminId: string,
  ): Promise<TrustRegistryEntry> {
    const existing = await this.prisma.trustRegistryEntry.findUnique({
      where: { id: entryId },
    })
    if (!existing) throw new NotFoundException('Trust registry entry not found')
    if (existing.isSelf && dto.jwksUri !== undefined) {
      throw new BadRequestException(
        'The self issuer’s JWKS location is derived, not configured',
      )
    }

    const entry = await this.prisma.trustRegistryEntry.update({
      where: { id: entryId },
      data: {
        ...(dto.accepted !== undefined ? { accepted: dto.accepted } : {}),
        ...(dto.jwksUri !== undefined ? { jwksUri: dto.jwksUri } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      },
    })
    this.cache.delete(entry.issuerDid)

    if (dto.accepted === false) {
      // Distrusting an issuer is an incident-grade action; it should be loud.
      this.logger.warn(`[${this.update.name}] Issuer distrusted`, {
        issuerDid: entry.issuerDid,
        isSelf: entry.isSelf,
        adminId,
      })
    }
    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: adminId,
      action:
        dto.accepted === false
          ? 'partner.trust_issuer_distrusted'
          : dto.accepted === true
            ? 'partner.trust_issuer_accepted'
            : 'partner.trust_issuer_updated',
      entity: 'TrustRegistryEntry',
      entityId: entry.id,
      metadata: {
        issuerDid: entry.issuerDid,
        before: { accepted: existing.accepted, jwksUri: existing.jwksUri },
        after: { accepted: entry.accepted, jwksUri: entry.jwksUri },
      },
    })
    return entry
  }
}
