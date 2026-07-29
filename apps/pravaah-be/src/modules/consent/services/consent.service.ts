import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { CreateConsentDto } from '@pravaah/schema'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ConsentStatus,
  KycStatus,
  RiskDecision,
  RiskSubjectType,
} from 'generated/prisma/client'

import { AaProviderRegistry } from '@/modules/consent/providers/aa/aa-registry'
import { verifyArtefactSignature } from '@/modules/consent/providers/aa/artefact.util'
import { canTransition, isRevocable } from '@/modules/consent/consent.state'
import { RiskService } from '@/modules/fraud/services/risk.service'

/** Approval window: the user must approve at the AA within 30 minutes. */
const APPROVAL_WINDOW_MS = 30 * 60_000

@Injectable()
export class ConsentService {
  private readonly logger: AppLogger

  constructor(
    private readonly registry: AaProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /**
     * M6's risk engine, for consent-farming detection (T11).
     *
     * The full engine rather than just `VelocityService`, because the interesting case is
     * bulk consent creation from ONE device across MANY accounts — which is a device and
     * graph question, not only a rate question.
     */
    private readonly risk: RiskService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ConsentService.name })
  }

  /**
   * Create an AA consent for a VERIFIED user. Returns the AA approval URL the
   * app opens in a webview. Duplicate active/pending consent for the same
   * purpose is reused rather than re-created.
   */
  async create(
    userId: string,
    dto: CreateConsentDto,
  ): Promise<{
    consentId: string
    providerConsentId: string | null
    approvalUrl: string | null
    reuseExisting?: boolean
  }> {
    // GUARD 1: user must be M0-VERIFIED and not suspended.
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user)
      throw new NotFoundException('Complete identity verification first')
    if (user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException('Complete identity verification first')
    }
    if (user.isSuspended) throw new ForbiddenException('Account suspended')
    if (!user.phone) {
      throw new BadRequestException('A verified mobile number is required')
    }

    // GUARD 2: data range sanity (defence-in-depth; DTO already checks this).
    const from = new Date(dto.dataRange.from)
    const to = new Date(dto.dataRange.to)
    if (from >= to || to > new Date()) {
      throw new BadRequestException('Invalid data range')
    }

    // GUARD 3: no duplicate active/pending consent for the same purpose.
    const dup = await this.prisma.consent.findFirst({
      where: {
        userId,
        purposeCode: dto.purposeCode,
        status: { in: [ConsentStatus.PENDING, ConsentStatus.ACTIVE] },
      },
    })
    if (dup) {
      this.logger.info('[create] Reusing existing consent', {
        userId,
        consentId: dup.id,
      })
      return {
        reuseExisting: true,
        consentId: dup.id,
        providerConsentId: dup.providerConsentId,
        approvalUrl: dup.redirectUrl,
      }
    }

    /**
     * GUARD 4: consent farming (M6 · T11).
     *
     * Automated bulk consent creation, either to harvest data or to probe the AA rail.
     * Scored rather than rate-limited, because the two look identical at low volume and a
     * flat rate limit would block a legitimate user reconnecting several banks in one
     * sitting — which is the normal onboarding path and the one that must stay smooth.
     *
     * Placed AFTER the duplicate check on purpose: a user retrying the same purpose reuses
     * the existing consent and returns above, so retries never inflate the velocity
     * counter against them. Scoring before that check would penalise a client with a flaky
     * connection.
     *
     * A `BLOCK` is refused; anything softer proceeds. Data access is not money, so a hold
     * would mean a consent nobody can approve and no route out — the honest control here is
     * to let it through and let the case tell an analyst.
     */
    const riskOutcome = await this.risk.scoreConsent({
      userId,
      subjectType: RiskSubjectType.CONSENT,
      subjectId: `consent:${dto.purposeCode}`,
      sensitive: true,
    })

    if (riskOutcome.decision === RiskDecision.BLOCK) {
      this.logger.warn('[create] Consent refused on risk', {
        userId,
        score: riskOutcome.score,
        reasons: riskOutcome.reasons,
      })
      throw new ForbiddenException(
        riskOutcome.reasons[0] ??
          'We cannot set up data sharing on this account right now. Please contact support.',
      )
    }

    const handle = process.env.AA_HANDLE ?? 'onemoney'
    const vua = `${user.phone.replace(/^\+/, '')}@${handle}`
    const consentExpiry = new Date(
      Date.now() + APPROVAL_WINDOW_MS,
    ).toISOString()
    // Prefer the deep link the app passed (so the AA redirects to exactly the
    // URL the in-app auth session is waiting for → auto-close). Fall back to the
    // configured APP_DEEPLINK.
    // Path + scheme must match the RN app: scheme `parvaahrn` (app.json) and a
    // single-segment `consent-return` route (Linking.createURL('consent-return')).
    const redirectUrl =
      dto.redirectUrl ??
      `${process.env.APP_DEEPLINK ?? 'parvaahrn://'}consent-return`

    const input = {
      vua,
      purpose: dto.purpose,
      purposeCode: dto.purposeCode,
      consentMode: 'STORE' as const,
      fetchType: dto.fetchType,
      frequency: dto.frequency,
      fiTypes: dto.fiTypes,
      dataRange: { from: from.toISOString(), to: to.toISOString() },
      dataLife: dto.dataLife,
      consentExpiry,
      redirectUrl,
    }

    // Try each provider in order (AA_MODE=live → Setu, then fall back to Finvu).
    // The first that succeeds owns the consent; its name is persisted so every
    // later call routes back to it.
    const order = this.registry.createOrder()
    let res: Awaited<
      ReturnType<(typeof order)[number]['createConsent']>
    > | null = null
    let winner: string | null = null
    for (const provider of order) {
      const attempt = await provider.createConsent(input)
      if (attempt.ok) {
        res = attempt
        winner = provider.name
        break
      }
      this.logger.warn('[create] AA provider failed, trying fallback', {
        provider: provider.name,
        error: attempt.error.message,
      })
      res = attempt
    }
    if (!res || !res.ok || !winner) {
      throw new BadRequestException(
        res && !res.ok ? res.error.message : 'No AA provider available',
      )
    }

    const dataLifeMs = this.dataLifeToMs(dto.dataLife)
    const consent = await this.prisma.consent.create({
      data: {
        userId,
        aaProvider: winner,
        providerConsentId: res.value.providerConsentId,
        vua,
        purpose: dto.purpose,
        purposeCode: dto.purposeCode,
        consentMode: 'STORE',
        fetchType: dto.fetchType,
        frequencyUnit: dto.frequency?.unit,
        frequencyValue: dto.frequency?.value,
        fiTypes: dto.fiTypes,
        dataRangeFrom: from,
        dataRangeTo: to,
        dataLifeUnit: dto.dataLife.unit,
        dataLifeValue: dto.dataLife.value,
        consentExpiry: new Date(consentExpiry),
        status: ConsentStatus.PENDING,
        redirectUrl: res.value.approvalUrl,
        expiresAt: new Date(Date.now() + dataLifeMs),
      },
    })
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: 'consent.created',
      entity: 'Consent',
      entityId: consent.id,
      metadata: {
        purpose: dto.purpose,
        purposeCode: dto.purposeCode,
        aaProvider: winner,
      },
    })
    this.logger.info('[create] Consent created', {
      userId,
      consentId: consent.id,
      aaProvider: winner,
    })
    return {
      consentId: consent.id,
      providerConsentId: res.value.providerConsentId,
      approvalUrl: res.value.approvalUrl,
    }
  }

  /**
   * Apply an AA status update (from a notification OR from polling). Enforces
   * legal transitions and verifies the signed artefact on activation. Idempotent
   * and safe against out-of-order / replayed notifications.
   */
  async applyStatus(
    providerConsentId: string,
    newStatus: ConsentStatus,
    signedArtefact?: string,
  ): Promise<{ id: string; status: ConsentStatus; artefactVerified: boolean }> {
    const consent = await this.prisma.consent.findUnique({
      where: { providerConsentId },
    })
    if (!consent) throw new NotFoundException('Consent not found')

    if (consent.status === newStatus) {
      return {
        id: consent.id,
        status: consent.status,
        artefactVerified: consent.artefactVerified,
      }
    }
    if (!canTransition(consent.status, newStatus)) {
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'consent.illegal_transition',
        entity: 'Consent',
        entityId: consent.id,
        metadata: { from: consent.status, to: newStatus },
      })
      this.logger.warn('[applyStatus] Ignoring illegal transition', {
        consentId: consent.id,
        from: consent.status,
        to: newStatus,
      })
      return {
        id: consent.id,
        status: consent.status,
        artefactVerified: consent.artefactVerified,
      }
    }

    let artefactVerified = consent.artefactVerified
    if (newStatus === ConsentStatus.ACTIVE && signedArtefact) {
      artefactVerified = verifyArtefactSignature(
        signedArtefact,
        process.env.AA_PUBLIC_KEY,
      )
    }

    const updated = await this.prisma.consent.update({
      where: { id: consent.id },
      data: {
        status: newStatus,
        artefactVerified,
        signedArtefact: signedArtefact
          ? encryptField(signedArtefact)
          : consent.signedArtefact,
        activatedAt:
          newStatus === ConsentStatus.ACTIVE ? new Date() : consent.activatedAt,
        revokedAt:
          newStatus === ConsentStatus.REVOKED ? new Date() : consent.revokedAt,
      },
    })
    await this.audit.log({
      actorType: 'SYSTEM',
      action: `consent.${newStatus.toLowerCase()}`,
      entity: 'Consent',
      entityId: consent.id,
      metadata: { artefactVerified },
    })
    return {
      id: updated.id,
      status: updated.status,
      artefactVerified: updated.artefactVerified,
    }
  }

  /**
   * User-initiated revoke → propagate to the AA, flip local state, and purge
   * all data tied to this consent immediately (data minimisation). This is the
   * trust "money shot" — revoking makes the data visibly disappear.
   */
  async revoke(userId: string, consentId: string): Promise<{ ok: true }> {
    const consent = await this.prisma.consent.findFirst({
      where: { id: consentId, userId },
    })
    if (!consent) throw new NotFoundException('Consent not found')
    if (!isRevocable(consent.status)) {
      throw new BadRequestException('Consent is not revocable')
    }

    if (consent.providerConsentId) {
      // Best-effort: local revocation + purge must proceed even if the AA call
      // fails (the user's intent to revoke is authoritative for us). Route to
      // the provider that owns this consent.
      await this.registry
        .byName(consent.aaProvider)
        .revokeConsent(consent.providerConsentId)
    }
    await this.prisma.consent.update({
      where: { id: consentId },
      data: { status: ConsentStatus.REVOKED, revokedAt: new Date() },
    })
    await this.purgeConsentData(consentId)
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: 'consent.revoked',
      entity: 'Consent',
      entityId: consentId,
    })
    this.logger.info('[revoke] Consent revoked and data purged', {
      userId,
      consentId,
    })
    return { ok: true }
  }

  /** Consent-dashboard data for the app. */
  async list(userId: string) {
    return this.prisma.consent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        purpose: true,
        purposeCode: true,
        fiTypes: true,
        status: true,
        fetchType: true,
        dataRangeFrom: true,
        dataRangeTo: true,
        dataLifeUnit: true,
        dataLifeValue: true,
        expiresAt: true,
        activatedAt: true,
        revokedAt: true,
        artefactVerified: true,
        createdAt: true,
      },
    })
  }

  /** Rich status for one consent (with session coverage), or NOT_FOUND. */
  async getStatus(userId: string, consentId: string) {
    const consent = await this.prisma.consent.findFirst({
      where: { id: consentId, userId },
      include: {
        sessions: {
          orderBy: { requestedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            fipTotal: true,
            fipCompleted: true,
            completedAt: true,
          },
        },
      },
    })
    if (!consent) return { status: 'NOT_FOUND' as const }

    const session = consent.sessions[0]

    // Truthful data availability: count the normalised feature rows that still
    // exist. After a revoke/data-life purge these are gone even though the
    // DataSession envelope remains — so the session must not claim COMPLETED
    // coverage when the underlying data has been deleted.
    const featureCount = await this.prisma.fiNormalized.count({
      where: { consentId },
    })
    const dataPurged =
      !!session &&
      featureCount === 0 &&
      (session.status === 'COMPLETED' || session.status === 'PARTIAL')

    const coverage =
      dataPurged || !session?.fipTotal || session.fipTotal <= 0
        ? null
        : Number((session.fipCompleted / session.fipTotal).toFixed(2))

    return {
      id: consent.id,
      status: consent.status,
      artefactVerified: consent.artefactVerified,
      fiTypes: consent.fiTypes,
      expiresAt: consent.expiresAt,
      // Number of normalised FI feature sets available to M2 (0 once purged).
      featuresAvailable: featureCount,
      dataSession: session
        ? {
            status: session.status,
            fipTotal: session.fipTotal,
            fipCompleted: session.fipCompleted,
            coverage,
            completedAt: session.completedAt,
            dataPurged,
          }
        : null,
    }
  }

  /** Hard-purge raw + normalised data tied to a consent. */
  private async purgeConsentData(consentId: string): Promise<void> {
    const sessions = await this.prisma.dataSession.findMany({
      where: { consentId },
      select: { id: true },
    })
    const sessionIds = sessions.map((s) => s.id)
    await this.prisma.$transaction([
      this.prisma.fiData.updateMany({
        where: { dataSessionId: { in: sessionIds } },
        data: {
          status: 'DELETED',
          encryptedBlob: '',
          deletedAt: new Date(),
        },
      }),
      this.prisma.fiNormalized.deleteMany({ where: { consentId } }),
    ])
  }

  private dataLifeToMs(dl: { unit: string; value: number }): number {
    const day = 86_400_000
    if (dl.unit === 'INF') return 100 * 365 * day
    return dl.value * (dl.unit === 'YEAR' ? 365 : 30) * day
  }
}
