import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { formatMoney } from '@/modules/payments/money.util'

import {
  LIMIT_POLICY,
  type CorridorLimits,
} from '@/modules/payments/payments.config'
import {
  CORRIDOR_TZ_OFFSET_MINUTES,
  bucketKeyFor,
  bucketResetAt,
} from '@/modules/payments/payments.state'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  Corridor,
  LimitScope,
  LimitWindow,
  Prisma,
  TxnStatus,
} from 'generated/prisma/client'

/** Which cap a check ran into. Surfaced so the app can explain the right one. */
export type LimitBreach =
  | 'PER_TXN_VALUE'
  | 'DAILY_VALUE'
  | 'DAILY_COUNT'
  | 'ANNUAL_LRS'
  | 'NEW_BENEFICIARY_24H'

export class LimitExceededException extends ForbiddenException {
  constructor(
    readonly breach: LimitBreach,
    message: string,
  ) {
    super(message)
  }
}

export interface LimitUsage {
  corridor: Corridor
  currency: string
  perTxnCapMinor: bigint
  dailyCapMinor: bigint
  dailyUsedMinor: bigint
  dailyRemainingMinor: bigint
  dailyCountCap: number
  dailyUsedCount: number
  dailyResetAt: Date
  annualCapMinor?: bigint
  annualUsedMinor?: bigint
  annualRemainingMinor?: bigint
  newBeneficiaryCapMinor: bigint
}

/**
 * Regulatory limits, enforced server-side.
 *
 * These are code, not UI hints. The app is given the same numbers (see `UPI_LIMITS`)
 * so it can warn before a user types an amount that will be refused, but a
 * client-side cap is a courtesy and this service is the control.
 *
 * Two design decisions do the heavy lifting, and both exist because the obvious
 * implementations are racy:
 *
 *  1. **A new day is a new ROW**, keyed by a calendar bucket. The obvious design —
 *     one row per user, reset when `resetAt` passes — is a race: two concurrent
 *     requests both read the stale timestamp, both zero the counter, and both then
 *     spend a full day's limit inside the same second. There is nothing to reset, so
 *     there is nothing to race on.
 *  2. **Check and consume are ONE statement.** `assertWithin` then `consume` has a
 *     window between them wide enough for a second request to pass the same check.
 *     {@link consume} is a conditional UPDATE whose WHERE clause *is* the limit, so
 *     the database arbitrates and the loser gets zero rows affected.
 *
 * The day is bucketed in the corridor's own timezone. UPI's daily limit resets at
 * midnight IST; a UTC bucket would roll over at 05:30 IST and hand every user a
 * window in which two days' limit is spendable inside one Indian day.
 */
