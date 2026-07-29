import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AdminDisputeListQuerySchema,
  AdminTxnListQuerySchema,
  LedgerQuerySchema,
  ManualReversalSchema,
  ReconListQuerySchema,
  ReleaseRiskHoldSchema,
  ResolveDeemedSchema,
  ResolveDisputeSchema,
  TrialBalanceQuerySchema,
  type AdminDisputeListQueryDto,
  type AdminTxnListQueryDto,
  type LedgerQueryDto,
  type ManualReversalDto,
  type ReconListQueryDto,
  type ReleaseRiskHoldDto,
  type ResolveDeemedDto,
  type ResolveDisputeDto,
  type TrialBalanceQueryDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { ADMIN_PAYMENT_ROUTES } from '@/modules/payments/payments.route'
import { DisputeService } from '@/modules/payments/services/dispute.service'
import { PaymentsAdminService } from '@/modules/payments/services/payments-admin.service'
import { ReconciliationService } from '@/modules/payments/services/reconciliation.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'

import { ActorType, AdminRole, type AdminUser } from 'generated/prisma/client'

/**
 * The M4 admin console — oversight, and the controls that move customer money by hand.
 *
 * The role split mirrors M2's and M3's, and the line is drawn where the CONSEQUENCE changes:
 *
 *  - **ADMIN alone** may resolve a DEEMED transaction, force a refund, or release a risk hold.
 *    Each of those moves real money on a human's judgement with no rail event to corroborate it.
 *  - **SENIOR_REVIEWER** may read everything and work disputes. That is a judgement about one
 *    customer's claim, permanently attributed.
 *  - Plain REVIEWER has no business here, so the class guard excludes them.
 *
 * The acting admin always comes from `req.admin` (populated by {@link AdminAuthGuard}), never
 * from a request body — a self-declared actor id would make the whole attribution trail
 * worthless.
 */
@Controller(ADMIN_PAYMENT_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ADMIN, AdminRole.SENIOR_REVIEWER)
export class AdminPaymentsController {
  private readonly logger: AppLogger

