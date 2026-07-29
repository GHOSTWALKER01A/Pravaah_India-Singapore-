import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  PURPOSE_CODES,
  QuoteRequestSchema,
  SUPPORTED_CURRENCIES,
  TopupSchema,
  WithdrawSchema,
  type QuoteRequestDto,
  type TopupDto,
  type WithdrawDto,
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

import { moneyView, rateE8ToString } from '@/modules/payments/money.util'
import { PAYMENT_ROUTES } from '@/modules/payments/payments.route'
import { FxService } from '@/modules/payments/services/fx.service'
import {
  IDEMPOTENCY_SCOPE,
  IdempotencyService,
} from '@/modules/payments/services/idempotency.service'
import { LimitService } from '@/modules/payments/services/limit.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { WalletService } from '@/modules/payments/services/wallet.service'

import { Corridor } from 'generated/prisma/client'

/**
 * The wallet API — balances, prices, and money crossing the platform's edge.
 *
 * Every route is JWT-guarded and scoped to `user.id`. Nothing here is addressable by id
 * alone: the ownership predicate lives inside each service's WHERE clause, so somebody else's
 * handle or quote id is a 404 rather than a 403 that confirms it exists.
 */
@Controller(PAYMENT_ROUTES.BASE)
@UseGuards(AuthGuard)
export class PaymentsController {
  private readonly logger: AppLogger

