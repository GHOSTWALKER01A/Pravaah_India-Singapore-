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
  CreateTransferSchema,
  RaiseDisputeBodySchema,
  RetryTransferSchema,
  TransferListQuerySchema,
  VerifyStepUpSchema,
  type CreateTransferDto,
  type RaiseDisputeBodyDto,
  type RetryTransferDto,
  type TransferListQueryDto,
  type VerifyStepUpDto,
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

import { StepUpService } from '@/modules/fraud/services/step-up.service'
import { isInFlight } from '@/modules/payments/payments.state'
import { TRANSFER_ROUTES } from '@/modules/payments/payments.route'
import { classifyRailCode } from '@/modules/payments/providers/upi-response-codes'
import { DisputeService } from '@/modules/payments/services/dispute.service'
import {
  IDEMPOTENCY_SCOPE,
  IdempotencyService,
} from '@/modules/payments/services/idempotency.service'
import { ReversalService } from '@/modules/payments/services/reversal.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { WalletService } from '@/modules/payments/services/wallet.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { NotFoundException } from '@nestjs/common'

import { StepUpMethod, StepUpPurpose, TxnStatus } from 'generated/prisma/client'

/**
 * Sending money.
 *
 * Two properties of this controller are worth stating, because both are places a payments API
 * commonly goes wrong:
 *
 *  - **Every mutation requires an `Idempotency-Key`.** A retried create returns the SAME
 *    transaction, never a second debit. Mobile clients retry — networks drop the response, not
 *    the request — so this is not defensive programming, it is the normal case.
 *  - **Status is read from US, never from the rail.** The client polls
 *    `GET /payments/transfers/:id`. A client that asked the rail directly would bypass the
 *    reconciliation that decides what a rail answer MEANS, and would show a user "sent" for a
 *    payment we had not settled.
 */
@Controller(TRANSFER_ROUTES.BASE)
@UseGuards(AuthGuard)
export class TransferController {
  private readonly logger: AppLogger

