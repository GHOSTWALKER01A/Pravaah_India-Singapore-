import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { PushService } from '@/modules/notifications/push.service'

import {
  ActorType,
  ConsentStatus,
  CredentialStatus,
  ScoreStatus,
} from 'generated/prisma/client'

import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'
import { VerifierSessionService } from '@/modules/passport/services/verifier-session.service'

/** How far ahead of expiry the holder gets a nudge. */
const EXPIRY_WARNING_DAYS = 7

/** Rows per page while sweeping. */
const SWEEP_BATCH = 500

/**
 * Pages one tick will walk before stopping. 500 × 40 = 20,000 credentials per run, which is
 * a bound on the tick's cost rather than on correctness: the next tick starts over and the
 * primary revocation path is synchronous anyway.
 */
const MAX_SWEEP_PAGES = 40

/**
 * The safety nets that keep credentials honest between requests.
 *
 * Every one of these is a BACKSTOP, not the primary path — M1's revoke already
 * purges data synchronously, and M2's own scheduler expires stale scores. These
 * crons exist to catch the case where one of those paths was missed, plus the cases
 * nothing else owns: a credential outliving its consent, and a holder walking into a
 * lender with a passport that quietly expired last night.
 *
 * The ordering principle: a credential must NEVER be presentable after the thing
 * that justified it has gone. Everything here is arranged to fail in that direction.
 */
