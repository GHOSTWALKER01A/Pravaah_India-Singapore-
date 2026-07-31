import { Inject, Injectable, NotFoundException } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { PravaahIdService } from '@/modules/users/pravaah-id.service'
import { handlePrismaError } from '@/utils/prisma-error.util'

import { ReviewEventsService } from '@/modules/kyc/admin/review-events.service'

import {
  CheckStatus,
  CheckType,
  Country,
  KycStatus,
  Prisma,
  ReviewDecision,
  ReviewStatus,
} from 'generated/prisma/client'

import {
  applyReviewDecision,
  evaluateKyc,
  NAME_MATCH_THRESHOLD,
  REQUIRED_CHECKS,
  type KycDecision,
  type RecordedReview,
} from '@/modules/kyc/kyc.state'
import { NameMatchService } from '@/modules/kyc/services/name-match.service'

export interface CheckOutcome {
  status: CheckStatus
  providerRefId?: string
  confidence?: number
  extractedName?: string
  raw?: unknown
}

/** How long a reviewer has to answer a case, from the moment it opens. */
const REVIEW_SLA_MS = 24 * 3600_000

/**
 * The minimum a check row has to carry for the decision logic to read it.
 *
 * Declared structurally rather than as the Prisma row type so `evaluate` can be
 * handed any projection — the full row when the DTO needs the provider fields,
 * a narrow select when only the decision matters — and still hand back a
 * correctly-typed latest-attempt map.
 */
interface EvaluableCheck {
  checkType: CheckType
  status: CheckStatus
  attempt: number
  extractedName: string | null
  updatedAt: Date
}

/** The part of a review case that changes the outcome. */
interface ReviewCaseFacts {
  status: ReviewStatus
  decision: ReviewDecision | null
  resolvedAt: Date | null
}

/** Canonical KYC status returned to the client apps (RN/admin). */
export interface KycProfileStatusDto {
  overallStatus: KycStatus
  country: Country
  verifiedName: string | null
  nameMatchScore: number | null
  riskScore: number | null
  completedAt: string | null
  nextStep: CheckType | null
  /**
   * IN_REVIEW with nothing wrong — queued for routine approval rather than being
   * adjudicated.
   *
   * Sent because the client CANNOT derive it. "Every check passed" is not the
   * same predicate: a profile whose documents disagree also has every check
   * passed, and it is the one case this flag must exclude. Nor does
   * `nameMatchScore` settle it — a single-source profile stores 1.0 here while
   * the decision treated the score as unreconciled (see `evaluate`), so a client
   * comparing it against the threshold gets that case backwards.
   *
   * It is `machineCleared` from the decision this response was computed from, so
   * the words the app shows and the reason the reviewer sees cannot disagree.
   */
  awaitingApproval: boolean
  checks: {
    checkType: CheckType
    status: CheckStatus
    provider: string
    confidence: number | null
    /**
     * The provider's session/transaction reference. Exposed so a redirect-based
     * step (DigiLocker, Singpass) can be RESUMED from server state: the app
     * held this only in component state, so backgrounding the app during
     * consent lost it and the user came back to a screen that had forgotten
     * they ever started. Not a secret — the client is handed the same value by
     * the initiate call.
     */
    providerRefId: string | null
    updatedAt: string
  }[]
}

/**
 * Drives the whole M0 flow. Every mutation is idempotent and resumable: a
 * dropped session, a duplicate provider callback, or a retried request all
 * converge to the same profile state. `recordCheck` → `reevaluate` is the only
 * path that changes `User.kycStatus`.
 */
