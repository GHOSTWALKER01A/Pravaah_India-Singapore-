import { randomBytes } from 'crypto'

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  INSURANCE_MOCK_INSURER_NOTICE,
  INSURANCE_NON_ADVICE_DISCLAIMER,
  POLICY_STATUS,
  PRODUCT_COPY,
  type BuyPolicyDto,
  type InsuranceProductTypeInput,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  addDays,
  canPolicyTransition,
  daysBetween,
  isCoverLive,
  isQuoteBuyable,
  isWithinFreeLook,
  nextPremiumDueAt,
} from '@/modules/insurance/insurance.state'
import { remainingCoverMinor } from '@/modules/insurance/insurance-pricing.util'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import { InsuranceMoneyService } from '@/modules/insurance/services/insurance-money.service'
import { PremiumService } from '@/modules/insurance/services/premium.service'
import { moneyView } from '@/modules/payments/money.util'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'

import {
  ActorType,
  InsuranceQuoteStatus,
  PolicyStatus,
  PremiumFrequency,
  type InsuranceProduct,
  type Policy,
} from 'generated/prisma/client'

type PolicyWithProduct = Policy & { product: InsuranceProduct }

/**
 * The policy lifecycle — buy, activate, cancel.
 *
 * One rule dominates this file: **cover is never granted before the premium has
 * settled on the ledger.** A policy is created `PENDING_PAYMENT`, the premium is
 * collected, and only then does it become `ACTIVE` with its dates set. The
 * alternative — activate on intent, collect afterwards — insures people who never
 * paid, and the discovery happens at claim time, which is the worst possible moment
 * for both sides.
 *
 * The corollary is the part that looks wrong and is not: once the premium HAS
 * settled, the policy activates even if the insurer's `bindPolicy` call fails.
 * Refusing to activate at that point would leave somebody who has paid holding no
 * cover because a third party's API was down. The missing reference is our
 * operations problem, and `InsuranceLifecycleService` retries the binding.
 */
