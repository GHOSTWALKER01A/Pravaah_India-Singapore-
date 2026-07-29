import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { SIGNAL_WEIGHTS } from '@/modules/fraud/fraud.config'
import type { Signal } from '@/modules/fraud/fraud.state'
import {
  hashIpNetwork,
  hashMobile,
  riskHash,
  HASH_NS,
} from '@/modules/fraud/risk-hash.util'
import type { RiskContext } from '@/modules/fraud/risk.types'

import {
  ActorType,
  ListEntityType,
  ListKind,
  type ListEntry,
} from 'generated/prisma/client'

/**
 * Watchlists, blocklists, the mule registry and sanctions.
 *
 * ## The hard/soft split
 *
 * `kind` decides everything. `WATCH` contributes a weighted signal the ladder may
 * or may not act on; `BLOCK`, `MULE` and `SANCTIONS` are HARD — they bypass the
 * arithmetic entirely and force a `BLOCK`. That asymmetry is the point: "the payee is
 * on a sanctions list" is not a probability to be averaged against a good payment
 * history, and a system that could average it away would eventually settle one.
 *
 * ## Why lookups are hashed
 *
 * `valueHash` is a keyed HMAC, so the table never holds a plaintext list of the
 * accounts we believe to be criminal. That is both a privacy position and an
 * operational one: a leaked plaintext blocklist is a roadmap telling every listed
 * account that it is known, which is the fastest way to lose the intelligence.
 *
 * ## Relationship to M0 and M4's existing screens
 *
 * This is a THIRD screen and does not replace either. M0's `SanctionsService` asks
 * "may this person be a customer" and writes to their KYC profile. M4's
 * `PayeeScreeningService` asks "may money be sent to this counterparty" by NAME. This
 * asks "is this identifier — a VPA, a device, a network — on a list we maintain", and
 * the identifiers are exactly what the other two cannot check. Collapsing them would
 * re-introduce the bug M4's screening service documents: writing a beneficiary's
 * screening result onto the payer's identity.
 */
