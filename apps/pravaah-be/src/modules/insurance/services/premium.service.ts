import { createHash } from 'crypto'

import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  MAX_PREMIUM_ATTEMPTS,
  PREMIUM_PERIOD_DAYS,
} from '@/modules/insurance/insurance.config'
import {
  graceEndsAt,
  isCoverLive,
  nextPremiumDueAt,
  premiumPeriod,
} from '@/modules/insurance/insurance.state'
import { InsuranceMoneyService } from '@/modules/insurance/services/insurance-money.service'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'

import {
  PolicyStatus,
  PremiumFrequency,
  type Policy,
  type PremiumPayment,
} from 'generated/prisma/client'

/** Why a premium collection did not complete, as the caller needs to branch on it. */
export type PremiumOutcome =
  | { ok: true; premium: PremiumPayment; transactionId: string }
  | {
      ok: false
      premium: PremiumPayment
      reason: 'INSUFFICIENT_BALANCE' | 'STATE_CONFLICT' | 'ALREADY_EXHAUSTED'
      /** Set for INSUFFICIENT_BALANCE. What the user needs to top up. */
      shortfallMinor?: bigint
      message: string
    }

/**
 * Premium collection and the dunning path.
 *
 * Two collections happen here and they are NOT the same operation:
 *
 *  - **The first premium**, at purchase, with the client's own `Idempotency-Key`.
 *    Cover does not exist until it settles.
 *  - **Every recurring premium**, from a cron, with a key DERIVED from the policy and
 *    the period. The cron has no client to supply one, and a generated key would make
 *    each retry a new debit.
 *
 * ## The period key is the whole idempotency story
 *
 * `PremiumPayment` is unique on `(policyId, periodStart)` and its `idempotencyKey` is
 * `sha256(policyId : periodStart)`. Together those mean a period can be ATTEMPTED any
 * number of times and COLLECTED exactly once — the retry finds the same row and the
 * same key, and M4 resolves the key to the transaction that already exists. A random
 * key per attempt would debit a policyholder four times for one month, which is the
 * specific failure that makes people distrust auto-debit.
 *
 * ## Why a failed premium is not an error
 *
 * A daily-wage earner's wallet being empty on the due date is the ORDINARY case this
 * product has to survive. It moves the policy to GRACE — cover still live — and
 * retries. Treating it as an exception would either lapse cover on the first bad day
 * or fill the logs with stack traces for the most expected event in the module.
 */
