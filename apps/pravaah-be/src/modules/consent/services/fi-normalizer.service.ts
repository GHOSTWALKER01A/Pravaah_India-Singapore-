import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { FiType } from 'generated/prisma/client'

interface NormalizedResult {
  coverageScore: number
  [key: string]: unknown
}

/**
 * Returned / dishonoured instrument markers as they appear in ReBIT narration
 * free text (there is no dedicated field for a bounce). Deliberately narrow:
 * "RETURN" alone would match legitimate merchant refunds, so it is only counted
 * alongside an instrument type (ECS/NACH/cheque).
 */
const BOUNCE_PATTERN =
  /\b(BOUNCE(?:D)?|DISHONOU?R(?:ED)?|INSUFF(?:ICIENT)?\s*(?:FUND|BAL)|(?:ECS|NACH|CHQ|CHEQUE)\s*(?:RTN|RET(?:URN)?|FAIL)|RTN\s*CHG|CHQ\s*RETURN)\b/i

/**
 * Turns a raw FIP payload into stable, encrypted-at-rest features + a coverage
 * score — the exact inputs M2 (scoring) will consume. Idempotent per
 * (user, consent, fiType) via the composite unique upsert. Never persists raw
 * financial data in the clear.
 *
 * Every feature here is a TREND or RATIO, never a point-in-time balance, which
 * is what makes the score hard to game: see `balanceRetention` (park-and-
 * withdraw penalty) and `boundarySpikeRatio` (inflow dressed up at the edges of
 * the requested data range). The raw keys emitted here are consumed by
 * `FeatureAssemblerService` — renaming one is a model-version change.
 */
