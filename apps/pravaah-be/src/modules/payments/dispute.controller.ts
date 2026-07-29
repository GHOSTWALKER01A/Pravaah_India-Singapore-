import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import {
  DisputeListQuerySchema,
  WithdrawDisputeSchema,
  type DisputeListQueryDto,
  type WithdrawDisputeDto,
} from '@pravaah/schema'

import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { moneyView } from '@/modules/payments/money.util'
import { DISPUTE_ROUTES } from '@/modules/payments/payments.route'
import { DisputeService } from '@/modules/payments/services/dispute.service'

import type { PaymentDispute } from 'generated/prisma/client'

/**
 * UDIR disputes — the customer's side.
 *
 * Raising one is done from the payment (`POST /payments/transfers/:id/dispute`), because a
 * dispute is always ABOUT a payment and asking the user to supply a transaction id in a body
 * they cannot see is how support tickets get filed against the wrong charge. This controller is
 * for what happens afterwards: tracking it, and withdrawing it.
 *
 * `slaDueAt` is returned on every response. UDIR obliges a PSP to answer inside a bounded
 * window, and showing the customer the actual deadline is the difference between an obligation
 * and a reassurance.
 */
@Controller(DISPUTE_ROUTES.BASE)
@UseGuards(AuthGuard)
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  @Get(DISPUTE_ROUTES.LIST)
  async list(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(DisputeListQuerySchema))
    query: DisputeListQueryDto,
  ) {
    const { items, total } = await this.disputes.list(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items.map((item) => this.present(item)),
      total,
      query.offset,
      query.limit,
      'Your disputes',
    )
  }

  @Get(DISPUTE_ROUTES.DETAIL)
  async detail(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const dispute = await this.disputes.get(user.id, id)
    return ResponseBuilder.success(
      {
        ...this.present(dispute),
        payment: {
          id: dispute.transaction.id,
          status: dispute.transaction.status,
          amount: moneyView(
            dispute.transaction.totalDebitMinor,
            dispute.transaction.sourceCurrency,
          ),
          counterpartyName: dispute.transaction.counterpartyName,
          utr: dispute.transaction.utr,
          createdAt: dispute.transaction.createdAt,
        },
      },
      'Dispute',
    )
  }

  /** Withdraw a dispute the user no longer wants pursued. */
  @Post(DISPUTE_ROUTES.WITHDRAW)
  async withdraw(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(WithdrawDisputeSchema))
    dto: WithdrawDisputeDto,
  ) {
    const dispute = await this.disputes.withdraw(user.id, id, dto.reason)
    return ResponseBuilder.success(this.present(dispute), 'Dispute withdrawn')
  }

  private present(dispute: PaymentDispute) {
    return {
      id: dispute.id,
      transactionId: dispute.transactionId,
      kind: dispute.kind,
      status: dispute.status,
      description: dispute.description,
      claimedAmountMinor: dispute.claimedAmountMinor?.toString() ?? null,
      resolution: dispute.resolution,
      // The deadline, shown to the customer. An obligation they can hold us to.
      slaDueAt: dispute.slaDueAt,
      createdAt: dispute.createdAt,
      resolvedAt: dispute.resolvedAt,
    }
  }
}
