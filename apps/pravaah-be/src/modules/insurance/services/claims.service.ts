import { createHash, randomUUID } from 'crypto'

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CLAIM_STATUS,
  EXPECTED_CLAIM_DOCS,
  type AddClaimDocDto,
  type ClaimListQueryDto,
  type InsuranceProductTypeInput,
  type SubmitClaimDto,
} from '@pravaah/schema'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  AMOUNT_MISMATCH_TOLERANCE_BPS,
  AUTO_APPROVE_CEILING_MINOR,
  CLAIM_AUTO_APPROVE_RISK_CEILING,
  MAX_CLAIM_DOCS,
  OCR_CONFIDENCE_FLOOR,
  REQUIRED_CLAIM_DOCS,
  TAMPER_BLOCK_THRESHOLD,
} from '@/modules/insurance/insurance.config'
import {
  isAmountMismatch,
  remainingCoverMinor,
} from '@/modules/insurance/insurance-pricing.util'
import {
  canAttachDocuments,
  canClaimTransition,
  COVERAGE_REFUSAL_MESSAGE,
  coverageRefusalFor,
  isClaimInFlight,
  isDecidable,
  utcDayKey,
} from '@/modules/insurance/insurance.state'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import { InsuranceMoneyService } from '@/modules/insurance/services/insurance-money.service'
import { ClaimRiskService } from '@/modules/insurance/services/claim-risk.service'
import { moneyView } from '@/modules/payments/money.util'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'

import {
  ActorType,
  ClaimDecision,
  ClaimDocStatus,
  ClaimStatus,
  type AdminUser,
  type Claim,
  type ClaimDocument,
  type InsuranceProduct,
  type Policy,
} from 'generated/prisma/client'

type ClaimWithDocs = Claim & { docs: ClaimDocument[] }

/** Who decided a claim. `SYSTEM` for the auto-approve path. */
export type ClaimActor =
  { type: 'SYSTEM' } | { type: 'ADMIN'; admin: AdminUser }

/**
 * The claims workflow — where the insurance promise is either kept or broken.
 *
 * Everything before this point is a contract. This is the part the policyholder
 * actually experiences, and it has to hold two things in tension that pull opposite
 * ways: **pay genuine claims fast**, and **do not pay fabricated ones**. Every
 * decision below is one or the other, and the ones that look overcautious are usually
 * the second.
 *
 * ## The guards, in the order they run
 *
 * `submit` refuses before a row exists, and the order is deliberate — cheapest and
 * most-explainable first:
 *
 *  1. **Ownership.** 404 on somebody else's policy, never 403.
 *  2. **Coverage.** `coverageRefusalFor` answers policy-live, waiting period,
 *     before-start, after-term and the filing window in ONE pure function, returning
 *     a REASON. That function is also what a reviewer re-runs six weeks later, so the
 *     submission and the audit cannot disagree.
 *  3. **The aggregate limit.** Cover REMAINING, not cover bought. Two claims of ₹8,000
 *     against ₹10,000 must not both pay in full, and checking each against the sum
 *     insured in isolation is exactly how that happens.
 *  4. **Duplicate detection**, by database constraint rather than by a lookup.
 *
 * ## Why the waiting-period check compares the INCIDENT date
 *
 * Never `now`. A claim filed today for an incident inside the waiting period is not
 * covered however long the claimant waited to file — and a claim for an incident after
 * the waiting period IS covered even if the policy has since lapsed. Those are two
 * different questions and conflating them refuses claims that should be paid.
 */