@Injectable()
export class LimitService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: LimitService.name })
  }

  policy(corridor: Corridor): CorridorLimits {
    return LIMIT_POLICY[corridor]
  }

  /**
   * The amount a corridor's caps actually measure.
   *
   * The cross-border cap is denominated in SGD regardless of which way the money is
   * going, so an INR→SGD transfer is measured by what ARRIVES (the SGD amount), and
   * an SGD→INR transfer by what LEAVES. Measuring the wrong side would compare rupees
   * against a Singapore-dollar ceiling — wrong by a factor of sixty-five, in the
   * direction that lets everything through.
   */
  limitBasis(
    corridor: Corridor,
    amounts: {
      sourceCurrency: string
      destCurrency: string
      totalDebitMinor: bigint
      destAmount: bigint
    },
  ): { amountMinor: bigint; currency: string } {
    const capCurrency = this.policy(corridor).currency
    if (amounts.sourceCurrency === capCurrency) {
      return { amountMinor: amounts.totalDebitMinor, currency: capCurrency }
    }
    if (amounts.destCurrency === capCurrency) {
      return { amountMinor: amounts.destAmount, currency: capCurrency }
    }
    // Neither side is the cap currency — a corridor we have not priced a cap for.
    // Refusing is the only safe answer: an unmeasurable transfer is an unlimited one.
    throw new InternalServerErrorException(
      `No ${capCurrency} leg to measure the ${corridor} cap against`,
    )
  }

  // ── read-only preview ─────────────────────────────────────────────────────
  /**
   * What is left, for display and for a friendly pre-flight rejection.
   *
   * ADVISORY. It reads counters without locking, so by the time a caller acts on it
   * the numbers may have moved. Enforcement is {@link consume} and nothing else — a
   * caller that trusted this and skipped the atomic step would have a limit that
   * holds under test and fails under concurrency.
   */
  async usage(userId: string, corridor: Corridor): Promise<LimitUsage> {
    const policy = this.policy(corridor)
    const now = new Date()

    const daily = await this.readCounter(userId, corridor, LimitWindow.DAY, now)
    const annual = policy.annualMinor
      ? await this.readCounter(userId, corridor, LimitWindow.YEAR, now)
      : null

    return {
      corridor,
      currency: policy.currency,
      perTxnCapMinor: policy.perTxnValueMinor,
      dailyCapMinor: policy.dailyValueMinor,
      dailyUsedMinor: daily?.usedMinor ?? 0n,
      dailyRemainingMinor: clampToZero(
        policy.dailyValueMinor - (daily?.usedMinor ?? 0n),
      ),
      dailyCountCap: policy.dailyCount,
      dailyUsedCount: daily?.usedCount ?? 0,
      dailyResetAt: bucketResetAt(
        'DAY',
        now,
        CORRIDOR_TZ_OFFSET_MINUTES[corridor],
      ),
      annualCapMinor: policy.annualMinor,
      annualUsedMinor:
        annual?.usedMinor ?? (policy.annualMinor ? 0n : undefined),
      annualRemainingMinor: policy.annualMinor
        ? clampToZero(policy.annualMinor - (annual?.usedMinor ?? 0n))
        : undefined,
      newBeneficiaryCapMinor: policy.newBeneficiary24hMinor,
    }
  }

  /**
   * The pre-flight check, run before a transaction row exists.
   *
   * Exists to fail EARLY and CLEARLY. The atomic consume can also reject, but by then
   * a transaction has been created and the user gets a transfer that appears and
   * immediately fails; this turns the common case into a clean 403 with a number the
   * user can act on.
   */
  async assertWithin(params: {
    userId: string
    corridor: Corridor
    amountMinor: bigint
    beneficiaryId?: string | null
  }): Promise<void> {
    const { userId, corridor, amountMinor } = params
    const policy = this.policy(corridor)

    if (amountMinor > policy.perTxnValueMinor) {
      throw new LimitExceededException(
        'PER_TXN_VALUE',
        `This is over the ${formatMoney(policy.perTxnValueMinor, policy.currency)} per-payment limit for this corridor`,
      )
    }

    const usage = await this.usage(userId, corridor)
    if (amountMinor > usage.dailyRemainingMinor) {
      throw new LimitExceededException(
        'DAILY_VALUE',
        `This would exceed your ${formatMoney(policy.dailyValueMinor, policy.currency)} daily limit for this corridor. ${formatMoney(usage.dailyRemainingMinor, policy.currency)} remaining today`,
      )
    }
    if (policy.dailyCount > 0 && usage.dailyUsedCount >= policy.dailyCount) {
      throw new LimitExceededException(
        'DAILY_COUNT',
        `You have reached the limit of ${policy.dailyCount} payments per day on this corridor`,
      )
    }
    if (
      policy.annualMinor !== undefined &&
      usage.annualRemainingMinor !== undefined &&
      amountMinor > usage.annualRemainingMinor
    ) {
      throw new LimitExceededException(
        'ANNUAL_LRS',
        `This would exceed your annual overseas remittance allowance (LRS). ${formatMoney(usage.annualRemainingMinor, policy.currency)} remaining this financial year`,
      )
    }

    if (params.beneficiaryId) {
      await this.assertNewBeneficiaryWindow({
        userId,
        corridor,
        beneficiaryId: params.beneficiaryId,
        amountMinor,
      })
    }
  }

  /**
   * The new-beneficiary cooling period.
   *
   * A SLIDING 24-hour window, and it must be. A calendar-day version would let a
   * beneficiary verified at 23:55 become unrestricted five minutes later — which is
   * exactly the boundary an attacker would wait for.
   *
   * This is the highest-yield anti-fraud control in UPI. Nearly every
   * social-engineering scam ends in a large transfer to an address the victim saved
   * minutes earlier, and the cap is what turns a life's savings into ₹5,000. The
   * window is measured from `verifiedAt`, not `createdAt`: a row a user created days
   * ago and only verified a minute before a large transfer is precisely the pattern
   * being caught.
   */
  async assertNewBeneficiaryWindow(params: {
    userId: string
    corridor: Corridor
    beneficiaryId: string
    amountMinor: bigint
  }): Promise<void> {
    const { userId, corridor, beneficiaryId, amountMinor } = params
    const policy = this.policy(corridor)

    const beneficiary = await this.prisma.beneficiary.findFirst({
      where: { id: beneficiaryId, userId },
      select: { verifiedAt: true, createdAt: true, isSelf: true },
    })
    if (!beneficiary) return

    // The user's own account is not a stranger. Applying the cooling period here
    // would cripple withdrawals without closing any fraud route.
    if (beneficiary.isSelf) return

    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000)
    const establishedAt = beneficiary.verifiedAt ?? beneficiary.createdAt
    if (establishedAt <= since) return

    // Everything already sent to THIS beneficiary inside the sliding window,
    // including transfers still in flight — an attacker firing five concurrent
    // transfers must not have all five see a zero total.
    const spent = await this.prisma.transaction.aggregate({
      where: {
        userId,
        beneficiaryId,
        createdAt: { gte: since },
        status: {
          notIn: [
            TxnStatus.FAILED,
            TxnStatus.REVERSED,
            TxnStatus.EXPIRED,
            TxnStatus.REFUNDED,
          ],
        },
      },
      _sum: { totalDebitMinor: true },
    })

    const used = spent._sum.totalDebitMinor ?? 0n
    if (used + amountMinor > policy.newBeneficiary24hMinor) {
      throw new LimitExceededException(
        'NEW_BENEFICIARY_24H',
        `For your safety, payments to a newly added payee are capped at ${formatMoney(policy.newBeneficiary24hMinor, policy.currency)} for the first 24 hours. ${formatMoney(clampToZero(policy.newBeneficiary24hMinor - used), policy.currency)} remaining to this payee`,
      )
    }
  }

  // ── the atomic enforcement ────────────────────────────────────────────────
  /**
   * Consume limit, atomically. THIS is the control.
   *
   * A conditional UPDATE whose WHERE clause encodes the cap:
   *
   *   `WHERE id = ? AND usedMinor <= cap − amount AND usedCount <= countCap − 1`
   *
   * Postgres evaluates the predicate and applies the increment in one statement, so
   * two concurrent requests cannot both pass. Zero rows affected means the limit is
   * reached — at which point the counter is re-read purely to say WHICH cap it was,
   * because "limit exceeded" without a number is not actionable.
   *
   * Called from inside the reserve transaction, so a rolled-back reserve rolls back
   * the consumption with it.
   */
  async consume(
    params: {
      userId: string
      corridor: Corridor
      amountMinor: bigint
    },
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const { userId, corridor, amountMinor } = params
    const policy = this.policy(corridor)
    const now = new Date()

    await this.consumeWindow({
      client,
      userId,
      corridor,
      window: LimitWindow.DAY,
      now,
      amountMinor,
      capMinor: policy.dailyValueMinor,
      countCap: policy.dailyCount,
      currency: policy.currency,
      breach: 'DAILY_VALUE',
    })

    if (policy.annualMinor !== undefined) {
      await this.consumeWindow({
        client,
        userId,
        corridor,
        window: LimitWindow.YEAR,
        now,
        amountMinor,
        capMinor: policy.annualMinor,
        // The LRS ceiling caps value, not frequency.
        countCap: 0,
        currency: policy.currency,
        breach: 'ANNUAL_LRS',
      })
    }
  }

  /**
   * Return limit to a user whose transfer did not happen.
   *
   * Guarded by a WHERE on `usedMinor >= amount`, so a double release cannot drive a
   * counter negative and hand somebody a limit they never had. A release that finds
   * nothing to give back is logged rather than thrown: the transfer is already being
   * unwound, and failing the reversal to protect a counter would strand real money to
   * defend a quota.
   */
  async release(
    params: { userId: string; corridor: Corridor; amountMinor: bigint },
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const { userId, corridor, amountMinor } = params
    const policy = this.policy(corridor)
    const now = new Date()

    const windows: LimitWindow[] = policy.annualMinor
      ? [LimitWindow.DAY, LimitWindow.YEAR]
      : [LimitWindow.DAY]

    for (const window of windows) {
      const bucketKey = this.bucketKey(corridor, window, now)
      const released = await client.limitCounter.updateMany({
        where: {
          userId,
          corridor,
          currency: policy.currency,
          window,
          scope: LimitScope.VALUE,
          bucketKey,
          usedMinor: { gte: amountMinor },
        },
        data: {
          usedMinor: { decrement: amountMinor },
          usedCount: { decrement: 1 },
        },
      })

      if (released.count === 0) {
        /**
         * Nothing to release. Two innocent causes: the bucket rolled over between
         * the consume and the reversal (the counter is already zero for a new day),
         * or this is a double release. Neither is worth failing a reversal for.
         */
        this.logger.warn(
          `[${this.release.name}] No limit to release — bucket may have rolled over`,
          {
            userId,
            corridor,
            window,
            bucketKey,
            amountMinor: amountMinor.toString(),
          },
        )
      }
    }

    // A decrement on `usedCount` can undershoot if the bucket rolled; clamp it back
    // rather than leaving a negative count that would inflate the next day's budget.
    await client.limitCounter.updateMany({
      where: { userId, corridor, usedCount: { lt: 0 } },
      data: { usedCount: 0 },
    })
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private async consumeWindow(params: {
    client: Prisma.TransactionClient
    userId: string
    corridor: Corridor
    window: LimitWindow
    now: Date
    amountMinor: bigint
    capMinor: bigint
    countCap: number
    currency: string
    breach: LimitBreach
  }): Promise<void> {
    const {
      client,
      userId,
      corridor,
      window,
      now,
      amountMinor,
      capMinor,
      countCap,
      currency,
      breach,
    } = params

    const bucketKey = this.bucketKey(corridor, window, now)
    await this.ensureCounter({
      client,
      userId,
      corridor,
      currency,
      window,
      bucketKey,
      now,
    })

    // The cap, expressed as the largest CURRENT value that can still absorb this
    // amount. Computed in BigInt so the comparison Postgres performs is exact.
    const headroom = capMinor - amountMinor
    if (headroom < 0n) {
      throw new LimitExceededException(
        breach === 'ANNUAL_LRS' ? 'ANNUAL_LRS' : 'PER_TXN_VALUE',
        `This single payment is larger than the ${formatMoney(capMinor, currency)} limit for this corridor`,
      )
    }

    const updated = await client.limitCounter.updateMany({
      where: {
        userId,
        corridor,
        currency,
        window,
        scope: LimitScope.VALUE,
        bucketKey,
        usedMinor: { lte: headroom },
        // `0` means uncapped. Applying `lte: -1` would refuse everything.
        ...(countCap > 0 ? { usedCount: { lte: countCap - 1 } } : {}),
      },
      data: {
        usedMinor: { increment: amountMinor },
        usedCount: { increment: 1 },
      },
    })

    if (updated.count === 1) return

    // Rejected. Re-read only to name the cap — the decision has already been made.
    const current = await client.limitCounter.findUnique({
      where: {
        userId_corridor_currency_window_scope_bucketKey: {
          userId,
          corridor,
          currency,
          window,
          scope: LimitScope.VALUE,
          bucketKey,
        },
      },
    })
    const used = current?.usedMinor ?? 0n
    const usedCount = current?.usedCount ?? 0

    if (countCap > 0 && usedCount >= countCap) {
      throw new LimitExceededException(
        'DAILY_COUNT',
        `You have reached the limit of ${countCap} payments per day on this corridor`,
      )
    }
    throw new LimitExceededException(
      breach,
      breach === 'ANNUAL_LRS'
        ? `This would exceed your annual overseas remittance allowance (LRS). ${formatMoney(clampToZero(capMinor - used), currency)} remaining this financial year`
        : `This would exceed your ${formatMoney(capMinor, currency)} daily limit for this corridor. ${formatMoney(clampToZero(capMinor - used), currency)} remaining today`,
    )
  }

  /**
   * Make sure this bucket's row exists.
   *
   * ## This was create-then-catch, and that was a live money bug
   *
   * The version this replaces did:
   *
   * ```ts
   * try { await client.limitCounter.create({ … }) }
   * catch (error) { if (!isUniqueViolation(error)) throw error }   // ← tx already aborted
   * ```
   *
   * `client` is the RESERVE TRANSACTION's client — `TransferOrchestratorService.reserve`
   * calls `consume(..., tx)` inside `$transaction`. In Postgres a failed statement aborts
   * the whole transaction, so the moment that `create` hit the unique constraint, the
   * swallowed violation left the transaction dead and every later command returned:
   *
   *     25P02  current transaction is aborted, commands ignored until end of
   *            transaction block
   *
   * The next statement is the conditional `updateMany` that actually ENFORCES the cap, so
   * the 25P02 replaced the real error on the way out and the reserve failed with a Postgres
   * state error naming nothing. `recoverStuckSagas` then re-drove the transaction once a
   * minute, forever, poisoning a fresh transaction every time — which is exactly the loop
   * `LedgerService.ensureAccount`'s comment describes, because that method had the identical
   * bug and was fixed while this one was not.
   *
   * It fires whenever the row already exists, which is every payment after the FIRST one in
   * a given bucket. So the second transfer of any day, and every re-drive of a stuck one.
   *
   * `createMany` with `skipDuplicates` compiles to `INSERT … ON CONFLICT DO NOTHING`. A
   * conflict is then not an error at all, nothing is aborted, and there is nothing to catch.
   * `upsert` would also work when Prisma emits a native `ON CONFLICT DO UPDATE`, but it
   * silently falls back to a non-atomic read-then-write when a query does not qualify, and
   * the inside of a money-moving transaction is not the place to depend on that staying true.
   */
  private async ensureCounter(params: {
    client: Prisma.TransactionClient
    userId: string
    corridor: Corridor
    currency: string
    window: LimitWindow
    bucketKey: string
    now: Date
  }): Promise<void> {
    const { client, userId, corridor, currency, window, bucketKey, now } =
      params

    await client.limitCounter.createMany({
      data: [
        {
          userId,
          corridor,
          currency,
          window,
          scope: LimitScope.VALUE,
          bucketKey,
          resetAt: bucketResetAt(
            window === LimitWindow.YEAR ? 'YEAR' : 'DAY',
            now,
            CORRIDOR_TZ_OFFSET_MINUTES[corridor],
          ),
        },
      ],
      /**
       * The whole point. Losing the race — or simply finding the row already there, which is
       * the ordinary case — must not abort the transaction this runs inside.
       */
      skipDuplicates: true,
    })
  }

  private async readCounter(
    userId: string,
    corridor: Corridor,
    window: LimitWindow,
    now: Date,
  ) {
    return this.prisma.limitCounter.findUnique({
      where: {
        userId_corridor_currency_window_scope_bucketKey: {
          userId,
          corridor,
          currency: this.policy(corridor).currency,
          window,
          scope: LimitScope.VALUE,
          bucketKey: this.bucketKey(corridor, window, now),
        },
      },
    })
  }

  private bucketKey(
    corridor: Corridor,
    window: LimitWindow,
    now: Date,
  ): string {
    const offset = CORRIDOR_TZ_OFFSET_MINUTES[corridor]
    switch (window) {
      case LimitWindow.YEAR:
        return bucketKeyFor('YEAR', now, offset)
      case LimitWindow.MONTH:
        return bucketKeyFor('MONTH', now, offset)
      default:
        return bucketKeyFor('DAY', now, offset)
    }
  }
}

function clampToZero(value: bigint): bigint {
  return value > 0n ? value : 0n
}
