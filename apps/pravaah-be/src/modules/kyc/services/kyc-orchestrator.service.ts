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
} from 'generated/prisma/client'

import {
  evaluateKyc,
  NAME_MATCH_THRESHOLD,
  REQUIRED_CHECKS,
} from '@/modules/kyc/kyc.state'
import { NameMatchService } from '@/modules/kyc/services/name-match.service'

export interface CheckOutcome {
  status: CheckStatus
  providerRefId?: string
  confidence?: number
  extractedName?: string
  raw?: unknown
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

  /** Recompute status from all checks + name reconciliation. */
  async reevaluate(
    userId: string,
  ): Promise<{ status: KycStatus; reason?: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    const profile = await this.prisma.kycProfile.findUnique({
      where: { userId },
      include: { checks: true },
    })
    if (!user || !profile) {
      throw new NotFoundException('KYC profile missing')
    }

    // Latest attempt per check type wins.
    const latest = new Map<CheckType, CheckStatus>()
    for (const c of [...profile.checks].sort((a, b) => a.attempt - b.attempt)) {
      latest.set(c.checkType, c.status)
    }

    const names = profile.checks
      .filter((c) => c.extractedName)
      .map((c) => c.extractedName as string)
    const { score, canonical } = this.nameMatch.reconcile(names)

    const sanctionsHit =
      latest.get(CheckType.SANCTIONS_PEP) === CheckStatus.FAILED

    const decision = evaluateKyc({
      requiredForCountry: REQUIRED_CHECKS[user.primaryCountry],
      checks: [...latest].map(([type, status]) => ({ type, status })),
      nameMatchScore: names.length >= 2 ? score : null,
      sanctionsHit,
      threshold: NAME_MATCH_THRESHOLD,
    })

    await this.prisma.kycProfile.update({
      where: { userId },
      data: {
        overallStatus: decision.status,
        nameMatchScore: score,
        verifiedName: canonical || null,
        completedAt: decision.status === KycStatus.VERIFIED ? new Date() : null,
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
      nameMatchScore: score,
    })

    // Open a review case when (and only when) we land in review — idempotent.
    if (decision.status === KycStatus.IN_REVIEW) {
      const reviewCase = await this.prisma.reviewCase.upsert({
        where: { kycProfileId: profile.id },
        create: {
          kycProfileId: profile.id,
          reason: decision.reason ?? 'Ambiguous',
          slaDueAt: new Date(Date.now() + 24 * 3600_000),
        },
        update: { reason: decision.reason ?? 'Ambiguous', status: 'OPEN' },
      })
      // Push the new/reopened case to any live admin console (fire-and-forget).
      void this.events.publish({
        type: 'OPENED',
        caseId: reviewCase.id,
        status: 'OPEN',
      })
    }
    return decision
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
      include: { checks: true },
    })

    // Latest attempt per check type.
    const latest = new Map<
      CheckType,
      NonNullable<typeof profile>['checks'][number]
    >()
    for (const c of [...(profile?.checks ?? [])].sort(
      (a, b) => a.attempt - b.attempt,
    )) {
      latest.set(c.checkType, c)
    }

    const required = REQUIRED_CHECKS[user.primaryCountry]
    const passed = new Set(
      [...latest.values()]
        .filter((c) => c.status === CheckStatus.PASSED)
        .map((c) => c.checkType),
    )
    const nextStep = required.find((t) => !passed.has(t)) ?? null

    // ── EDGE CASE HEALING ────────────────────────────────────────────────────
    // If a user was seeded incorrectly, or their profile/checks were wiped 
    // while their User.kycStatus remained VERIFIED, the UI becomes inconsistent
    // (showing VERIFIED badge but 0 checks cleared and missing verifiedName).
    // We compute the true status on the fly and heal the DB if it drifted.
    const sanctionsHit =
      latest.get(CheckType.SANCTIONS_PEP)?.status === CheckStatus.FAILED

    const names = (profile?.checks ?? [])
      .filter((c) => c.extractedName)
      .map((c) => c.extractedName as string)
    const { score } = this.nameMatch.reconcile(names)

    const decision = evaluateKyc({
      requiredForCountry: required,
      checks: [...latest.values()].map((c) => ({
        type: c.checkType,
        status: c.status,
      })),
      nameMatchScore: names.length >= 2 ? score : null,
      sanctionsHit,
      threshold: NAME_MATCH_THRESHOLD,
    })

    let overallStatus = user.kycStatus
    let verifiedName = profile?.verifiedName ?? null
    let nameMatchScore = profile?.nameMatchScore ?? null
    let completedAt = profile?.completedAt?.toISOString() ?? null

    if (decision.status !== user.kycStatus) {
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
