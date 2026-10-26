import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import {
  ConsentReceiptQuerySchema,
  WithdrawConsentReceiptSchema,
  type ConsentReceiptQueryDto,
  type WithdrawConsentReceiptDto,
} from '@pravaah/schema'

import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { HOLDER_SHARES_ROUTES } from '@/modules/partner/partner.route'
import { ConsentReceiptService } from '@/modules/partner/services/consent-receipt.service'

/**
 * "Who has seen my passport" — the holder's consent receipts.
 *
 * The transparency centrepiece of M7: every organisation the holder shared with,
 * what they shared, why, for how long — and a Withdraw button that actually does
 * something (redacts our copy, notifies the partner of its deletion obligation).
 *
 * Every read is scoped to the authenticated holder in the service's WHERE clause,
 * so a receipt id belonging to anyone else is a 404.
 */
@Controller(HOLDER_SHARES_ROUTES.BASE)
@UseGuards(AuthGuard)
export class HolderSharesController {
  constructor(private readonly receipts: ConsentReceiptService) {}

  @Get(HOLDER_SHARES_ROUTES.LIST)
  async list(
    @Query(new ZodValidationPipe(ConsentReceiptQuerySchema))
    query: ConsentReceiptQueryDto,
    @User() user: AuthenticatedUser,
  ) {
    const data = await this.receipts.listForHolder(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      data.items,
      data.total,
      query.offset,
      query.limit,
      'Your shares',
    )
  }

  /** The receipt for a request the wallet just approved — drives the "shared ✓" screen. */
  @Get(HOLDER_SHARES_ROUTES.BY_REQUEST)
  async byRequest(
    @Param('requestId', new UUIDValidationPipe()) requestId: string,
    @User() user: AuthenticatedUser,
  ) {
    const data = await this.receipts.byRequestForHolder(user.id, requestId)
    return ResponseBuilder.success(data, 'Consent receipt')
  }

  @Get(HOLDER_SHARES_ROUTES.DETAIL)
  async detail(
    @Param('receiptId', new UUIDValidationPipe()) receiptId: string,
    @User() user: AuthenticatedUser,
  ) {
    const data = await this.receipts.detailForHolder(user.id, receiptId)
    return ResponseBuilder.success(data, 'Consent receipt')
  }

  @Post(HOLDER_SHARES_ROUTES.WITHDRAW)
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @Param('receiptId', new UUIDValidationPipe()) receiptId: string,
    @Body(new ZodValidationPipe(WithdrawConsentReceiptSchema))
    dto: WithdrawConsentReceiptDto,
    @User() user: AuthenticatedUser,
  ) {
    const data = await this.receipts.withdraw(user.id, receiptId, dto.reason)
    return ResponseBuilder.success(
      data,
      'Share withdrawn — the organisation has been told to delete what you shared',
    )
  }
}
