import { createHash, randomBytes } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  PARTNER_API_KEY_PREFIX,
  type IssuePartnerApiKeyDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { claimsOutsideScope } from '@/modules/passport/passport.state'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import {
  ActorType,
  PartnerApiKeyStatus,
  PartnerStatus,
  type PartnerApiKey,
} from 'generated/prisma/client'

/** Live keys a partner may hold at once. Rotation briefly needs two per integration. */
const MAX_ACTIVE_KEYS = 10
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Who minted or changed a key. Exactly one kind of actor, always attributed. */
export type KeyActor =
  { kind: 'PARTNER_USER'; id: string } | { kind: 'ADMIN'; id: string }

/** The safe projection — there is no code path that returns `keyHash`. */
const KEY_VIEW = {
  id: true,
  label: true,
  prefix: true,
  scopes: true,
  status: true,
  rateLimitPerMin: true,
  expiresAt: true,
  lastUsedAt: true,
  createdAt: true,
  revokedAt: true,
  revokedReason: true,
  rotatedFromId: true,
} as const

/**
 * Partner API keys: many per partner, scoped, rate-limited, rotatable.
 *
 * The plaintext is returned exactly ONCE, in the issue or rotate response, and only
 * its sha256 is stored. A key we can re-read is a key that leaks with the database;
 * a partner who loses one gets a new one, never a copy.
 *
 * A key's `scopes` are checked against the partner's approved scope at issue, and
 * AGAIN on every request by `PartnerApiKeyGuard` — so an admin narrowing a partner
 * narrows every key it holds without anybody having to find and edit them.
 */
