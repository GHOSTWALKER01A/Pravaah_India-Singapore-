import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  INSURANCE_MOCK_INSURER_NOTICE,
  INSURANCE_NON_ADVICE_DISCLAIMER,
  PRODUCT_COPY,
  RISK_TIER_COPY,
} from '@pravaah/schema'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { QUOTE_TTL_MS } from '@/modules/insurance/insurance.config'
import {
  computePremium,
  savingsBps,
  tierCoverCeilingMinor,
} from '@/modules/insurance/insurance-pricing.util'
import { addDays, isQuoteBuyable } from '@/modules/insurance/insurance.state'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import { UnderwritingService } from '@/modules/insurance/services/underwriting.service'
import { moneyView } from '@/modules/payments/money.util'

import {
  ActorType,
  InsuranceQuoteStatus,
  KycStatus,
  RiskTier,
  type InsuranceProduct,
  type InsuranceQuote,
} from 'generated/prisma/client'

/**
 * Turning an underwriting decision into a priced, buyable offer.
 *
 * The quote row is the artefact that makes this product defensible. It freezes the
 * decision, the evidence, the pricing-model version and the exact premium a person
 * was shown — so when they ask "why am I paying this?", or an ombudsman asks on
 * their behalf a year later, there is a row to point at rather than a re-derivation
 * from code that has since changed.
 *
 * Every quote is created, including a DECLINE. A decline recorded as a row is a
 * decision that can be reviewed, appealed and counted; a decline returned as a 403
 * is an outcome nobody can audit and the applicant cannot act on.
 */