@Injectable()
export class PremiumService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly money: InsuranceMoneyService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PremiumService.name })
  }

  /**
   * Collect the first premium for a policy that has just been created.
   *
   * The period start is RESOLVED, not taken as `new Date()`, and that is the whole
   * point of this method existing separately from {@link collectForPeriod}.
   *
   * A retry — the holder tops up their wallet an hour later and tries again — must
   * collect the SAME period. Taking `now` on each call would compute a different
   * `periodStart`, which produces a different `(policyId, periodStart)` row and a
   * different derived idempotency key: two premium periods and two debits for one
   * month of cover. That is the exact failure that makes people distrust auto-debit,
   * and it is invisible in testing because the happy path only ever calls this once.
   *
   * So an existing first period wins, and only a genuinely first attempt starts now.
   */
  async collectFirst(
    policy: Policy,
    context: { deviceId?: string | null; ipAddress?: string | null } = {},
  ): Promise<PremiumOutcome> {
    const existing = await this.prisma.premiumPayment.findFirst({
      where: { policyId: policy.id },
      orderBy: { periodStart: 'asc' },
      select: { periodStart: true },
    })

    const period = premiumPeriod(existing?.periodStart ?? new Date())
    return this.collectForPeriod(policy, period, context)
  }

  /**
   * Collect a recurring premium for the period beginning at `periodStart`.
   *
   * Called by the dunning sweep. Increments the attempt counter on the SAME row
   * rather than inserting a new one, so "how many times have we tried to collect
   * July?" is a column rather than a count over rows that a partial failure could
   * skew.
   */
  async collectRecurring(
    policy: Policy,
    periodStart: Date,
  ): Promise<PremiumOutcome> {
    return this.collectForPeriod(policy, premiumPeriod(periodStart), {})
  }

  private async collectForPeriod(
    policy: Policy,
    period: { start: Date; end: Date },
    context: { deviceId?: string | null; ipAddress?: string | null },
  ): Promise<PremiumOutcome> {
    const premium = await this.upsertPeriod(policy, period)

    // Already paid — the point of the unique period row.
    if (premium.status === 'PAID' && premium.transactionId) {
      return { ok: true, premium, transactionId: premium.transactionId }
    }

    if (premium.attempt > MAX_PREMIUM_ATTEMPTS) {
      /**
       * The attempt budget is spent.
       *
       * Reported rather than retried forever. A policy whose premium has failed four
       * times is one the dunning sweep should leave to lapse, and continuing to debit
       * a wallet that keeps coming up short is a worse experience than an honest
       * lapse notice.
       */
      return {
        ok: false,
        premium,
        reason: 'ALREADY_EXHAUSTED',
        message: `We tried to collect this premium ${MAX_PREMIUM_ATTEMPTS} times without success.`,
      }
    }

    const result = await this.money.collectPremium({
      userId: policy.userId,
      policyId: policy.id,
      premiumPaymentId: premium.id,
      amountMinor: premium.amountMinor,
      currency: premium.currency,
      idempotencyKey: premium.idempotencyKey,
      deviceId: context.deviceId,
      ipAddress: context.ipAddress,
    })

    if (!result.collected) {
      const failure = result.failure
      const reason =
        failure?.kind === 'INSUFFICIENT_BALANCE'
          ? 'INSUFFICIENT_BALANCE'
          : 'STATE_CONFLICT'

      const updated = await this.prisma.premiumPayment.update({
        where: { id: premium.id },
        data: {
          status: 'FAILED',
          failureReason:
            failure?.kind === 'INSUFFICIENT_BALANCE'
              ? 'Not enough balance in the Pravaah wallet'
              : (failure?.detail ?? 'Premium collection did not complete'),
        },
      })

      this.logger.warn(
        `[${this.collectForPeriod.name}] Premium not collected`,
        {
          policyId: policy.id,
          premiumPaymentId: premium.id,
          attempt: premium.attempt,
          reason,
        },
      )

      return {
        ok: false,
        premium: updated,
        reason,
        shortfallMinor:
          failure?.kind === 'INSUFFICIENT_BALANCE'
            ? failure.shortfallMinor
            : undefined,
        message:
          failure?.kind === 'INSUFFICIENT_BALANCE'
            ? 'There was not enough in your Pravaah wallet to collect this premium. Add money and we will try again.'
            : 'We could not collect this premium. We will try again shortly.',
      }
    }

    const paid = await this.prisma.premiumPayment.update({
      where: { id: premium.id },
      data: {
        status: 'PAID',
        transactionId: result.transaction.id,
        paidAt: new Date(),
        failureReason: null,
      },
    })

    return { ok: true, premium: paid, transactionId: result.transaction.id }
  }

  /**
   * Get or create the row for a period, bumping `attempt` on a retry.
   *
   * Create-then-catch rather than `upsert`, for the reason M4's `ensureAccount`
   * documents: two concurrent collections (the cron and a manual retry) race to
   * create the same period, and Prisma's `upsert` still resolves to an INSERT under
   * the hood, so the loser gets a unique violation. Here that violation is not a
   * failure — it is the answer.
   */
  private async upsertPeriod(
    policy: Policy,
    period: { start: Date; end: Date },
  ): Promise<PremiumPayment> {
    const idempotencyKey = this.periodKey(policy.id, period.start)

    try {
      return await this.prisma.premiumPayment.create({
        data: {
          policyId: policy.id,
          amountMinor: policy.premiumMinor,
          currency: policy.currency,
          periodStart: period.start,
          periodEnd: period.end,
          status: 'PENDING',
          idempotencyKey,
        },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }

    const existing = await this.prisma.premiumPayment.findUnique({
      where: {
        policyId_periodStart: {
          policyId: policy.id,
          periodStart: period.start,
        },
      },
    })
    if (!existing) {
      // Only reachable if the row was created and deleted between our INSERT and
      // this SELECT. Retrying the insert would race again; surfacing it lets the
      // caller (a cron) pick the policy up on its next pass.
      throw new Error(
        `Premium period for policy ${policy.id} vanished while claiming it`,
      )
    }

    if (existing.status === 'PAID') return existing

    return this.prisma.premiumPayment.update({
      where: { id: existing.id },
      data: { attempt: { increment: 1 }, status: 'PENDING' },
    })
  }

  /**
   * The deterministic idempotency key for a policy period.
   *
   * Hashed rather than concatenated so the key length is fixed and it carries no
   * internal ids in the clear — the same treatment M4 gives its rail references. The
   * period start is normalised to milliseconds since epoch, so two callers computing
   * "the period starting on the 1st" cannot disagree over a timezone rendering.
   */
  private periodKey(policyId: string, periodStart: Date): string {
    return `prem-${createHash('sha256')
      .update(`${policyId}:${periodStart.getTime()}`)
      .digest('hex')
      .slice(0, 40)}`
  }

  // ── the dunning path ──────────────────────────────────────────────────────
  /**
   * A premium came due. Try to collect it, and move the policy accordingly.
   *
   * The state transitions are the consumer-protection logic:
   *
   *  - **Collected while ACTIVE** → stay ACTIVE, advance the due date.
   *  - **Collected while in GRACE** → back to ACTIVE. Cover is restored, and
   *    critically the WAITING PERIOD IS NOT RESET. Requiring a new policy after a
   *    one-week gap would cost a daily-wage earner months of accrued cover because
   *    their wallet was empty on a Tuesday.
   *  - **Failed while ACTIVE** → GRACE, with the window recorded. Cover stays live.
   *  - **Failed while in GRACE** → stay in GRACE. The lapse is the sweep's decision
   *    once `graceEndsAt` passes, not this method's, so a retry that fails on day two
   *    of seven does not end somebody's cover five days early.
   */
  async settleDuePremium(policy: Policy): Promise<{
    policy: Policy
    outcome: PremiumOutcome
  }> {
    if (policy.frequency !== PremiumFrequency.MONTHLY) {
      throw new Error(
        `settleDuePremium called for a ${policy.frequency} policy — one-time premiums have no recurrence`,
      )
    }

    /**
     * The period starts at the DUE DATE, not now.
     *
     * That is what makes the period key stable across retries: a sweep running at
     * 02:00 and again at 03:00 must compute the same period for the same missed
     * premium, and `now` would give two different keys and two debits.
     */
    const periodStart = policy.nextPremiumDueAt ?? new Date()
    const outcome = await this.collectRecurring(policy, periodStart)

    if (outcome.ok) {
      const period = premiumPeriod(periodStart)
      const updated = await this.prisma.policy.update({
        where: { id: policy.id },
        data: {
          // GRACE → ACTIVE restores cover. Already-ACTIVE stays ACTIVE.
          status: PolicyStatus.ACTIVE,
          nextPremiumDueAt: nextPremiumDueAt(
            PremiumFrequency.MONTHLY,
            period.end,
          ),
          graceEndsAt: null,
        },
      })

      if (policy.status === PolicyStatus.GRACE) {
        this.logger.info(
          `[${this.settleDuePremium.name}] Cover restored after a missed premium`,
          { policyId: policy.id },
        )
      }
      return { policy: updated, outcome }
    }

    // Already in GRACE — leave the lapse decision to the sweep's clock.
    if (policy.status === PolicyStatus.GRACE) {
      return { policy, outcome }
    }

    if (!isCoverLive(policy.status)) {
      // Nothing to move: the policy is already closed.
      return { policy, outcome }
    }

    const graced = await this.prisma.policy.update({
      where: { id: policy.id },
      data: {
        status: PolicyStatus.GRACE,
        graceEndsAt: graceEndsAt(periodStart),
      },
    })

    this.logger.info(
      `[${this.settleDuePremium.name}] Premium missed — policy moved to grace, cover still live`,
      { policyId: policy.id, graceEndsAt: graced.graceEndsAt },
    )
    return { policy: graced, outcome }
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  /** The premium history for a policy. What the holder sees under "payments". */
  history(policyId: string): Promise<PremiumPayment[]> {
    return this.prisma.premiumPayment.findMany({
      where: { policyId },
      orderBy: { periodStart: 'desc' },
    })
  }

  /** The most recent SETTLED premium — the one a free-look refund returns. */
  latestPaid(policyId: string): Promise<PremiumPayment | null> {
    return this.prisma.premiumPayment.findFirst({
      where: { policyId, status: 'PAID', transactionId: { not: null } },
      orderBy: { periodStart: 'desc' },
    })
  }

  /** Every settled premium on a policy, oldest first. Used by the full refund. */
  allPaid(policyId: string): Promise<PremiumPayment[]> {
    return this.prisma.premiumPayment.findMany({
      where: { policyId, status: 'PAID', transactionId: { not: null } },
      orderBy: { periodStart: 'asc' },
    })
  }

  /** The period length, exposed so the policy service does not re-derive it. */
  get periodDays(): number {
    return PREMIUM_PERIOD_DAYS
  }
}