@Injectable()
export class WatchlistService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: WatchlistService.name })
  }

  // ── the collector ─────────────────────────────────────────────────────────
  /**
   * Check every identifier in the context against every list.
   *
   * One batched query rather than four sequential ones. This runs inline on the
   * payment path, and four round trips to check four identifiers is three more than
   * the latency budget allows.
   */
  async signals(ctx: RiskContext): Promise<Signal[]> {
    const candidates: Array<{
      entityType: ListEntityType
      valueHash: string
      label: string
    }> = []

    if (ctx.beneficiaryHandle) {
      candidates.push({
        entityType: ListEntityType.BENEFICIARY,
        valueHash: riskHash(HASH_NS.BENEFICIARY, ctx.beneficiaryHandle),
        label: 'the payee',
      })
      /**
       * A VPA is checked under BOTH namespaces.
       *
       * A handle can be listed as a payment address (`VPA`) or as a payee
       * (`BENEFICIARY`), and an analyst listing `fraud@ybl` may reasonably pick
       * either. Checking one namespace would silently miss listings made under the
       * other — a watchlist that matches nothing while reporting success.
       */
      if (ctx.beneficiaryHandle.includes('@')) {
        candidates.push({
          entityType: ListEntityType.VPA,
          valueHash: riskHash(HASH_NS.VPA, ctx.beneficiaryHandle),
          label: 'the payment address',
        })
      }
    }

    if (ctx.clientDeviceId) {
      candidates.push({
        entityType: ListEntityType.DEVICE,
        valueHash: riskHash(HASH_NS.DEVICE, ctx.clientDeviceId),
        label: 'this device',
      })
    }

    if (ctx.ipAddress) {
      candidates.push({
        entityType: ListEntityType.IP,
        valueHash: hashIpNetwork(ctx.ipAddress),
        label: 'this network',
      })
    }

    candidates.push({
      entityType: ListEntityType.USER,
      valueHash: riskHash(HASH_NS.USER, ctx.userId),
      label: 'this account',
    })

    if (candidates.length === 0) return []

    const hits = await this.prisma.listEntry.findMany({
      where: {
        active: true,
        /**
         * Both conditions inside `AND`, each with its own `OR`.
         *
         * They cannot be two sibling `OR` keys — an object has one `OR`, so the
         * second would overwrite the first and the query would match every listing
         * that had not expired, regardless of whether it named anything in this
         * request. Nesting under `AND` is what keeps them as two independent
         * requirements: match one of these identifiers, AND be unexpired.
         */
        AND: [
          {
            OR: candidates.map(({ entityType, valueHash }) => ({
              entityType,
              valueHash,
            })),
          },
          /**
           * An expired listing is not a listing.
           *
           * `null` means indefinite, so the filter admits both. A bare
           * `expiresAt: { gt: now }` would silently drop every permanent entry —
           * which is most of them.
           */
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
    })

    return hits.map((hit) => {
      const candidate = candidates.find(
        (item) =>
          item.entityType === hit.entityType &&
          item.valueHash === hit.valueHash,
      )
      return this.toSignal(hit, candidate?.label ?? 'this action')
    })
  }

  /**
   * Turn a list hit into a signal.
   *
   * The reason string is written for the USER, and it deliberately does not name the
   * list or quote the analyst's note. "Payee on MULE list: forwarded funds for
   * ring #4471" tells a fraudster precisely what we know and which address to
   * abandon. The analyst console shows the full record; the user is told their
   * payment cannot proceed and given an appeal route.
   */
  private toSignal(entry: ListEntry, label: string): Signal {
    const isHard = entry.kind !== ListKind.WATCH

    if (isHard) {
      this.logger.warn(
        `[${this.toSignal.name}] Hard list hit — action will be blocked`,
        {
          kind: entry.kind,
          entityType: entry.entityType,
          source: entry.source,
        },
      )
    }

    return {
      type: 'WATCHLIST_HIT',
      // A hard signal's weight is never used (it bypasses the arithmetic), but `1`
      // is the honest value to record rather than a number implying it was averaged.
      weight: isHard ? 1 : SIGNAL_WEIGHTS.WATCHLIST_WATCH,
      value: 1,
      reason: isHard
        ? `Payments involving ${label} are not permitted`
        : `${capitalise(label)} is under review`,
      isHard,
    }
  }

  // ── management ────────────────────────────────────────────────────────────
  /**
   * Add or re-activate a listing.
   *
   * Takes the identifier in PLAINTEXT and hashes it here. That is the opposite of
   * what the M6 build doc specified (`valueHash` in the request body), and the
   * difference is a correctness bug rather than a preference: if the client supplies
   * the hash, the client chooses the salt, so two consoles produce two different
   * hashes for the same VPA and neither ever matches a lookup. The salt is a server
   * secret; only the server can compute the key.
   *
   * `upsert` so re-listing a lifted entry reactivates the original row, preserving
   * `addedAt` and therefore the history of when the identifier was first suspected.
   */
  async add(params: {
    kind: ListKind
    entityType: ListEntityType
    value: string
    reason: string
    source: string
    addedById?: string | null
    expiresAt?: Date | null
  }): Promise<ListEntry> {
    const valueHash = this.hashFor(params.entityType, params.value)

    const entry = await this.prisma.listEntry.upsert({
      where: {
        kind_entityType_valueHash: {
          kind: params.kind,
          entityType: params.entityType,
          valueHash,
        },
      },
      create: {
        kind: params.kind,
        entityType: params.entityType,
        valueHash,
        reason: params.reason,
        source: params.source,
        addedById: params.addedById ?? null,
        expiresAt: params.expiresAt ?? null,
      },
      update: {
        active: true,
        reason: params.reason,
        expiresAt: params.expiresAt ?? null,
      },
    })

    await this.audit.log({
      actorType: params.addedById ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: params.addedById ?? null,
      action: 'fraud.list.added',
      entity: 'ListEntry',
      entityId: entry.id,
      /**
       * The audit metadata records the KIND and the reason, never the value.
       *
       * An audit log that quoted the listed VPA would re-introduce in plaintext
       * exactly what `valueHash` exists to avoid — and audit rows are the one table
       * guaranteed never to be deleted.
       */
      metadata: {
        kind: params.kind,
        entityType: params.entityType,
        reason: params.reason,
        source: params.source,
      },
    })

    this.logger.warn(`[${this.add.name}] List entry added`, {
      kind: params.kind,
      entityType: params.entityType,
    })

    return entry
  }

  /**
   * Lift a listing.
   *
   * Deactivated, never deleted. A removed row loses the fact that the identifier was
   * once listed and by whom — which is what an appeal, and any review of a wrongful
   * listing, is argued from.
   */
  async remove(params: {
    kind: ListKind
    entityType: ListEntityType
    value: string
    reason: string
    removedById: string
  }): Promise<boolean> {
    const valueHash = this.hashFor(params.entityType, params.value)

    const updated = await this.prisma.listEntry.updateMany({
      where: {
        kind: params.kind,
        entityType: params.entityType,
        valueHash,
        active: true,
      },
      data: { active: false },
    })

    if (updated.count === 0) return false

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: params.removedById,
      action: 'fraud.list.removed',
      entity: 'ListEntry',
      metadata: {
        kind: params.kind,
        entityType: params.entityType,
        reason: params.reason,
      },
    })

    return true
  }

  /** Whether one identifier is on a hard list. Used by the case-resolution path. */
  async isHardListed(
    entityType: ListEntityType,
    value: string,
  ): Promise<boolean> {
    const hit = await this.prisma.listEntry.findFirst({
      where: {
        entityType,
        valueHash: this.hashFor(entityType, value),
        active: true,
        kind: { not: ListKind.WATCH },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    })
    return hit !== null
  }

  /**
   * Map an entity type to its hash namespace.
   *
   * Centralised so a namespace is never guessed at a call site. A mismatch here does
   * not fail loudly — it produces a hash that never matches anything, and a
   * blocklist that silently matches nothing is worse than having none, because it
   * reports coverage it does not provide.
   */
  private hashFor(entityType: ListEntityType, value: string): string {
    switch (entityType) {
      case ListEntityType.MOBILE:
        return hashMobile(value)
      case ListEntityType.IP:
        return hashIpNetwork(value)
      case ListEntityType.VPA:
        return riskHash(HASH_NS.VPA, value)
      case ListEntityType.BENEFICIARY:
        return riskHash(HASH_NS.BENEFICIARY, value)
      case ListEntityType.DEVICE:
        return riskHash(HASH_NS.DEVICE, value)
      case ListEntityType.USER:
        return riskHash(HASH_NS.USER, value)
    }
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