  constructor(
    private readonly admin: PaymentsAdminService,
    private readonly reconciliation: ReconciliationService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly disputes: DisputeService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminPaymentsController.name })
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  /**
   * The trial balance. Zero in every currency, always.
   *
   * The one number to page somebody about. Since every posting set is validated as balanced
   * before it is written, a non-zero result cannot come from a bad posting — it means entries
   * reached the table without going through the ledger service at all.
   */
  @Get(ADMIN_PAYMENT_ROUTES.TRIAL_BALANCE)
  async trialBalance(
    @Query(new ZodValidationPipe(TrialBalanceQuerySchema))
    query: TrialBalanceQueryDto,
  ) {
    const data = await this.admin.trialBalance(query)
    return ResponseBuilder.success(
      data,
      data.balanced
        ? 'Trial balance is zero in every currency'
        : 'TRIAL BALANCE IS BROKEN — investigate immediately',
    )
  }

  @Get(ADMIN_PAYMENT_ROUTES.LEDGER)
  async ledger(
    @Query(new ZodValidationPipe(LedgerQuerySchema)) query: LedgerQueryDto,
  ) {
    const { items, total } = await this.admin.ledgerEntries(query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      'Ledger entries',
    )
  }

  @Get(ADMIN_PAYMENT_ROUTES.STATS)
  async stats() {
    const data = await this.admin.stats()
    return ResponseBuilder.success(data, 'Payment operations overview')
  }

  @Get(ADMIN_PAYMENT_ROUTES.TRANSACTIONS)
  async transactions(
    @Query(new ZodValidationPipe(AdminTxnListQuerySchema))
    query: AdminTxnListQueryDto,
  ) {
    const { items, total } = await this.admin.transactions(query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      query.needsAttention ? 'Payments waiting on a human' : 'Payments',
    )
  }

  /** One transaction: the ledger legs, the rail trail, the reconciliations, the reversals. */
  @Get(ADMIN_PAYMENT_ROUTES.TRANSACTION_DETAIL)
  async transactionDetail(@Param('id', new UUIDValidationPipe()) id: string) {
    const data = await this.admin.transactionDetail(id)
    return ResponseBuilder.success(data, 'Payment detail')
  }

  @Get(ADMIN_PAYMENT_ROUTES.RECONCILIATIONS)
  async reconciliations(
    @Query(new ZodValidationPipe(ReconListQuerySchema))
    query: ReconListQueryDto,
  ) {
    const { items, total } = await this.admin.reconciliations(query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      'Reconciliation trail',
    )
  }

  // ── operations ────────────────────────────────────────────────────────────
  /** Ask the rail about one transaction, right now. Read-only in effect. */
  @Post(ADMIN_PAYMENT_ROUTES.TRANSACTION_RECHECK)
  async recheck(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Req() request: { admin: AdminUser },
  ) {
    const data = await this.admin.recheck(id, { id: request.admin.id })
    return ResponseBuilder.success(data, 'Rechecked against the rail')
  }

  /** Run a reconciliation sweep on demand, rather than waiting for the scheduler. */
  @Post(ADMIN_PAYMENT_ROUTES.RECONCILE_NOW)
  @AdminRoles(AdminRole.ADMIN)
  async reconcileNow(@Req() request: { admin: AdminUser }) {
    const summary = await this.reconciliation.reconcileDue()
    this.logger.warn(
      `[${this.reconcileNow.name}] Manual reconciliation sweep`,
      { adminId: request.admin.id, ...summary },
    )
    return ResponseBuilder.success(
      summary,
      summary.lateSettlements > 0
        ? `Corrected ${summary.lateSettlements} late settlement(s)`
        : 'Reconciliation complete',
    )
  }

  /**
   * Resolve a transaction the rail never answered.
   *
   * ADMIN only. The two options are opposites and both irreversible: SETTLE credits the
   * beneficiary and closes the ledger; REVERSE gives the money back to the sender. Guessing
   * wrong pays twice or not at all — which is exactly why the saga parks these instead of
   * choosing, and why this demands an evidence reference rather than only a reason.
   */
  @Post(ADMIN_PAYMENT_ROUTES.TRANSACTION_RESOLVE_DEEMED)
  @AdminRoles(AdminRole.ADMIN)
  async resolveDeemed(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(ResolveDeemedSchema)) dto: ResolveDeemedDto,
    @Req() request: { admin: AdminUser },
  ) {
    const transaction = await this.admin.resolveDeemed(id, dto, {
      id: request.admin.id,
    })
    return ResponseBuilder.success(
      { id: transaction.id, status: transaction.status },
      dto.resolution === 'SETTLE'
        ? 'Settled — the beneficiary has been credited'
        : 'Reversed — the sender has been made whole',
    )
  }

  /** Force a refund. ADMIN only, reasoned, and routed through the normal refund path. */
  @Post(ADMIN_PAYMENT_ROUTES.TRANSACTION_REFUND)
  @AdminRoles(AdminRole.ADMIN)
  async refund(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(ManualReversalSchema)) dto: ManualReversalDto,
    @Req() request: { admin: AdminUser },
  ) {
    const reversal = await this.admin.manualRefund(id, dto, {
      id: request.admin.id,
    })
    return ResponseBuilder.success(
      {
        id: reversal.id,
        status: reversal.status,
        amountMinor: reversal.amountMinor.toString(),
      },
      'Refund issued',
    )
  }

  /**
   * Release or block a payment the risk engine held.
   *
   * A released hold re-enters the saga at VALIDATED, not at RESERVED — the balance and the
   * limits are re-checked, because a hold can sit for hours and the money may have been spent
   * or the day's quota used in the meantime.
   */
  @Post(ADMIN_PAYMENT_ROUTES.TRANSACTION_RISK)
  @AdminRoles(AdminRole.ADMIN)
  async resolveRisk(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(ReleaseRiskHoldSchema))
    dto: ReleaseRiskHoldDto,
    @Req() request: { admin: AdminUser },
  ) {
    const transaction = await this.orchestrator.resolveRiskHold(
      id,
      dto.decision,
      { type: ActorType.ADMIN, id: request.admin.id },
      dto.reason,
    )
    return ResponseBuilder.success(
      { id: transaction.id, status: transaction.status },
      dto.decision === 'RELEASE' ? 'Payment released' : 'Payment blocked',
    )
  }

  // ── disputes ──────────────────────────────────────────────────────────────
  /**
   * The dispute work queue, across every user.
   *
   * Ordered by SLA deadline by default. This is deliberately a superset of
   * {@link slaBreaches}: a queue that only listed disputes already past their deadline would let
   * every single one go late before anyone could see it, which is the opposite of what an SLA is
   * for. `breachedOnly=true` narrows this to that same subset when a lead wants only the failures.
   */
  @Get(ADMIN_PAYMENT_ROUTES.DISPUTES)
  async disputeQueue(
    @Query(new ZodValidationPipe(AdminDisputeListQuerySchema))
    query: AdminDisputeListQueryDto,
  ) {
    const { items, total } = await this.disputes.queue(query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      'Dispute queue',
    )
  }

  /** The SLA queue — the list an operations lead actually watches. */
  @Get(ADMIN_PAYMENT_ROUTES.DISPUTES_SLA)
  async slaBreaches() {
    const items = await this.disputes.breachingSla()
    return ResponseBuilder.success(
      items,
      items.length > 0
        ? `${items.length} dispute(s) past their SLA`
        : 'No disputes past their SLA',
    )
  }

  /** Claim a dispute, so two reviewers do not both work it. */
  @Post(ADMIN_PAYMENT_ROUTES.DISPUTE_CLAIM)
  async claimDispute(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Req() request: { admin: AdminUser },
  ) {
    const dispute = await this.disputes.claim(id, request.admin.id)
    return ResponseBuilder.success(
      { id: dispute.id, status: dispute.status },
      'Dispute claimed for review',
    )
  }

  /**
   * Resolve a dispute.
   *
   * Crediting the customer goes through the normal refund path, which sends the rail leg before
   * the ledger may say the money came back and respects what remains refundable. A shortcut
   * here would have to reimplement all of that, and would get it wrong.
   */
  @Post(ADMIN_PAYMENT_ROUTES.DISPUTE_RESOLVE)
  async resolveDispute(
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(ResolveDisputeSchema)) dto: ResolveDisputeDto,
    @Req() request: { admin: AdminUser },
  ) {
    const dispute = await this.disputes.resolve(id, dto, {
      id: request.admin.id,
    })
    return ResponseBuilder.success(
      {
        id: dispute.id,
        status: dispute.status,
        resolution: dispute.resolution,
      },
      'Dispute resolved',
    )
  }
}