@Injectable()
export class QuotingService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly underwriting: UnderwritingService,
    private readonly registry: InsuranceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: QuotingService.name })
  }

  // ── the marketplace ───────────────────────────────────────────────────────
  /**
   * The products on offer.
   *
   * No prices. Pricing is personal here — it depends on the applicant's own score —
   * so a marketplace showing "from ₹X/month" would advertise a figure most viewers
   * will not be offered. The card shows who the cover is for and the coverage band;
   * the price arrives at the quote.
   */
  async products(filter: { type?: string; currency?: string } = {}) {
    const rows = await this.prisma.insuranceProduct.findMany({
      where: {
        isActive: true,
        ...(filter.type ? { type: filter.type as never } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
      },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((product) => this.describeProduct(product))
  }

  describeProduct(product: InsuranceProduct) {
    const copy = PRODUCT_COPY[product.type]
    return {
      id: product.id,
      type: product.type,
      name: product.name,
      label: copy?.label ?? product.name,
      tagline: product.tagline ?? copy?.who ?? null,
      currency: product.currency,
      coverage: {
        minMinor: product.minCoverMinor.toString(),
        maxMinor: product.maxCoverMinor.toString(),
        min: moneyView(product.minCoverMinor, product.currency),
        max: moneyView(product.maxCoverMinor, product.currency),
      },
      termDays: product.termDays,
      waitingPeriodDays: product.waitingPeriodDays,
      freeLookDays: product.freeLookDays,
      exclusions: this.readExclusions(product.exclusions),
      disclaimer: product.disclaimer,
      /**
       * The two notices travel with every priced surface.
       *
       * Attached at the API rather than left to each client, so a screen that forgot
       * them is a visible omission in one place instead of a missing paragraph in
       * three apps.
       */
      nonAdviceDisclaimer: INSURANCE_NON_ADVICE_DISCLAIMER,
      insurerNotice: INSURANCE_MOCK_INSURER_NOTICE,
    }
  }

  // ── quoting ───────────────────────────────────────────────────────────────
  /**
   * Price a specific person against a specific product.
   *
   * The order of the guards is the design: identity first, then the product, then
   * the coverage band, then underwriting. Everything that can refuse cheaply refuses
   * before a score is read, so the common rejection is a clean 4xx rather than a
   * quote row nobody wanted.
   */
  async quote(
    userId: string,
    input: { productId: string; coverageMinor: bigint },
  ): Promise<InsuranceQuote & { product: InsuranceProduct }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kycStatus: true, isSuspended: true },
    })
    if (!user) throw new NotFoundException('User not found')

    /**
     * Identity, first.
     *
     * An insurance contract is a legal agreement with a verified person, and a claim
     * paid to an unverified identity is an unauthenticated withdrawal wearing a
     * claim form. This is the same gate M4 applies before moving money, for a
     * reason that is if anything stronger here: the payout leg exists precisely to
     * send money to whoever holds the policy.
     */
    if (user.isSuspended) {
      throw new ForbiddenException(
        'Your account is on hold. Please contact support.',
      )
    }
    if (user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException(
        'Complete your identity verification before buying cover',
      )
    }

    const product = await this.prisma.insuranceProduct.findUnique({
      where: { id: input.productId },
    })
    if (!product || !product.isActive) {
      throw new NotFoundException('That cover is not available')
    }

    if (
      input.coverageMinor < product.minCoverMinor ||
      input.coverageMinor > product.maxCoverMinor
    ) {
      throw new BadRequestException(
        `Choose cover between ${moneyView(product.minCoverMinor, product.currency).formatted} and ${moneyView(product.maxCoverMinor, product.currency).formatted}`,
      )
    }

    const decision = await this.underwriting.assess(userId, product)

    if (decision.tier === RiskTier.DECLINE) {
      return this.recordDecline(userId, product, input.coverageMinor, decision)
    }

    /**
     * The tier's coverage ceiling.
     *
     * Refused rather than silently clamped. Clamping would sell somebody less cover
     * than they asked for at a price they did not question — and they would discover
     * the shortfall at claim time. The error names the ceiling so the client can
     * re-quote at an amount that will actually bind.
     */
    const ceiling = tierCoverCeilingMinor(decision.tier, product.maxCoverMinor)
    if (input.coverageMinor > ceiling) {
      throw new BadRequestException(
        `At your current risk band the most cover available on this product is ${moneyView(ceiling, product.currency).formatted}. Improving your Pravaah score raises this.`,
      )
    }

    const priced = computePremium({
      coverageMinor: input.coverageMinor,
      baseRateBps: product.baseRateBps,
      multiplierBps: decision.multiplierBps,
      termDays: product.termDays,
    })

    /**
     * The STANDARD comparison, quoted through the SAME function.
     *
     * Not `premium / multiplier × 10000`. Dividing back would round a second time
     * and could show a saving of a paisa in the wrong direction on a small premium —
     * on the one screen whose entire purpose is the claim "your reputation made this
     * cheaper".
     */
    const standard = computePremium({
      coverageMinor: input.coverageMinor,
      baseRateBps: product.baseRateBps,
      multiplierBps: this.underwriting.standardDecision(product).multiplierBps,
      termDays: product.termDays,
    })

    const quote = await this.prisma.insuranceQuote.create({
      data: {
        userId,
        productId: product.id,
        type: product.type,
        coverageMinor: input.coverageMinor,
        currency: product.currency,
        premiumMinor: priced.premiumMinor,
        standardPremiumMinor: standard.premiumMinor,
        frequency: priced.frequency,
        riskTier: decision.tier,
        riskMultiplierBps: decision.multiplierBps,
        scoreId: decision.scoreId,
        scoreBand: decision.scoreBand,
        confidence: decision.confidence,
        /**
         * The pricing inputs, field-encrypted.
         *
         * Kept so a disputed premium can be reproduced exactly, encrypted because
         * they are derived from someone's financial behaviour. Never read to make a
         * decision — only to explain one already made.
         */
        riskInputsEnc: encryptField(
          JSON.stringify({
            band: decision.scoreBand,
            scoreValue: decision.scoreValue,
            confidence: decision.confidence,
            breakdown: decision.breakdown,
            baseRateBps: product.baseRateBps,
            effectiveAnnualBps: priced.effectiveAnnualBps,
            annualPremiumMinor: priced.annualPremiumMinor.toString(),
          }),
        ),
        pricingModelVersion: decision.pricingModelVersion,
        waitingPeriodDays: decision.waitingPeriodDays,
        status: InsuranceQuoteStatus.PRICED,
        validUntil: new Date(Date.now() + QUOTE_TTL_MS),
      },
      include: { product: true },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'insurance.quote.priced',
      entity: 'InsuranceQuote',
      entityId: quote.id,
      metadata: {
        productType: product.type,
        tier: decision.tier,
        multiplierBps: decision.multiplierBps,
        premiumMinor: priced.premiumMinor.toString(),
        scoreId: decision.scoreId,
        pricingModelVersion: decision.pricingModelVersion,
      },
    })

    this.logger.info(`[${this.quote.name}] Quote priced`, {
      userId,
      quoteId: quote.id,
      tier: decision.tier,
      productType: product.type,
    })
    return quote
  }

  /**
   * Record a decline as a quote.
   *
   * A row, with the reason and the M2 provenance, because a decline is a DECISION
   * about somebody derived from their own data. It has to be reviewable by an admin,
   * countable in a fairness audit, and explainable back to the applicant with a
   * route to eligibility — and none of that is possible if the answer was a 403.
   */
  private async recordDecline(
    userId: string,
    product: InsuranceProduct,
    coverageMinor: bigint,
    decision: Awaited<ReturnType<UnderwritingService['assess']>>,
  ): Promise<InsuranceQuote & { product: InsuranceProduct }> {
    const quote = await this.prisma.insuranceQuote.create({
      data: {
        userId,
        productId: product.id,
        type: product.type,
        coverageMinor,
        currency: product.currency,
        // Zero, and the status says DECLINED so no screen can read it as free cover.
        premiumMinor: 0n,
        standardPremiumMinor: 0n,
        frequency: 'MONTHLY',
        riskTier: RiskTier.DECLINE,
        riskMultiplierBps: 0,
        scoreId: decision.scoreId,
        scoreBand: decision.scoreBand,
        confidence: decision.confidence,
        pricingModelVersion: decision.pricingModelVersion,
        waitingPeriodDays: decision.waitingPeriodDays,
        status: InsuranceQuoteStatus.DECLINED,
        declineReason: decision.declineReason,
        validUntil: new Date(Date.now() + QUOTE_TTL_MS),
      },
      include: { product: true },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'insurance.quote.declined',
      entity: 'InsuranceQuote',
      entityId: quote.id,
      metadata: {
        productType: product.type,
        scoreBand: decision.scoreBand,
        scoreId: decision.scoreId,
        reason: decision.declineReason,
      },
    })

    this.logger.info(`[${this.recordDecline.name}] Cover declined`, {
      userId,
      quoteId: quote.id,
      band: decision.scoreBand,
    })
    return quote
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  async get(
    userId: string,
    quoteId: string,
  ): Promise<InsuranceQuote & { product: InsuranceProduct }> {
    const quote = await this.prisma.insuranceQuote.findFirst({
      where: { id: quoteId, userId },
      include: { product: true },
    })
    // 404, not 403: somebody else's quote id must not be confirmed to exist.
    if (!quote) throw new NotFoundException('Quote not found')
    return quote
  }

  /**
   * The wire shape of a quote — the "reputation moment" screen, assembled here.
   *
   * Built server-side rather than left to each client, because the comparison and
   * the explanation are the product's argument and they must be identical in the RN
   * app, the admin console and an audit export. A client reassembling the sentence
   * from a multiplier would eventually word it differently, and one of those wordings
   * would be a claim we cannot stand behind.
   */
  describeQuote(
    quote: InsuranceQuote & { product: InsuranceProduct },
    explanation: string[] = [],
  ) {
    const buyable = isQuoteBuyable(quote.status, quote.validUntil)
    const saving = savingsBps(quote.premiumMinor, quote.standardPremiumMinor)
    const tierCopy = RISK_TIER_COPY[quote.riskTier]

    return {
      id: quote.id,
      status: quote.status,
      isBuyable: buyable,
      validUntil: quote.validUntil,

      product: this.describeProduct(quote.product),
      coverage: moneyView(quote.coverageMinor, quote.currency),

      premium: moneyView(quote.premiumMinor, quote.currency),
      frequency: quote.frequency,
      /**
       * What a standard-risk applicant would pay, and the gap.
       *
       * Only meaningful when there IS a discount, so a negative saving is passed
       * through rather than hidden: a SUBSTANDARD applicant paying more than standard
       * should see that honestly, not a blank space where a discount would be.
       */
      standardPremium: moneyView(quote.standardPremiumMinor, quote.currency),
      savingBps: saving,
      savingPercent: Number((saving / 100).toFixed(2)),

      riskTier: quote.riskTier,
      riskTierLabel: tierCopy?.label ?? quote.riskTier,
      riskTierExplanation: tierCopy?.explanation ?? null,
      scoreBand: quote.scoreBand,
      confidence: quote.confidence,
      pricingModelVersion: quote.pricingModelVersion,

      waitingPeriodDays: quote.waitingPeriodDays,
      /**
       * When cover would actually begin, if bought now.
       *
       * A date rather than a day count, because "30 days" is abstract and the
       * question a claimant asks later is "was I covered on the 14th?". Computed from
       * now because the policy has not started yet — the authoritative value lands on
       * the policy at activation.
       */
      coverWouldStartFrom: buyable
        ? addDays(new Date(), quote.waitingPeriodDays)
        : null,

      declineReason: quote.declineReason,
      explanation,
      exclusions: this.readExclusions(quote.product.exclusions),
      nonAdviceDisclaimer: INSURANCE_NON_ADVICE_DISCLAIMER,
      insurerNotice: INSURANCE_MOCK_INSURER_NOTICE,
      insurer: this.registry.describe().insurer,
    }
  }

  /**
   * Exclusions out of the product's JSON column.
   *
   * Defensive because the column is `Json`: an admin form, a seed script or a
   * migration could put something other than a string array there, and a marketplace
   * that crashed on it would take down the whole insurance surface. Non-strings are
   * dropped rather than rendered as `[object Object]` on a screen whose job is to
   * tell somebody what is NOT covered.
   */
  private readExclusions(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  }
}
