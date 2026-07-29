import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import {
  AUTH_VELOCITY,
  SIGNAL_WEIGHTS,
  VELOCITY_CAPS,
  type VelocityCap,
} from '@/modules/fraud/fraud.config'
import {
  breachDegree,
  breachDegreeBigInt,
  velocityBucketKey,
  velocityResetAt,
  type Signal,
} from '@/modules/fraud/fraud.state'
import { hashIdentifier, hashIpNetwork } from '@/modules/fraud/risk-hash.util'
import type { RiskContext } from '@/modules/fraud/risk.types'

import {
  RiskSubjectType,
  VelocityDimension,
  type Prisma,
} from 'generated/prisma/client'

/**
 * Rolling velocity — the cheapest, highest-yield fraud control there is.
 *
 * Nearly every attack that monetises a foothold does so FAST, because the attacker
 * is racing detection. A takeover drains; a mule ring passes funds through; a
 * stuffing bot sprays. All three are visible as rate long before they are visible
 * as anything else.
 *
 * ## Two design decisions, both because the obvious version is racy
 *
 *  1. **A new window is a NEW ROW**, keyed by `bucketKey`. The build-doc version of
 *     this service did `upsert(..., update: {})` and then a second `update` that
 *     zeroed the counter when `resetAt` had passed. That is three round trips and a
 *     race: two concurrent requests both read the stale reset time, both zero the
 *     counter, and both then spend a full window's budget in the same second. This
 *     is M4's `LimitCounter` lesson, and it cost that module a rewrite to learn.
 *  2. **Increment and read are ONE statement.** `create`-then-catch-then-`update`
 *     with an atomic `{ increment }` means Postgres arbitrates, and the returned row
 *     is the post-increment value — so the caller never compares a count it read
 *     before its own event was counted.
 *
 * ## Signal, not limit
 *
 * Nothing here refuses anything. M4's `LimitService` owns the hard regulatory caps
 * and throws; this contributes a WEIGHTED signal the ladder may or may not act on.
 * Conflating the two would give either a fraud heuristic that blocks money by
 * itself, or a regulatory limit a favourable risk score could argue away.
 */
