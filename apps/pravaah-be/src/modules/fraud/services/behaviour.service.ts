import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { BEHAVIOUR, SIGNAL_WEIGHTS } from '@/modules/fraud/fraud.config'
import { clamp01, type Signal } from '@/modules/fraud/fraud.state'
import type { RiskContext } from '@/modules/fraud/risk.types'

import { RiskSubjectType, TxnStatus } from 'generated/prisma/client'

/**
 * Per-user behavioural baselines — amount, hour, and geography.
 *
 * ## The principle: relative, not absolute
 *
 * Every signal here compares a user against THEMSELVES, never against a population
 * average. ₹200,000 is unremarkable for somebody who remits that monthly and a
 * four-sigma event for somebody whose largest previous transfer was ₹5,000. A
 * population threshold gets both wrong in the expensive direction: it waves through
 * the drain of a small account and challenges the ordinary behaviour of a large one.
 *
 * ## Why none of these can act alone
 *
 * A person can legitimately make a large payment at 3am from a city they have never
 * visited — that is a description of a business traveller with an emergency, not a
 * fraudster. So each of these is a modest weighted contribution, and it is the
 * COMBINATION (new device + odd hour + impossible geography + anomalous amount) that
 * pushes the aggregate past a threshold. This is where the noisy-OR earns its place:
 * four such signals compound to ~0.75 while any one of them scores below 0.30.
 */