  constructor(
    private readonly wallet: WalletService,
    private readonly fx: FxService,
    private readonly limits: LimitService,
    private readonly handles: UpiHandleService,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentsController.name })
  }

  // ── wallet ────────────────────────────────────────────────────────────────
  /** Balances, UPI handles and remaining limits — the whole wallet screen. */
  @Get(PAYMENT_ROUTES.WALLET)
  async overview(@User() user: AuthenticatedUser) {
    const data = await this.wallet.overview(user.id)
    return ResponseBuilder.success(data, 'Your wallet')
  }

  /**
   * The account statement, derived from ledger entries.
   *
   * Not the transaction list. A transaction tells the user what they tried to do; the ledger
   * tells them what happened to their money — the reserve, the fee and the refund as separate,
   * timestamped lines. When somebody disputes a balance, this is the document that answers.
   */
  @Get(PAYMENT_ROUTES.STATEMENT)
  async statement(
    @User() user: AuthenticatedUser,
    @Query('currency') currency?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const data = await this.wallet.statement(user.id, {
      currency: currency?.toUpperCase(),
      limit: boundedInt(limit, 50, 200),
      offset: boundedInt(offset, 0, Number.MAX_SAFE_INTEGER),
    })
    return ResponseBuilder.success(data, 'Account statement')
  }

  /**
   * The caps, and how much of each is left.
   *
   * Served so the app can warn BEFORE a user types an amount it will have to reject. The
   * numbers are advisory to the client and enforced server-side — a client-side cap is a
   * courtesy, `LimitService` is the control.
   */
  @Get(PAYMENT_ROUTES.LIMITS)
  async limitUsage(@User() user: AuthenticatedUser) {
    const [domestic, crossBorder] = await Promise.all([
      this.limits.usage(user.id, Corridor.DOMESTIC),
      this.limits.usage(user.id, Corridor.CROSS_BORDER),
    ])
    return ResponseBuilder.success(
      {
        domestic,
        crossBorder,
        currencies: Object.values(SUPPORTED_CURRENCIES),
        purposeCodes: Object.values(PURPOSE_CODES),
      },
      'Your payment limits',
    )
  }

  // ── UPI handles ───────────────────────────────────────────────────────────
  @Get(PAYMENT_ROUTES.HANDLES)
  async listHandles(@User() user: AuthenticatedUser) {
    const handles = await this.handles.list(user.id)
    return ResponseBuilder.success(
      handles.map((handle) => this.handles.describe(handle)),
      'Your UPI IDs',
    )
  }

  /** Allocate a UPI ID. Idempotent — an existing active handle is returned as-is. */
  @Post(PAYMENT_ROUTES.HANDLES)
  async createHandle(
    @User() user: AuthenticatedUser,
    @Body('vpa') requested?: string,
  ) {
    const handle = await this.handles.allocate(user.id, requested)
    this.logger.info(`[${this.createHandle.name}] UPI ID allocated`, {
      userId: user.id,
      vpa: handle.vpa,
    })
    return ResponseBuilder.success(
      this.handles.describe(handle),
      `Your UPI ID is ${handle.vpa}`,
    )
  }

  @Post(PAYMENT_ROUTES.HANDLE_PRIMARY)
  async setPrimaryHandle(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const handle = await this.handles.setPrimary(user.id, id)
    return ResponseBuilder.success(
      this.handles.describe(handle),
      `${handle.vpa} is now your primary UPI ID`,
    )
  }

  /**
   * Turn a UPI ID off.
   *
   * The address is retired, never recycled — a payer with it saved, or a printed QR on a
   * shopfront, must never start reaching a different person.
   */
  @Post(PAYMENT_ROUTES.HANDLE_DEACTIVATE)
  async deactivateHandle(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const handle = await this.handles.deactivate(user.id, id)
    return ResponseBuilder.success(
      this.handles.describe(handle),
      `${handle.vpa} has been turned off and will not be reissued`,
    )
  }

  // ── pricing ───────────────────────────────────────────────────────────────
  /**
   * Lock a price.
   *
   * Returns the complete breakdown — rate, spread, fee, tax, what leaves, what arrives —
   * frozen for 90 seconds and usable exactly once. The transfer endpoint reads these numbers
   * back rather than recomputing them, which is what guarantees the user is charged the total
   * they agreed to.
   *
   * 200 rather than 201: a quote is a price, not a resource the client owns.
   */
  @Post(PAYMENT_ROUTES.QUOTE)
  @HttpCode(HttpStatus.OK)
  async quote(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(QuoteRequestSchema)) dto: QuoteRequestDto,
  ) {
    const quote = await this.fx.quote(user.id, dto)

    return ResponseBuilder.success(
      {
        quoteId: quote.id,
        corridor:
          quote.sourceCurrency === quote.destCurrency
            ? Corridor.DOMESTIC
            : Corridor.CROSS_BORDER,
        youSend: moneyView(quote.sourceAmount, quote.sourceCurrency),
        theyGet: moneyView(quote.destAmount, quote.destCurrency),
        fee: moneyView(quote.feeMinor, quote.sourceCurrency),
        tax: moneyView(quote.taxMinor, quote.sourceCurrency),
        totalDebit: moneyView(quote.totalDebitMinor, quote.sourceCurrency),
        /**
         * Both rates, so the spread is VISIBLE rather than implied.
         *
         * A remittance product that shows only the customer rate is asking to be trusted
         * about the difference; showing the mid alongside it is what makes the fee honest.
         */
        rate: rateE8ToString(quote.rateE8),
        midRate: rateE8ToString(quote.midRateE8),
        spreadBps: quote.spreadBps,
        rateSource: quote.rateSource,
        validUntil: quote.validUntil,
        // The countdown the app renders. Sent as a duration so a clock-skewed device still
        // expires the quote at roughly the right moment.
        validForMs: Math.max(0, quote.validUntil.getTime() - Date.now()),
      },
      'Price locked',
    )
  }

  // ── money in and out ──────────────────────────────────────────────────────
  /**
   * Add money — a UPI collect raised against the user's own account.
   *
   * The wallet is credited only when the rail confirms the payer's bank completed the debit.
   * We never see a UPI PIN: the authorisation happens in their own bank's app.
   */
  @Post(PAYMENT_ROUTES.TOPUP)
  async topup(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(TopupSchema)) dto: TopupDto,
  ) {
    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.TOPUP,
        key: idempotencyKey,
        body: dto,
      },
      () => this.wallet.topup(user.id, dto, idempotencyKey),
    )
    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That top-up request was already created'
        : 'Approve the request in your UPI app to add the money',
    )
  }

  /** Move wallet funds out to the user's own verified bank account. */
  @Post(PAYMENT_ROUTES.WITHDRAW)
  async withdraw(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @ClientIp() ipAddress: string | null,
    @Body(new ZodValidationPipe(WithdrawSchema)) dto: WithdrawDto,
  ) {
    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.WITHDRAW,
        key: idempotencyKey,
        body: dto,
      },
      () => this.wallet.withdraw(user.id, dto, idempotencyKey, { ipAddress }),
    )
    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That withdrawal was already started'
        : 'Withdrawal started',
    )
  }
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}