@Injectable()
export class KycOrchestratorService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly nameMatch: NameMatchService,
    private readonly audit: AuditService,
    private readonly events: ReviewEventsService,
    private readonly pravaahIds: PravaahIdService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: KycOrchestratorService.name })
  }

  /**
   * Provision (or update) the user + KYC profile for a country. `User.id` IS
   * the Supabase auth id (`sub`) — there is no separate internal id.
   */
  async startKyc(input: {
    supabaseUserId: string
    phone?: string
    email?: string
    country: Country
  }): Promise<{ status: KycStatus; reason?: string }> {
    try {
      const user = await this.prisma.user.upsert({
        where: { id: input.supabaseUserId },
        create: {
          id: input.supabaseUserId,
          pravaahId: this.pravaahIds.generate(),
          phone: input.phone ?? input.supabaseUserId,
          email: input.email,
          primaryCountry: input.country,
        },
        update: { primaryCountry: input.country },
      })
      // Every user entering KYC must already have the public identity the
      // reviewer console will label their case with.
      await this.pravaahIds.ensureFor(user.id, user.pravaahId)
      await this.getOrCreateProfile(user.id)
      return await this.reevaluate(user.id)
    } catch (e) {
      // A phone/email already registered to a different auth id surfaces as a
      // Prisma P2002 — map it to a 409 instead of an opaque 500. (HttpExceptions
      // thrown by reevaluate, e.g. NotFound, are re-thrown unchanged.)
      handlePrismaError(e)
    }
  }

  /**
   * Store (or clear) the device's Expo push token for a user so decision
   * notifications can reach them with the app closed. Upserts the user row so a
   * device can register its token before KYC has been started.
   */
  async setPushToken(input: {
    supabaseUserId: string
    phone?: string
    email?: string
    token: string
  }): Promise<{ ok: true }> {
    await this.prisma.user.upsert({
      where: { id: input.supabaseUserId },
      create: {
        id: input.supabaseUserId,
        pravaahId: this.pravaahIds.generate(),
        phone: input.phone ?? input.supabaseUserId,
        email: input.email,
        expoPushToken: input.token,
      },
      update: { expoPushToken: input.token },
    })
    return { ok: true }
  }

  /**
   * Validate that KYC was started for this Supabase auth id and return it
   * (which is also the `User.id`). Throws if the user row doesn't exist yet.
   */
  async resolveUserId(supabaseUserId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: supabaseUserId },
      select: { id: true },
    })
    if (!user) {
      throw new NotFoundException('KYC not started for this user')
    }
    return user.id
  }

  /** Idempotently record a check result and re-evaluate the profile. */
  async recordCheck(
    userId: string,
    checkType: CheckType,
    provider: string,
    outcome: CheckOutcome,
  ): Promise<{ status: KycStatus; reason?: string }> {
    const profile = await this.getOrCreateProfile(userId)

    // Idempotency: a providerRefId already recorded as PASSED is a no-op.
    if (outcome.providerRefId) {
      const existing = await this.prisma.kycCheck.findFirst({
        where: {
          kycProfileId: profile.id,
          checkType,
          providerRefId: outcome.providerRefId,
        },
      })
      if (existing && existing.status === CheckStatus.PASSED) {
        return this.reevaluate(userId)
      }
    }

    const attempt = await this.nextAttempt(profile.id, checkType)
    await this.prisma.kycCheck.create({
      data: {
        kycProfileId: profile.id,
        provider,
        checkType,
        attempt,
        status: outcome.status,
        providerRefId: outcome.providerRefId,
        confidence: outcome.confidence,
        extractedName: outcome.extractedName,
        maskedResult: this.maskRaw(),
        encryptedBlob: outcome.raw
          ? encryptField(JSON.stringify(outcome.raw))
          : null,
      },
    })
    await this.audit.log({
      actorType: 'SYSTEM',
      action: `kyc.${checkType}.${outcome.status}`,
      entity: 'KycProfile',
      entityId: profile.id,
    })
    return this.reevaluate(userId)
  }

  /**
   * Recompute status from all checks + name reconciliation + the review decision
   * on file, and persist it.
   *
   * The composition is the point: see {@link evaluate}. This is still the only
   * path that writes `User.kycStatus` from check data, and it is now idempotent
   * for an admin-decided profile — calling it a hundred times after an approval
   * re-derives VERIFIED a hundred times rather than walking the holder back into
   * the queue.
   */
  async reevaluate(userId: string): Promise<KycDecision> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    const profile = await this.prisma.kycProfile.findUnique({
      where: { userId },
      include: { checks: true, reviewCase: true },
    })
    if (!user || !profile) {
      throw new NotFoundException('KYC profile missing')
    }

    const { decision, machine, score, canonical } = this.evaluate(user, profile)

    await this.prisma.kycProfile.update({
      where: { userId },
      data: {
        overallStatus: decision.status,
        nameMatchScore: score,
        verifiedName: canonical || null,
        /**
         * Stamped once and then preserved. `new Date()` unconditionally would
         * move the completion time forward on every re-derivation — and this
         * runs on every check AND every status read — so the one timestamp that
         * says when this identity was verified would always read "just now".
         */
        completedAt:
          decision.status === KycStatus.VERIFIED
            ? (profile.completedAt ?? new Date())
            : null,
      },
    })
    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: decision.status },
    })

    this.logger.info(`[${this.reevaluate.name}] KYC re-evaluated`, {
      userId,
      status: decision.status,
      reason: decision.reason,
      machineStatus: machine.status,
      nameMatchScore: score,
    })

    // A review case exists exactly while a person still owes us a decision.
    if (decision.status === KycStatus.IN_REVIEW) {
      await this.syncReviewCase(profile.id, machine.reason ?? 'Ambiguous')
    } else if (
      profile.reviewCase &&
      profile.reviewCase.decision &&
      profile.reviewCase.resolvedAt &&
      profile.reviewCase.status !== ReviewStatus.RESOLVED
    ) {
      /**
       * A row the old reopen path mangled: decided, yet marked OPEN.
       *
       * The decision above already honours it — see `recordedReview` — so the
       * holder is unblocked either way. This repairs the QUEUE, which otherwise
       * shows an analyst an open case that has already been answered and cannot
       * be claimed (the reopen left `assignedAdminId` set, and `claim` requires
       * it to be null).
       */
      await this.prisma.reviewCase.update({
        where: { kycProfileId: profile.id },
        data: { status: ReviewStatus.RESOLVED },
      })
      this.logger.warn(
        `[${this.reevaluate.name}] Repaired a decided case still marked open`,
        { userId, decision: profile.reviewCase.decision },
      )
    }
    return decision
  }

  /**
   * The composed verdict: what the checks say, then what the reviewer said.
   *
   * Shared by `reevaluate` (which writes it) and `getProfileStatus` (which
   * compares against it before healing). They MUST agree — when they did not,
   * every poll of `GET /kyc/status` saw a "mismatch" between the machine's
   * IN_REVIEW and the admin's VERIFIED, healed it by re-running the machine, and
   * so undid the approval within seconds of it being granted.
   *
   * Generic in the check row so both callers can pass whatever projection they
   * already have and still get the fully-typed latest-attempt map back.
   */
  private evaluate<C extends EvaluableCheck>(
    user: { primaryCountry: Country },
    profile: {
      checks: C[]
      reviewCase: ReviewCaseFacts | null
    } | null,
  ): {
    decision: KycDecision
    /** The machine's own verdict, before the reviewer's answer is applied. */
    machine: KycDecision
    /** Latest attempt per check type — what both the DTO and the decision read. */
    latest: Map<CheckType, C>
    score: number
    canonical: string
  } {
    const checks = profile?.checks ?? []

    // Latest attempt per check type wins.
    const latest = new Map<CheckType, C>()
    for (const c of [...checks].sort((a, b) => a.attempt - b.attempt)) {
      latest.set(c.checkType, c)
    }

    // Every attempt contributes a name, not just the latest: reconciliation is
    // about whether the sources agree, and a superseded attempt still came from
    // a source.
    const names = checks
      .filter((c) => c.extractedName)
      .map((c) => c.extractedName as string)
    const { score, canonical } = this.nameMatch.reconcile(names)

    const machine = evaluateKyc({
      requiredForCountry: REQUIRED_CHECKS[user.primaryCountry],
      checks: [...latest.values()].map((c) => ({
        type: c.checkType,
        status: c.status,
      })),
      nameMatchScore: names.length >= 2 ? score : null,
      sanctionsHit:
        latest.get(CheckType.SANCTIONS_PEP)?.status === CheckStatus.FAILED,
      threshold: NAME_MATCH_THRESHOLD,
    })

    const decision = applyReviewDecision(
      machine,
      /**
       * Staleness is measured against the LATEST attempts only — the exact rows
       * the verdict above was computed from — never against every historical row.
       *
       * A superseded attempt cannot change the decision, so it must not be able
       * to invalidate an approval. `KycPollerService` expires any check left
       * PENDING for 30 minutes, and `updatedAt` is `@updatedAt`, so that sweep
       * touches abandoned attempts: a holder who abandoned Aadhaar once and
       * passed it on the retry would have been silently thrown back into review
       * the first time the poller ran after their approval.
       */
      this.recordedReview(profile?.reviewCase ?? null, [...latest.values()]),
    )
    return { decision, machine, latest, score, canonical }
  }

  /**
   * The reviewer's answer, and whether it still covers this profile.
   *
   * A decision goes stale the moment decision-relevant evidence changes after it
   * — see `RecordedReview` and the call site above for which rows count.
   * Compared against `updatedAt` rather than `createdAt` because a provider
   * callback can flip an existing attempt from PENDING to PASSED in place, and
   * that is new evidence too.
   */
  private recordedReview(
    reviewCase: ReviewCaseFacts | null,
    checks: EvaluableCheck[],
  ): RecordedReview | null {
    /**
     * Keyed off `decision` + `resolvedAt`, deliberately NOT off `status`.
     *
     * Those two fields are written by exactly one thing — `ReviewService.decide`,
     * which writes both atomically — so their presence IS a recorded decision.
     * `status` is written by several paths, one of which (the old blanket reopen
     * this file used to do) forced it back to OPEN while leaving the decision in
     * place. Trusting `status` would discard real approvals sitting in rows that
     * bug produced. A case this file reopens has its decision fields CLEARED, so
     * a genuinely reopened case is correctly read as undecided.
     */
    if (!reviewCase?.decision || !reviewCase.resolvedAt) {
      return null
    }
    const latestCheckAt = checks.reduce<number>(
      (max, c) => Math.max(max, c.updatedAt.getTime()),
      0,
    )
    return {
      decision: reviewCase.decision,
      stale:
        reviewCase.resolvedAt !== null &&
        latestCheckAt > reviewCase.resolvedAt.getTime(),
    }
  }

  /**
   * Put a case in front of a reviewer, without ever disturbing one they are
   * already holding.
   *
   * The previous `upsert` forced `status: 'OPEN'` on every re-derivation, which
   * had two bugs. It yanked a CLAIMED case out from under the reviewer working
   * it; and when it reopened a RESOLVED case it left `assignedAdminId` set, so
   * `claim` (which requires `assignedAdminId: null`) could never succeed again
   * and the case was stuck permanently unclaimable.
   */
  private async syncReviewCase(
    profileId: string,
    reason: string,
  ): Promise<void> {
    const existing = await this.prisma.reviewCase.findUnique({
      where: { kycProfileId: profileId },
    })

    if (!existing) {
      const created = await this.prisma.reviewCase.create({
        data: {
          kycProfileId: profileId,
          reason,
          slaDueAt: new Date(Date.now() + REVIEW_SLA_MS),
        },
      })
      void this.events.publish({
        type: 'OPENED',
        caseId: created.id,
        status: 'OPEN',
      })
      return
    }

    /**
     * "Has this case been answered" is `decision` + `resolvedAt`, not `status` —
     * the same rule `recordedReview` applies, and for the same reason: only
     * `ReviewService.decide` writes those two, while `status` was rewritten by
     * the old blanket reopen. A row left OPEN-but-decided by that bug is
     * ANSWERED, and must take the full reopen below; treating it as live would
     * refresh its reason and leave `assignedAdminId` set, which is precisely the
     * permanently-unclaimable state this method exists to prevent.
     */
    const answered = existing.decision !== null && existing.resolvedAt !== null

    // Genuinely live (OPEN or CLAIMED, undecided) — the reason may have moved on
    // as later checks landed, but the assignment must not.
    if (!answered) {
      if (existing.reason !== reason) {
        await this.prisma.reviewCase.update({
          where: { id: existing.id },
          data: { reason },
        })
      }
      return
    }

    /**
     * Answered, yet we are back in review: the evidence changed after the
     * decision, so it no longer covers this profile. Reopened as a genuinely
     * fresh case — unassigned, with the old decision cleared — because the
     * next reviewer must not inherit a verdict passed on different evidence.
     */
    await this.prisma.reviewCase.update({
      where: { id: existing.id },
      data: {
        status: ReviewStatus.OPEN,
        reason,
        decision: null,
        decisionNotes: null,
        resolvedAt: null,
        assignedAdminId: null,
        slaDueAt: new Date(Date.now() + REVIEW_SLA_MS),
      },
    })
    this.logger.info(
      `[${this.syncReviewCase.name}] Resolved case reopened — checks changed after the decision`,
      { caseId: existing.id, reason },
    )
    void this.events.publish({
      type: 'OPENED',
      caseId: existing.id,
      status: 'OPEN',
    })
  }

  /** Source of truth for the app: current status + the exact next step. */
  async status(userId: string): Promise<{
    status: KycStatus
    nextStep: CheckType | null
    completed: CheckType[]
    required: CheckType[]
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('User not found')

    const profile = await this.prisma.kycProfile.findUnique({
      where: { userId },
      include: { checks: true },
    })
    const required = REQUIRED_CHECKS[user.primaryCountry]
    const done = new Set(
      profile?.checks
        .filter((c) => c.status === CheckStatus.PASSED)
        .map((c) => c.checkType),
    )
    const nextStep = required.find((t) => !done.has(t)) ?? null
    return { status: user.kycStatus, nextStep, completed: [...done], required }
  }

  /**
   * Rich profile status in the shape the client apps consume (overallStatus +
   * country + per-check list). Returned by GET /kyc/status and by every check
   * endpoint so the app always renders from one canonical shape.
   */
  async getProfileStatus(userId: string): Promise<KycProfileStatusDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('User not found')

    const profile = await this.prisma.kycProfile.findUnique({
      where: { userId },
      include: { checks: true, reviewCase: true },
    })

    const required = REQUIRED_CHECKS[user.primaryCountry]

    /**
     * ── EDGE CASE HEALING ──────────────────────────────────────────────────
     * If a user was seeded incorrectly, or their profile/checks were wiped while
     * `User.kycStatus` stayed VERIFIED, the UI goes inconsistent — a VERIFIED
     * seal above zero cleared checks and no verified name. So the true status is
     * derived here and the DB is healed if it drifted.
     *
     * It derives the COMPOSED status (checks + the reviewer's decision), not the
     * machine's verdict alone. That distinction is the whole bug this healing
     * used to cause: the machine can never answer VERIFIED, so an approved
     * holder looked like permanent drift, and every poll of this endpoint —
     * every 8 seconds from the passport screen — "healed" their approval away
     * and reopened their review case.
     */
    const { decision, machine, latest } = this.evaluate(user, profile)

    const passed = new Set(
      [...latest.values()]
        .filter((c) => c.status === CheckStatus.PASSED)
        .map((c) => c.checkType),
    )
    const nextStep = required.find((t) => !passed.has(t)) ?? null

    let overallStatus = user.kycStatus
    let verifiedName = profile?.verifiedName ?? null
    let nameMatchScore = profile?.nameMatchScore ?? null
    let completedAt = profile?.completedAt?.toISOString() ?? null

    /**
     * NOT_STARTED is a real state that `evaluateKyc` cannot express — with no
     * checks recorded it can only report IN_PROGRESS ("awaiting everything"). So
     * a user who has never touched KYC is left alone; healing them would flip
     * them to IN_PROGRESS on their first status read and the passport screen
     * would offer to "continue" a verification they never began.
     */
    const untouched =
      latest.size === 0 && user.kycStatus === KycStatus.NOT_STARTED

    if (!untouched && decision.status !== user.kycStatus) {
      this.logger.warn(`[getProfileStatus] State mismatch detected, healing`, {
        userId,
        dbStatus: user.kycStatus,
        computedStatus: decision.status,
      })
      // Ensure profile exists before reevaluating, otherwise reevaluate throws
      if (!profile) {
        await this.getOrCreateProfile(userId)
      }
      // Heal the database
      const fixed = await this.reevaluate(userId)
      overallStatus = fixed.status
      // Re-fetch the healed profile to get updated verifiedName and completedAt
      const healedProfile = await this.prisma.kycProfile.findUnique({
        where: { userId },
      })
      verifiedName = healedProfile?.verifiedName ?? null
      nameMatchScore = healedProfile?.nameMatchScore ?? null
      completedAt = healedProfile?.completedAt?.toISOString() ?? null
    }

    return {
      overallStatus,
      country: user.primaryCountry,
      verifiedName,
      nameMatchScore,
      riskScore: profile?.riskScore ?? null,
      completedAt,
      nextStep,
      /**
       * Composed status IN_REVIEW *and* the machine had no objection.
       *
       * Read off the pre-heal decision deliberately: healing re-derives from the
       * same inputs, so it persists this verdict rather than changing it — and
       * `applyReviewDecision` drops `machineCleared` once a reviewer's answer is
       * folded in, which is correct (an answered case is not awaiting an answer)
       * but means the flag has to come from `machine`.
       */
      awaitingApproval:
        decision.status === KycStatus.IN_REVIEW &&
        machine.machineCleared === true,
      checks: [...latest.values()].map((c) => ({
        checkType: c.checkType,
        status: c.status,
        provider: c.provider,
        confidence: c.confidence,
        providerRefId: c.providerRefId,
        updatedAt: c.updatedAt.toISOString(),
      })),
    }
  }

  private async getOrCreateProfile(userId: string) {
    return this.prisma.kycProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    })
  }

  private async nextAttempt(
    profileId: string,
    checkType: CheckType,
  ): Promise<number> {
    const last = await this.prisma.kycCheck.findFirst({
      where: { kycProfileId: profileId, checkType },
      orderBy: { attempt: 'desc' },
    })
    return (last?.attempt ?? 0) + 1
  }

  // Admins only ever see this redacted projection; the real payload lives in
  // the AES-GCM `encryptedBlob`.
  private maskRaw(): Prisma.InputJsonValue {
    return { redacted: true }
  }
}
