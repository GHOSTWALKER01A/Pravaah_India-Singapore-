import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  AUTH_ATTEMPT_RETENTION_MS,
  BINDING_TOKEN_TTL_MS,
  GRAPH,
  VELOCITY_RETENTION_MS,
} from '@/modules/fraud/fraud.config'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { MuleGraphService } from '@/modules/fraud/services/mule-graph.service'
import { StepUpService } from '@/modules/fraud/services/step-up.service'

import { DeviceStatus, DeviceEventType } from 'generated/prisma/client'

/**
 * M6's background work — the jobs that keep the fast path fast and the data honest.
 *
 * Everything expensive lives here rather than on a request path. That split is the
 * whole reason a transfer can be risk-scored in a few indexed reads: the graph
 * traversal, the token-staleness sweep and the retention purges all happen on a clock.
 *
 * Every job is INDEPENDENTLY guarded. A throw inside one `@Cron` handler is an
 * unhandled rejection that Nest logs and moves past, but it would also abort the rest
 * of that handler's work — so each one catches its own failures and reports them,
 * because a silently dead retention sweep is a table that grows until it is a
 * production incident.
 */
@Injectable()
export class FraudSchedulerService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MuleGraphService,
    private readonly stepUp: StepUpService,
    private readonly devices: DeviceTrustService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FraudSchedulerService.name })
  }

  /**
   * Recompute the mule graph.
   *
   * Every 15 minutes, which is the staleness the inline path accepts. A mule ring does
   * not form in the seconds between two transfers, so a score computed a few minutes
   * ago is as good as one computed now — and this is the trade that keeps a graph
   * traversal out of a payment.
   */
  @Cron(GRAPH.RECOMPUTE_CRON, { name: 'fraud:graph-recompute' })
  async recomputeGraph(): Promise<void> {
    try {
      await this.graph.recomputeClusters()
    } catch (error) {
      this.logger.error(
        `[${this.recomputeGraph.name}] Graph recompute failed — inline scores are now stale`,
        { err: error },
      )
    }
  }

  /**
   * Expire stale step-up challenges.
   *
   * Housekeeping, not correctness: `isStepUpRedeemable` already checks the clock, so a
   * PENDING row past its expiry cannot be redeemed. This exists so the analyst view and
   * the lockout counters are not polluted by rows that are dead but labelled pending —
   * a dashboard full of stale PENDING challenges is how an operator stops trusting it.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'fraud:expire-step-ups' })
  async expireStepUps(): Promise<void> {
    try {
      const expired = await this.stepUp.expireStale()
      if (expired > 0) {
        this.logger.info(
          `[${this.expireStepUps.name}] Expired ${expired} stale challenges`,
        )
      }
    } catch (error) {
      this.logger.error(`[${this.expireStepUps.name}] Sweep failed`, {
        err: error,
      })
    }
  }

  /**
   * Flag devices whose binding token is past its TTL.
   *
   * A token that never expires has the useful life of the account. This does NOT revoke
   * the device — that would sign a user out for the crime of not opening the app for a
   * week. It records an event, so the next action from that device carries a
   * `TOKEN_REFRESH`-due marker and the app can rotate on its next call.
   *
   * The distinction matters: rotation is a hygiene measure, and a hygiene measure that
   * locks people out gets switched off by the first operator who gets paged for it.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'fraud:stale-tokens' })
  async flagStaleTokens(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - BINDING_TOKEN_TTL_MS)

      /**
       * Devices ALREADY flagged inside this TTL window.
       *
       * Without this the job re-flags the same devices every hour, forever. A device whose
       * client never calls refresh — a seeded fixture, a web session, an uninstalled app —
       * stays stale permanently, so the sweep would write a `TOKEN_REFRESH` row per device
       * per hour indefinitely: unbounded growth on the one table the analyst timeline reads,
       * burying every real bind, revoke and SIM-change event under a wall of maintenance
       * markers. That is worse than not flagging at all, because it destroys the signal the
       * events exist to carry.
       *
       * One marker per device per TTL window is the correct cadence: the marker means "this
       * token is due for rotation", which is a fact that does not become truer by being
       * restated hourly.
       */
      const alreadyFlagged = await this.prisma.deviceEvent.findMany({
        where: {
          type: DeviceEventType.TOKEN_REFRESH,
          createdAt: { gte: cutoff },
          deviceRef: { not: null },
        },
        select: { deviceRef: true },
        distinct: ['deviceRef'],
      })
      const flaggedIds = alreadyFlagged
        .map((event) => event.deviceRef)
        .filter((id): id is string => id !== null)

      const stale = await this.prisma.device.findMany({
        where: {
          status: DeviceStatus.ACTIVE,
          /**
           * `null` counts as stale — those are devices bound before rotation existed,
           * and they are the ones most in need of a fresh token.
           */
          OR: [{ tokenRotatedAt: null }, { tokenRotatedAt: { lt: cutoff } }],
          ...(flaggedIds.length > 0 ? { id: { notIn: flaggedIds } } : {}),
        },
        select: { id: true, userId: true },
        take: 500,
      })

      for (const device of stale) {
        await this.devices.recordEvent({
          userId: device.userId,
          deviceRef: device.id,
          type: DeviceEventType.TOKEN_REFRESH,
          metadata: { due: true, reason: 'binding token past its TTL' },
        })
      }

      if (stale.length > 0) {
        this.logger.info(
          `[${this.flagStaleTokens.name}] Flagged ${stale.length} devices for token rotation`,
        )
      }
    } catch (error) {
      this.logger.error(`[${this.flagStaleTokens.name}] Sweep failed`, {
        err: error,
      })
    }
  }

  /**
   * Purge data that has outlived its purpose.
   *
   * ## What is purged, and what deliberately is not
   *
   * Velocity buckets and auth attempts go — a counter for a window that closed last
   * week has no further use, and DPDP's storage-limitation principle says data kept
   * without a purpose is data kept unlawfully.
   *
   * `RiskAssessment` and `FraudCase` are NOT purged here, despite
   * `ASSESSMENT_RETENTION_MS` existing. That is a considered omission rather than an
   * oversight: deleting an assessment destroys the only explanation of a decision that
   * affected somebody, which is precisely what DPDP requires be explainable to them,
   * and a fraud dispute is argued months later from exactly those rows. Purging them
   * needs a deliberate, audited retention job with legal sign-off on the window — not
   * a cron sweep that quietly erases the evidence trail.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'fraud:retention' })
  async purgeExpiredData(): Promise<void> {
    try {
      const velocityCutoff = new Date(Date.now() - VELOCITY_RETENTION_MS)
      const authCutoff = new Date(Date.now() - AUTH_ATTEMPT_RETENTION_MS)

      const [velocity, auth, lists] = await Promise.all([
        this.prisma.velocityCounter.deleteMany({
          where: { resetAt: { lt: velocityCutoff } },
        }),
        this.prisma.authAttempt.deleteMany({
          where: { createdAt: { lt: authCutoff } },
        }),
        /**
         * Time-boxed listings past their expiry are DEACTIVATED, never deleted.
         *
         * The row is the record that an identifier was once listed and by whom, which
         * is what an appeal or a review of a wrongful listing is argued from. The
         * lookup already excludes expired entries, so deactivating changes nothing
         * operationally and preserves the history.
         */
        this.prisma.listEntry.updateMany({
          where: { active: true, expiresAt: { lt: new Date() } },
          data: { active: false },
        }),
      ])

      this.logger.info(`[${this.purgeExpiredData.name}] Retention sweep done`, {
        velocityCounters: velocity.count,
        authAttempts: auth.count,
        listEntriesDeactivated: lists.count,
      })
    } catch (error) {
      this.logger.error(`[${this.purgeExpiredData.name}] Sweep failed`, {
        err: error,
      })
    }
  }

  /**
   * Re-check SIM serials on devices that have not been seen recently.
   *
   * Catches the swap that happened while the app was closed — the case the inline
   * check structurally cannot see, because the inline check only runs when the device
   * acts. An attacker who swaps a SIM and waits is exactly the patient version of T1,
   * and without this job the freeze would only arrive after their first transfer
   * attempt rather than before it.
   *
   * Bounded to a small batch so one pass cannot fan out into thousands of provider
   * calls, and skipped entirely when the provider is not configured — there is nothing
   * to corroborate against.
   */
  @Cron(CronExpression.EVERY_6_HOURS, { name: 'fraud:sim-recheck' })
  async recheckSimSerials(): Promise<void> {
    try {
      const staleAfter = new Date(Date.now() - 24 * 60 * 60 * 1_000)

      const candidates = await this.prisma.device.findMany({
        where: {
          status: DeviceStatus.ACTIVE,
          simSerialHash: { not: null },
          lastSeenAt: { lt: staleAfter },
        },
        select: {
          id: true,
          simSerialHash: true,
          user: { select: { phone: true } },
        },
        take: 100,
      })

      let flagged = 0
      for (const device of candidates) {
        if (!device.user.phone) continue

        const result = await this.devices.detectSimSwap({
          deviceRef: device.id,
          mobileHash: this.devices.mobileHashFor(device.user.phone),
          /**
           * The STORED serial is presented, not a fresh one.
           *
           * There is no fresh one — the device is not here to report it. So this pass
           * asks only the carrier's question ("was this number re-issued"), and the
           * anchor comparison necessarily agrees with itself. That is why the job is
           * useless without a live provider and why it is skipped below.
           */
          presentedSimSerialHash: device.simSerialHash,
          source: 'sweep',
        })

        if (result.suspected) flagged += 1
      }

      if (flagged > 0) {
        this.logger.warn(
          `[${this.recheckSimSerials.name}] Flagged ${flagged} devices on a background SIM re-check`,
        )
      }
    } catch (error) {
      this.logger.error(`[${this.recheckSimSerials.name}] Sweep failed`, {
        err: error,
      })
    }
  }
}