@Injectable()
export class ClaimsService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: ClaimRiskService,
    private readonly money: InsuranceMoneyService,
    private readonly registry: InsuranceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ClaimsService.name })
  }

  // ── file ──────────────────────────────────────────────────────────────────
  async submit(userId: string, dto: SubmitClaimDto): Promise<ClaimWithDocs> {
    const policy = await this.prisma.policy.findFirst({
      where: { id: dto.policyId, userId },
      include: { product: true },
    })
    if (!policy) throw new NotFoundException('Policy not found')

    const refusal = coverageRefusalFor(policy, dto.incidentDate)
    if (refusal) {
      /**
       * A refusal the claimant can act on, or at least understand.
       *
       * A 400 with "not covered" would be the same experience this population gets
       * from every insurer. `COVERAGE_REFUSAL_MESSAGE` names the specific control that
       * refused — and for the waiting period, points at the date on their policy.
       */
      throw new BadRequestException(COVERAGE_REFUSAL_MESSAGE[refusal])
    }

    const amountClaimedMinor = BigInt(dto.amountClaimedMinor)
    const remaining = remainingCoverMinor(policy)

    if (remaining <= 0n) {
      throw new BadRequestException(
        `This policy's cover of ${moneyView(policy.coverageMinor, policy.currency).formatted} has already been fully claimed.`,
      )
    }
    if (amountClaimedMinor > remaining) {
      throw new BadRequestException(
        `The most you can claim on this policy now is ${moneyView(remaining, policy.currency).formatted} — ${moneyView(policy.claimedMinor, policy.currency).formatted} of the cover has already been paid out.`,
      )
    }

    /**
     * The duplicate fingerprint: policy + incident DAY + amount.
     *
     * The day rather than the timestamp, because a claimant re-filing the same
     * incident will not reproduce the same millisecond — and two claims for the same
     * loss on the same day for the same amount are one claim submitted twice.
     */
    const dedupeHash = createHash('sha256')
      .update(
        `${policy.id}:${utcDayKey(dto.incidentDate)}:${amountClaimedMinor.toString()}`,
      )
      .digest('hex')

    try {
      const claim = await this.prisma.claim.create({
        data: {
          policyId: policy.id,
          userId,
          claimNumber: this.claimNumber(),
          type: policy.product.type,
          amountClaimedMinor,
          currency: policy.currency,
          status: ClaimStatus.SUBMITTED,
          incidentDate: dto.incidentDate,
          description: dto.description,
          dedupeHash,
        },
        include: { docs: true },
      })

      await this.audit.log({
        actorType: ActorType.USER,
        actorId: userId,
        action: 'insurance.claim.submitted',
        entity: 'Claim',
        entityId: claim.id,
        metadata: {
          claimNumber: claim.claimNumber,
          policyId: policy.id,
          amountClaimedMinor: amountClaimedMinor.toString(),
          incidentDate: dto.incidentDate.toISOString(),
        },
      })

      this.logger.info(`[${this.submit.name}] Claim filed`, {
        claimId: claim.id,
        claimNumber: claim.claimNumber,
        policyId: policy.id,
      })
      return claim
    } catch (error) {
      if (isUniqueViolation(error)) {
        /**
         * The constraint caught a duplicate.
         *
         * By DATABASE, not by a preceding lookup, because two concurrent submissions
         * both read "no matching claim" before either writes. The existing claim is
         * named in the error so the claimant can find it rather than filing a third.
         */
        const existing = await this.prisma.claim.findUnique({
          where: {
            policyId_dedupeHash: { policyId: policy.id, dedupeHash },
          },
          select: { claimNumber: true, status: true },
        })
        throw new ConflictException(
          existing
            ? `You have already filed a claim for this incident (${existing.claimNumber}, currently ${existing.status}).`
            : 'A matching claim already exists for this incident.',
        )
      }
      throw error
    }
  }

  // ── documents ─────────────────────────────────────────────────────────────
  /**
   * Attach a document, then OCR it.
   *
   * The row is created BEFORE extraction runs, so a document whose OCR fails is still
   * recorded as uploaded. A claimant who photographed a bill and saw nothing appear
   * would re-upload it repeatedly; the row plus a REJECTED status tells them what
   * happened.
   */
  async addDocument(
    userId: string,
    claimId: string,
    dto: AddClaimDocDto,
    file: { buffer: Buffer; originalname?: string },
  ): Promise<ClaimDocument> {
    const claim = await this.owned(userId, claimId)

    if (!canAttachDocuments(claim.status)) {
      throw new ConflictException(
        `This claim is ${claim.status.toLowerCase().replace('_', ' ')} and can no longer take new documents.`,
      )
    }

    const existingCount = await this.prisma.claimDocument.count({
      where: { claimId },
    })
    if (existingCount >= MAX_CLAIM_DOCS) {
      throw new BadRequestException(
        `A claim can carry at most ${MAX_CLAIM_DOCS} documents.`,
      )
    }

    /**
     * The content hash, unique per claim.
     *
     * Stops the same bill being uploaded three times to pad a document count into the
     * auto-approve path — a trivially cheap attack against a threshold that only
     * counts documents.
     */
    const contentHash = createHash('sha256').update(file.buffer).digest('hex')

    let doc: ClaimDocument
    try {
      doc = await this.prisma.claimDocument.create({
        data: {
          claimId,
          docType: dto.docType,
          // The object-store path. The BYTES are not persisted in the database —
          // only the extraction (encrypted) and the fingerprint.
          storagePath: `claims/${claimId}/${contentHash.slice(0, 16)}`,
          contentHash,
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'That exact document has already been attached to this claim.',
        )
      }
      throw error
    }

    const extraction = await this.registry
      .ocr()
      .extract(file.buffer, dto.docType, claim.currency)

    if (!extraction.ok) {
      this.logger.info(
        `[${this.addDocument.name}] Document could not be read`,
        {
          claimId,
          docId: doc.id,
          docType: dto.docType,
          reason: extraction.error.code,
        },
      )
      return this.prisma.claimDocument.update({
        where: { id: doc.id },
        data: { verificationStatus: ClaimDocStatus.REJECTED },
      })
    }

    const value = extraction.value

    /**
     * The three-way verdict, and the reason it is three-way.
     *
     * SUSPECT and UPLOADED are NOT the same outcome:
     *
     *  - `tamperScore >= TAMPER_BLOCK_THRESHOLD` → SUSPECT. The claim can never
     *    auto-approve. A person looks at it.
     *  - `confidence < OCR_CONFIDENCE_FLOOR` → stays UPLOADED. The document is not
     *    trusted enough to verify, and the claimant is asked for a clearer copy.
     *  - Otherwise → VERIFIED.
     *
     * Collapsing the middle case into SUSPECT would accuse somebody with a cracked
     * phone camera of forgery; collapsing it into VERIFIED would let an unreadable
     * document satisfy the auto-approve condition.
     */
    const verificationStatus =
      value.tamperScore >= TAMPER_BLOCK_THRESHOLD
        ? ClaimDocStatus.SUSPECT
        : value.confidence < OCR_CONFIDENCE_FLOOR
          ? ClaimDocStatus.UPLOADED
          : ClaimDocStatus.VERIFIED

    const updated = await this.prisma.claimDocument.update({
      where: { id: doc.id },
      data: {
        /**
         * The extraction, field-encrypted.
         *
         * A hospital bill names a diagnosis and a treating physician. That is health
         * data about an identified person, so it gets the same AES-256-GCM treatment as
         * a raw KYC payload — and the admin projection masks it.
         */
        ocrJsonEnc: encryptField(JSON.stringify(value.fields)),
        extractedAmountMinor: value.amountMinor ?? null,
        tamperScore: value.tamperScore,
        ocrConfidence: value.confidence,
        verificationStatus,
      },
    })

    if (verificationStatus === ClaimDocStatus.SUSPECT) {
      this.logger.warn(
        `[${this.addDocument.name}] Document flagged as likely altered — the claim cannot auto-approve`,
        { claimId, docId: doc.id, tamperScore: value.tamperScore },
      )
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'insurance.claim.document_suspect',
        entity: 'ClaimDocument',
        entityId: doc.id,
        metadata: {
          claimId,
          docType: dto.docType,
          tamperScore: value.tamperScore,
          provider: value.provider,
        },
      })
    }

    return updated
  }

  // ── move to review ────────────────────────────────────────────────────────
  /**
   * Finalise a submission: score the fraud signals, then auto-approve or route to a
   * person.
   *
   * A separate call from `submit` because documents arrive as separate multipart
   * requests. The claimant files, uploads, and then says "I'm done" — and only at that
   * point is there a complete picture to assess. Scoring at submission would evaluate
   * every claim as though it had no documents.
   */
  async finalise(
    userId: string,
    claimId: string,
    /**
     * The request's device and network context, for M6's cross-cutting layers.
     *
     * Optional so every existing caller keeps compiling, and absent means those layers
     * simply contribute less — a claim with no device id scores `DEVICE_UNBOUND` rather
     * than failing. Threading it through is what lets a claim filed from an emulator on a
     * flagged network be seen as one, which claims scoring alone never could.
     */
    context: {
      deviceId?: string | null
      ipAddress?: string | null
      geoHint?: string | null
    } = {},
  ): Promise<ClaimWithDocs> {
    const claim = await this.owned(userId, claimId)

    if (claim.status === ClaimStatus.UNDER_REVIEW) {
      // Idempotent: the claimant tapped twice, or the client retried.
      return this.loadOwned(userId, claimId)
    }
    if (!canClaimTransition(claim.status, ClaimStatus.UNDER_REVIEW)) {
      throw new ConflictException(
        `A ${claim.status.toLowerCase().replace('_', ' ')} claim cannot be submitted for review.`,
      )
    }

    const policy = await this.prisma.policy.findUniqueOrThrow({
      where: { id: claim.policyId },
      include: { product: true },
    })
    const docs = await this.prisma.claimDocument.findMany({
      where: { claimId },
    })

    const missing = this.missingRequiredDocs(policy.product.type, docs)
    if (missing.length > 0) {
      /**
       * Held at SUBMITTED, not rejected.
       *
       * A rejection for a missing payslip is one the claimant could have fixed in ten
       * minutes and should never have received. The list of what is missing goes back
       * in the error so they can fix it in one round trip.
       */
      throw new BadRequestException(
        `Before we can review this, please attach: ${missing.join(', ')}. ${
          EXPECTED_CLAIM_DOCS[policy.product.type]?.length
            ? `Helpful extras: ${EXPECTED_CLAIM_DOCS[policy.product.type].join(', ')}.`
            : ''
        }`.trim(),
      )
    }

    const hasTamperedDocument = docs.some(
      (doc) => (doc.tamperScore ?? 0) >= TAMPER_BLOCK_THRESHOLD,
    )
    const hasAmountMismatch = this.detectAmountMismatch(claim, docs)

    const assessment = await this.risk.scoreClaim({
      claim,
      policy,
      hasTamperedDocument,
      hasAmountMismatch,
      documentCount: docs.length,
      documentsRequired:
        (REQUIRED_CLAIM_DOCS[policy.product.type] ?? []).length > 0,
      deviceId: context.deviceId,
      ipAddress: context.ipAddress,
      geoHint: context.geoHint,
    })

    await this.prisma.claim.update({
      where: { id: claimId },
      data: {
        status: ClaimStatus.UNDER_REVIEW,
        riskScore: assessment.value,
        riskFlags: assessment.flags,
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'insurance.claim.under_review',
      entity: 'Claim',
      entityId: claimId,
      metadata: {
        riskScore: assessment.value,
        flags: assessment.flags,
        forceReview: assessment.forceReview,
        documentCount: docs.length,
      },
    })

    /**
     * Notify the insurer, and the health exchange if there is one.
     *
     * After our own state change, and its failure is not allowed to block the claim.
     * A claims workflow that stalled because a third party's API was down would leave
     * somebody holding a hospital bill waiting on an integration.
     */
    await this.notifyExternally(claim, policy)

    if (this.qualifiesForAutoApproval(claim, docs, assessment)) {
      this.logger.info(
        `[${this.finalise.name}] Small low-risk claim auto-approved`,
        { claimId, claimNumber: claim.claimNumber },
      )
      await this.decide(
        { type: 'SYSTEM' },
        claimId,
        ClaimDecision.APPROVE,
        'Automatically approved: a small claim, low fraud risk, no document concerns, and all documents verified.',
      )
    }

    return this.loadOwned(userId, claimId)
  }

  /**
   * The auto-approve condition. Every clause has to hold.
   *
   * Deliberately conjunctive and deliberately narrow. Auto-approval exists so a
   * genuine small claim settles in seconds instead of days — which for this user is
   * the difference between the product working and being a form they filled in. It is
   * NOT a throughput optimisation, and every clause dropped is money that can be taken
   * without a human ever looking.
   */
  private qualifiesForAutoApproval(
    claim: Claim,
    docs: ClaimDocument[],
    assessment: { value: number; forceReview: boolean },
  ): boolean {
    const ceiling = AUTO_APPROVE_CEILING_MINOR[claim.currency]
    if (ceiling === undefined) {
      /**
       * No ceiling configured for this currency.
       *
       * Refuses to auto-approve rather than falling back to another currency's
       * ceiling — ₹500 and S$500 differ by about 60×, and picking the wrong one would
       * auto-pay a claim two orders of magnitude above the intended limit.
       */
      this.logger.warn(
        `[${this.qualifiesForAutoApproval.name}] No auto-approve ceiling for ${claim.currency} — routing to review`,
        { claimId: claim.id, currency: claim.currency },
      )
      return false
    }

    return (
      claim.amountClaimedMinor <= ceiling &&
      !assessment.forceReview &&
      assessment.value < CLAIM_AUTO_APPROVE_RISK_CEILING &&
      docs.length > 0 &&
      docs.every((doc) => doc.verificationStatus === ClaimDocStatus.VERIFIED)
    )
  }

  // ── decide ────────────────────────────────────────────────────────────────
  /**
   * Adjudicate a claim. The only path to a payout.
   *
   * An APPROVE does three things atomically-in-spirit and carefully in order:
   *
   *  1. Cap the approved amount at both the claimed amount and the policy's REMAINING
   *     cover. A fat-fingered extra zero cannot pay more than the contract allows.
   *  2. Move the claim to APPROVED and increment the policy's `claimedMinor` in ONE
   *     database transaction — so the aggregate limit is consumed by the same commit
   *     that grants the payout, and a concurrent second claim sees it.
   *  3. Pay out through M4's ledger, idempotently.
   *
   * If step 3 fails the claim STAYS APPROVED and is retried by the lifecycle sweep.
   * There is deliberately no `APPROVED → REJECTED` edge: once a claimant has been told
   * their claim is approved, that cannot be walked back because a payout errored. The
   * money is owed; the only question is when it arrives.
   */
  async decide(
    actor: ClaimActor,
    claimId: string,
    decision: ClaimDecision,
    reason: string,
    approveMinor?: bigint,
  ): Promise<{
    claim: Claim
    payoutPending: boolean
    payoutTxnId: string | null
  }> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { policy: true },
    })
    if (!claim) throw new NotFoundException('Claim not found')

    if (!isDecidable(claim.status)) {
      throw new ConflictException(
        `A ${claim.status.toLowerCase().replace('_', ' ')} claim cannot be decided.`,
      )
    }

    const actorType =
      actor.type === 'SYSTEM' ? ActorType.SYSTEM : ActorType.ADMIN
    const reviewerId = actor.type === 'ADMIN' ? actor.admin.id : null

    if (decision === ClaimDecision.REQUEST_INFO) {
      const updated = await this.prisma.claim.update({
        where: { id: claimId },
        data: {
          status: ClaimStatus.INFO_REQUESTED,
          decisionReason: reason,
          decidedByType: actorType,
          reviewerId,
        },
      })
      await this.audit.log({
        actorType,
        actorId: reviewerId,
        action: 'insurance.claim.info_requested',
        entity: 'Claim',
        entityId: claimId,
        metadata: { reason },
      })
      return { claim: updated, payoutPending: false, payoutTxnId: null }
    }

    if (decision === ClaimDecision.REJECT) {
      const updated = await this.prisma.claim.update({
        where: { id: claimId },
        data: {
          status: ClaimStatus.REJECTED,
          decision,
          decisionReason: reason,
          decidedByType: actorType,
          reviewerId,
          decidedAt: new Date(),
        },
      })
      await this.audit.log({
        actorType,
        actorId: reviewerId,
        action: 'insurance.claim.rejected',
        entity: 'Claim',
        entityId: claimId,
        metadata: { reason, claimNumber: claim.claimNumber },
      })
      this.logger.info(`[${this.decide.name}] Claim rejected`, {
        claimId,
        claimNumber: claim.claimNumber,
      })
      return { claim: updated, payoutPending: false, payoutTxnId: null }
    }

    // ── APPROVE ─────────────────────────────────────────────────────────────
    const remaining = remainingCoverMinor(claim.policy)
    const requested = approveMinor ?? claim.amountClaimedMinor
    /**
     * Capped twice, and both caps are load-bearing.
     *
     * Against the CLAIMED amount, so an operator cannot approve more than was asked
     * for; and against REMAINING cover, so the aggregate limit holds even if the
     * reviewer is looking at a stale screen where an earlier claim had not yet paid.
     */
    const approved =
      requested > claim.amountClaimedMinor
        ? claim.amountClaimedMinor
        : requested > remaining
          ? remaining
          : requested

    if (approved <= 0n) {
      throw new ConflictException(
        'This policy has no cover left to pay a claim against.',
      )
    }

    const approvedClaim = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.claim.updateMany({
        where: { id: claimId, status: claim.status },
        data: {
          status: ClaimStatus.APPROVED,
          decision,
          decisionReason: reason,
          decidedByType: actorType,
          reviewerId,
          amountApprovedMinor: approved,
          decidedAt: new Date(),
        },
      })
      if (moved.count === 0) {
        // Another reviewer decided it between our read and this write.
        throw new ConflictException(
          'That claim was decided by someone else a moment ago.',
        )
      }

      /**
       * Consume the aggregate limit in the SAME transaction as the approval.
       *
       * If these were two statements, two concurrent approvals on one policy would
       * both pass the remaining-cover check and the policy would pay out more than the
       * sum insured. Committing them together means the second reviewer's transaction
       * sees the first's increment.
       */
      await tx.policy.update({
        where: { id: claim.policyId },
        data: { claimedMinor: { increment: approved } },
      })

      return tx.claim.findUniqueOrThrow({ where: { id: claimId } })
    })

    await this.audit.log({
      actorType,
      actorId: reviewerId,
      action: 'insurance.claim.approved',
      entity: 'Claim',
      entityId: claimId,
      metadata: {
        claimNumber: claim.claimNumber,
        approvedMinor: approved.toString(),
        claimedMinor: claim.amountClaimedMinor.toString(),
        reason,
      },
    })

    const payout = await this.money.payoutClaim({
      userId: claim.userId,
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      amountMinor: approved,
      currency: claim.currency,
    })

    if (!payout.paid) {
      /**
       * The claim stays APPROVED and the sweep retries.
       *
       * Money is never lost and never invented — the M4 invariant. The claimant is
       * shown "approved, payment on its way" rather than a failure, because the
       * decision has been made and the obligation is real.
       */
      this.logger.error(
        `[${this.decide.name}] Payout did not settle — claim stays APPROVED for retry`,
        { claimId, transactionId: payout.transaction.id },
      )
      return {
        claim: approvedClaim,
        payoutPending: true,
        payoutTxnId: null,
      }
    }

    const paid = await this.markPaid(claimId, payout.transaction.id)
    return {
      claim: paid,
      payoutPending: false,
      payoutTxnId: payout.transaction.id,
    }
  }

  /**
   * Attach the settled payout and close the claim.
   *
   * `payoutTxnId` is UNIQUE, so a second attempt to attach a different transaction to
   * the same claim — or the same transaction to two claims — is a database error rather
   * than a double payout that reconciles to nothing.
   */
  async markPaid(claimId: string, transactionId: string): Promise<Claim> {
    try {
      return await this.prisma.claim.update({
        where: { id: claimId },
        data: {
          status: ClaimStatus.PAID,
          payoutTxnId: transactionId,
          paidAt: new Date(),
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.warn(
          `[${this.markPaid.name}] Payout transaction is already attached`,
          { claimId, transactionId },
        )
        return this.prisma.claim.findUniqueOrThrow({ where: { id: claimId } })
      }
      throw error
    }
  }

  // ── withdraw ──────────────────────────────────────────────────────────────
  /**
   * The claimant withdraws.
   *
   * Available while a claim is SUBMITTED or INFO_REQUESTED, not after a decision. A
   * decided claim is part of the book's loss history and cannot be retracted to tidy
   * it up — and a claimant who disagrees with a rejection files a new claim, which is
   * how the two decisions stay separately auditable.
   */
  async withdraw(
    userId: string,
    claimId: string,
    reason?: string,
  ): Promise<Claim> {
    const claim = await this.owned(userId, claimId)

    if (!canClaimTransition(claim.status, ClaimStatus.WITHDRAWN)) {
      throw new ConflictException(
        `A ${claim.status.toLowerCase().replace('_', ' ')} claim cannot be withdrawn.`,
      )
    }

    const updated = await this.prisma.claim.update({
      where: { id: claimId },
      data: {
        status: ClaimStatus.WITHDRAWN,
        decisionReason: reason?.slice(0, 300) ?? 'Withdrawn by the claimant',
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'insurance.claim.withdrawn',
      entity: 'Claim',
      entityId: claimId,
      metadata: { reason: reason ?? null },
    })
    return updated
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  async list(
    userId: string,
    query: ClaimListQueryDto,
  ): Promise<{ items: ClaimWithDocs[]; total: number }> {
    const where = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.policyId ? { policyId: query.policyId } : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where,
        include: { docs: true },
        orderBy: { submittedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.claim.count({ where }),
    ])
    return { items, total }
  }

  async loadOwned(userId: string, claimId: string): Promise<ClaimWithDocs> {
    const claim = await this.prisma.claim.findFirst({
      where: { id: claimId, userId },
      include: { docs: true },
    })
    if (!claim) throw new NotFoundException('Claim not found')
    return claim
  }

  /**
   * The claimant-facing shape.
   *
   * `riskScore` and `riskFlags` are deliberately ABSENT. Telling a claimant which
   * fraud signals fired on their claim is a manual for evading them, and telling them
   * their claim scored 0.55 on a heuristic is neither actionable nor fair. The reviewer
   * sees them; the claimant sees the decision and its reason.
   */
  describe(claim: ClaimWithDocs) {
    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      policyId: claim.policyId,
      type: claim.type,
      status: claim.status,
      statusLabel: CLAIM_STATUS_LABEL[claim.status],
      isFinal: !isClaimInFlight(claim.status),

      amountClaimed: moneyView(claim.amountClaimedMinor, claim.currency),
      amountApproved: claim.amountApprovedMinor
        ? moneyView(claim.amountApprovedMinor, claim.currency)
        : null,

      incidentDate: claim.incidentDate,
      description: claim.description,

      decision: claim.decision,
      decisionReason: claim.decisionReason,
      /**
       * Whether a person or the system decided.
       *
       * Surfaced honestly. A claimant told "approved" is entitled to know it was an
       * automatic decision on a small claim rather than a reviewer's judgement — and if
       * they disagree with an automatic rejection, that is the first thing an appeal
       * would turn on.
       */
      decidedBy: claim.decidedByType,
      decidedAt: claim.decidedAt,
      paidAt: claim.paidAt,
      payoutTransactionId: claim.payoutTxnId,

      documents: claim.docs.map((doc) => ({
        id: doc.id,
        docType: doc.docType,
        status: doc.verificationStatus,
        /**
         * A prompt, not a score.
         *
         * The claimant needs to know whether to re-upload; the tamper score itself is
         * a fraud-detection detail and publishing it would tell somebody exactly how
         * altered a document has to be before it passes.
         */
        needsBetterCopy:
          doc.verificationStatus === ClaimDocStatus.UPLOADED &&
          doc.ocrConfidence !== null &&
          doc.ocrConfidence < OCR_CONFIDENCE_FLOOR,
        extractedAmount: doc.extractedAmountMinor
          ? moneyView(doc.extractedAmountMinor, claim.currency)
          : null,
        uploadedAt: doc.uploadedAt,
      })),

      submittedAt: claim.submittedAt,
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private async owned(userId: string, claimId: string): Promise<Claim> {
    const claim = await this.prisma.claim.findFirst({
      where: { id: claimId, userId },
    })
    if (!claim) throw new NotFoundException('Claim not found')
    return claim
  }

  /** `CLM-A1B2C3D4`. Random, and unique by index — never a timestamp slice. */
  private claimNumber(): string {
    return `CLM-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
  }

  /**
   * Required documents this claim is still missing.
   *
   * Only counts documents that were actually READ — a REJECTED upload does not satisfy
   * a requirement, because an unreadable payslip is not proof of anything. SUSPECT
   * ones DO count: the requirement is met, and the tamper gate then forces the claim
   * to a human rather than asking the claimant for another copy of a document we
   * believe was altered.
   */
  private missingRequiredDocs(
    productType: string,
    docs: ClaimDocument[],
  ): string[] {
    const required =
      REQUIRED_CLAIM_DOCS[productType as InsuranceProductTypeInput] ?? []
    const present = new Set(
      docs
        .filter((doc) => doc.verificationStatus !== ClaimDocStatus.REJECTED)
        .map((doc) => doc.docType),
    )
    return required.filter((docType) => !present.has(docType))
  }

  /**
   * Whether any document's amount materially understates the claim.
   *
   * Uses the HIGHEST extracted amount across documents, not the first. A hospital
   * episode legitimately produces several bills, and comparing against whichever one
   * happened to be uploaded first would flag a genuine multi-bill claim as a mismatch
   * on every submission.
   */
  private detectAmountMismatch(claim: Claim, docs: ClaimDocument[]): boolean {
    const amounts = docs
      .map((doc) => doc.extractedAmountMinor)
      .filter((amount): amount is bigint => amount !== null)
    if (amounts.length === 0) return false

    const highest = amounts.reduce(
      (max, amount) => (amount > max ? amount : max),
      0n,
    )
    return isAmountMismatch({
      claimedMinor: claim.amountClaimedMinor,
      extractedMinor: highest,
      toleranceBps: AMOUNT_MISMATCH_TOLERANCE_BPS,
    })
  }

  /**
   * Tell the insurer, and the health exchange if one is reachable.
   *
   * Both are best-effort and neither can block the claim. The insurer notification is
   * a NOTIFICATION — our adjudication decides whether the claimant is paid — and the
   * exchange leg is skipped entirely when unconfigured rather than answered with a
   * fabricated request id.
   */
  private async notifyExternally(
    claim: Claim,
    policy: Policy & { product: InsuranceProduct },
  ): Promise<void> {
    if (policy.insurerPolicyRef) {
      const submitted = await this.registry
        .insurer()
        .submitClaim({
          insurerPolicyRef: policy.insurerPolicyRef,
          claimNumber: claim.claimNumber,
          amountMinor: claim.amountClaimedMinor,
          currency: claim.currency,
          incidentDate: claim.incidentDate.toISOString(),
          description: claim.description,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `[${this.notifyExternally.name}] Insurer notification threw`,
            { claimId: claim.id, err: error },
          )
          return null
        })

      if (submitted?.ok) {
        await this.prisma.claim.update({
          where: { id: claim.id },
          data: { insurerClaimRef: submitted.value.insurerClaimRef },
        })
      } else if (submitted && !submitted.ok) {
        this.logger.warn(
          `[${this.notifyExternally.name}] Insurer did not accept the claim notification — our own adjudication continues`,
          { claimId: claim.id, error: submitted.error.message },
        )
      }
    }

    /**
     * The health-claims exchange, for health products only.
     *
     * An income-protection or travel claim has no business on a health rail, and
     * filing one there would be a category error visible to every other HCX
     * participant.
     */
    if (policy.product.type !== 'HEALTH_TOPUP') return

    const exchange = this.registry.claimsExchange()
    if (!exchange) {
      this.logger.info(
        `[${this.notifyExternally.name}] No claims exchange configured — skipping the HCX leg`,
        { claimId: claim.id },
      )
      return
    }

    const filed = await exchange
      .createClaim({
        abhaRef: policy.abhaRef,
        claimNumber: claim.claimNumber,
        amountMinor: claim.amountClaimedMinor,
        currency: claim.currency,
        providerId: 'PRAVAAH-DEMO-FACILITY',
        incidentDate: claim.incidentDate.toISOString(),
      })
      .catch(() => null)

    if (filed?.ok) {
      await this.prisma.claim.update({
        where: { id: claim.id },
        data: { hcxRequestId: filed.value.hcxRequestId },
      })
    }
  }
}

/** Claim statuses, in words a claimant reads rather than an enum. */
const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  [CLAIM_STATUS.SUBMITTED]: 'Filed — add your documents',
  [CLAIM_STATUS.UNDER_REVIEW]: 'Being reviewed',
  [CLAIM_STATUS.INFO_REQUESTED]: 'We need something else from you',
  [CLAIM_STATUS.APPROVED]: 'Approved — payment on its way',
  [CLAIM_STATUS.PAID]: 'Paid to your wallet',
  [CLAIM_STATUS.REJECTED]: 'Not approved',
  [CLAIM_STATUS.WITHDRAWN]: 'Withdrawn',
}
