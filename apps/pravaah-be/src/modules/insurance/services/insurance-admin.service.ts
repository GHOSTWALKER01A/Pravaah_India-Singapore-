import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  type AdminClaimQueueQueryDto,
  type AdminPolicyListQueryDto,
  type LossRatioQueryDto,
  type UpsertInsuranceProductDto,
} from '@pravaah/schema'

import { decryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { lossRatioBps } from '@/modules/insurance/insurance-pricing.util'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import { InsuranceMoneyService } from '@/modules/insurance/services/insurance-money.service'
import { PremiumService } from '@/modules/insurance/services/premium.service'
import { moneyView } from '@/modules/payments/money.util'

import {
  ActorType,
  ClaimStatus,
  InsuranceQuoteStatus,
  PolicyStatus,
  type AdminUser,
  type ClaimDocument,
  type InsuranceProduct,
} from 'generated/prisma/client'

/**
 * Admin oversight for the insurance book.
 *
 * Two audiences, and they need different things:
 *
 *  - **A reviewer** needs the claim queue, with the fraud signals and the document
 *    verdicts visible, so they can decide. That is the only place `riskScore` and
 *    `riskFlags` are surfaced — the claimant never sees them, because a list of which
 *    signals fired is a manual for evading them.
 *  - **An operator or an actuary** needs the BOOK: earned premium, paid claims, and the
 *    loss ratio per product. That is the one number an insurance judge looks for, and
 *    it is read off the LEDGER rather than from these tables.
 *
 * ## Why the loss ratio comes from the ledger
 *
 * `PremiumPayment.status` and `Claim.amountApprovedMinor` record what we INTENDED.
 * `LedgerEntry` records what actually moved. The two diverge exactly when it matters
 * most — a payout that failed after the claim was marked approved, a premium refunded
 * after being counted as earned — and a loss ratio that disagreed with the trial
 * balance would discredit both numbers. So the book is derived from the same rows the
 * money is.
 */
@Injectable()
export class InsuranceAdminService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly money: InsuranceMoneyService,
    private readonly premiums: PremiumService,
    private readonly registry: InsuranceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: InsuranceAdminService.name })
  }

  // ── the catalogue ─────────────────────────────────────────────────────────
  /**
   * Create a product.
   *
   * Admin-managed so a new cover — or a repriced one — needs no deploy. Note what is
   * NOT editable through this path: an existing product's `baseRateBps` can be changed
   * for FUTURE quotes, but no already-issued policy is repriced, because a policy's
   * premium lives on the policy and its quote. That is the whole reason the quote
   * snapshots the price rather than pointing at the catalogue.
   */
  async createProduct(
    admin: AdminUser,
    dto: UpsertInsuranceProductDto,
  ): Promise<InsuranceProduct> {
    const product = await this.prisma.insuranceProduct.create({
      data: {
        type: dto.type,
        name: dto.name,
        tagline: dto.tagline ?? null,
        currency: dto.currency,
        baseRateBps: dto.baseRateBps,
        minCoverMinor: BigInt(dto.minCoverMinor),
        maxCoverMinor: BigInt(dto.maxCoverMinor),
        termDays: dto.termDays,
        waitingPeriodDays: dto.waitingPeriodDays,
        freeLookDays: dto.freeLookDays,
        exclusions: dto.exclusions,
        disclaimer: dto.disclaimer,
        isActive: dto.isActive,
      },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: 'insurance.product.created',
      entity: 'InsuranceProduct',
      entityId: product.id,
      metadata: {
        type: dto.type,
        baseRateBps: dto.baseRateBps,
        waitingPeriodDays: dto.waitingPeriodDays,
      },
    })
    return product
  }

  /**
   * Update a product.
   *
   * The audit metadata records the PREVIOUS base rate alongside the new one. A repricing
   * is a commercial decision somebody will be asked about — "why did income protection
   * get 20% dearer in August?" — and an audit row that only holds the new value cannot
   * answer it.
   */
  async updateProduct(
    admin: AdminUser,
    productId: string,
    dto: UpsertInsuranceProductDto,
  ): Promise<InsuranceProduct> {
    const existing = await this.prisma.insuranceProduct.findUnique({
      where: { id: productId },
    })
    if (!existing) throw new NotFoundException('Product not found')

    const product = await this.prisma.insuranceProduct.update({
      where: { id: productId },
      data: {
        type: dto.type,
        name: dto.name,
        tagline: dto.tagline ?? null,
        currency: dto.currency,
        baseRateBps: dto.baseRateBps,
        minCoverMinor: BigInt(dto.minCoverMinor),
        maxCoverMinor: BigInt(dto.maxCoverMinor),
        termDays: dto.termDays,
        waitingPeriodDays: dto.waitingPeriodDays,
        freeLookDays: dto.freeLookDays,
        exclusions: dto.exclusions,
        disclaimer: dto.disclaimer,
        isActive: dto.isActive,
      },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: 'insurance.product.updated',
      entity: 'InsuranceProduct',
      entityId: productId,
      metadata: {
        previousBaseRateBps: existing.baseRateBps,
        baseRateBps: dto.baseRateBps,
        previousWaitingPeriodDays: existing.waitingPeriodDays,
        waitingPeriodDays: dto.waitingPeriodDays,
        // Explicitly recorded: nobody should have to infer from a diff that live
        // policies were untouched by a repricing.
        appliesToExistingPolicies: false,
      },
    })
    return product
  }

  /**
   * Withdraw or restore a product.
   *
   * Deactivation, never deletion. Existing policies keep referencing it — their
   * exclusions, term and waiting period are read from this row — so a deleted product
   * would leave live contracts unrenderable. Deactivating only stops NEW quotes.
   */
  async setProductActive(
    admin: AdminUser,
    productId: string,
    isActive: boolean,
  ): Promise<InsuranceProduct> {
    const product = await this.prisma.insuranceProduct
      .update({ where: { id: productId }, data: { isActive } })
      .catch(() => null)
    if (!product) throw new NotFoundException('Product not found')

    const liveCount = await this.prisma.policy.count({
      where: {
        productId,
        status: { in: [PolicyStatus.ACTIVE, PolicyStatus.GRACE] },
      },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: isActive
        ? 'insurance.product.activated'
        : 'insurance.product.withdrawn',
      entity: 'InsuranceProduct',
      entityId: productId,
      // The count matters on a withdrawal: an admin retiring a product should see how
      // many people are still covered by it.
      metadata: { livePolicies: liveCount },
    })
    return product
  }

  listProducts(): Promise<InsuranceProduct[]> {
    return this.prisma.insuranceProduct.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    })
  }

  // ── the claim queue ───────────────────────────────────────────────────────
  /**
   * Claims awaiting a decision.
   *
   * Ordered OLDEST FIRST. A newest-first queue silently starves the claims that have
   * been waiting longest, which are precisely the ones where somebody is out of pocket
   * — and a reviewer working from the top of a newest-first list would never reach
   * them.
   */
  async claimQueue(query: AdminClaimQueueQueryDto) {
    const where = {
      status: query.status,
      ...(query.flaggedOnly ? { riskFlags: { isEmpty: false } } : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where,
        include: {
          docs: true,
          policy: { include: { product: true } },
          user: { select: { pravaahId: true, primaryCountry: true } },
          reviewer: { select: { id: true, email: true, role: true } },
        },
        orderBy: { submittedAt: 'asc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.claim.count({ where }),
    ])

    return {
      items: items.map((claim) => this.describeClaimForReviewer(claim)),
      total,
    }
  }

  async claimDetail(claimId: string) {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: {
        docs: true,
        policy: { include: { product: true, quote: true } },
        user: { select: { pravaahId: true, primaryCountry: true } },
        reviewer: { select: { id: true, email: true, role: true } },
      },
    })
    if (!claim) throw new NotFoundException('Claim not found')

    const otherClaims = await this.prisma.claim.count({
      where: { userId: claim.userId, id: { not: claim.id } },
    })

    return {
      ...this.describeClaimForReviewer(claim),
      /**
       * The policy's own pricing provenance, so a reviewer can see WHY this cover was
       * sold at this price — the band, the confidence, the pricing-model version.
       *
       * Relevant to adjudication rather than decoration: a claim on a policy priced
       * from a thin file with a 60-day waiting period is a different picture from one on
       * an EXCELLENT-band policy, and the reviewer should not have to open three screens
       * to see which they are looking at.
       */
      underwriting: {
        riskTier: claim.policy.quote.riskTier,
        scoreBand: claim.policy.quote.scoreBand,
        confidence: claim.policy.quote.confidence,
        multiplierBps: claim.policy.quote.riskMultiplierBps,
        pricingModelVersion: claim.policy.quote.pricingModelVersion,
        waitingPeriodDays: claim.policy.quote.waitingPeriodDays,
      },
      claimHistory: { otherClaimsByHolder: otherClaims },
    }
  }

  /**
   * The reviewer's view of a claim.
   *
   * Two things here that the claimant's view deliberately lacks:
   *
   *  - `riskScore` and `riskFlags` — the fraud signals. A reviewer cannot decide without
   *    them; a claimant given them has a list of what to avoid next time.
   *  - The documents' tamper scores.
   *
   * And one thing NOT here even for a reviewer: the decrypted OCR payload. A hospital
   * bill names a diagnosis, and a reviewer deciding an income-protection claim has no
   * need for it. The extracted AMOUNT is what the decision turns on, and that is
   * surfaced. The full extraction is available through
   * {@link revealDocumentExtraction}, which writes its own audit row.
   */
  private describeClaimForReviewer(claim: {
    id: string
    claimNumber: string
    status: ClaimStatus
    type: string
    amountClaimedMinor: bigint
    amountApprovedMinor: bigint | null
    currency: string
    incidentDate: Date
    description: string
    riskScore: number | null
    riskFlags: string[]
    decision: string | null
    decisionReason: string | null
    decidedByType: ActorType | null
    decidedAt: Date | null
    paidAt: Date | null
    payoutTxnId: string | null
    insurerClaimRef: string | null
    hcxRequestId: string | null
    submittedAt: Date
    docs: ClaimDocument[]
    policy: {
      id: string
      policyNumber: string
      status: PolicyStatus
      coverageMinor: bigint
      claimedMinor: bigint
      startAt: Date | null
      endAt: Date | null
      waitingPeriodEndsAt: Date | null
      product: { name: string; type: string }
    }
    user: { pravaahId: string | null; primaryCountry: string }
    reviewer: { id: string; email: string; role: string } | null
  }) {
    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      status: claim.status,
      type: claim.type,

      amountClaimed: moneyView(claim.amountClaimedMinor, claim.currency),
      amountApproved: claim.amountApprovedMinor
        ? moneyView(claim.amountApprovedMinor, claim.currency)
        : null,

      incidentDate: claim.incidentDate,
      description: claim.description,
      submittedAt: claim.submittedAt,

      risk: { score: claim.riskScore, flags: claim.riskFlags },

      /** The holder, by PUBLIC id. An admin console has no need for the UUID. */
      holder: {
        pravaahId: claim.user.pravaahId,
        country: claim.user.primaryCountry,
      },

      policy: {
        id: claim.policy.id,
        policyNumber: claim.policy.policyNumber,
        status: claim.policy.status,
        product: claim.policy.product.name,
        productType: claim.policy.product.type,
        coverage: moneyView(claim.policy.coverageMinor, claim.currency),
        claimedToDate: moneyView(claim.policy.claimedMinor, claim.currency),
        remainingCover: moneyView(
          claim.policy.coverageMinor - claim.policy.claimedMinor > 0n
            ? claim.policy.coverageMinor - claim.policy.claimedMinor
            : 0n,
          claim.currency,
        ),
        startAt: claim.policy.startAt,
        endAt: claim.policy.endAt,
        waitingPeriodEndsAt: claim.policy.waitingPeriodEndsAt,
      },

      documents: claim.docs.map((doc) => ({
        id: doc.id,
        docType: doc.docType,
        status: doc.verificationStatus,
        tamperScore: doc.tamperScore,
        ocrConfidence: doc.ocrConfidence,
        extractedAmount: doc.extractedAmountMinor
          ? moneyView(doc.extractedAmountMinor, claim.currency)
          : null,
        // The extraction is held encrypted. See revealDocumentExtraction.
        hasExtraction: doc.ocrJsonEnc !== null,
        uploadedAt: doc.uploadedAt,
      })),

      decision: {
        decision: claim.decision,
        reason: claim.decisionReason,
        byType: claim.decidedByType,
        reviewer: claim.reviewer,
        decidedAt: claim.decidedAt,
      },

      payout: {
        transactionId: claim.payoutTxnId,
        paidAt: claim.paidAt,
        /**
         * Approved but unpaid — the state that must never go unnoticed.
         *
         * A claimant has been told their claim is approved and the money has not
         * arrived. There is no error in any log; only this flag and the retry sweep.
         */
        pending: claim.status === ClaimStatus.APPROVED && !claim.payoutTxnId,
      },

      external: {
        insurerClaimRef: claim.insurerClaimRef,
        hcxRequestId: claim.hcxRequestId,
      },
    }
  }

  /**
   * Decrypt one document's extraction, on the record.
   *
   * Its own endpoint with its own audit row, rather than being folded into the claim
   * detail. A hospital bill names a diagnosis and a treating physician; that is health
   * data about an identified person, and an admin console that rendered it on every
   * queue load would expose it to every reviewer who scrolled past. Making the reveal
   * an explicit, logged act is what turns "encrypted at rest" into an access control
   * rather than a storage detail.
   */
  async revealDocumentExtraction(admin: AdminUser, docId: string) {
    const doc = await this.prisma.claimDocument.findUnique({
      where: { id: docId },
      include: { claim: { select: { id: true, claimNumber: true } } },
    })
    if (!doc) throw new NotFoundException('Document not found')
    if (!doc.ocrJsonEnc) {
      throw new ConflictException(
        'This document has no extraction — it was not readable.',
      )
    }

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      action: 'insurance.claim.document_revealed',
      entity: 'ClaimDocument',
      entityId: docId,
      metadata: {
        claimId: doc.claim.id,
        claimNumber: doc.claim.claimNumber,
        docType: doc.docType,
      },
    })

    let fields: unknown
    try {
      fields = JSON.parse(decryptField(doc.ocrJsonEnc))
    } catch (error) {
      this.logger.error(
        `[${this.revealDocumentExtraction.name}] Could not decrypt a document extraction`,
        { docId, err: error },
      )
      throw new ConflictException(
        'This extraction could not be decrypted. The encryption key may have been rotated.',
      )
    }

    return {
      id: doc.id,
      docType: doc.docType,
      status: doc.verificationStatus,
      tamperScore: doc.tamperScore,
      ocrConfidence: doc.ocrConfidence,
      fields,
    }
  }

  // ── policies ──────────────────────────────────────────────────────────────
  async policies(query: AdminPolicyListQueryDto) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.type ? { product: { type: query.type as never } } : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.policy.findMany({
        where,
        include: {
          product: { select: { name: true, type: true } },
          user: { select: { pravaahId: true } },
          quote: {
            select: { riskTier: true, scoreBand: true, confidence: true },
          },
          _count: { select: { claims: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.policy.count({ where }),
    ])

    return {
      items: items.map((policy) => ({
        id: policy.id,
        policyNumber: policy.policyNumber,
        status: policy.status,
        holder: policy.user.pravaahId,
        product: policy.product.name,
        productType: policy.product.type,
        coverage: moneyView(policy.coverageMinor, policy.currency),
        premium: moneyView(policy.premiumMinor, policy.currency),
        frequency: policy.frequency,
        underwriting: {
          riskTier: policy.quote.riskTier,
          scoreBand: policy.quote.scoreBand,
          confidence: policy.quote.confidence,
        },
        claimCount: policy._count.claims,
        claimedToDate: moneyView(policy.claimedMinor, policy.currency),
        startAt: policy.startAt,
        endAt: policy.endAt,
        nextPremiumDueAt: policy.nextPremiumDueAt,
        insurerPolicyRef: policy.insurerPolicyRef,
        insurerBindPending: policy.insurerPolicyRef === null,
        createdAt: policy.createdAt,
      })),
      total,
    }
  }

  /** Premium history for one policy, for a support conversation about a debit. */
  async premiumHistory(policyId: string) {
    const policy = await this.prisma.policy.findUnique({
      where: { id: policyId },
      select: { id: true, currency: true, policyNumber: true },
    })
    if (!policy) throw new NotFoundException('Policy not found')

    const history = await this.premiums.history(policyId)
    return {
      policyNumber: policy.policyNumber,
      items: history.map((premium) => ({
        id: premium.id,
        amount: moneyView(premium.amountMinor, premium.currency),
        status: premium.status,
        periodStart: premium.periodStart,
        periodEnd: premium.periodEnd,
        attempt: premium.attempt,
        failureReason: premium.failureReason,
        transactionId: premium.transactionId,
        refunded: moneyView(premium.refundedMinor, premium.currency),
        paidAt: premium.paidAt,
      })),
    }
  }

  // ── the book ──────────────────────────────────────────────────────────────
  /**
   * The loss ratio and the underwriting position.
   *
   * The one number an insurance judge looks for, and the reason it is trustworthy here
   * is that it comes from the LEDGER — the same rows the trial balance is computed from.
   * A loss ratio derived from application tables would eventually disagree with the
   * money, and at that point neither figure means anything.
   *
   * `null` for a currency with no earned premium, never `0`. A book that has never sold
   * a policy has no loss ratio, and printing `0%` on it would read as a perfectly
   * performing product.
   */
  async book(query: LossRatioQueryDto = {}) {
    const [totals, floats] = await Promise.all([
      this.money.bookTotals({
        currency: query.currency,
        from: query.from,
        to: query.to,
      }),
      this.money.floatBalances(),
    ])

    const floatByCurrency = new Map(
      floats.map((entry) => [entry.currency, entry.balanceMinor]),
    )

    const byCurrency = totals.map((total) => {
      const ratioBps = lossRatioBps(total.paidMinor, total.netEarnedMinor)
      return {
        currency: total.currency,
        earnedPremium: moneyView(total.earnedMinor, total.currency),
        refundedPremium: moneyView(total.refundedMinor, total.currency),
        netEarnedPremium: moneyView(total.netEarnedMinor, total.currency),
        claimsPaid: moneyView(total.paidMinor, total.currency),
        lossRatioBps: ratioBps,
        lossRatioPercent:
          ratioBps === null ? null : Number((ratioBps / 100).toFixed(2)),
        /**
         * The float's balance — the underwriting result, and it may be NEGATIVE.
         *
         * Returned as a signed string rather than a `MoneyView`, because `moneyView`
         * refuses negatives by design (M4's money helpers reject them so a debit cannot
         * masquerade as a credit). A loss is a real state and clamping it to zero would
         * make a loss-making book look break-even.
         */
        floatBalanceMinor: (
          floatByCurrency.get(total.currency) ?? 0n
        ).toString(),
        underwritingResult:
          (floatByCurrency.get(total.currency) ?? 0n) >= 0n
            ? 'SURPLUS'
            : 'DEFICIT',
      }
    })

    return {
      byCurrency,
      /**
       * Deliberately no cross-currency total.
       *
       * Adding INR paise to SGD cents produces a number that means nothing, and a
       * "combined loss ratio" would be the most confidently wrong figure on the
       * dashboard. The same reasoning governs M4's trial balance, which is also
       * per-currency.
       */
      note: 'Figures are derived from ledger entries, not from application tables, so they reconcile against the M4 trial balance. There is no combined total — adding paise to cents would be meaningless.',
    }
  }

  /**
   * Portfolio counts and the conversion funnel.
   *
   * The funnel is where an underwriting problem shows up first: a high decline rate
   * means the band floor is set wrong for the population, and a high
   * priced-but-not-bought rate means the price is wrong. Both are visible here before
   * they show up as a loss ratio months later.
   */
  async stats() {
    const [
      productCount,
      policiesByStatus,
      quotesByStatus,
      claimsByStatus,
      pendingPayouts,
      unboundPolicies,
      suspectDocs,
    ] = await Promise.all([
      this.prisma.insuranceProduct.count({ where: { isActive: true } }),
      this.prisma.policy.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.insuranceQuote.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.claim.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.claim.count({
        where: { status: ClaimStatus.APPROVED, payoutTxnId: null },
      }),
      this.prisma.policy.count({
        where: {
          status: { in: [PolicyStatus.ACTIVE, PolicyStatus.GRACE] },
          insurerPolicyRef: null,
        },
      }),
      this.prisma.claimDocument.count({
        where: { verificationStatus: 'SUSPECT' },
      }),
    ])

    const quoted = this.countFor(quotesByStatus, InsuranceQuoteStatus.PRICED)
    const converted = this.countFor(
      quotesByStatus,
      InsuranceQuoteStatus.CONVERTED,
    )
    const declined = this.countFor(
      quotesByStatus,
      InsuranceQuoteStatus.DECLINED,
    )
    const totalQuotes = quotesByStatus.reduce(
      (total, row) => total + row._count._all,
      0,
    )

    return {
      products: { active: productCount },
      policies: this.tally(policiesByStatus),
      quotes: this.tally(quotesByStatus),
      claims: this.tally(claimsByStatus),

      funnel: {
        totalQuotes,
        priced: quoted,
        converted,
        declined,
        /**
         * Percentages as integers with two decimals, computed from counts.
         *
         * A decline rate is the fairness canary: if it rises sharply, the band floor is
         * excluding a population rather than pricing it, and that is exactly the outcome
         * M2's fairness audit exists to catch.
         */
        declineRatePercent:
          totalQuotes > 0
            ? Number(((declined / totalQuotes) * 100).toFixed(2))
            : null,
        conversionRatePercent:
          quoted + converted > 0
            ? Number(((converted / (quoted + converted)) * 100).toFixed(2))
            : null,
      },

      /**
       * The operational alarms.
       *
       * Counts an operator should act on rather than admire. `pendingPayouts` is the
       * important one: every row is a person who has been told their claim is approved
       * and has not been paid.
       */
      attention: {
        pendingPayouts,
        policiesAwaitingInsurerBinding: unboundPolicies,
        suspectDocuments: suspectDocs,
        claimsAwaitingReview: this.countFor(
          claimsByStatus,
          ClaimStatus.UNDER_REVIEW,
        ),
      },

      /**
       * What is actually running.
       *
       * Surfaced so nobody has to infer from behaviour whether a policy was bound at a
       * licensed insurer or a demonstration one.
       */
      providers: this.registry.describe(),
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private tally(
    rows: Array<{ status: string; _count: { _all: number } }>,
  ): Record<string, number> {
    return Object.fromEntries(rows.map((row) => [row.status, row._count._all]))
  }

  private countFor(
    rows: Array<{ status: string; _count: { _all: number } }>,
    status: string,
  ): number {
    return rows.find((row) => row.status === status)?._count._all ?? 0
  }
}