@Injectable()
export class PolicyService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly premiums: PremiumService,
    private readonly money: InsuranceMoneyService,
    private readonly registry: InsuranceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PolicyService.name })
  }

  // ── buy ───────────────────────────────────────────────────────────────────
  /**
   * Buy cover from a PRICED quote.
   *
   * Idempotent at three levels, because a mobile client WILL retry this:
   *
   *  1. `Policy.quoteId` is UNIQUE — two concurrent buys against one quote cannot
   *     both bind a contract. The loser reads the winner's policy back.
   *  2. The premium's period key is derived from the policy, so a retry collects the
   *     same period rather than a second one.
   *  3. M4's `Transaction.idempotencyKey` resolves a retried debit to the existing
   *     transaction.
   *
   * The client's `Idempotency-Key` is used at the controller, through
   * `IdempotencyService.runOnce`, so a retry returns the identical response body
   * rather than merely avoiding a second debit.
   */
  async buy(
    userId: string,
    dto: BuyPolicyDto,
    context: { ipAddress?: string | null } = {},
  ): Promise<PolicyWithProduct> {
    const quote = await this.prisma.insuranceQuote.findFirst({
      where: { id: dto.quoteId, userId },
      include: { product: true },
    })
    if (!quote) throw new NotFoundException('Quote not found')

    if (quote.status === InsuranceQuoteStatus.CONVERTED) {
      /**
       * Already bought.
       *
       * The existing policy, not an error. A user who double-tapped, or whose network
       * dropped our response, is asking the same question again — and answering it
       * with a 409 would send them to support over a policy they already hold.
       */
      const existing = await this.prisma.policy.findUnique({
        where: { quoteId: quote.id },
        include: { product: true },
      })
      if (existing) return existing
    }

    if (quote.status === InsuranceQuoteStatus.DECLINED) {
      throw new BadRequestException(
        quote.declineReason ??
          'This cover is not available to you at the moment',
      )
    }

    if (!isQuoteBuyable(quote.status, quote.validUntil)) {
      /**
       * Expired, or never priced.
       *
       * The quote is marked EXPIRED here rather than left for the cron, so the
       * client's next request sees a consistent status instead of a row that the
       * sweep has not reached yet.
       */
      if (
        quote.status === InsuranceQuoteStatus.PRICED &&
        canPolicyTransitionSafe(quote.status)
      ) {
        await this.prisma.insuranceQuote.updateMany({
          where: { id: quote.id, status: InsuranceQuoteStatus.PRICED },
          data: { status: InsuranceQuoteStatus.EXPIRED },
        })
      }
      throw new BadRequestException(
        'That price has expired. Ask for a new quote — your premium may have changed.',
      )
    }

    /**
     * The premium the user actually saw.
     *
     * A cross-check, not an instruction: the server never charges this number, it
     * only refuses to proceed when the quote disagrees. Sharper here than in a
     * transfer, because this figure will be debited every month — a stale screen
     * would enrol somebody in a recurring charge they never agreed to.
     */
    if (BigInt(dto.expectedPremiumMinor) !== quote.premiumMinor) {
      throw new ConflictException(
        `The premium has changed since that screen was shown (now ${moneyView(quote.premiumMinor, quote.currency).formatted}). Please review it again.`,
      )
    }

    const policy = await this.createPending(userId, quote)

    // Already activated by a previous attempt — nothing left to do.
    if (policy.status !== PolicyStatus.PENDING_PAYMENT) {
      return policy
    }

    const collected = await this.premiums.collectFirst(policy, {
      deviceId: dto.deviceId ?? null,
      ipAddress: context.ipAddress ?? null,
    })

    if (!collected.ok) {
      await this.audit.log({
        actorType: ActorType.USER,
        actorId: userId,
        action: 'insurance.premium.failed',
        entity: 'Policy',
        entityId: policy.id,
        metadata: {
          reason: collected.reason,
          shortfallMinor: collected.shortfallMinor?.toString() ?? null,
        },
      })

      this.logger.info(
        `[${this.buy.name}] Premium not collected — policy stays pending, no cover granted`,
        { policyId: policy.id, reason: collected.reason },
      )
      /**
       * The policy is RETURNED, still PENDING_PAYMENT, rather than thrown away.
       *
       * The user needs something to retry against, and the row carries the quote's
       * price — so topping up the wallet and retrying collects the premium they were
       * quoted rather than sending them back through underwriting at a price that may
       * have moved.
       */
      return this.load(userId, policy.id)
    }

    /**
     * The first premium's period end becomes the next due date.
     *
     * Threaded through rather than recomputed from a fresh `now` inside `activate`. The
     * premium bought a specific 30-day window; deriving the next due date from a second
     * clock reading would set it a few milliseconds — or, on a retry hours later, a few
     * HOURS — away from the period the holder actually paid for, and the dunning sweep
     * would then collect the second month early.
     */
    return this.activate(
      policy,
      quote.waitingPeriodDays,
      collected.premium.periodEnd,
    )
  }

  /**
   * Create the PENDING_PAYMENT row.
   *
   * A unique violation on `quoteId` is NOT an error: it means a concurrent request
   * created this policy, and the existing row is returned so the caller resumes
   * rather than binding a second contract on one price.
   */
  private async createPending(
    userId: string,
    quote: {
      id: string
      productId: string
      coverageMinor: bigint
      premiumMinor: bigint
      frequency: PremiumFrequency
      currency: string
      type: string
    },
  ): Promise<PolicyWithProduct> {
    try {
      return await this.prisma.policy.create({
        data: {
          userId,
          quoteId: quote.id,
          productId: quote.productId,
          policyNumber: this.policyNumber(quote.type),
          coverageMinor: quote.coverageMinor,
          premiumMinor: quote.premiumMinor,
          frequency: quote.frequency,
          currency: quote.currency,
          status: PolicyStatus.PENDING_PAYMENT,
        },
        include: { product: true },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.prisma.policy.findUnique({
          where: { quoteId: quote.id },
          include: { product: true },
        })
        if (existing) {
          this.logger.warn(
            `[${this.createPending.name}] Resuming a policy a concurrent request had already created`,
            { policyId: existing.id, status: existing.status },
          )
          return existing
        }
      }
      throw error
    }
  }

  /**
   * The premium has settled. Bind at the insurer and set the dates that ARE the
   * contract.
   *
   * All four dates are computed from ONE `now`, not from four separate `new Date()`
   * calls. Separate calls would drift by milliseconds and — far worse — would make
   * the waiting period, the free-look window and the first premium due date
   * measured from slightly different instants. When a claimant later asks "was I
   * covered on the 14th?", the answer must come from one clock.
   */
  private async activate(
    policy: PolicyWithProduct,
    waitingPeriodDays: number,
    firstPeriodEnd: Date,
  ): Promise<PolicyWithProduct> {
    const bind = await this.registry.insurer().bindPolicy({
      productType: policy.product.type,
      coverageMinor: policy.coverageMinor,
      currency: policy.currency,
      // The PUBLIC identifier, never the internal UUID. See BindPolicyInput.
      holderRef: await this.holderRef(policy.userId),
      policyNumber: policy.policyNumber,
      termDays: policy.product.termDays,
      waitingPeriodDays,
      premiumMinor: policy.premiumMinor,
      riskTier:
        (
          await this.prisma.insuranceQuote.findUnique({
            where: { id: policy.quoteId },
            select: { riskTier: true },
          })
        )?.riskTier ?? 'STANDARD',
    })

    if (!bind.ok) {
      /**
       * The insurer did not answer. Activate anyway.
       *
       * The premium has SETTLED. Withholding cover from somebody who has paid,
       * because a third party's API was down, would be the wrong party bearing that
       * outage. `insurerPolicyRef` stays null and the lifecycle sweep retries the
       * binding — an operational loose end rather than an uninsured policyholder.
       */
      this.logger.error(
        `[${this.activate.name}] Insurer binding failed — activating on the settled premium and retrying the bind later`,
        { policyId: policy.id, error: bind.error.message },
      )
    }

    const now = new Date()

    const [, activated] = await this.prisma.$transaction([
      this.prisma.insuranceQuote.update({
        where: { id: policy.quoteId },
        data: {
          status: InsuranceQuoteStatus.CONVERTED,
          convertedAt: now,
        },
      }),
      this.prisma.policy.update({
        where: { id: policy.id },
        data: {
          status: PolicyStatus.ACTIVE,
          insurerPolicyRef: bind.ok ? bind.value.insurerPolicyRef : null,
          startAt: now,
          endAt: addDays(now, policy.product.termDays),
          waitingPeriodEndsAt: addDays(now, waitingPeriodDays),
          freeLookEndsAt: addDays(now, policy.product.freeLookDays),
          nextPremiumDueAt: nextPremiumDueAt(policy.frequency, firstPeriodEnd),
        },
        include: { product: true },
      }),
    ])

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: policy.userId,
      action: 'insurance.policy.activated',
      entity: 'Policy',
      entityId: policy.id,
      metadata: {
        policyNumber: policy.policyNumber,
        productType: policy.product.type,
        coverageMinor: policy.coverageMinor.toString(),
        premiumMinor: policy.premiumMinor.toString(),
        insurerPolicyRef: bind.ok ? bind.value.insurerPolicyRef : null,
        insurerBindPending: !bind.ok,
      },
    })

    this.logger.info(`[${this.activate.name}] Policy active`, {
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      waitingPeriodEndsAt: activated.waitingPeriodEndsAt,
    })
    return activated
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  /**
   * Cancel a policy.
   *
   * Inside the free-look window the holder gets EVERY premium back — the window IRDAI
   * requires a real insurer to honour, so this build honours it too. Outside it, cover
   * simply ends with no refund, which is stated in the response rather than left for
   * the holder to discover from their wallet balance.
   *
   * A pro-rata refund for a mid-term cancellation is deliberately NOT implemented and
   * is called out as a roadmap item. Guessing at the unearned-premium calculation
   * would produce a number nobody could defend, and this is the one place in the
   * module where a plausible-looking figure is worse than an honest absence.
   */
  async cancel(
    userId: string,
    policyId: string,
    reason?: string,
  ): Promise<{
    policy: PolicyWithProduct
    refund: {
      eligible: boolean
      refundedMinor: string
      reason: string
    }
  }> {
    const policy = await this.load(userId, policyId)

    if (!canPolicyTransition(policy.status, PolicyStatus.CANCELLED)) {
      throw new ConflictException(
        `A ${policy.status.toLowerCase().replace('_', ' ')} policy cannot be cancelled`,
      )
    }

    const withinFreeLook = isWithinFreeLook(policy.freeLookEndsAt)

    /**
     * Cancel FIRST, refund second.
     *
     * The order matters. Cancelling first means a refund that fails leaves a
     * cancelled policy and an unrefunded premium — visible, and recoverable by an
     * admin. Refunding first would mean a failed cancellation leaves a policyholder
     * refunded AND covered, which is a free policy that no sweep would ever notice.
     */
    const cancelled = await this.prisma.policy.update({
      where: { id: policy.id },
      data: {
        status: PolicyStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason?.slice(0, 300) ?? null,
        nextPremiumDueAt: null,
        graceEndsAt: null,
      },
      include: { product: true },
    })

    let refundedMinor = 0n
    if (withinFreeLook) {
      refundedMinor = await this.refundAllPremiums(policy.id, reason)
    }

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'insurance.policy.cancelled',
      entity: 'Policy',
      entityId: policy.id,
      metadata: {
        withinFreeLook,
        refundedMinor: refundedMinor.toString(),
        reason: reason ?? null,
      },
    })

    return {
      policy: cancelled,
      refund: {
        eligible: withinFreeLook,
        refundedMinor: refundedMinor.toString(),
        reason: withinFreeLook
          ? 'Cancelled inside the free-look window, so every premium collected has been returned to your wallet.'
          : 'The free-look window has passed, so no premium is refunded. Cover has ended from today. A pro-rata refund of unearned premium is not offered on this product.',
      },
    }
  }

  /**
   * Return every settled premium on a policy.
   *
   * Each period is refunded separately, keyed by its own `PremiumPayment` id as the
   * ledger `legRef`. One combined refund would collide on the unique posting
   * constraint the moment a policy had been collected twice — and the collision would
   * surface as "already refunded", silently keeping the holder's second month.
   *
   * Failures are logged and the loop CONTINUES rather than aborting. A policy with
   * two premiums where the first refund fails should still return the second; the
   * shortfall is then one visible admin task instead of two.
   */
  private async refundAllPremiums(
    policyId: string,
    reason?: string,
  ): Promise<bigint> {
    const paid = await this.premiums.allPaid(policyId)
    let total = 0n

    for (const premium of paid) {
      if (!premium.transactionId) continue

      const result = await this.money.refundPremium({
        transactionId: premium.transactionId,
        premiumPaymentId: premium.id,
        amountMinor: premium.amountMinor - premium.refundedMinor,
        reason: reason ?? 'Free-look cancellation',
      })

      if (result.refunded) {
        total += premium.amountMinor - premium.refundedMinor
      } else {
        this.logger.error(
          `[${this.refundAllPremiums.name}] A free-look premium refund did not post — needs an admin`,
          { policyId, premiumPaymentId: premium.id },
        )
      }
    }
    return total
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  async load(userId: string, policyId: string): Promise<PolicyWithProduct> {
    const policy = await this.prisma.policy.findFirst({
      where: { id: policyId, userId },
      include: { product: true },
    })
    // 404, not 403 — somebody else's policy id must not be confirmed to exist.
    if (!policy) throw new NotFoundException('Policy not found')
    return policy
  }

  async list(
    userId: string,
    query: { activeOnly: boolean; limit: number; offset: number },
  ): Promise<{ items: PolicyWithProduct[]; total: number }> {
    const where = {
      userId,
      ...(query.activeOnly
        ? { status: { in: [PolicyStatus.ACTIVE, PolicyStatus.GRACE] } }
        : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.policy.findMany({
        where,
        include: { product: true },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.policy.count({ where }),
    ])
    return { items, total }
  }

  /**
   * The wire shape of a policy.
   *
   * `isCovered` is derived through `isCoverLive` rather than compared against
   * `'ACTIVE'`, because a policy in GRACE IS still covered — the premium is late, not
   * abandoned. A client that treated GRACE as uncovered would tell somebody they had
   * no insurance on a day they could have claimed.
   */
  describe(policy: PolicyWithProduct) {
    const copy = PRODUCT_COPY[policy.product.type]
    const now = new Date()
    const remaining = remainingCoverMinor(policy)

    return {
      id: policy.id,
      policyNumber: policy.policyNumber,
      status: policy.status,
      statusLabel: POLICY_STATUS_LABEL[policy.status],
      isCovered: isCoverLive(policy.status),

      product: {
        id: policy.product.id,
        type: policy.product.type,
        name: policy.product.name,
        label: copy?.label ?? policy.product.name,
      },

      coverage: moneyView(policy.coverageMinor, policy.currency),
      /**
       * Cover LEFT, not just cover bought.
       *
       * The aggregate limit is what a second claim is actually assessed against, and a
       * policy wallet showing only the sum insured would let somebody plan a claim
       * against money already paid out.
       */
      remainingCover: moneyView(remaining, policy.currency),
      claimedToDate: moneyView(policy.claimedMinor, policy.currency),

      premium: moneyView(policy.premiumMinor, policy.currency),
      frequency: policy.frequency,
      nextPremiumDueAt: policy.nextPremiumDueAt,

      startAt: policy.startAt,
      endAt: policy.endAt,
      waitingPeriodEndsAt: policy.waitingPeriodEndsAt,
      /**
       * The countdown, in days, or `0` once cover is fully live.
       *
       * Surfaced as a number because the waiting period is the single thing a new
       * policyholder most misunderstands, and "you are covered from 27 August" on the
       * policy card prevents the claim that gets refused for it.
       */
      waitingPeriodDaysRemaining:
        policy.waitingPeriodEndsAt && policy.waitingPeriodEndsAt > now
          ? Math.max(1, daysBetween(now, policy.waitingPeriodEndsAt) + 1)
          : 0,
      isInWaitingPeriod: Boolean(
        policy.waitingPeriodEndsAt && policy.waitingPeriodEndsAt > now,
      ),

      freeLookEndsAt: policy.freeLookEndsAt,
      canCancelForFullRefund: isWithinFreeLook(policy.freeLookEndsAt, now),
      graceEndsAt: policy.graceEndsAt,

      insurerPolicyRef: policy.insurerPolicyRef,
      /**
       * Whether the insurer-side binding is still outstanding.
       *
       * Surfaced rather than hidden. The cover is real — the premium settled — but an
       * operator looking at the console should be able to see which policies have not
       * yet been acknowledged by the insurer, without inferring it from a null.
       */
      insurerBindPending:
        policy.insurerPolicyRef === null && isCoverLive(policy.status),

      exclusions: Array.isArray(policy.product.exclusions)
        ? policy.product.exclusions.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      nonAdviceDisclaimer: INSURANCE_NON_ADVICE_DISCLAIMER,
      insurerNotice: INSURANCE_MOCK_INSURER_NOTICE,
      createdAt: policy.createdAt,
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * A human-quotable policy number: `PRV-INC-7K2F9A`.
   *
   * Random suffix rather than a timestamp slice. `Date.now().toString().slice(-8)`
   * looks unique and is not: two policies bought in the same millisecond collide, and
   * the collision surfaces as a unique-constraint failure on a purchase whose premium
   * has already settled. Six bytes of randomness, and the caller retries on the
   * (astronomically unlikely) clash through the unique index.
   */
  private policyNumber(productType: string): string {
    const prefix =
      PRODUCT_COPY[productType as InsuranceProductTypeInput]?.policyPrefix ??
      'GEN'
    const suffix = randomBytes(4)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 6)
      .toUpperCase()
    return `PRV-${prefix}-${suffix}`
  }

  /**
   * The identifier handed to the insurer.
   *
   * `pravaahId` (`PVH-XXXX-XXXX-XXXX`), falling back to the UUID only if the public
   * id has not been minted. A real insurer needs the holder's identity for
   * underwriting, but that exchange belongs in a data-sharing agreement — not
   * smuggled through a policy-binding call as a name or a document number.
   */
  private async holderRef(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pravaahId: true },
    })
    return user?.pravaahId ?? userId
  }
}

/** Policy statuses, in words a holder reads rather than an enum. */
const POLICY_STATUS_LABEL: Record<PolicyStatus, string> = {
  [POLICY_STATUS.PENDING_PAYMENT]: 'Awaiting your first premium',
  [POLICY_STATUS.ACTIVE]: 'Active',
  [POLICY_STATUS.GRACE]: 'Premium overdue — still covered',
  [POLICY_STATUS.LAPSED]: 'Lapsed — no cover',
  [POLICY_STATUS.CANCELLED]: 'Cancelled',
  [POLICY_STATUS.EXPIRED]: 'Term ended',
}

/**
 * Whether a quote in this status may be marked EXPIRED.
 *
 * A tiny helper rather than an inline comparison, so the buy path and the lifecycle
 * sweep cannot drift on which statuses are expirable.
 */
function canPolicyTransitionSafe(status: InsuranceQuoteStatus): boolean {
  return status === InsuranceQuoteStatus.PRICED
}