@Injectable()
export class FiNormalizerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FiNormalizerService.name })
  }

  async normalize(
    userId: string,
    consentId: string,
    fiType: FiType,
    payload: unknown,
    dataLifeExpiresAt: Date,
  ): Promise<void> {
    const normalized = this.normalizeByType(fiType, payload)

    await this.prisma.fiNormalized.upsert({
      where: {
        userId_consentId_fiType: { userId, consentId, fiType },
      },
      create: {
        userId,
        consentId,
        fiType,
        normalizedJson: encryptField(JSON.stringify(normalized)),
        coverageScore: normalized.coverageScore,
        dataLifeExpiresAt,
      },
      update: {
        normalizedJson: encryptField(JSON.stringify(normalized)),
        coverageScore: normalized.coverageScore,
        dataLifeExpiresAt,
      },
    })
    this.logger.info('[normalize] FI features computed', {
      userId,
      consentId,
      fiType,
      coverageScore: normalized.coverageScore,
    })
  }

  private normalizeByType(
    fiType: FiType,
    payload: unknown,
  ): NormalizedResult {
    switch (fiType) {
      case FiType.DEPOSIT:
      case FiType.TERM_DEPOSIT:
      case FiType.RECURRING_DEPOSIT:
        return this.normalizeDeposit(payload)
      case FiType.GSTR:
        return this.normalizeGst(payload)
      default:
        return { raw: 'unsupported', coverageScore: 0.2 }
    }
  }

  private normalizeDeposit(p: unknown): NormalizedResult {
    const acc = (p as Record<string, any>)?.Account ?? (p as Record<string, any>)
    const txns: any[] =
      acc?.Transactions?.Transaction ?? acc?.transactions ?? []
    const credits = txns.filter(
      (t) => (t.type ?? t.Type)?.toUpperCase() === 'CREDIT',
    )
    const debits = txns.filter(
      (t) => (t.type ?? t.Type)?.toUpperCase() === 'DEBIT',
    )
    const inflow = credits.reduce((s, t) => s + this.amount(t), 0)
    const outflow = debits.reduce((s, t) => s + this.amount(t), 0)
    // Chronological order matters for retention (closing vs peak), and AA
    // payloads are not guaranteed sorted.
    const ordered = [...txns].sort((a, b) =>
      this.stamp(a).localeCompare(this.stamp(b)),
    )
    const balances = ordered
      .map((t) => Number(t.currentBalance ?? t.Balance ?? 0))
      .filter((n) => Number.isFinite(n) && n !== 0)
    const avgBalance = balances.length
      ? balances.reduce((a, b) => a + b, 0) / balances.length
      : 0

    // Income regularity: coefficient of variation of monthly credit sums
    // (lower CV → steadier income → higher regularity, mapped to 0..1).
    const monthly = this.groupByMonth(credits)
    const monthKeys = Object.keys(monthly).sort()
    const cv = this.coeffVar(Object.values(monthly))

    // ── M2 anti-gaming features ────────────────────────────────────────────
    // balanceRetention: CLOSING balance ÷ PEAK balance. Someone who parks a lump
    // sum and withdraws it peaks high and closes low → near 0, even though their
    // avgBalance looks healthy. Someone who genuinely accumulates closes AT their
    // peak → 1.0. Deliberately not trough÷peak, which would punish growth.
    const peak = balances.length ? Math.max(...balances) : 0
    const trough = balances.length ? Math.min(...balances) : 0
    const closing = balances.length ? balances[balances.length - 1]! : 0
    const balanceRetention =
      peak > 0
        ? Number(Math.max(0, Math.min(1, closing / peak)).toFixed(3))
        : null

    // obligationRatio: outflow ÷ inflow — the debt/commitment load. >1 means
    // the account is being drained faster than it fills.
    const obligationRatio =
      inflow > 0 ? Number((outflow / inflow).toFixed(3)) : null

    // bounceCount: returned/dishonoured instruments, read off the narration
    // (ReBIT leaves the reason in free text; there is no dedicated field).
    const bounceCount = txns.filter((t) =>
      BOUNCE_PATTERN.test(String(t.narration ?? t.Narration ?? '')),
    ).length

    // boundarySpikeRatio: share of total inflow that landed in the first or last
    // month of the window. A genuine salary is flat across months; a score
    // dressed up for the data range clusters at the edges. Surfaced so scoring
    // can down-weight it — see M2 §12.
    const edgeInflow =
      monthKeys.length >= 3
        ? (monthly[monthKeys[0]!] ?? 0) +
          (monthly[monthKeys[monthKeys.length - 1]!] ?? 0)
        : 0
    const boundarySpikeRatio =
      monthKeys.length >= 3 && inflow > 0
        ? Number((edgeInflow / inflow).toFixed(3))
        : null

    return {
      txnCount: txns.length,
      totalInflow: Number(inflow.toFixed(2)),
      totalOutflow: Number(outflow.toFixed(2)),
      avgBalance: Number(avgBalance.toFixed(2)),
      peakBalance: Number(peak.toFixed(2)),
      minBalance: Number(trough.toFixed(2)),
      closingBalance: Number(closing.toFixed(2)),
      balanceRetention,
      obligationRatio,
      bounceCount,
      boundarySpikeRatio,
      incomeRegularity:
        cv === null ? null : Number((1 / (1 + cv)).toFixed(3)),
      monthsCovered: monthKeys.length,
      // Coverage blends transaction density with history depth: 50 txns alone
      // over one month is NOT complete data, and M2 turns coverage into the
      // confidence band the user actually sees.
      coverageScore: Number(
        (
          0.5 * Math.min(1, txns.length / 50) +
          0.5 * Math.min(1, monthKeys.length / 6)
        ).toFixed(3),
      ),
    }
  }

  private normalizeGst(p: unknown): NormalizedResult {
    const o = p as Record<string, any>
    const turnover = Number(
      o?.summary?.annualTurnover ?? o?.turnover ?? 0,
    )
    const filed = Number(o?.summary?.filedMonths ?? 0)
    const total = Number(o?.summary?.totalMonths ?? 12)
    const late = Number(o?.summary?.lateFilings ?? 0)

    // Filing consistency rewards filing AND filing on time: a business that
    // files all twelve returns late is not as reliable as one that files them
    // on the due date, so late filings cost half a month each.
    const effective = Math.max(0, filed - 0.5 * late)
    return {
      annualTurnover: turnover,
      filedMonths: filed,
      filingConsistency: total
        ? Number(Math.max(0, Math.min(1, effective / total)).toFixed(3))
        : null,
      lateFilings: late,
      // Turnover alone is not coverage — a GSTIN with turnover but no filing
      // record is a thin business file.
      coverageScore: Number(
        (
          0.6 * (turnover > 0 ? 1 : 0) +
          0.4 * (total ? Math.min(1, filed / total) : 0)
        ).toFixed(3),
      ),
    }
  }

  private amount(t: any): number {
    const n = Number(t.amount ?? t.Amount ?? 0)
    return Number.isFinite(n) ? Math.abs(n) : 0
  }

  private stamp(t: any): string {
    return String(t.transactionTimestamp ?? t.date ?? '')
  }

  private groupByMonth(txns: any[]): Record<string, number> {
    return txns.reduce((acc: Record<string, number>, t) => {
      const m = String(
        t.transactionTimestamp ?? t.date ?? '',
      ).slice(0, 7)
      if (!m) return acc
      acc[m] = (acc[m] ?? 0) + this.amount(t)
      return acc
    }, {})
  }

  private coeffVar(xs: number[]): number | null {
    if (xs.length < 2) return null
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    if (!mean) return null
    const sd = Math.sqrt(
      xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length,
    )
    return sd / mean
  }
}
