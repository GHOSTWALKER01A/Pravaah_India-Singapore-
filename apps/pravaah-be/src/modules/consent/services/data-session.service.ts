import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import {
  decryptField,
  encryptField,
} from '@/common/crypto/field-crypto.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { DataSessionStatus, FiType } from 'generated/prisma/client'

import type { FipPayload } from '@/modules/consent/providers/aa/aa.provider'
import { AaProviderRegistry } from '@/modules/consent/providers/aa/aa-registry'
import { decryptFi, type KeyMaterial } from '@/modules/consent/providers/aa/aa-crypto.util'
import { canFetch } from '@/modules/consent/consent.state'
import { FiNormalizerService } from '@/modules/consent/services/fi-normalizer.service'

@Injectable()
export class DataSessionService {
  private readonly logger: AppLogger

  constructor(
    private readonly registry: AaProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly normalizer: FiNormalizerService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DataSessionService.name })
  }

  /**
   * Create a data session against an ACTIVE consent. Idempotent per consent: an
   * in-flight or completed session is reused to avoid duplicate FIP hits and
   * provider rate-limits.
   */
  async createSession(consentId: string) {
    const consent = await this.prisma.consent.findUnique({
      where: { id: consentId },
    })
    if (!consent) throw new NotFoundException('Consent not found')
    if (!canFetch(consent.status, consent.expiresAt)) {
      throw new ForbiddenException('Consent is not fetchable')
    }

    const existing = await this.prisma.dataSession.findFirst({
      where: {
        consentId,
        status: {
          in: [
            DataSessionStatus.PENDING,
            DataSessionStatus.PARTIAL,
            DataSessionStatus.COMPLETED,
          ],
        },
      },
    })
    if (existing) return existing

    const res = await this.registry.byName(consent.aaProvider).createSession({
      providerConsentId: consent.providerConsentId!,
      dataRange: {
        from: consent.dataRangeFrom.toISOString(),
        to: consent.dataRangeTo.toISOString(),
      },
      format: 'json',
    })
    if (!res.ok) throw new ForbiddenException(res.error.message)

    const session = await this.prisma.dataSession.create({
      data: {
        consentId,
        providerSessionId: res.value.providerSessionId,
        status: DataSessionStatus.PENDING,
        dataRangeFrom: consent.dataRangeFrom,
        dataRangeTo: consent.dataRangeTo,
        keyMaterial: res.value.keyMaterialPrivate
          ? encryptField(res.value.keyMaterialPrivate)
          : null,
      },
    })
    this.logger.info('[createSession] Data session created', {
      consentId,
      sessionId: session.id,
    })
    return session
  }

  /**
   * Fetch + persist FI data (called on FI-notification OR by re-poll). Handles
   * PARTIAL coverage; re-checks consent is still fetchable (revoke mid-fetch is
   * a hard stop that fails the session). A per-FIP decryption failure is
   * skipped and counted as partial — it never crashes the fetch.
   */
  async fetchAndStore(sessionId: string): Promise<void> {
    const session = await this.prisma.dataSession.findUnique({
      where: { id: sessionId },
      include: { consent: true },
    })
    if (!session?.providerSessionId) return
    if (
      session.status === DataSessionStatus.COMPLETED ||
      session.status === DataSessionStatus.FAILED
    ) {
      return // terminal — nothing to do
    }

    // Consent may have been revoked between session-create and fetch.
    if (!canFetch(session.consent.status, session.consent.expiresAt)) {
      await this.prisma.dataSession.update({
        where: { id: sessionId },
        data: { status: DataSessionStatus.FAILED },
      })
      this.logger.warn('[fetchAndStore] Consent no longer fetchable', {
        sessionId,
        consentStatus: session.consent.status,
      })
      return
    }

    const res = await this.registry
      .byName(session.consent.aaProvider)
      .fetch(session.providerSessionId)
    if (!res.ok) return // transient — the scheduler will re-poll

    const dataLifeExpiresAt = session.consent.expiresAt ?? new Date()
    let stored = 0
    for (const fip of res.value.fips) {
      const payload = fip.decryptedJson ?? this.selfDecrypt(fip, session.keyMaterial)
      if (payload === null || payload === undefined) {
        this.logger.warn('[fetchAndStore] FIP payload undecryptable', {
          sessionId,
          fipId: fip.fipId,
        })
        continue // counts toward PARTIAL
      }
      await this.prisma.fiData.create({
        data: {
          dataSessionId: sessionId,
          fipId: fip.fipId,
          fiType: fip.fiType as FiType,
          status: 'DECRYPTED',
          encryptedBlob: encryptField(JSON.stringify(payload)),
          dataLifeExpiresAt,
        },
      })
      await this.normalizer.normalize(
        session.consent.userId,
        session.consentId,
        fip.fiType as FiType,
        payload,
        dataLifeExpiresAt,
      )
      stored++
    }

    const status: DataSessionStatus =
      res.value.status === 'COMPLETED'
        ? DataSessionStatus.COMPLETED
        : res.value.status === 'PENDING'
          ? DataSessionStatus.PENDING
          : DataSessionStatus.PARTIAL

    await this.prisma.dataSession.update({
      where: { id: sessionId },
      data: {
        status,
        fipTotal: res.value.fipTotal,
        fipCompleted: res.value.fipCompleted ?? stored,
        completedAt:
          status === DataSessionStatus.COMPLETED ? new Date() : null,
      },
    })
    this.logger.info('[fetchAndStore] FI data stored', {
      sessionId,
      status,
      stored,
    })
  }

  /**
   * Self-decrypt fallback (ReBIT ECDH) for providers that hand back encrypted
   * payloads + their KeyMaterial. Returns the parsed JSON, or null on failure.
   * Setu decrypted-fetch and the sandbox mock return `decryptedJson`, so this
   * path is exercised only by self-decrypt providers.
   */
  private selfDecrypt(
    fip: FipPayload,
    keyMaterialEnc: string | null,
  ): unknown | null {
    if (!fip.encrypted || !fip.keyMaterial || !keyMaterialEnc) return null
    try {
      const ours = JSON.parse(decryptField(keyMaterialEnc)) as KeyMaterial
      const remote = fip.keyMaterial as {
        DHPublicKey?: { KeyValue?: string }
        Nonce?: string
      }
      const remotePublicKeyB64 = remote.DHPublicKey?.KeyValue
      const remoteNonceB64 = remote.Nonce
      if (!remotePublicKeyB64 || !remoteNonceB64) return null
      const plain = decryptFi({
        ourPrivateKeyB64: ours.privateKey,
        ourPublicKeyB64: ours.publicKey,
        ourNonceB64: ours.nonce,
        remotePublicKeyB64,
        remoteNonceB64,
        cipherB64: fip.encrypted,
      })
      return JSON.parse(plain)
    } catch (e) {
      this.logger.error('[selfDecrypt] ReBIT decrypt failed', { err: e })
      return null
    }
  }
}