@Injectable()
export class PassportLifecycleService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly revocation: RevocationService,
    private readonly keys: KeyManagementService,
    private readonly sessions: VerifierSessionService,
    private readonly push: PushService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PassportLifecycleService.name })
  }

  /**
   * Expire credentials whose validity window has closed.
   *
   * Cheap and purely local: `exp` is inside the signed credential, so a verifier
   * already rejects these offline. This sweep exists so OUR view agrees — an
   * "ISSUED" badge in the wallet on a credential the world rejects is the worst
   * possible thing to show someone standing at a counter.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async expireLapsed(): Promise<void> {
    const result = await this.prisma.credential.updateMany({
      where: {
        status: { in: [CredentialStatus.ISSUED, CredentialStatus.SUSPENDED] },
        expiresAt: { lt: new Date() },
      },
      data: { status: CredentialStatus.EXPIRED },
    })
    if (result.count > 0) {
      this.logger.info(`[${this.expireLapsed.name}] Credentials expired`, {
        count: result.count,
      })
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'passport.expired_batch',
        entity: 'Credential',
        metadata: { count: result.count },
      })
    }
  }

  /**
   * Revoke credentials whose underlying consent or score has died.
   *
   * THE most important sweep in M3. A credential that outlives its consent is a live,
   * cryptographically-signed credit assertion with no lawful basis behind it — and
   * unlike an expiry, nothing in the credential itself reveals it. Only the status
   * list can kill it, so this is the one place that must not silently fail.
   *
   * Revocation rather than expiry is deliberate: expiry would leave the credential
   * verifying offline until its `exp`, and the whole point is to stop it NOW.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async revokeOrphaned(): Promise<void> {
    const now = new Date()
    let revoked = 0
    let examined = 0
    // Keyset pagination on the primary key.
    //
    // A bare `take: SWEEP_BATCH` looks fine and is silently broken at scale: with more live
    // credentials than the batch size it re-reads the SAME first page on every tick, so an
    // orphan sitting at position 501 is never found. A cursor walks the whole set; the page
    // cap stops one tick monopolising the database if the population is enormous.
    let cursor: string | undefined
    for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
      const live = await this.prisma.credential.findMany({
        where: {
          status: { in: [CredentialStatus.ISSUED, CredentialStatus.SUSPENDED] },
        },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          credentialNumber: true,
          score: { select: { status: true, expiresAt: true, consentId: true } },
        },
      })
      if (!live.length) break

      examined += live.length
      cursor = live[live.length - 1]!.id

      // Consents resolved in one query per page rather than per credential: a per-row
      // lookup turns a routine sweep into N round-trips on a table that only grows.
      const consents = await this.prisma.consent.findMany({
        where: { id: { in: [...new Set(live.map((c) => c.score.consentId))] } },
        select: { id: true, status: true, expiresAt: true },
      })
      const consentById = new Map(consents.map((c) => [c.id, c]))

      for (const credential of live) {
        const reason = this.orphanReason(
          credential.score,
          consentById.get(credential.score.consentId),
          now,
        )
        if (!reason) continue

        const result = await this.revocation.revoke(credential.id, reason, {
          type: ActorType.SYSTEM,
        })
        if (result.changed) revoked += 1
      }

      if (live.length < SWEEP_BATCH) break
    }

    if (revoked > 0) {
      this.logger.warn(
        `[${this.revokeOrphaned.name}] Revoked credentials with no live basis`,
        { revoked, examined },
      )
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'passport.revoked_orphaned_batch',
        entity: 'Credential',
        metadata: { revoked, examined },
      })
    }
  }

  /**
   * Why a credential no longer has a basis, or null when it still does.
   *
   * Separated out and returning the REASON rather than a boolean, because the reason
   * lands in the audit trail and on the revocation record — "consent_revoked" and
   * "score_expired" send a user to two different screens.
   */
  private orphanReason(
    score: { status: ScoreStatus; expiresAt: Date | null },
    consent: { status: ConsentStatus; expiresAt: Date | null } | undefined,
    now: Date,
  ): string | null {
    if (!consent) return 'consent_missing'
    if (
      consent.status === ConsentStatus.REVOKED ||
      consent.status === ConsentStatus.EXPIRED ||
      consent.status === ConsentStatus.REJECTED ||
      consent.status === ConsentStatus.FAILED
    ) {
      return `consent_${consent.status.toLowerCase()}`
    }
    if (consent.expiresAt && consent.expiresAt <= now) return 'consent_data_life_ended'

    // A score the user has since had EXPIRED or OVERRIDDEN below its issued band is
    // no longer the number in the credential. OVERRIDDEN is deliberately NOT an
    // orphan: an admin override is a considered decision about the score, and M2
    // keeps such a score servable.
    if (
      score.status === ScoreStatus.EXPIRED ||
      score.status === ScoreStatus.FAILED ||
      score.status === ScoreStatus.INSUFFICIENT_DATA
    ) {
      return `score_${score.status.toLowerCase()}`
    }
    if (score.expiresAt && score.expiresAt <= now) return 'score_expired'

    return null
  }

  /**
   * Warn holders before their passport lapses.
   *
   * A passport that expires silently fails at the worst possible moment — in front
   * of a lender, with the user unable to explain it. One push a week ahead turns that
   * into a two-tap refresh at home.
   *
   * Daily, and only for credentials crossing INTO the window today, so a user does
   * not get seven identical notifications.
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async warnBeforeExpiry(): Promise<void> {
    const now = Date.now()
    const windowStart = new Date(now + (EXPIRY_WARNING_DAYS - 1) * 86_400_000)
    const windowEnd = new Date(now + EXPIRY_WARNING_DAYS * 86_400_000)

    const expiring = await this.prisma.credential.findMany({
      where: {
        status: CredentialStatus.ISSUED,
        expiresAt: { gte: windowStart, lt: windowEnd },
      },
      take: SWEEP_BATCH,
      select: {
        id: true,
        expiresAt: true,
        user: { select: { id: true, expoPushToken: true } },
      },
    })
    if (!expiring.length) return

    let notified = 0
    for (const credential of expiring) {
      if (!credential.user.expoPushToken) continue
      const { sent } = await this.push.send({
        token: credential.user.expoPushToken,
        title: 'Your Pravaah passport expires soon',
        body: `It stops working on ${credential.expiresAt.toLocaleDateString('en-IN')}. Refresh it in the app — it takes a moment.`,
        data: { type: 'passport.expiring', credentialId: credential.id },
      })
      if (sent) notified += 1
    }

    this.logger.info(
      `[${this.warnBeforeExpiry.name}] Expiry warnings dispatched`,
      { expiring: expiring.length, notified },
    )
  }

  /** Close out verifier requests nobody answered. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireRequests(): Promise<void> {
    const count = await this.sessions.expireStale()
    if (count > 0) {
      this.logger.info(
        `[${this.expireRequests.name}] Verifier requests expired`,
        { count },
      )
    }
  }

  /**
   * Retire issuer keys once every credential they signed has expired.
   *
   * Deliberately rare. A retired key drops out of the DID document and JWKS, and
   * retiring one too early would break every credential it signed — so this runs
   * daily rather than hourly and only acts on a key with nothing live behind it.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async retireKeys(): Promise<void> {
    const retired = await this.keys.retireExhaustedKeys()
    if (retired > 0) {
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'passport.keys_retired',
        entity: 'IssuerKey',
        metadata: { retired },
      })
    }
  }
}