@Injectable()
export class VelocityService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: VelocityService.name })
  }

  // ── the collector ─────────────────────────────────────────────────────────
  /**
   * Count this action and report anything it breached.
   *
   * WRITES, unless `dryRun`. That is why the engine calls collectors exactly once
   * per action: scoring the same transfer twice would count it twice and inflate
   * the user's own velocity against them.
   */
  async signals(ctx: RiskContext): Promise<Signal[]> {
    if (ctx.subjectType === RiskSubjectType.TRANSACTION) {
      return this.transactionSignals(ctx)
    }
    if (ctx.subjectType === RiskSubjectType.CONSENT) {
      return this.consentSignals(ctx)
    }
    return []
  }

  private async transactionSignals(ctx: RiskContext): Promise<Signal[]> {
    const amount = ctx.amountMinor ?? 0n
    const out: Signal[] = []

    const counts = await this.bumpAll(
      ctx.userId,
      VelocityDimension.TXN_COUNT,
      0n,
      ctx.dryRun,
    )
    const values = await this.bumpAll(
      ctx.userId,
      VelocityDimension.TXN_VALUE,
      amount,
      ctx.dryRun,
    )

    for (const { cap, count } of counts) {
      const degree = breachDegree(count, cap.count)
      if (degree > 0) {
        out.push({
          type: 'VELOCITY_COUNT',
          weight: SIGNAL_WEIGHTS.VELOCITY_COUNT,
          value: degree,
          reason: `${count} payments in the last ${humaniseWindow(cap.label)}`,
        })
      }
    }

    for (const { cap, valueMinor } of values) {
      const degree = breachDegreeBigInt(valueMinor, cap.valueMinor)
      if (degree > 0) {
        out.push({
          type: 'VELOCITY_VALUE',
          weight: SIGNAL_WEIGHTS.VELOCITY_VALUE,
          value: degree,
          reason: `An unusually high total sent in the last ${humaniseWindow(cap.label)}`,
        })
      }
    }

    /**
     * New-beneficiary-then-drain — the APP / social-engineering signature (T7).
     *
     * The single most common shape of a UPI scam: the victim is talked into saving
     * an address and sending everything at once. Note this is the SIGNAL; M4's
     * `assertNewBeneficiaryWindow` is the hard cap that actually limits the damage.
     * Both exist because the cap bounds the loss and the signal escalates the
     * account — one stops this payment, the other catches the pattern.
     */
    if (
      ctx.beneficiaryAgeMs != null &&
      ctx.beneficiaryAgeMs < 10 * 60_000 &&
      amount >= 50_000_00n
    ) {
      out.push({
        type: 'NEW_BENEFICIARY_DRAIN',
        weight: SIGNAL_WEIGHTS.NEW_BENEFICIARY_DRAIN,
        value: 1,
        reason: 'A large payment to a payee added minutes ago',
      })
    }

    // Only the WORST breach per type survives — see `dedupeByType`. Two windows
    // firing the same signal is one fact observed twice, and counting it twice in
    // a noisy-OR would double its weight.
    return dedupeByType(out)
  }

  private async consentSignals(ctx: RiskContext): Promise<Signal[]> {
    const counts = await this.bumpAll(
      ctx.userId,
      VelocityDimension.CONSENT,
      0n,
      ctx.dryRun,
    )

    const out: Signal[] = []
    for (const { cap, count } of counts) {
      const degree = breachDegree(count, cap.count)
      if (degree > 0) {
        out.push({
          type: 'CONSENT_VELOCITY',
          weight: SIGNAL_WEIGHTS.CONSENT_VELOCITY,
          value: degree,
          reason: `${count} data-sharing requests in the last ${humaniseWindow(cap.label)}`,
        })
      }
    }
    return dedupeByType(out)
  }

  // ── auth: credential stuffing and ATO (T3) ────────────────────────────────
  /**
   * Failed-login velocity, per identifier AND per network.
   *
   * Split because the two attacks look nothing alike, and a single counter would
   * catch neither well. A handful of fails on ONE identifier is usually a person who
   * forgot their password — soft, low threshold. The same volume from one /24 across
   * MANY identifiers is a bot — high threshold, and past `IP_HARD_FAILS` it is hard,
   * because at forty misses in ten minutes from one network there is no innocent
   * reading left.
   *
   * Reads `AuthAttempt` rows directly rather than a bucketed counter: the window here
   * must be a true sliding one (a bot that straddles a bucket edge is the entire
   * problem), and the row volume is bounded by the rate limiter in front of it.
   */
  async loginSignals(params: {
    identifierHash: string
    ipHash?: string | null
  }): Promise<Signal[]> {
    const since = new Date(Date.now() - AUTH_VELOCITY.WINDOW_MS)
    const out: Signal[] = []

    const identifierFails = await this.prisma.authAttempt.count({
      where: {
        identifierHash: params.identifierHash,
        success: false,
        createdAt: { gt: since },
      },
    })

    if (identifierFails >= AUTH_VELOCITY.IDENTIFIER_FAILS) {
      out.push({
        type: 'LOGIN_STUFFING',
        weight: SIGNAL_WEIGHTS.LOGIN_STUFFING,
        value: breachDegree(identifierFails, AUTH_VELOCITY.IDENTIFIER_FAILS),
        reason: `${identifierFails} failed sign-in attempts for this account in the last 10 minutes`,
      })
    }

    if (params.ipHash) {
      const ipFails = await this.prisma.authAttempt.count({
        where: {
          ipHash: params.ipHash,
          success: false,
          createdAt: { gt: since },
        },
      })

      if (ipFails >= AUTH_VELOCITY.IP_FAILS) {
        const isHard = ipFails >= AUTH_VELOCITY.IP_HARD_FAILS
        out.push({
          type: 'LOGIN_STUFFING',
          weight: SIGNAL_WEIGHTS.LOGIN_STUFFING,
          value: 1,
          reason: isHard
            ? 'A credential-stuffing pattern from this network'
            : `${ipFails} failed sign-in attempts from this network in the last 10 minutes`,
          isHard,
        })

        if (isHard) {
          this.logger.warn(
            `[${this.loginSignals.name}] Hard-blocking a network on stuffing volume`,
            { ipFails },
          )
        }
      }
    }

    return dedupeByType(out)
  }

  /**
   * Record a login attempt. Called on every outcome, success and failure.
   *
   * Best-effort: a failure to record must never break a login. But note the
   * asymmetry with the audit trail — a lost attempt row weakens a future stuffing
   * count, so it is logged at `warn` rather than swallowed silently.
   */
  async recordAuthAttempt(params: {
    identifier: string
    ipAddress?: string | null
    userId?: string | null
    deviceRef?: string | null
    success: boolean
    outcome?: string
  }): Promise<void> {
    try {
      await this.prisma.authAttempt.create({
        data: {
          identifierHash: hashIdentifier(params.identifier),
          ipHash: params.ipAddress
            ? hashIpNetwork(params.ipAddress)
            : 'unknown',
          userId: params.userId ?? null,
          deviceRef: params.deviceRef ?? null,
          success: params.success,
          outcome: params.outcome ?? null,
        },
      })
    } catch (error) {
      this.logger.warn(
        `[${this.recordAuthAttempt.name}] Failed to record an auth attempt — stuffing detection is degraded`,
        { err: error },
      )
    }
  }

  // ── step-up failure velocity ──────────────────────────────────────────────
  /**
   * Failed step-ups in the lockout window.
   *
   * Closes the gap the per-challenge attempt cap leaves open: three guesses per
   * challenge with unlimited challenges is unlimited guesses. Read by
   * `StepUpService` before issuing, so a user under attack stops being issued
   * challenges at all.
   */
  async stepUpFailures(userId: string): Promise<number> {
    const cap = VELOCITY_CAPS.STEP_UP_FAIL?.[0]
    if (!cap) return 0

    const counter = await this.read(userId, VelocityDimension.STEP_UP_FAIL, cap)
    return counter?.count ?? 0
  }

  async recordStepUpFailure(userId: string): Promise<void> {
    await this.bumpAll(userId, VelocityDimension.STEP_UP_FAIL, 0n, false)
  }

  async recordNewBeneficiary(userId: string): Promise<void> {
    await this.bumpAll(userId, VelocityDimension.NEW_BENEFICIARY, 0n, false)
  }

  // ── the counter primitive ─────────────────────────────────────────────────
  /**
   * Increment (or read) every window configured for a dimension.
   *
   * Every window, not just the shortest, because the windows cover each other's
   * boundary effects. A tumbling 10-minute bucket lets an attacker straddle the edge
   * for up to 2× the budget; the 1-day bucket is still counting when that happens.
   */
  private async bumpAll(
    userId: string,
    dimension: VelocityDimension,
    valueMinor: bigint,
    dryRun = false,
  ): Promise<Array<{ cap: VelocityCap; count: number; valueMinor: bigint }>> {
    const caps = VELOCITY_CAPS[dimension] ?? []
    const results: Array<{
      cap: VelocityCap
      count: number
      valueMinor: bigint
    }> = []

    for (const cap of caps) {
      const row = dryRun
        ? await this.read(userId, dimension, cap)
        : await this.bump(userId, dimension, cap, valueMinor)

      results.push({
        cap,
        count: row?.count ?? 0,
        valueMinor: row?.valueMinor ?? 0n,
      })
    }

    return results
  }

  /**
   * Atomically count one event in one window.
   *
   * `create`-then-catch-then-`update`, and the catch is the normal path after the
   * first event in a bucket rather than an error case. The alternative — `upsert`
   * with `{ increment }` in the update branch — is correct in Prisma too, but this
   * form returns the post-increment row from a single `updateMany`+read on the hot
   * path and keeps the unique-violation handling identical to M4's `ensureCounter`,
   * which is the pattern this codebase already trusts.
   */
  private async bump(
    userId: string,
    dimension: VelocityDimension,
    cap: VelocityCap,
    valueMinor: bigint,
  ) {
    const now = new Date()
    const bucketKey = velocityBucketKey(cap.windowMs, now)

    try {
      return await this.prisma.velocityCounter.create({
        data: {
          userId,
          dimension,
          window: cap.label,
          bucketKey,
          count: 1,
          valueMinor,
          resetAt: velocityResetAt(cap.windowMs, now),
        },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }

    /**
     * The bucket already exists. Increment it and return the POST-increment row.
     *
     * `update` rather than `updateMany` so the updated row comes back — the caller
     * must compare a count that includes its own event. Comparing a pre-increment
     * count is an off-by-one that lets exactly one extra action through every window.
     */
    return this.prisma.velocityCounter.update({
      where: {
        userId_dimension_window_bucketKey: {
          userId,
          dimension,
          window: cap.label,
          bucketKey,
        },
      },
      data: {
        count: { increment: 1 },
        valueMinor: { increment: valueMinor },
      },
    })
  }

  private read(
    userId: string,
    dimension: VelocityDimension,
    cap: VelocityCap,
  ): Promise<Prisma.VelocityCounterGetPayload<object> | null> {
    return this.prisma.velocityCounter.findUnique({
      where: {
        userId_dimension_window_bucketKey: {
          userId,
          dimension,
          window: cap.label,
          bucketKey: velocityBucketKey(cap.windowMs),
        },
      },
    })
  }
}

/**
 * Keep only the strongest instance of each signal type.
 *
 * Necessary because two windows can breach the same dimension at once (5 payments
 * in 10 minutes is also 5 payments in a day). In a noisy-OR, two copies of one
 * signal compound as though they were independent observations — so a single busy
 * afternoon would score as two separate anomalies.
 */
function dedupeByType(signals: Signal[]): Signal[] {
  const strongest = new Map<string, Signal>()
  for (const signal of signals) {
    const existing = strongest.get(signal.type)
    const isStronger =
      !existing ||
      Boolean(signal.isHard) > Boolean(existing.isHard) ||
      signal.weight * signal.value > existing.weight * existing.value

    if (isStronger) strongest.set(signal.type, signal)
  }
  return [...strongest.values()]
}

function humaniseWindow(label: string): string {
  switch (label) {
    case '1m':
      return 'minute'
    case '10m':
      return '10 minutes'
    case '30m':
      return '30 minutes'
    case '1h':
      return 'hour'
    case '1d':
      return 'day'
    default:
      return label
  }
}
