import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { ConsentStatus } from 'generated/prisma/client'

import { AaProviderRegistry } from '@/modules/consent/providers/aa/aa-registry'
import { ConsentService } from '@/modules/consent/services/consent.service'
import { DataSessionService } from '@/modules/consent/services/data-session.service'

/** Raw AA notification body (both consent + FI shapes tolerated). */
export interface AaNotificationBody {
  type?: string
  consentId?: string
  status?: string
  sessionId?: string
  ConsentStatusNotification?: { consentId?: string; consentStatus?: string }
  FIStatusNotification?: { sessionId?: string; FIStatus?: string }
  [key: string]: unknown
}

/**
 * Translates AA notifications into consent/session progress. Signature +
 * replay are enforced upstream (the webhook guard/controller); this service is
 * pure orchestration and is also reused by the sandbox mock consent screen.
 */
@Injectable()
export class ConsentNotificationService {
  private readonly logger: AppLogger

  constructor(
    private readonly registry: AaProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly consents: ConsentService,
    private readonly sessions: DataSessionService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ConsentNotificationService.name })
  }

  /** Consent status notification → apply status, auto-fetch on activation. */
  async onConsentNotification(body: AaNotificationBody): Promise<void> {
    const providerConsentId =
      body.ConsentStatusNotification?.consentId ?? body.consentId
    const raw = (
      body.ConsentStatusNotification?.consentStatus ??
      body.status ??
      ''
    ).toUpperCase()

    const map: Partial<Record<string, ConsentStatus>> = {
      ACTIVE: ConsentStatus.ACTIVE,
      REJECTED: ConsentStatus.REJECTED,
      REVOKED: ConsentStatus.REVOKED,
      PAUSED: ConsentStatus.PAUSED,
      EXPIRED: ConsentStatus.EXPIRED,
      FAILED: ConsentStatus.FAILED,
    }
    const newStatus = map[raw]
    if (!providerConsentId || !newStatus) {
      this.logger.warn('[onConsentNotification] Unrecognised notification', {
        providerConsentId,
        raw,
      })
      return
    }

    // On activation, fetch the signed artefact for verification — via the
    // provider that owns this consent.
    let artefact: string | undefined
    if (newStatus === ConsentStatus.ACTIVE) {
      const owner = await this.prisma.consent.findUnique({
        where: { providerConsentId },
        select: { aaProvider: true },
      })
      if (owner) {
        const res = await this.registry
          .byName(owner.aaProvider)
          .getConsent(providerConsentId)
        if (res.ok) artefact = res.value.signedArtefact
      }
    }

    const consent = await this.consents.applyStatus(
      providerConsentId,
      newStatus,
      artefact,
    )

    // Auto-Fetch UX: on a verified activation, kick the data session. The FI
    // notification (or the scheduler safety-net) drives the actual fetch; we
    // also attempt an immediate fetch so the sandbox demo is instant and a
    // live provider that is already ready completes without waiting.
    if (
      consent.status === ConsentStatus.ACTIVE &&
      consent.artefactVerified
    ) {
      const session = await this.sessions.createSession(consent.id)
      await this.sessions.fetchAndStore(session.id).catch((e) => {
        this.logger.warn('[onConsentNotification] Immediate fetch deferred', {
          err: e,
        })
      })
    }
  }

  /** FI-data-ready notification → fetch + store. */
  async onFiNotification(body: AaNotificationBody): Promise<void> {
    const providerSessionId =
      body.FIStatusNotification?.sessionId ?? body.sessionId
    if (!providerSessionId) return
    const session = await this.prisma.dataSession.findUnique({
      where: { providerSessionId },
    })
    if (session) await this.sessions.fetchAndStore(session.id)
  }
}
