import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { PartnerUsageKind, type Prisma } from 'generated/prisma/client'

import { PartnerConfig } from '@/modules/partner/partner.config'
import {
  billingPeriod,
  isBillable,
  recentPeriods,
} from '@/modules/partner/partner.state'

/** A Prisma client or an interactive-transaction client. */
type Db = Prisma.TransactionClient | PrismaService

export interface UsageEventInput {
  partnerId: string
  kind: PartnerUsageKind
  /** The fact's identity. The same fact observed twice must produce the same key. */
  dedupeKey: string
  verifierRequestId?: string | null
  apiKeyId?: string | null
  occurredAt?: Date
}

/**
 * Metering for verification-as-a-service.
 *
 * An event LEDGER, not counters. `count = count + 1` cannot be made idempotent —
 * a redelivered event or a reconciliation pass double-bills. A row keyed by a
 * `dedupeKey` that names the FACT (`<requestId>:VERIFIED`) can: a replay is a
 * unique violation, skipped by `createMany({ skipDuplicates })`. The invoice is a
 * `groupBy`, and every billed line points at the verification it charges for.
 *
 * `skipDuplicates` (INSERT … ON CONFLICT DO NOTHING) rather than create-then-catch
 * because these writes run INSIDE the event processor's transaction, and a caught
 * unique violation leaves a Postgres transaction aborted (25P02) — the exact bug
 * M4's `LimitService.ensureCounter` shipped with.
 */
@Injectable()
export class PartnerUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PartnerConfig,
  ) {}

  /** Record events. Returns how many were NEW (0 means every one was a replay). */
  async record(db: Db, events: UsageEventInput[]): Promise<number> {
    if (!events.length) return 0
    const unitPrice = this.config.pricePerVerificationMinor()
    const currency = this.config.billingCurrency()

    const result = await db.partnerUsageEvent.createMany({
      data: events.map((event) => {
        const occurredAt = event.occurredAt ?? new Date()
        const billable = isBillable(event.kind)
        return {
          partnerId: event.partnerId,
          kind: event.kind,
          billable,
          // The price is frozen onto the event at the moment it happened, so a
          // later price change never re-prices history.
          unitPriceMinor: billable ? unitPrice : 0,
          currency,
          period: billingPeriod(occurredAt),
          dedupeKey: event.dedupeKey,
          verifierRequestId: event.verifierRequestId ?? null,
          apiKeyId: event.apiKeyId ?? null,
          occurredAt,
        }
      }),
      skipDuplicates: true,
    })
    return result.count
  }

  /**
   * One period's invoice preview, plus a short history.
   *
   * The amount is summed from each event's FROZEN price rather than multiplied by
   * today's, so the preview and the eventual invoice agree by construction.
   */
  async summary(
    partnerId: string,
    period = billingPeriod(),
  ): Promise<Record<string, unknown>> {
    const history = recentPeriods(period, 6)

    const [byKind, amount, byPeriod] = await Promise.all([
      this.prisma.partnerUsageEvent.groupBy({
        by: ['kind'],
        where: { partnerId, period },
        _count: { _all: true },
      }),
      this.prisma.partnerUsageEvent.aggregate({
        where: { partnerId, period, billable: true },
        _sum: { unitPriceMinor: true },
        _count: { _all: true },
      }),
      this.prisma.partnerUsageEvent.groupBy({
        by: ['period'],
        where: { partnerId, period: { in: history }, billable: true },
        _count: { _all: true },
        _sum: { unitPriceMinor: true },
      }),
    ])

    const counts = Object.fromEntries(
      Object.values(PartnerUsageKind).map((kind) => [
        kind,
        byKind.find((row) => row.kind === kind)?._count._all ?? 0,
      ]),
    ) as Record<PartnerUsageKind, number>

    const requests = counts.REQUEST_CREATED
    const verified = counts.VERIFIED

    return {
      period,
      currency: this.config.billingCurrency(),
      unitPriceMinor: this.config.pricePerVerificationMinor(),
      counts,
      billableCount: amount._count._all,
      amountMinor: amount._sum.unitPriceMinor ?? 0,
      // Funnel metrics a partner actually manages against.
      conversion: {
        requests,
        verified,
        approvalRate:
          requests > 0 ? Number((verified / requests).toFixed(3)) : 0,
        declined: counts.DECLINED,
        expired: counts.EXPIRED,
      },
      history: history.map((p) => {
        const row = byPeriod.find((entry) => entry.period === p)
        return {
          period: p,
          billableCount: row?._count._all ?? 0,
          amountMinor: row?._sum.unitPriceMinor ?? 0,
        }
      }),
    }
  }

  /** The billed lines behind a period's total — every charge is explainable. */
  async lineItems(
    partnerId: string,
    period: string,
    limit: number,
    offset: number,
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    const where = { partnerId, period, billable: true }
    const [rows, total] = await Promise.all([
      this.prisma.partnerUsageEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          kind: true,
          unitPriceMinor: true,
          currency: true,
          occurredAt: true,
          verifierRequestId: true,
          apiKeyId: true,
        },
      }),
      this.prisma.partnerUsageEvent.count({ where }),
    ])

    // One query for the partner's own references, not one per line.
    const requestIds = rows
      .map((row) => row.verifierRequestId)
      .filter((id): id is string => !!id)
    const refs = requestIds.length
      ? await this.prisma.verifierRequest.findMany({
          where: { id: { in: requestIds }, partnerId },
          select: { id: true, externalRef: true },
        })
      : []
    const refById = new Map(refs.map((r) => [r.id, r.externalRef]))

    return {
      total,
      items: rows.map((row) => ({
        ...row,
        externalRef: row.verifierRequestId
          ? (refById.get(row.verifierRequestId) ?? null)
          : null,
      })),
    }
  }

  /** Platform-wide billable volume for one period, by partner. Admin overview. */
  async platformOverview(
    period = billingPeriod(),
  ): Promise<Record<string, unknown>> {
    const rows = await this.prisma.partnerUsageEvent.groupBy({
      by: ['partnerId'],
      where: { period, billable: true },
      _count: { _all: true },
      _sum: { unitPriceMinor: true },
      orderBy: { _count: { partnerId: 'desc' } },
      take: 50,
    })
    const partners = rows.length
      ? await this.prisma.verifierPartner.findMany({
          where: { id: { in: rows.map((row) => row.partnerId) } },
          select: { id: true, name: true, country: true },
        })
      : []
    const byId = new Map(partners.map((p) => [p.id, p]))
    return {
      period,
      currency: this.config.billingCurrency(),
      totalBillable: rows.reduce((sum, row) => sum + row._count._all, 0),
      totalAmountMinor: rows.reduce(
        (sum, row) => sum + (row._sum.unitPriceMinor ?? 0),
        0,
      ),
      partners: rows.map((row) => ({
        partnerId: row.partnerId,
        name: byId.get(row.partnerId)?.name ?? null,
        country: byId.get(row.partnerId)?.country ?? null,
        billableCount: row._count._all,
        amountMinor: row._sum.unitPriceMinor ?? 0,
      })),
    }
  }
}
