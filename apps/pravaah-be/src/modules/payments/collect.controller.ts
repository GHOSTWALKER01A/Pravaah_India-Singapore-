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
  CollectListQuerySchema,
  CreateCollectSchema,
  type CollectListQueryDto,
  type CreateCollectDto,
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
import { COLLECT_ROUTES } from '@/modules/payments/payments.route'
import { CollectService } from '@/modules/payments/services/collect.service'
import {
  IDEMPOTENCY_SCOPE,
  IdempotencyService,
} from '@/modules/payments/services/idempotency.service'
import { maskVpa } from '@/modules/payments/vpa.util'

import type { CollectRequest } from 'generated/prisma/client'

/**
 * Requesting money — UPI collect.
 *
 * Note what is deliberately ABSENT: there is no endpoint here for a payer to approve a
 * collect. Approval happens inside the payer's own PSP app, in the bank/NPCI secure component,
 * with their UPI PIN. Any approval we accepted directly would be an authorisation with no PIN
 * behind it — which is not a shortcut, it is the entire security model discarded.
 *
 * A payer's answer therefore only ever reaches us through a signed rail webhook, and the mock
 * rail (`/mock/upi/...`, development only) is what plays the payer's app in a demo.
 */
@Controller(COLLECT_ROUTES.BASE)
@UseGuards(AuthGuard)
export class CollectController {
  private readonly logger: AppLogger

  constructor(
    private readonly collects: CollectService,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: CollectController.name })
  }

  /** Ask somebody to pay you. */
  @Post(COLLECT_ROUTES.CREATE)
  async create(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(CreateCollectSchema)) dto: CreateCollectDto,
  ) {
    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.COLLECT_CREATE,
        key: idempotencyKey,
        body: dto,
      },
      async () => {
        const collect = await this.collects.create(user.id, dto, idempotencyKey)
        return this.present(collect)
      },
    )

    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That request was already sent'
        : 'Request sent. They need to approve it in their UPI app.',
    )
  }

  @Get(COLLECT_ROUTES.LIST)
  async list(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(CollectListQuerySchema))
    query: CollectListQueryDto,
  ) {
    const { items, total } = await this.collects.list(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items.map((item) => this.present(item)),
      total,
      query.offset,
      query.limit,
      query.side === 'RECEIVED'
        ? 'Requests for you to pay'
        : 'Requests you have sent',
    )
  }

  @Get(COLLECT_ROUTES.DETAIL)
  async detail(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const collect = await this.collects.get(user.id, id)
    return ResponseBuilder.success(this.present(collect), 'Payment request')
  }

  /** Cancel a request the user no longer wants answered. */
  @Post(COLLECT_ROUTES.REVOKE)
  async revoke(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const collect = await this.collects.revoke(user.id, id)
    return ResponseBuilder.success(this.present(collect), 'Request cancelled')
  }

  private present(collect: CollectRequest) {
    return {
      id: collect.id,
      status: collect.status,
      // Masked: a collect list names a counterparty's payable address.
      payer: maskVpa(collect.payerHandle),
      payerName: collect.payerName,
      amount: moneyView(collect.amountMinor, collect.currency),
      purposeCode: collect.purposeCode,
      narration: collect.narration,
      isOpen: this.collects.isOpen(collect),
      expiresAt: collect.expiresAt,
      // A countdown, so a clock-skewed device still expires it at about the right moment.
      expiresInMs: Math.max(0, collect.expiresAt.getTime() - Date.now()),
      declineReason: collect.declineReason,
      transactionId: collect.transactionId,
      createdAt: collect.createdAt,
      respondedAt: collect.respondedAt,
    }
  }
}