@Injectable()
export class PartnerApiKeyService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerApiKeyService.name })
  }

  async issue(
    partnerId: string,
    dto: IssuePartnerApiKeyDto,
    actor: KeyActor,
  ): Promise<Record<string, unknown>> {
    const partner = await this.requireActivePartner(partnerId)
    const outside = claimsOutsideScope(dto.scopes, partner.allowedScopes)
    if (outside.length) {
      throw new BadRequestException(
        `A key cannot carry scopes the partner was not approved for: ${outside.join(', ')}`,
      )
    }
    await this.assertKeyBudget(partnerId)

    const minted = mintKey()
    const key = await this.prisma.partnerApiKey.create({
      data: {
        partnerId,
        label: dto.label,
        prefix: minted.prefix,
        keyHash: minted.hash,
        scopes: [...new Set(dto.scopes)],
        rateLimitPerMin: dto.rateLimitPerMin,
        expiresAt: dto.expiresInDays
          ? new Date(Date.now() + dto.expiresInDays * DAY_MS)
          : null,
        ...this.actorColumns(actor),
      },
      select: KEY_VIEW,
    })

    await this.auditKey('partner.api_key_issued', key.id, partnerId, actor, {
      label: key.label,
      prefix: key.prefix,
      scopes: key.scopes,
    })
    return { ...key, apiKey: minted.raw, warning: SHOWN_ONCE }
  }

  list(partnerId: string) {
    return this.prisma.partnerApiKey.findMany({
      where: { partnerId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      select: KEY_VIEW,
    })
  }

  async revoke(
    partnerId: string,
    keyId: string,
    reason: string,
    actor: KeyActor,
  ): Promise<Record<string, unknown>> {
    // Scoped by partner in the WHERE: another partner's key id is a 404.
    const result = await this.prisma.partnerApiKey.updateMany({
      where: { id: keyId, partnerId, status: PartnerApiKeyStatus.ACTIVE },
      data: {
        status: PartnerApiKeyStatus.REVOKED,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    })
    if (result.count === 0) {
      const exists = await this.prisma.partnerApiKey.findFirst({
        where: { id: keyId, partnerId },
        select: { id: true },
      })
      if (!exists) throw new NotFoundException('API key not found')
      throw new ConflictException('This key is already revoked')
    }
    await this.auditKey('partner.api_key_revoked', keyId, partnerId, actor, {
      reason,
    })
    return { id: keyId, status: PartnerApiKeyStatus.REVOKED }
  }

  /**
   * Rotate: mint a replacement with the same label, limit and scopes, and let the
   * old key live on for `graceHours` so the partner can deploy with no downtime.
   * `graceHours: 0` kills the old key now — the answer when it has leaked.
   *
   * `rotatedFromId` is UNIQUE, so two concurrent rotations of one key cannot fork
   * it into two replacements: the loser is a P2002, answered as 409.
   */
  async rotate(
    partnerId: string,
    keyId: string,
    graceHours: number,
    actor: KeyActor,
  ): Promise<Record<string, unknown>> {
    const partner = await this.requireActivePartner(partnerId)
    const old = await this.prisma.partnerApiKey.findFirst({
      where: { id: keyId, partnerId },
    })
    if (!old) throw new NotFoundException('API key not found')
    if (!isLive(old)) {
      throw new ConflictException(
        'Only a live key can be rotated — issue a new one instead',
      )
    }

    // Carried over, but re-intersected with the partner's CURRENT scope, so a
    // rotation can never resurrect a scope an admin has since removed.
    const allowed = new Set(partner.allowedScopes)
    const scopes = old.scopes.filter((scope) => allowed.has(scope))
    if (!scopes.length) {
      throw new BadRequestException(
        'None of this key’s scopes are still approved for the partner — issue a new key instead',
      )
    }

    const minted = mintKey()
    const now = new Date()
    try {
      const fresh = await this.prisma.$transaction(async (tx) => {
        const created = await tx.partnerApiKey.create({
          data: {
            partnerId,
            label: old.label,
            prefix: minted.prefix,
            keyHash: minted.hash,
            scopes,
            rateLimitPerMin: old.rateLimitPerMin,
            // The replacement inherits a hard expiry, never extends one.
            expiresAt: old.expiresAt,
            rotatedFromId: old.id,
            ...this.actorColumns(actor),
          },
          select: KEY_VIEW,
        })
        await tx.partnerApiKey.update({
          where: { id: old.id },
          data:
            graceHours === 0
              ? {
                  status: PartnerApiKeyStatus.REVOKED,
                  revokedAt: now,
                  revokedReason: 'Rotated with no grace period',
                }
              : {
                  expiresAt: earliest(
                    old.expiresAt,
                    new Date(now.getTime() + graceHours * HOUR_MS),
                  ),
                },
        })
        return created
      })

      await this.auditKey(
        'partner.api_key_rotated',
        fresh.id,
        partnerId,
        actor,
        {
          rotatedFromId: old.id,
          graceHours,
        },
      )
      return {
        ...fresh,
        apiKey: minted.raw,
        warning: SHOWN_ONCE,
        previousKey: {
          id: old.id,
          prefix: old.prefix,
          worksUntil:
            graceHours === 0
              ? now
              : new Date(now.getTime() + graceHours * HOUR_MS),
        },
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This key has already been rotated')
      }
      throw error
    }
  }

  /** Mark keys whose expiry (or rotation grace) has passed. The guard already refuses them. */
  async sweepExpired(now = new Date()): Promise<number> {
    const result = await this.prisma.partnerApiKey.updateMany({
      where: { status: PartnerApiKeyStatus.ACTIVE, expiresAt: { lte: now } },
      data: {
        status: PartnerApiKeyStatus.REVOKED,
        revokedAt: now,
        revokedReason: 'Expired',
      },
    })
    if (result.count) {
      this.logger.info(`[${this.sweepExpired.name}] Expired keys revoked`, {
        count: result.count,
      })
    }
    return result.count
  }

  /** Every live key of a partner dies with it. Used by partner revocation. */
  revokeAllForPartner(partnerId: string, reason: string) {
    return this.prisma.partnerApiKey.updateMany({
      where: { partnerId, status: PartnerApiKeyStatus.ACTIVE },
      data: {
        status: PartnerApiKeyStatus.REVOKED,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    })
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async requireActivePartner(partnerId: string) {
    const partner = await this.prisma.verifierPartner.findUnique({
      where: { id: partnerId },
      select: { id: true, status: true, allowedScopes: true },
    })
    if (!partner) throw new NotFoundException('Partner not found')
    if (partner.status !== PartnerStatus.ACTIVE) {
      throw new ForbiddenException(
        partner.status === PartnerStatus.PENDING_APPROVAL
          ? 'API keys are available once your application is approved'
          : `Keys cannot be issued while the partner is ${partner.status.toLowerCase()}`,
      )
    }
    return partner
  }

  private async assertKeyBudget(partnerId: string): Promise<void> {
    const live = await this.prisma.partnerApiKey.count({
      where: {
        partnerId,
        status: PartnerApiKeyStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    })
    if (live >= MAX_ACTIVE_KEYS) {
      throw new ConflictException(
        `A partner may hold at most ${MAX_ACTIVE_KEYS} live keys — revoke one first`,
      )
    }
  }

  private actorColumns(actor: KeyActor) {
    return actor.kind === 'ADMIN'
      ? { createdByAdminId: actor.id, createdByPartnerUserId: null }
      : { createdByPartnerUserId: actor.id, createdByAdminId: null }
  }

  private auditKey(
    action: string,
    keyId: string,
    partnerId: string,
    actor: KeyActor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.log({
      // A partner user is not a PRAVAAH user or admin; SYSTEM with the actor named
      // in metadata keeps the attribution without inventing an ActorType.
      actorType: actor.kind === 'ADMIN' ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: actor.kind === 'ADMIN' ? actor.id : null,
      action,
      entity: 'PartnerApiKey',
      entityId: keyId,
      metadata: {
        partnerId,
        ...(actor.kind === 'PARTNER_USER' ? { partnerUserId: actor.id } : {}),
        ...metadata,
      },
    })
  }
}

const SHOWN_ONCE =
  'This is the only time this key will be shown. Store it in a secret manager — PRAVAAH keeps only a hash.'

/** 36 random bytes → 48 base64url chars of entropy after the family prefix. */
function mintKey(): { raw: string; prefix: string; hash: string } {
  const raw = `${PARTNER_API_KEY_PREFIX}${randomBytes(36).toString('base64url')}`
  return {
    raw,
    // Family prefix + 8 characters: enough to tell keys apart in a console, far too
    // few to authenticate with.
    prefix: raw.slice(0, PARTNER_API_KEY_PREFIX.length + 8),
    hash: createHash('sha256').update(raw).digest('hex'),
  }
}

function isLive(key: PartnerApiKey, now = new Date()): boolean {
  return (
    key.status === PartnerApiKeyStatus.ACTIVE &&
    (!key.expiresAt || key.expiresAt > now)
  )
}

function earliest(a: Date | null, b: Date): Date {
  return a && a < b ? a : b
}
