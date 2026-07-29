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
  CreateMandateSchema,
  MandateActionSchema,
  MandateListQuerySchema,
  PresentMandateDebitSchema,
  type CreateMandateDto,
  type MandateActionDto,
  type MandateListQueryDto,
  type PresentMandateDebitDto,
} from '@pravaah/schema'

import { IdempotencyKey } from '@/common/decorators/idempotency-key.decorator'
import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { moneyView } from '@/modules/payments/money.util'
import { MANDATE_ROUTES } from '@/modules/payments/payments.route'
import {
  IDEMPOTENCY_SCOPE,
  IdempotencyService,
} from '@/modules/payments/services/idempotency.service'
import { MandateService } from '@/modules/payments/services/mandate.service'

import type { Mandate } from 'generated/prisma/client'

/**
 * UPI AutoPay — standing permission to debit.
 *
 * The most consequential object a user can create here, because it is the only one that moves
 * money while they are not present. Three things this controller makes visible rather than
 * implicit:
 *
 *  - the CEILING the user authorised, on every response, so a mandate is never a vague
 *    "subscription" the user cannot quantify;
 *  - the NEXT debit date and amount, so an unwanted charge can be cancelled before it happens
 *    rather than disputed after;
 *  - that revoking is FINAL while pausing is not — a person cancelling a subscription must not
 *    be one mis-tap away from it resuming.
 */
@Controller(MANDATE_ROUTES.BASE)
@UseGuards(AuthGuard)
export class MandateController {
  private readonly logger: AppLogger

  constructor(
    private readonly mandates: MandateService,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MandateController.name })
  }

  /**
   * Set up AutoPay.
   *
   * Returns PENDING, not active. The payer has to approve it in their own PSP app with their
   * UPI PIN — a mandate we marked active on creation would be a standing debit permission the
   * user never actually authorised.
   */
  @Post(MANDATE_ROUTES.CREATE)
  async create(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(CreateMandateSchema)) dto: CreateMandateDto,
  ) {
    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.MANDATE_CREATE,
        key: idempotencyKey,
        body: dto,
      },
      async () => {
        const mandate = await this.mandates.create(user.id, dto, idempotencyKey)
        return this.present(mandate)
      },
    )

    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That AutoPay setup was already started'
        : 'Approve the AutoPay mandate in your UPI app to activate it',
    )
  }

  @Get(MANDATE_ROUTES.LIST)
  async list(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(MandateListQuerySchema))
    query: MandateListQueryDto,
  ) {
    const { items, total } = await this.mandates.list(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items.map((item) => this.present(item)),
      total,
      query.offset,
      query.limit,
      'Your AutoPay mandates',
    )
  }

  /**
   * One mandate, with its recent debits.
   *
   * The execution history includes SKIPPED and FAILED rows, not only successful debits. A user
   * asking "why wasn't I charged last month?" needs to see that the debit was skipped because
   * their balance was short — hiding it would make the answer unavailable to them.
   */
  @Get(MANDATE_ROUTES.DETAIL)
  async detail(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const mandate = await this.mandates.get(user.id, id)
    return ResponseBuilder.success(
      {
        ...this.present(mandate),
        payee: {
          displayName: mandate.beneficiary.displayName,
          registeredName: mandate.beneficiary.registeredName,
        },
        debits: mandate.executions.map((execution) => ({
          sequence: execution.sequence,
          status: execution.status,
          amount: moneyView(execution.amountMinor, mandate.currency),
          dueAt: execution.dueAt,
          // Surfaced because it is a promise we made: NPCI requires 24 hours' notice, and
          // showing when it was sent is how the user can hold us to it.
          notifiedAt: execution.notifiedAt,
          debitedAt: execution.debitedAt,
          failureReason: execution.failureReason,
          transactionId: execution.transactionId,
        })),
      },
      'AutoPay mandate',
    )
  }

  /** Pause, resume, or revoke. Revocation is permanent. */
  @Post(MANDATE_ROUTES.ACTION)
  async act(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(MandateActionSchema)) dto: MandateActionDto,
  ) {
    const mandate = await this.mandates.act(user.id, id, dto)
    this.logger.info(
      `[${this.act.name}] Mandate ${dto.action.toLowerCase()}d`,
      {
        userId: user.id,
        mandateId: id,
      },
    )

    return ResponseBuilder.success(
      this.present(mandate),
      dto.action === 'REVOKE'
        ? 'AutoPay cancelled. No further payments will be taken.'
        : dto.action === 'PAUSE'
          ? 'AutoPay paused. You can resume it any time.'
          : 'AutoPay resumed',
    )
  }

  /**
   * The payee presents a debit against an existing mandate.
   *
   * Checked against the authorised ceiling HERE, not just at creation — the merchant chooses
   * the amount, and a mandate is a permission that outlives the moment it was granted. The due
   * date must also leave room for the 24-hour notice, so a merchant cannot schedule a debit for
   * "now" and bypass the warning.
   */
  @Post(MANDATE_ROUTES.PRESENT_DEBIT)
  async presentDebit(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(PresentMandateDebitSchema))
    dto: PresentMandateDebitDto,
  ) {
    // Ownership first: presenting a debit against somebody else's mandate must 404, not be
    // validated and then rejected further in.
    const mandate = await this.mandates.get(user.id, id)

    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.MANDATE_EXECUTE,
        key: idempotencyKey,
        body: { mandateId: id, ...dto },
      },
      async () => {
        const execution = await this.mandates.presentDebit(mandate.id, dto)
        return {
          id: execution.id,
          sequence: execution.sequence,
          status: execution.status,
          amount: moneyView(execution.amountMinor, mandate.currency),
          dueAt: execution.dueAt,
          notifiedAt: execution.notifiedAt,
        }
      },
    )

    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That debit was already scheduled'
        : "Debit scheduled. We'll notify the payer at least 24 hours beforehand.",
    )
  }

  private present(mandate: Mandate) {
    return {
      id: mandate.id,
      mandateRef: mandate.mandateRef,
      umn: mandate.umn,
      status: mandate.status,
      frequency: mandate.frequency,
      amountRule: mandate.amountRule,
      // The ceiling, on every response. A mandate the user cannot quantify is a mandate they
      // cannot meaningfully have consented to.
      maxAmount: moneyView(mandate.maxAmountMinor, mandate.currency),
      currency: mandate.currency,
      purposeCode: mandate.purposeCode,
      narration: mandate.narration,
      validFrom: mandate.validFrom,
      validUntil: mandate.validUntil,
      nextDebitAt: mandate.nextDebitAt,
      lastDebitAt: mandate.lastDebitAt,
      revokeReason: mandate.revokeReason,
      failureReason: mandate.failureReason,
      approvedAt: mandate.approvedAt,
      createdAt: mandate.createdAt,
    }
  }
}
