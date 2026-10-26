import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  PARTNER_WEBHOOK_EVENT,
  type ConsentReceiptQueryDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  ConsentReceiptStatus,
  Prisma,
  type VerifierPartner,
} from 'generated/prisma/client'

import {
  answeredPredicateKeys,
  claimLabels,
  readCompiledPredicates,
  redactResult,
  type RedactionReason,
} from '@/modules/partner/partner.state'
import { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'

type Db = Prisma.TransactionClient | PrismaService

/** Receipts purged per batch; the job loops until none remain. */
const PURGE_BATCH = 200
const DAY_MS = 86_400_000

/** What {@link ConsentReceiptService.issue} needs, all already loaded by the caller. */
export interface ReceiptSource {
  requestId: string
  userId: string
  purpose: string
  requestedClaims: string[]
  predicates: unknown
  presentationId: string | null
  disclosedClaims: string[]
  partner: Pick<VerifierPartner, 'id' | 'name' | 'domain' | 'retentionDays'>
}

/**
 * Consent receipts — the holder's durable record of every share.
 *
 * Not decoration: this is the DPDP / PDPA consent artefact, and it is the holder's
 * WITHDRAWAL handle. "Who has seen my passport" turns selective disclosure from a
 * cryptographic property into something a person can see and act on.
 *
 * Two rules shape everything here:
 *
 *  - A receipt stores claim NAMES, never values. One that stored the disclosed
 *    score would recreate, permanently and in our database, exactly the data
 *    selective disclosure exists to keep out of our hands.
 *  - The partner's name and domain are SNAPSHOTTED. A receipt is a record of what
 *    the holder was shown when they said yes; it must not change if the partner
 *    later renames itself.
 */
@Injectable()
export class ConsentReceiptService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: PartnerWebhookService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ConsentReceiptService.name })
  }

  /**
   * Issue the receipt for an approved request. Idempotent on the request id, and
   * `createMany({ skipDuplicates })` so it is safe inside the event transaction.
   */
  async issue(
    db: Db,
    source: ReceiptSource,
    issuedAt = new Date(),
  ): Promise<boolean> {
    const disclosed = new Set(source.disclosedClaims)
    const result = await db.consentReceipt.createMany({
      data: [
        {
          userId: source.userId,
          partnerId: source.partner.id,
          verifierRequestId: source.requestId,
          presentationId: source.presentationId,
          partnerName: source.partner.name,
          partnerDomain: source.partner.domain,
          purpose: source.purpose,
          claimsShared: [...disclosed].sort(),
          claimsWithheld: source.requestedClaims.filter(
            (claim) => !disclosed.has(claim),
          ),
          predicateKeys: answeredPredicateKeys(
            readCompiledPredicates(source.predicates),
            source.disclosedClaims,
          ),
          retentionDays: source.partner.retentionDays,
          issuedAt,
          purgeAt: new Date(
            issuedAt.getTime() + source.partner.retentionDays * DAY_MS,
          ),
        },
      ],
      skipDuplicates: true,
    })
    return result.count > 0
  }

  // ── holder surface ────────────────────────────────────────────────────────
  async listForHolder(
    userId: string,
    query: ConsentReceiptQueryDto,
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    const where: Prisma.ConsentReceiptWhereInput = {
      userId,
      ...(query.status ? { status: query.status } : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.consentReceipt.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          partner: { select: { type: true, country: true, status: true } },
        },
      }),
      this.prisma.consentReceipt.count({ where }),
    ])
    return { items: rows.map((row) => this.toHolderView(row)), total }
  }

  async detailForHolder(
    userId: string,
    receiptId: string,
  ): Promise<Record<string, unknown>> {
    // Ownership is in the WHERE, so another holder's receipt id is a 404 that
    // reveals nothing about whether it exists.
    const row = await this.prisma.consentReceipt.findFirst({
      where: { id: receiptId, userId },
      include: {
        partner: { select: { type: true, country: true, status: true } },
        request: {
          select: {
            channel: true,
            createdAt: true,
            decision: { select: { decision: true, decidedAt: true } },
          },
        },
      },
    })
    if (!row) throw new NotFoundException('Receipt not found')
    return {
      ...this.toHolderView(row),
      channel: row.request.channel,
      requestedAt: row.request.createdAt,
      // The holder is told the OUTCOME the partner recorded (approved / declined),
      // never its free-text reason or metadata — those are the partner's notes.
      partnerDecision: row.request.decision ?? null,
    }
  }

  async byRequestForHolder(
    userId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.consentReceipt.findFirst({
      where: { verifierRequestId: requestId, userId },
      include: {
        partner: { select: { type: true, country: true, status: true } },
      },
    })
    if (!row) throw new NotFoundException('Receipt not found')
    return this.toHolderView(row)
  }

  /**
   * Withdraw a share.
   *
   * Three effects, in this order: the receipt flips to WITHDRAWN (a CAS, so a
   * double tap withdraws once); the cached disclosure on the request is redacted,
   * so neither PRAVAAH nor the partner's API can read it again; and the partner is
   * sent `consent.withdrawn`, which starts THEIR deletion obligation for the copy
   * they already hold. All three commit together.
   */
  async withdraw(
    userId: string,
    receiptId: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const receipt = await this.prisma.consentReceipt.findFirst({
      where: { id: receiptId, userId },
      include: {
        partner: {
          select: {
            id: true,
            webhookUrl: true,
            webhookSecretEnc: true,
            status: true,
          },
        },
        request: { select: { id: true, externalRef: true, resultJson: true } },
      },
    })
    if (!receipt) throw new NotFoundException('Receipt not found')

    const now = new Date()
    const changed = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.consentReceipt.updateMany({
        where: { id: receipt.id, status: ConsentReceiptStatus.ACTIVE },
        data: {
          status: ConsentReceiptStatus.WITHDRAWN,
          withdrawnAt: now,
          // Kept for OUR insight only, never forwarded — see WithdrawConsentReceiptSchema.
          withdrawReason: reason ?? null,
        },
      })
      if (flipped.count === 0) return false

      await this.redactRequest(
        tx,
        receipt.request.id,
        receipt.request.resultJson,
        'CONSENT_WITHDRAWN',
        now,
      )
      await this.webhooks.enqueue(
        tx,
        receipt.partner,
        PARTNER_WEBHOOK_EVENT.CONSENT_WITHDRAWN,
        {
          requestId: receipt.request.id,
          externalRef: receipt.request.externalRef,
          receiptId: receipt.id,
          claimsShared: receipt.claimsShared,
          withdrawnAt: now.toISOString(),
          obligation:
            'The holder has withdrawn consent. Delete the data received for this request.',
        },
        `${receipt.id}:WITHDRAWN`,
      )
      return true
    })

    if (!changed) {
      throw new ConflictException(
        receipt.status === ConsentReceiptStatus.WITHDRAWN
          ? 'You have already withdrawn this share'
          : 'This share has already expired and its data has been deleted',
      )
    }

    this.webhooks.kick()
    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'partner.consent_withdrawn',
      entity: 'ConsentReceipt',
      entityId: receipt.id,
      metadata: {
        partnerId: receipt.partnerId,
        verifierRequestId: receipt.verifierRequestId,
        hasReason: !!reason,
      },
    })
    this.logger.info(`[${this.withdraw.name}] Holder withdrew a share`, {
      receiptId: receipt.id,
      partnerId: receipt.partnerId,
    })
    return {
      id: receipt.id,
      status: ConsentReceiptStatus.WITHDRAWN,
      withdrawnAt: now,
      partnerNotified: !!receipt.partner.webhookUrl,
    }
  }

  // ── retention ─────────────────────────────────────────────────────────────
  /**
   * Redact cached disclosures whose retention has elapsed.
   *
   * Covers WITHDRAWN receipts too: their redaction already happened at withdrawal,
   * and marking them purged here closes the row out. Keyset-paginated by id — a
   * `take: N` loop without a cursor re-reads page one forever once any row in it
   * cannot be updated (M3's `revokeOrphaned` lesson).
   */
  async purgeDue(now = new Date()): Promise<number> {
    let purged = 0
    let cursor: string | undefined
    for (;;) {
      const due = await this.prisma.consentReceipt.findMany({
        where: { purgedAt: null, purgeAt: { lt: now } },
        orderBy: { id: 'asc' },
        take: PURGE_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          status: true,
          verifierRequestId: true,
          request: { select: { resultJson: true } },
        },
      })
      if (!due.length) return purged
      cursor = due[due.length - 1].id

      for (const receipt of due) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await this.redactRequest(
              tx,
              receipt.verifierRequestId,
              receipt.request.resultJson,
              'RETENTION_ELAPSED',
              now,
            )
            await tx.consentReceipt.update({
              where: { id: receipt.id },
              data: {
                purgedAt: now,
                ...(receipt.status === ConsentReceiptStatus.ACTIVE
                  ? { status: ConsentReceiptStatus.EXPIRED }
                  : {}),
              },
            })
          })
          purged++
        } catch (error) {
          this.logger.error(
            `[${this.purgeDue.name}] Could not purge a receipt`,
            {
              receiptId: receipt.id,
              err: error,
            },
          )
        }
      }
    }
  }

  /** Replace the cached verifier result with its redacted form. No-op if already redacted. */
  private async redactRequest(
    db: Db,
    requestId: string,
    resultJson: unknown,
    reason: RedactionReason,
    at: Date,
  ): Promise<void> {
    if (!resultJson || (resultJson as { redacted?: unknown }).redacted === true)
      return
    await db.verifierRequest.update({
      where: { id: requestId },
      data: {
        resultJson: redactResult(
          resultJson,
          reason,
          at,
        ) as Prisma.InputJsonValue,
      },
    })
  }

  private toHolderView(row: {
    id: string
    partnerName: string
    partnerDomain: string | null
    purpose: string
    claimsShared: string[]
    claimsWithheld: string[]
    predicateKeys: string[]
    retentionDays: number
    status: ConsentReceiptStatus
    issuedAt: Date
    withdrawnAt: Date | null
    purgeAt: Date
    purgedAt: Date | null
    verifierRequestId: string
    partner: { type: string; country: string | null; status: string }
  }): Record<string, unknown> {
    const labels = claimLabels(row.claimsShared)
    return {
      id: row.id,
      requestId: row.verifierRequestId,
      partner: {
        name: row.partnerName,
        domain: row.partnerDomain,
        type: row.partner.type,
        country: row.partner.country,
        // So the wallet can say "this organisation is no longer approved".
        stillApproved: row.partner.status === 'ACTIVE',
      },
      purpose: row.purpose,
      claimsShared: row.claimsShared.map((claim, i) => ({
        claim,
        label: labels[i],
      })),
      claimsWithheld: row.claimsWithheld,
      predicatesAnswered: row.predicateKeys,
      retentionDays: row.retentionDays,
      status: row.status,
      issuedAt: row.issuedAt,
      withdrawnAt: row.withdrawnAt,
      /** When the partner's copy held by PRAVAAH is deleted. */
      dataDeletedAt: row.purgedAt,
      deletesOn: row.purgeAt,
      canWithdraw: row.status === ConsentReceiptStatus.ACTIVE,
    }
  }
}