@Injectable()
export class BehaviourService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: BehaviourService.name })
  }

  async signals(ctx: RiskContext): Promise<Signal[]> {
    const out: Signal[] = []

    if (
      ctx.subjectType === RiskSubjectType.TRANSACTION &&
      ctx.amountMinor != null
    ) {
      const amountSignal = await this.amountAnomaly(ctx.userId, ctx.amountMinor)
      if (amountSignal) out.push(amountSignal)
    }

    const hourSignal = this.oddHour(ctx.geoHint)
    if (hourSignal) out.push(hourSignal)

    out.push(...(await this.geoSignals(ctx)))
    return out
  }

  // ── amount ────────────────────────────────────────────────────────────────
  /**
   * Is this amount a statistical outlier for this user?
   *
   * A z-score over their recent successful transfers. Three details matter:
   *
   *  - **Only SUCCESS rows form the baseline.** Including failures would let an
   *    attacker inflate a victim's baseline with a series of large declined attempts,
   *    then send the real one as "normal".
   *  - **A minimum history.** With two prior transactions the standard deviation is
   *    meaningless, and a confident z-score computed from noise is worse than no
   *    signal — it would fire on the third transaction every user ever makes.
   *  - **The comparison is in Number, and only after a BigInt read.** Money arithmetic
   *    stays in BigInt everywhere it decides an amount (M4's rule); a z-score is a
   *    statistic, not a ledger value, and cannot be computed in integers. The
   *    conversion is confined to this one function and never flows back into a
   *    monetary decision.
   */
  private async amountAnomaly(
    userId: string,
    amountMinor: bigint,
  ): Promise<Signal | null> {
    const prior = await this.prisma.transaction.findMany({
      where: { userId, status: TxnStatus.SUCCESS },
      select: { totalDebitMinor: true },
      take: BEHAVIOUR.HISTORY_WINDOW,
      orderBy: { createdAt: 'desc' },
    })

    if (prior.length < BEHAVIOUR.MIN_HISTORY) return null

    const values = prior.map((row) => Number(row.totalDebitMinor))
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length

    /**
     * A zero standard deviation is real, not a bug: a user who has sent exactly
     * ₹1,000 five times has none. Falling back to `1` would make the z-score
     * enormous and fire on any different amount; falling back to the MEAN treats
     * "twice your only-ever amount" as a 1-sigma event, which is the honest reading.
     */
    const stdDev = Math.sqrt(variance) || mean || 1
    const z = (Number(amountMinor) - mean) / stdDev

    if (z <= BEHAVIOUR.AMOUNT_Z_THRESHOLD) return null

    return {
      type: 'AMOUNT_ANOMALY',
      weight: SIGNAL_WEIGHTS.AMOUNT_ANOMALY,
      value: clamp01(z / BEHAVIOUR.AMOUNT_Z_SATURATION),
      reason: 'This amount is much larger than this account usually sends',
    }
  }

  // ── hour ──────────────────────────────────────────────────────────────────
  /**
   * An action at an hour this user is never active.
   *
   * The weakest signal in the module (0.10) and intentionally so — plenty of people
   * pay bills at 2am. It is here because it is nearly free and it CORROBORATES: an
   * odd hour alone means nothing, an odd hour alongside a new device and an
   * impossible geography is the third leg of a takeover.
   *
   * Evaluated in the user's inferred LOCAL time, from the geo hint. A UTC hour window
   * would flag every Indian user's 6:30am–9:30am — their morning — as unusual, which
   * is the kind of bug that makes a fraud team stop trusting a signal entirely.
   */
  private oddHour(geoHint?: string | null): Signal | null {
    const offsetMinutes = localOffsetMinutes(geoHint)
    const local = new Date(Date.now() + offsetMinutes * 60_000)
    const hour = local.getUTCHours()

    if (hour < BEHAVIOUR.ODD_HOUR_START || hour > BEHAVIOUR.ODD_HOUR_END) {
      return null
    }

    return {
      type: 'ODD_HOUR',
      weight: SIGNAL_WEIGHTS.ODD_HOUR,
      value: 0.6,
      reason: 'This action happened at an unusual time of day',
    }
  }

  // ── geography (T10) ───────────────────────────────────────────────────────
  /**
   * Impossible travel, and first-time-in-a-country.
   *
   * Compares against the most recent device event that carried a geo hint. Two
   * distinct signals come out of it, and separating them is the point:
   *
   *  - `GEO_IMPOSSIBLE` (0.50) — two different countries inside an hour. Nobody flew
   *    India↔Singapore in that window, so one of the two sessions is not the account
   *    holder.
   *  - `GEO_NEW_COUNTRY` (0.20) — a country this account has never acted from, with
   *    enough history for that to mean something. Ordinary for a traveller, which is
   *    why it is weighted a quarter of the impossible case.
   *
   * A cross-border remittance product has to be careful here: its users genuinely
   * move between two countries, and that is the whole premise. So the impossible
   * window is a conservative 60 minutes rather than a tight one, and merely being
   * abroad is never treated as suspicious on its own.
   */
  async geoSignals(ctx: RiskContext): Promise<Signal[]> {
    if (!ctx.geoHint) return []

    const country = countryOf(ctx.geoHint)
    const out: Signal[] = []

    const last = await this.prisma.deviceEvent.findFirst({
      where: { userId: ctx.userId, geoHint: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { geoHint: true, createdAt: true },
    })

    if (last?.geoHint) {
      const lastCountry = countryOf(last.geoHint)
      const elapsedMs = Date.now() - last.createdAt.getTime()

      if (
        lastCountry !== country &&
        elapsedMs < BEHAVIOUR.IMPOSSIBLE_TRAVEL_MS &&
        // A negative elapsed time means clock skew, not time travel. Ignored rather
        // than treated as a zero-second hop, which would fire on every skewed clock.
        elapsedMs >= 0
      ) {
        out.push({
          type: 'GEO_IMPOSSIBLE',
          weight: SIGNAL_WEIGHTS.GEO_IMPOSSIBLE,
          value: 1,
          reason: `This account acted from ${lastCountry} and ${country} within the hour`,
        })

        this.logger.warn(
          `[${this.geoSignals.name}] Impossible travel detected`,
          {
            userId: ctx.userId,
            from: lastCountry,
            to: country,
            elapsedMs,
          },
        )
      }
    }

    /**
     * A country never seen before.
     *
     * `distinct` on the hint rather than a count of rows, because the question is how
     * many PLACES this account has acted from — a thousand events from one city is
     * still one place, and the baseline it establishes is exactly as thin.
     */
    const seen = await this.prisma.deviceEvent.findMany({
      where: { userId: ctx.userId, geoHint: { not: null } },
      select: { geoHint: true },
      distinct: ['geoHint'],
      take: 25,
    })

    const seenCountries = new Set(
      seen
        .map((row) => (row.geoHint ? countryOf(row.geoHint) : null))
        .filter((value): value is string => value !== null),
    )

    if (
      seenCountries.size >= BEHAVIOUR.MIN_GEO_HISTORY &&
      !seenCountries.has(country)
    ) {
      out.push({
        type: 'GEO_NEW_COUNTRY',
        weight: SIGNAL_WEIGHTS.GEO_NEW_COUNTRY,
        value: 1,
        reason: `This is the first time this account has acted from ${country}`,
      })
    }

    return out
  }
}

/** The country half of a hint like `IN-MH`. */
function countryOf(geoHint: string): string {
  return geoHint.trim().toUpperCase().slice(0, 2)
}

/**
 * A crude UTC offset for the corridor's two countries.
 *
 * Deliberately a lookup rather than a timezone library. The only question asked of
 * it is "is this the middle of the night for this user", and IST (+5:30) and SGT
 * (+8:00) answer that for the entire user base of an India↔Singapore product.
 * Pulling in a full tz database to place an 0.10-weight signal more precisely would
 * be effort spent on the least decisive input in the module.
 *
 * Unknown regions fall back to UTC, which makes the signal noisier for them — and
 * since it can never decide an outcome alone, noisier is an acceptable failure.
 */
function localOffsetMinutes(geoHint?: string | null): number {
  if (!geoHint) return 0
  switch (countryOf(geoHint)) {
    case 'IN':
      return 330
    case 'SG':
      return 480
    default:
      return 0
  }
}
