import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  BuyPolicySchema,
  CancelPolicySchema,
  InsuranceQuoteRequestSchema,
  PolicyListQuerySchema,
  ProductListQuerySchema,
  type BuyPolicyDto,
  type CancelPolicyDto,
  type InsuranceQuoteRequestDto,
  type PolicyListQueryDto,
  type ProductListQueryDto,
} from '@pravaah/schema'

import {
  ClientIp,
  IdempotencyKey,
} from '@/common/decorators/idempotency-key.decorator'
import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { INSURANCE_ROUTES } from '@/modules/insurance/insurance.route'
import { PolicyService } from '@/modules/insurance/services/policy.service'
import { PremiumService } from '@/modules/insurance/services/premium.service'
import { QuotingService } from '@/modules/insurance/services/quoting.service'
import { UnderwritingService } from '@/modules/insurance/services/underwriting.service'
import { moneyView } from '@/modules/payments/money.util'
import {
  IDEMPOTENCY_SCOPE,
  IdempotencyService,
} from '@/modules/payments/services/idempotency.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { NotFoundException } from '@nestjs/common'

/**
 * Buying cover.
 *
 * Three properties of this controller are worth stating, because each is a place an
 * insurance API commonly goes wrong:
 *
 *  - **A quote is not a contract, and buying requires an `Idempotency-Key`.** A retried
 *    purchase returns the SAME policy, never a second one with a second monthly premium.
 *    Mobile clients retry — networks drop the response, not the request — so this is the
 *    normal case rather than a defensive measure.
 *  - **The premium is a cross-check, not an instruction.** `expectedPremiumMinor` is
 *    compared against the quote and the request is REFUSED on a mismatch. The server
 *    never charges the client's number.
 *  - **The disclaimer travels with every priced response.** Attached by the service, not
 *    by each client, so a screen that forgot it is one visible omission rather than a
 *    missing paragraph in three apps.
 */
@Controller(INSURANCE_ROUTES.BASE)
@UseGuards(AuthGuard)
export class InsuranceController {
  private readonly logger: AppLogger