  constructor(
    private readonly orchestrator: TransferOrchestratorService,
    private readonly wallet: WalletService,
    private readonly reversals: ReversalService,
    private readonly disputes: DisputeService,
    private readonly idempotency: IdempotencyService,
    /**
     * M6's step-up orchestration, so a held transfer can carry its challenge.
     *
     * Injected into the CONTROLLER rather than the orchestrator for the read path, because this
     * is a presentation concern: the orchestrator decides and issues, this reports what is
     * outstanding. The orchestrator has its own injection for the issuing side.
     */
    private readonly stepUp: StepUpService,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: TransferController.name })
  }

  /**
   * Send money.
   *
   * The body carries no amount — that lives on the quote — and three confirmations instead:
   * the total the user saw, the payee name they read, and an explicit acknowledgement. Each
   * closes a specific failure mode, described on `CreateTransferSchema`.
   */
  @Post(TRANSFER_ROUTES.CREATE)
  async create(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @ClientIp() ipAddress: string | null,
    @Body(new ZodValidationPipe(CreateTransferSchema)) dto: CreateTransferDto,
  ) {
    this.logger.info(`[${this.create.name}] Transfer requested`, {
      userId: user.id,
      type: dto.type,
      beneficiaryId: dto.beneficiaryId,
    })

    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.TRANSFER_CREATE,
        key: idempotencyKey,
        body: dto,
      },
      async () => {
        const transaction = await this.orchestrator.create(user.id, dto, {
          idempotencyKey,
          ipAddress,
        })
        /**
         * The challenge travels back on the CREATE response.
         *
         * Without this the app learns a transfer needs confirming and has no nonce to confirm
         * it with — which made the whole STEP_UP band unreachable from the client. Folded in
         * here rather than left to a follow-up poll so the challenge sheet can open on the same
         * frame the payment is submitted.
         */
        return this.presentWithStepUp(user.id, transaction)
      },
    )

    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That payment was already submitted'
        : this.messageFor(result.value),
    )
  }

  @Get(TRANSFER_ROUTES.LIST)
  async list(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(TransferListQuerySchema))
    query: TransferListQueryDto,
  ) {
    const { items, total } = await this.wallet.transactions(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      'Your payments',
    )
  }

  /**
   * The status the client polls.
   *
   * `isFinal` is returned so the app knows when to STOP polling, rather than inferring it from
   * a status enum it would have to keep in sync with ours. A client that kept polling a
   * settled payment is wasted battery; one that stopped polling a pending payment shows a user
   * a spinner that never resolves.
   */
  @Get(TRANSFER_ROUTES.DETAIL)
  async detail(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const transaction = await this.owned(user.id, id)
    /**
     * The poll carries the challenge too, so a resume works.
     *
     * The app can be killed between submitting a transfer and answering its challenge. If only
     * `create` returned the nonce, that payment would be permanently stranded in `RISK_HELD`
     * with no client-side route out — the user would have to wait for an analyst on a hold that
     * was only ever meant to be a two-tap confirmation.
     */
    return ResponseBuilder.success(
      await this.presentWithStepUp(user.id, transaction),
      'Payment status',
    )
  }

  /**
   * The receipt.
   *
   * Includes the ledger legs, because a receipt that cannot show where the fee went is a
   * receipt nobody can check — and includes the reversals, so a partially refunded payment
   * shows both halves rather than a single confusing net.
   */
  @Get(TRANSFER_ROUTES.RECEIPT)
  async receipt(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const transaction = await this.owned(user.id, id)
    const [reversals, entries] = await Promise.all([
      this.reversals.listForTransaction(transaction.id),
      this.prisma.ledgerEntry.findMany({
        where: {
          transactionId: transaction.id,
          // Only the user's own side. The platform's fee and FX positions are our books, not
          // theirs, and a receipt listing them would leak our internal account structure.
          account: { ownerType: 'USER', ownerId: user.id },
        },
        orderBy: { postedAt: 'asc' },
      }),
    ])

    return ResponseBuilder.success(
      {
        ...this.present(transaction),
        movements: entries.map((entry) => ({
          leg: entry.leg,
          direction: entry.direction,
          amountMinor: entry.amountMinor.toString(),
          currency: entry.currency,
          postedAt: entry.postedAt,
        })),
        refunds: reversals.map((reversal) => ({
          id: reversal.id,
          kind: reversal.kind,
          amountMinor: reversal.amountMinor.toString(),
          status: reversal.status,
          reason: reversal.reason,
          completedAt: reversal.completedAt,
        })),
      },
      'Payment receipt',
    )
  }

  /**
   * Retry a failed payment.
   *
   * Mints a NEW transaction against a fresh quote rather than re-driving the failed one, which
   * is why it needs its own idempotency key. Re-driving would give one transaction id two rail
   * references and two ledger histories, and no reconciliation could then say which one the
   * rail was talking about.
   */
  @Post(TRANSFER_ROUTES.RETRY)
  async retry(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @ClientIp() ipAddress: string | null,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(RetryTransferSchema)) body: RetryTransferDto,
  ) {
    const original = await this.owned(user.id, id)
    if (!original.beneficiaryId) {
      throw new NotFoundException('That payment has no payee to retry against')
    }

    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.TRANSFER_RETRY,
        key: idempotencyKey,
        body: { originalId: id, ...body },
      },
      async () => {
        const transaction = await this.orchestrator.create(
          user.id,
          {
            // Carried over from the original so a retry cannot quietly change the payee or the
            // purpose — those are what the user already confirmed.
            beneficiaryId: original.beneficiaryId!,
            type: original.type as CreateTransferDto['type'],
            purposeCode:
              original.purposeCode as CreateTransferDto['purposeCode'],
            narration: original.narration ?? undefined,
            mcc: original.mcc ?? undefined,
            quoteId: body.quoteId,
            expectedTotalDebitMinor: body.expectedTotalDebitMinor,
            // Re-confirmed, because the payee's registered name may have changed since.
            confirmedRegisteredName: body.confirmedRegisteredName,
            confirmedName: true,
            deviceId: body.deviceId,
            passportRef: original.passportRef ?? undefined,
          },
          { idempotencyKey, ipAddress },
        )
        return this.present(transaction)
      },
    )

    return ResponseBuilder.success(
      result.value,
      result.replayed ? 'That retry was already submitted' : 'Payment retried',
    )
  }

  /**
   * Answer the M6 step-up on a transfer parked awaiting confirmation.
   *
   * The release path for the medium-risk band. A transfer that scored between the review and
   * hold thresholds — or that came from a brand-new device — sits in `RISK_HELD` with a
   * challenge issued, and this is how the account holder clears it themselves without an
   * analyst being paged.
   *
   * No `Idempotency-Key`, deliberately. The single-use NONCE already provides replay
   * protection, and it does so more strictly than an idempotency key would: a second call
   * with the same nonce is refused by `StepUpService.verify` because the challenge has left
   * `PENDING`, whereas an idempotency replay would cheerfully return the first call's
   * success.
   */
  /**
   * Ask for a fresh confirmation on a held transfer whose challenge lapsed.
   *
   * Returns the same shape as `detail`, so the app re-renders the prompt from one field rather
   * than merging a challenge into state it already holds — the same reasoning that made
   * `confirmStepUp` return `presentWithStepUp` on success.
   */
  @Post(TRANSFER_ROUTES.REQUEST_STEP_UP)
  async requestStepUp(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const transaction = await this.orchestrator.reissueStepUp(user.id, id)
    const presented = await this.presentWithStepUp(user.id, transaction)
    return ResponseBuilder.success(
      presented,
      presented.stepUp
        ? messageForStepUp(presented.stepUp.method)
        : this.messageFor(presented),
    )
  }

  @Post(TRANSFER_ROUTES.CONFIRM_STEP_UP)
  async confirmStepUp(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(VerifyStepUpSchema)) dto: VerifyStepUpDto,
  ) {
    const transaction = await this.orchestrator.resumeAfterStepUp(
      user.id,
      id,
      dto.nonce,
      dto.answer,
    )

    /**
     * `presentWithStepUp`, not `present`, even though the challenge just passed.
     *
     * It resolves to `stepUp: null` here, and that null is the POINT: the app renders the
     * challenge sheet from this field, so returning the plain shape would leave the client
     * unable to tell that the challenge is spent. One shape for the whole lifecycle means the
     * sheet closes because the data says it should, not because the screen guessed.
     */
    const presented = await this.presentWithStepUp(user.id, transaction)
    return ResponseBuilder.success(presented, this.messageFor(presented))
  }

  /** Raise a UDIR dispute against a payment. */
  @Post(TRANSFER_ROUTES.DISPUTE)
  async dispute(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    // Pre-built in the schema package, NOT derived here with `.omit()`. Zod 4 throws on `.omit()`
    // against a refined object, and it throws at module load — so the version of this line that
    // reads `RaiseDisputeSchema.omit(...)` prevents the entire application from starting.
    @Body(new ZodValidationPipe(RaiseDisputeBodySchema))
    dto: RaiseDisputeBodyDto,
  ) {
    const created = await this.disputes.raise(user.id, {
      ...dto,
      transactionId: id,
    })

    return ResponseBuilder.success(
      {
        id: created.id,
        kind: created.kind,
        status: created.status,
        slaDueAt: created.slaDueAt,
        createdAt: created.createdAt,
      },
      "We've raised your dispute and will come back to you",
    )
  }

  // ── shared ────────────────────────────────────────────────────────────────
  private async owned(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, userId },
    })
    // 404, not 403: someone else's transaction id must not be confirmed to exist.
    if (!transaction) throw new NotFoundException('Payment not found')
    return transaction
  }

  /**
   * The client-facing shape.
   *
   * `railMessage` is the rail's code translated into something a person can act on. "U30"
   * tells a user nothing; "your bank could not complete this, please try again" tells them
   * exactly what to try, and prevents a support call.
   */
  private present(transaction: Parameters<WalletService['describe']>[0]) {
    const classification = transaction.railCode
      ? classifyRailCode(transaction.railCode)
      : null

    return {
      ...this.wallet.describe(transaction),
      isFinal: !isInFlight(transaction.status),
      railMessage: classification?.userMessage ?? null,
      canRetry: Boolean(classification?.retryable),
    }
  }

  /**
   * The presented transaction, plus the M6 challenge when one is waiting on the user.
   *
   * ## Why this is a separate, async wrapper rather than part of `present`
   *
   * `present` is synchronous and pure, and it is called from `receipt` and from inside the
   * idempotency callback. Making it async to add one conditional lookup would put a database
   * round trip on every list row and every receipt render, for a field only a `RISK_HELD`
   * transaction can have. So the lookup is opt-in and guarded by the status.
   *
   * ## Why `RISK_HELD` alone is not enough to decide
   *
   * `RISK_HELD` covers BOTH outcomes: a `HOLD` waiting on an analyst, and a `STEP_UP` waiting
   * on the user. They are the same state on purpose — M4 has exactly one "money not yet moved"
   * state and a second would have to be taught to every reconciler and scheduler. The presence
   * of a live challenge is what distinguishes them, which is precisely why the client needs
   * this field: without it the app cannot tell "confirm this yourself" from "we are reviewing
   * it", and would show the wrong one to everybody.
   */
  private async presentWithStepUp(
    userId: string,
    transaction: Parameters<WalletService['describe']>[0] & {
      idempotencyKey: string
    },
  ) {
    const presented = this.present(transaction)

    if (transaction.status !== TxnStatus.RISK_HELD) {
      return { ...presented, stepUp: null }
    }

    /**
     * Scoped to the transfer's IDEMPOTENCY KEY, not its id.
     *
     * That is what the orchestrator issued the challenge against, because a retry arrives with
     * the same key and re-scores before any row is loaded. Looking it up by transaction id here
     * would find nothing and silently present every stepped-up transfer as an analyst hold.
     */
    const pending = await this.stepUp.pendingFor({
      userId,
      purpose: StepUpPurpose.TRANSACTION,
      subjectId: transaction.idempotencyKey,
    })

    return {
      ...presented,
      stepUp: pending
        ? {
            nonce: pending.nonce,
            method: pending.method,
            expiresAt: pending.expiresAt,
            attemptsRemaining: pending.attemptsRemaining,
          }
        : null,
    }
  }

  private messageFor(presented: { status: string }): string {
    switch (presented.status) {
      case 'SUCCESS':
        return 'Payment successful'
      case 'RISK_HELD':
        return "We're reviewing this payment for your safety. We'll be in touch shortly."
      case 'FAILED':
        return 'That payment could not be completed'
      case 'DEEMED':
        return "We're still confirming this with the payment network. Your money is safe."
      default:
        return "Payment submitted — we'll confirm as soon as the network does"
    }
  }
}

/**
 * The prompt matching the factor actually issued on a transfer.
 *
 * Duplicated from the fraud controller's equivalent rather than shared, and deliberately: these
 * are user-facing strings for two different surfaces, and a shared helper would mean a copy change
 * for the payment prompt silently rewording the generic security one. Wording is not logic.
 */
function messageForStepUp(method: StepUpMethod): string {
  switch (method) {
    case StepUpMethod.PIN_REAUTH:
      return 'Enter your Pravaah PIN to send this payment'
    case StepUpMethod.BIOMETRIC:
      return 'Confirm with your fingerprint or face to send this payment'
    default:
      return 'Enter the code we sent you to send this payment'
  }
}