  constructor(
    private readonly quoting: QuotingService,
    private readonly underwriting: UnderwritingService,
    private readonly policies: PolicyService,
    private readonly premiums: PremiumService,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: InsuranceController.name })
  }

  // ── marketplace ───────────────────────────────────────────────────────────
  /**
   * The three covers.
   *
   * No premiums in this response. Pricing depends on the viewer's own score, so a
   * marketplace advertising "from ₹X/month" would show a figure most viewers will not be
   * offered — and the one screen whose job is to build trust would open with a number
   * that turns out to be wrong.
   */
  @Get(INSURANCE_ROUTES.PRODUCTS)
  async products(
    @Query(new ZodValidationPipe(ProductListQuerySchema))
    query: ProductListQueryDto,
  ) {
    const items = await this.quoting.products(query)
    return ResponseBuilder.success(
      items,
      'Cover available to you. Prices are personal — ask for a quote to see yours.',
    )
  }

  @Get(INSURANCE_ROUTES.PRODUCT_DETAIL)
  async product(@Param('id', new UUIDValidationPipe()) id: string) {
    const product = await this.prisma.insuranceProduct.findFirst({
      where: { id, isActive: true },
    })
    if (!product) throw new NotFoundException('That cover is not available')
    return ResponseBuilder.success(
      this.quoting.describeProduct(product),
      product.name,
    )
  }

  // ── quote ─────────────────────────────────────────────────────────────────
  /**
   * Ask for a price.
   *
   * A POST because it CREATES a quote row — a decision about somebody derived from their
   * own financial data, which has to be reviewable, countable in a fairness audit, and
   * explainable back to them. A GET that computed a price without recording it would
   * leave nothing to point at when they ask why.
   *
   * A DECLINE returns 200 with a declined quote, not a 403. The applicant needs the
   * reason and the route back to eligibility; a 403 would give them the same
   * unexplained refusal they already get from every other insurer.
   */
  @Post(INSURANCE_ROUTES.QUOTE)
  async quote(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(InsuranceQuoteRequestSchema))
    dto: InsuranceQuoteRequestDto,
  ) {
    this.logger.info(`[${this.quote.name}] Quote requested`, {
      userId: user.id,
      productId: dto.productId,
    })

    const quote = await this.quoting.quote(user.id, {
      productId: dto.productId,
      coverageMinor: BigInt(dto.coverageMinor),
    })

    /**
     * Re-derive the explanation for the response.
     *
     * The sentences are not persisted on the quote — only the encrypted inputs are — so
     * they are rebuilt from the same assessment the pricing used. Storing prose would
     * mean a wording fix required a migration, and a wording that could drift from the
     * numbers beside it is worse than one rebuilt each time.
     */
    const assessment = await this.underwriting.assess(user.id, {
      type: quote.product.type,
      waitingPeriodDays: quote.product.waitingPeriodDays,
    })

    return ResponseBuilder.success(
      this.quoting.describeQuote(quote, assessment.explanation),
      quote.status === 'DECLINED'
        ? 'This cover is not available to you yet'
        : 'Your price',
    )
  }

  @Get(INSURANCE_ROUTES.QUOTE_DETAIL)
  async getQuote(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const quote = await this.quoting.get(user.id, id)
    return ResponseBuilder.success(
      this.quoting.describeQuote(quote),
      'Your quote',
    )
  }

  // ── buy ───────────────────────────────────────────────────────────────────
  /**
   * Buy cover.
   *
   * Wrapped in `IdempotencyService.runOnce`, so a retry returns the IDENTICAL response
   * body rather than merely avoiding a second debit. That distinction matters here: the
   * response carries the policy number the holder will quote when they claim, and a
   * retry that returned a different shape would leave two records of what they bought.
   */
  @Post(INSURANCE_ROUTES.POLICIES)
  async buy(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @ClientIp() ipAddress: string | null,
    @Body(new ZodValidationPipe(BuyPolicySchema)) dto: BuyPolicyDto,
  ) {
    this.logger.info(`[${this.buy.name}] Policy purchase requested`, {
      userId: user.id,
      quoteId: dto.quoteId,
    })

    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        /**
         * Reuses M4's TRANSFER_CREATE scope.
         *
         * A purchase's only money movement IS a premium debit, so sharing the scope means
         * one key cannot be used for both a transfer and a policy purchase — which is the
         * conservative reading. A separate M5 scope would let the same key do both, and
         * "the same key means the same intent" is the property idempotency rests on.
         */
        scope: IDEMPOTENCY_SCOPE.TRANSFER_CREATE,
        key: idempotencyKey,
        body: dto,
      },
      async () => {
        const policy = await this.policies.buy(user.id, dto, { ipAddress })
        return this.policies.describe(policy)
      },
    )

    const data = result.value
    return ResponseBuilder.success(
      data,
      result.replayed
        ? 'That cover was already purchased'
        : this.purchaseMessage(data),
    )
  }

  /**
   * The message that goes with a purchase.
   *
   * `PENDING_PAYMENT` gets an explicit instruction rather than a generic success, because
   * the holder at that moment has a policy row and NO COVER. Telling them "policy
   * created" would be the single most dangerous sentence in the module — somebody who
   * believes they are insured and is not.
   */
  private purchaseMessage(
    policy: ReturnType<PolicyService['describe']>,
  ): string {
    if (policy.status === 'PENDING_PAYMENT') {
      return 'Your policy is reserved but NOT yet active — we could not collect the first premium. Add money to your Pravaah wallet and retry the premium to start your cover.'
    }
    return policy.isInWaitingPeriod
      ? `Cover is active. Claims for incidents from ${policy.waitingPeriodEndsAt?.toDateString() ?? 'the end of your waiting period'} onwards are payable — the waiting period runs for ${policy.waitingPeriodDaysRemaining} more day(s).`
      : 'Your cover is active.'
  }

  /**
   * Retry the first premium after the wallet has been topped up.
   *
   * Its own route rather than repeating the buy call, because the policy already exists
   * at the quoted price. Re-buying would send the holder back through underwriting at a
   * price that may have moved — punishing them for having had an empty wallet on the day
   * they decided to buy cover.
   */
  @Post(INSURANCE_ROUTES.POLICY_RETRY_PREMIUM)
  async retryPremium(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @ClientIp() ipAddress: string | null,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const policy = await this.policies.load(user.id, id)

    if (policy.status !== 'PENDING_PAYMENT') {
      return ResponseBuilder.success(
        this.policies.describe(policy),
        'Nothing to collect — this policy is already past its first premium.',
      )
    }

    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.TRANSFER_CREATE,
        key: idempotencyKey,
        body: { retryPremiumFor: id },
      },
      async () => {
        /**
         * Re-enter `buy`, rather than collecting the premium here and activating
         * separately.
         *
         * `buy` is re-entrant by construction: `createPending` resolves the unique
         * `quoteId` back to this policy, and `collectFirst` reuses the existing premium
         * period instead of opening a second one. So the collection, the insurer binding
         * and all four contract dates are set by ONE code path.
         *
         * The version of this method that called `collectFirst` and then `buy` collected
         * the premium TWICE — once here and once inside `buy` — because each call took its
         * own `now` and therefore opened its own premium period. Two debits for one month
         * of cover, on the retry path used by exactly the people whose wallet was short.
         */
        const policyAfter = await this.policies.buy(
          user.id,
          {
            // The price the policy was already sold at, not a fresh quote. Re-quoting
            // would reprice somebody for having had an empty wallet on the day they
            // decided to buy cover.
            quoteId: policy.quoteId,
            expectedPremiumMinor: policy.premiumMinor.toString(),
            acceptedDisclaimer: true,
          },
          { ipAddress },
        )

        const described = this.policies.describe(policyAfter)
        if (described.status === 'PENDING_PAYMENT') {
          const balanceShortfall = await this.premiums.latestPaid(policy.id)
          return {
            collected: false as const,
            policy: described,
            message:
              'There is still not enough in your Pravaah wallet to collect this premium. Add money and try again.',
            // Present only when at least one period has ever settled, which on a first
            // premium it has not — kept for shape stability across both branches.
            lastPaidAt: balanceShortfall?.paidAt ?? null,
          }
        }
        return { collected: true as const, policy: described, message: '' }
      },
    )

    const data = result.value as {
      collected: boolean
      policy: ReturnType<PolicyService['describe']>
      message: string
    }

    return ResponseBuilder.success(
      data,
      data.collected
        ? 'Premium collected — your cover is active.'
        : data.message,
    )
  }

  // ── the policy wallet ─────────────────────────────────────────────────────
  @Get(INSURANCE_ROUTES.POLICIES)
  async myPolicies(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(PolicyListQuerySchema))
    query: PolicyListQueryDto,
  ) {
    const { items, total } = await this.policies.list(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items.map((policy) => this.policies.describe(policy)),
      total,
      query.offset,
      query.limit,
      'Your cover',
    )
  }

  @Get(INSURANCE_ROUTES.POLICY_DETAIL)
  async policy(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const policy = await this.policies.load(user.id, id)
    return ResponseBuilder.success(
      this.policies.describe(policy),
      policy.policyNumber,
    )
  }

  /**
   * The premium history for one policy.
   *
   * Its own route because it answers a specific and common question — "what did you take
   * from my wallet, and when?" — and folding it into the policy response would make the
   * policy wallet's hottest read carry a growing list nobody asked for.
   */
  @Get(INSURANCE_ROUTES.POLICY_PREMIUMS)
  async premiumHistory(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const policy = await this.policies.load(user.id, id)
    const history = await this.premiums.history(policy.id)

    return ResponseBuilder.success(
      history.map((premium) => ({
        id: premium.id,
        amount: moneyView(premium.amountMinor, premium.currency),
        status: premium.status,
        periodStart: premium.periodStart,
        periodEnd: premium.periodEnd,
        /**
         * The M4 transaction, so the holder can open the ledger entry behind the debit.
         *
         * This is the link that makes the premium checkable rather than asserted: the
         * same statement line M4 shows for a transfer.
         */
        transactionId: premium.transactionId,
        refunded: moneyView(premium.refundedMinor, premium.currency),
        paidAt: premium.paidAt,
        // The internal failure text is deliberately not surfaced verbatim; the status
        // plus the retry route is what the holder can act on.
        failed: premium.status === 'FAILED',
      })),
      'Premiums collected on this policy',
    )
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  /**
   * Cancel cover.
   *
   * The response states plainly whether a refund is coming and why. A cancellation that
   * silently refunded — or silently did not — would leave the holder checking their
   * wallet balance to find out what happened to their premium.
   */
  @Post(INSURANCE_ROUTES.POLICY_CANCEL)
  async cancel(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(CancelPolicySchema)) dto: CancelPolicyDto,
  ) {
    const result = await this.policies.cancel(user.id, id, dto.reason)
    return ResponseBuilder.success(
      {
        policy: this.policies.describe(result.policy),
        refund: {
          ...result.refund,
          refunded: moneyView(
            BigInt(result.refund.refundedMinor),
            result.policy.currency,
          ),
        },
      },
      result.refund.eligible
        ? 'Cover cancelled and your premium has been returned to your wallet.'
        : 'Cover cancelled.',
    )
  }
}
