import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { CreateTransferDto } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { MuleGraphService } from '@/modules/fraud/services/mule-graph.service'
import { StepUpService } from '@/modules/fraud/services/step-up.service'
import { subMinor } from '@/modules/payments/money.util'
import {
  DEEMED_AFTER_MS,
  OWNER_TYPE,
  PLATFORM_OWNER,
} from '@/modules/payments/payments.config'
import {
  canTransition,
  corridorFor,
  hasFundsInSuspense,
  hasStatusCheckBudget,
  isSettled,
  nextPollAt,
  railFor,
} from '@/modules/payments/payments.state'
import {
  inboundCreditPlan,
  recoveryPlan,
  reservePlan,
  reverseReservePlan,
  settlePlan,
  type TransactionAccounts,
  type TransferAmounts,
} from '@/modules/payments/posting-plan'
import { BeneficiaryService } from '@/modules/payments/services/beneficiary.service'
import { FxService } from '@/modules/payments/services/fx.service'
import {
  LedgerService,
  isDuplicatePostingError,
  isUniqueViolation,
} from '@/modules/payments/services/ledger.service'
import { LimitService } from '@/modules/payments/services/limit.service'
import { PaymentRiskService } from '@/modules/payments/services/payment-risk.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { classifyRailCode } from '@/modules/payments/providers/upi-response-codes'
import { maskHandle } from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  AccountType,
  ActorType,
  Corridor,
  KycStatus,
  LedgerLeg,
  PaymentRail,
  Prisma,
  StepUpPurpose,
  TxnStatus,
  TxnType,
  type Beneficiary,
  type Transaction,
} from 'generated/prisma/client'

/** The rail's answer, normalised so every caller reasons about it identically. */
export interface RailOutcomeInput {
  status: 'SUCCESS' | 'FAILED' | 'PENDING'
  railCode?: string | null
  utr?: string | null
  amountMinor?: bigint | null
}

/**
 * The transfer saga.
 *
 * ```
 *  create ─▶ VALIDATED ─▶ RESERVED ─▶ SUBMITTED ─▶ PENDING ─▶ SUCCESS
 *              │             │            └──────────┴──▶ FAILED ─▶ (REVERSED)
 *              │             └──▶ REVERSED                   │
 *              ├──▶ RISK_HELD                                └──▶ SUCCESS  ← late settlement
 *              └──▶ FAILED
 * ```
 *
 * Five rules run through every method here, and they are the whole design:
 *
 *  1. **Money moves inside a database transaction, or it does not move.** Every ledger
 *     posting commits together with the status change that justifies it. A settlement
 *     whose entries committed and whose status did not is a transaction the reconciler
 *     will settle again.
 *  2. **The reserve is taken under a row lock.** Prisma's transactions run at READ
 *     COMMITTED, so two concurrent transfers would both read the same balance and both
 *     spend it. `lockWalletAndBalance` is what makes the check atomic with the spend.
 *  3. **A transport failure is not a rail rejection.** If we do not know whether the
 *     rail received the request, the reserve is HELD and the submit is retried with the
 *     same idempotency key. Releasing it would refund a sender whose payment is settling.
 *  4. **Every write is idempotent at the database level.** The ledger's unique
 *     constraint, not a status check, is what stops two concurrent webhooks from
 *     crediting a beneficiary twice — both read `PENDING` before either writes.
 *  5. **The rail's answer outranks ours.** {@link applyRailOutcome} will move a FAILED
 *     transaction to SUCCESS, because a payment we gave up on that actually settled is
 *     the most expensive event in payments and the only defence is being willing to
 *     correct ourselves.
 */
@Injectable()
export class TransferOrchestratorService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly limits: LimitService,
    private readonly fx: FxService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly handles: UpiHandleService,
    private readonly risk: PaymentRiskService,
    /**
     * M6's step-up orchestration, for the medium-risk band.
     *
     * Before M6 this module had two outcomes — proceed, or park for an analyst. A
     * dynamic second factor is the third, and it is the one the RBI mandate effective
     * 1 April 2026 requires on digital payments.
     */
    private readonly stepUp: StepUpService,
    /** M6's link graph, so each payee pairing becomes a mule-detection edge. */
    private readonly graph: MuleGraphService,
    private readonly providers: PaymentProviderFactory,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: TransferOrchestratorService.name })
  }

  // ── create ────────────────────────────────────────────────────────────────
  /**
   * Validate everything, then drive the saga.
   *
   * Ordered so that nothing irreversible happens until everything reversible has
   * passed. Eligibility, the payee, the price, the name confirmation, the limits and the
   * risk score are all checked BEFORE a single ledger entry exists — so the common
   * rejection is a clean 4xx with no transaction to explain, rather than a row the user
   * watches fail.
   */
  async create(
    userId: string,
    dto: CreateTransferDto,
    context: { idempotencyKey: string; ipAddress?: string | null },
  ): Promise<Transaction> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kycStatus: true, isSuspended: true },
    })
    if (!user) throw new NotFoundException('User not found')

    /**
     * Eligibility, first.
     *
     * A suspended account must not move money for any reason, and an unverified one must
     * not move money at all — an unverified identity sending funds abroad is precisely
     * what AML rules exist to prevent.
     */
    if (user.isSuspended) {
      throw new ForbiddenException(
        'Your account is on hold. Please contact support.',
      )
    }
    if (user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException(
        'Complete your identity verification before sending money',
      )
    }

    // The quote decides the currencies, and therefore the corridor. Never the client.
    const quote = await this.fx.requireLive(userId, dto.quoteId)
    this.fx.assertExpectedTotal(quote, dto.expectedTotalDebitMinor)

    const corridor = corridorFor(quote.sourceCurrency, quote.destCurrency)
    const beneficiary = await this.beneficiaries.assertPayable(
      userId,
      dto.beneficiaryId,
      corridor,
    )
    this.beneficiaries.assertNameConfirmed(
      beneficiary,
      dto.confirmedRegisteredName,
    )

    if (beneficiary.currency !== quote.destCurrency) {
      throw new BadRequestException(
        `This payee is credited in ${beneficiary.currency}, but that price is for ${quote.destCurrency}`,
      )
    }

    const limitBasis = this.limits.limitBasis(corridor, {
      sourceCurrency: quote.sourceCurrency,
      destCurrency: quote.destCurrency,
      totalDebitMinor: quote.totalDebitMinor,
      destAmount: quote.destAmount,
    })

    // Pre-flight: fail early and with the number the user needs, before any row exists.
    await this.limits.assertWithin({
      userId,
      corridor,
      amountMinor: limitBasis.amountMinor,
      beneficiaryId: beneficiary.id,
    })

    const assessment = await this.risk.score({
      userId,
      corridor,
      beneficiary,
      totalDebitMinor: quote.totalDebitMinor,
      limitAmountMinor: limitBasis.amountMinor,
      dailyCapMinor: this.limits.policy(corridor).dailyValueMinor,
      deviceId: dto.deviceId,
      ipAddress: context.ipAddress,
      geoHint: dto.geoHint,
    })

    /**
     * A STEP_UP that has already been satisfied proceeds as an ALLOW.
     *
     * Checked BEFORE the insert, so a user who answered their challenge and retried does
     * not create a second held transaction. The challenge is scoped to this
     * `Idempotency-Key` rather than to the user, which is what stops a challenge passed for
     * a ₹100 transfer from authorising a ₹100,000 one — the confused-deputy shape
     * `StepUpService.verify` refuses at the other end.
     */
    const stepUpSatisfied =
      assessment.stepUp &&
      (await this.stepUp.hasPassed({
        userId,
        purpose: StepUpPurpose.TRANSACTION,
        subjectId: context.idempotencyKey,
      }))

    const transaction = await this.insertTransaction({
      userId,
      dto,
      quote,
      corridor,
      beneficiary,
      assessment,
      context,
      stepUpSatisfied,
    })

    /**
     * Observe the payee as a graph edge.
     *
     * Fire-and-forget, after the row exists. This is what makes the fan-in mule pattern
     * visible later: twenty accounts paying three beneficiaries is only detectable if each
     * payment recorded the pairing. Not awaited on the critical path — a graph edge is
     * intelligence, and failing a legitimate transfer to record one would be the wrong
     * trade.
     */
    void this.graph
      .observeBeneficiary(userId, beneficiary.handle)
      .catch((error: unknown) => {
        this.logger.warn(
          `[${this.create.name}] Failed to record a beneficiary graph edge`,
          { err: error },
        )
      })

    if (transaction.status === TxnStatus.RISK_HELD) {
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'txn.risk_held',
        entity: 'Transaction',
        entityId: transaction.id,
        metadata: {
          score: assessment.value,
          flags: assessment.flags,
          decision: assessment.decision,
          assessmentId: assessment.assessmentId,
          caseId: assessment.caseId,
        },
      })
      return transaction
    }

    /**
     * An unsatisfied STEP_UP parks the transfer and issues a challenge.
     *
     * Parked in `RISK_HELD` — the same state a HOLD uses — because M4 has exactly one
     * "money not yet moved, waiting on a decision" state and inventing a second would mean
     * every reconciler, scheduler and admin query had to learn about it. What differs is
     * the ROUTE OUT: a HOLD waits for an analyst, whereas this one is released the moment
     * the user answers, without anybody being paged.
     *
     * The challenge is issued AFTER the insert so it can be scoped to a real transaction,
     * and the transfer is returned rather than thrown — the client needs the transaction id
     * to poll and the nonce to answer, and an exception carries neither.
     */
    if (assessment.stepUp && !stepUpSatisfied) {
      const challenge = await this.stepUp.issue({
        userId,
        purpose: StepUpPurpose.TRANSACTION,
        /**
         * Scoped to the IDEMPOTENCY KEY, not the transaction id.
         *
         * The retry arrives with the same key and re-scores before any row is loaded, so
         * `hasPassed` above is checked against something the client can reproduce. Scoping
         * to the transaction id would work only if the client retried against that id, which
         * the idempotent-create contract does not require it to do.
         */
        subjectId: context.idempotencyKey,
        assessmentId: assessment.assessmentId,
        reason: assessment.reasons[0] ?? 'Please confirm this payment.',
      })

      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: TxnStatus.RISK_HELD,
          failureReason: 'Awaiting your confirmation',
        },
      })

      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'txn.step_up_required',
        entity: 'Transaction',
        entityId: transaction.id,
        metadata: {
          score: assessment.value,
          flags: assessment.flags,
          challengeNonce: challenge.nonce,
        },
      })

      this.logger.warn(`[${this.create.name}] Transfer awaiting a step-up`, {
        transactionId: transaction.id,
        score: assessment.value,
      })

      return this.load(transaction.id)
    }

    return this.drive(transaction.id)
  }

  /**
   * Continue a transfer whose step-up has just passed.
   *
   * The release path for a `RISK_HELD` transaction that was waiting on the USER rather than
   * on an analyst. It re-enters the saga through `resolveRiskHold`, so the limits and the
   * balance are re-checked exactly as they are for an analyst release — a challenge answered
   * twenty minutes later must not skip a check made before the wait.
   */
  /**
   * Re-issue a lapsed step-up on a held transfer.
   *
   * ## Distinguishing a step-up hold from an analyst hold, which is the whole difficulty
   *
   * `RISK_HELD` covers both, and they need opposite handling: a step-up hold is waiting for the
   * USER, an analyst hold for a HUMAN REVIEWER. Minting a challenge for an analyst hold would be
   * actively harmful — it would let the account holder release, with a code, a payment a reviewer
   * had deliberately stopped. That is the confused-deputy shape M6 exists to prevent, arrived at
   * from inside the module.
   *
   * They are told apart by evidence rather than by a flag: a transfer that was ever stepped up
   * HAS a `StepUpChallenge` row against its idempotency key. An analyst hold has none, because
   * nothing ever challenged it. So the presence of a prior challenge is the authorisation to mint
   * another, and its absence is a refusal.
   *
   * ## Why a FAILED challenge does not qualify
   *
   * A challenge that failed had its attempts exhausted. Re-issuing on top would convert a
   * three-guess cap into an unlimited one, three at a time — the exact bypass the per-challenge
   * cap exists to close. Those users go through the cross-challenge lockout in
   * `StepUpService.issue`, and the honest answer is that they wait or contact support.
   */
  async reissueStepUp(
    userId: string,
    transactionId: string,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)

    if (transaction.userId !== userId) {
      throw new NotFoundException('No such payment')
    }
    if (transaction.status !== TxnStatus.RISK_HELD) {
      throw new ConflictException('That payment is not awaiting confirmation')
    }

    const live = await this.stepUp.pendingFor({
      userId,
      purpose: StepUpPurpose.TRANSACTION,
      subjectId: transaction.idempotencyKey,
    })
    /**
     * A live challenge is returned as-is rather than replaced.
     *
     * `issue` expires the previous challenge for the same subject, so minting here would kill a
     * code the user may be halfway through typing — and on a double tap, kill the one it just
     * sent. Idempotent-while-live is the only safe shape for a button.
     */
    if (live) return transaction

    const history = await this.stepUp.historyFor({
      userId,
      purpose: StepUpPurpose.TRANSACTION,
      subjectId: transaction.idempotencyKey,
    })

    if (!history.everChallenged) {
      throw new ConflictException(
        'That payment is under review. We will be in touch shortly.',
      )
    }
    if (history.exhausted) {
      throw new ConflictException(
        'Too many incorrect attempts on this payment. Please contact support.',
      )
    }

    await this.stepUp.issue({
      userId,
      purpose: StepUpPurpose.TRANSACTION,
      subjectId: transaction.idempotencyKey,
      reason: 'Confirm this payment to send it.',
    })

    return transaction
  }

  async resumeAfterStepUp(
    userId: string,
    transactionId: string,
    nonce: string,
    answer: string,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)

    if (transaction.userId !== userId) {
      throw new NotFoundException('No such payment')
    }
    if (transaction.status !== TxnStatus.RISK_HELD) {
      throw new ConflictException('That payment is not awaiting confirmation')
    }

    await this.stepUp.verify({
      userId,
      nonce,
      answer,
      expectedPurpose: StepUpPurpose.TRANSACTION,
      /**
       * The challenge's subject is the idempotency key the transfer was created with, so
       * it is read off the row rather than taken from the caller. A caller-supplied subject
       * would let somebody redeem a challenge against a different transfer.
       */
      expectedSubjectId: transaction.idempotencyKey,
    })

    return this.resolveRiskHold(
      transactionId,
      'RELEASE',
      { type: ActorType.USER, id: userId },
      'Confirmed by the account holder with a second factor',
    )
  }

  /**
   * Insert the transaction row and burn the quote, atomically.
   *
   * Together, because a consumed quote with no transaction would strand the user's
   * price, and a transaction with an unconsumed quote would let the same locked rate
   * fund a second transfer.
   *
   * A unique violation on `idempotencyKey` is NOT an error: it means a previous attempt
   * created this row and then died — most likely the process crashed after the insert,
   * and the idempotency lock was later reclaimed. The existing row is returned so the
   * saga resumes rather than restarting.
   */
  private async insertTransaction(params: {
    userId: string
    dto: CreateTransferDto
    quote: Awaited<ReturnType<FxService['requireLive']>>
    corridor: Corridor
    beneficiary: Beneficiary
    assessment: Awaited<ReturnType<PaymentRiskService['score']>>
    context: { idempotencyKey: string; ipAddress?: string | null }
    /** True when a challenge for this idempotency key has already been answered. */
    stepUpSatisfied?: boolean
  }): Promise<Transaction> {
    const { userId, dto, quote, corridor, beneficiary, assessment, context } =
      params

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.fx.consume(tx, quote.id)

        return tx.transaction.create({
          data: {
            userId,
            type: dto.type,
            corridor,
            rail: railFor(corridor, beneficiary.handleType),
            /**
             * A held transfer starts in `RISK_HELD`; everything else starts VALIDATED.
             *
             * A pending STEP_UP is deliberately NOT reflected here. The row is created
             * VALIDATED and moved to `RISK_HELD` by the caller once the challenge has been
             * issued, because the two must happen together: a row parked before its
             * challenge exists is one the user has no way to release, and a crash between
             * the two would strand it exactly there.
             */
            status: assessment.hold ? TxnStatus.RISK_HELD : TxnStatus.VALIDATED,

            sourceCurrency: quote.sourceCurrency,
            destCurrency: quote.destCurrency,
            sourceAmount: quote.sourceAmount,
            destAmount: quote.destAmount,
            feeMinor: quote.feeMinor,
            taxMinor: quote.taxMinor,
            totalDebitMinor: quote.totalDebitMinor,
            fxQuoteId: quote.id,
            fxRateE8: quote.rateE8,

            beneficiaryId: beneficiary.id,
            // Snapshotted, so a receipt six months from now names the payee as they
            // were when the money moved rather than as the row reads today.
            counterpartyHandle: beneficiary.handle,
            counterpartyName: beneficiary.registeredName,

            purposeCode: dto.purposeCode,
            mcc: dto.mcc ?? null,
            narration: dto.narration ?? null,

            idempotencyKey: context.idempotencyKey,
            provider: this.providers.nameFor(corridor),

            riskScore: assessment.value,
            riskFlags: assessment.flags,

            deviceId: dto.deviceId ?? null,
            ipAddress: context.ipAddress ?? null,
            passportRef: dto.passportRef ?? null,
          },
        })
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.prisma.transaction.findUnique({
          where: { idempotencyKey: context.idempotencyKey },
        })
        if (existing) {
          this.logger.warn(
            `[${this.insertTransaction.name}] Resuming a transfer a previous attempt had already created`,
            { transactionId: existing.id, status: existing.status },
          )
          return existing
        }
      }
      throw error
    }
  }

  /**
   * Create a transaction that does not come from a user-facing quote.
   *
   * Used by the flows where a quote would be friction with no benefit — a withdrawal to
   * one's own account, a topup, an AutoPay debit. In each of those the price IS the
   * amount: same currency, no FX, no fee, so there is nothing to lock and nothing for the
   * user to have been shown incorrectly.
   *
   * It still goes through the same saga, the same ledger, the same limits and the same
   * reconciliation. The quote is the only thing skipped, and only where it would be an
   * identity function.
   */
  async createRaw(params: {
    userId: string
    type: TxnType
    direction?: 'OUTBOUND' | 'INBOUND'
    currency: string
    amountMinor: bigint
    counterpartyHandle: string
    counterpartyName?: string | null
    beneficiaryId?: string | null
    purposeCode: string
    narration?: string | null
    idempotencyKey: string
    status?: TxnStatus
    deviceId?: string | null
    ipAddress?: string | null
    /**
     * Override the rail. Only `INTERNAL` is a legitimate value here, and only for
     * a movement that genuinely never reaches a PSP — M5's premium collection and
     * claim payout move between a holder's wallet and the platform's own
     * insurance float.
     *
     * It matters because the default would label those rows `UPI`. A ledger move
     * recorded as a UPI payment is one the reconciler will eventually ask the
     * rail about, and the rail will answer "unknown reference" — which marks a
     * settled premium DEEMED and parks it for a human who has nothing to check
     * it against.
     */
    rail?: PaymentRail
  }): Promise<Transaction> {
    const corridor = Corridor.DOMESTIC
    const rail = params.rail ?? railFor(corridor, 'UPI_VPA')

    try {
      return await this.prisma.transaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          direction: params.direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND',
          corridor,
          rail,
          status: params.status ?? TxnStatus.VALIDATED,

          sourceCurrency: params.currency,
          destCurrency: params.currency,
          sourceAmount: params.amountMinor,
          destAmount: params.amountMinor,
          feeMinor: 0n,
          taxMinor: 0n,
          totalDebitMinor: params.amountMinor,
          // Exactly 1:1, recorded rather than left null so a refund of this transaction
          // has a rate to size its far leg with.
          fxRateE8: 100_000_000n,

          beneficiaryId: params.beneficiaryId ?? null,
          counterpartyHandle: params.counterpartyHandle,
          counterpartyName: params.counterpartyName ?? null,

          purposeCode: params.purposeCode,
          narration: params.narration ?? null,

          idempotencyKey: params.idempotencyKey,
          provider: rail,

          deviceId: params.deviceId ?? null,
          ipAddress: params.ipAddress ?? null,
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.prisma.transaction.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
        })
        if (existing) return existing
      }
      throw error
    }
  }

  /**
   * Credit money that has ARRIVED — a topup, or an approved collect.
   *
   * The mirror of a payout and much simpler, because there is nothing to reserve: the
   * funds are already ours by the time the rail tells us. One balanced posting from the
   * external account into the wallet, and the transaction closes.
   */
  async settleInbound(
    transactionId: string,
    outcome: RailOutcomeInput = { status: 'SUCCESS' },
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)
    if (transaction.status === TxnStatus.SUCCESS) return transaction
    if (!canTransition(transaction.status, TxnStatus.SUCCESS)) {
      this.logger.warn(
        `[${this.settleInbound.name}] Refusing to credit from an illegal state`,
        { transactionId, status: transaction.status },
      )
      return transaction
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const wallet = await this.ledger.userWallet(
          transaction.userId,
          transaction.destCurrency,
          tx,
        )
        const external = await this.ledger.ensureAccount(
          OWNER_TYPE.EXTERNAL,
          transaction.beneficiaryId ?? PLATFORM_OWNER,
          AccountType.EXTERNAL,
          transaction.destCurrency,
          tx,
        )

        await this.ledger.post(
          tx,
          transaction.id,
          inboundCreditPlan(
            { external: external.id, wallet: wallet.id },
            transaction.destCurrency,
            transaction.destAmount,
          ),
        )
        await this.transition(tx, transaction, TxnStatus.SUCCESS, {
          completedAt: new Date(),
          railCode: outcome.railCode ?? transaction.railCode,
          utr: outcome.utr ?? transaction.utr,
          nextPollAt: null,
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        this.logger.warn(
          `[${this.settleInbound.name}] Inbound credit already posted concurrently`,
          { transactionId },
        )
        return this.load(transactionId)
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'txn.credited',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { type: transaction.type },
    })
    return this.load(transactionId)
  }

  // ── drive ─────────────────────────────────────────────────────────────────
  /**
   * Move a transaction as far forward as it can go, from wherever it is.
   *
   * Re-entrant on purpose. The recovery scheduler calls it on rows stuck mid-saga after
   * a crash, and each step is guarded by its own precondition — so calling it twice on
   * the same transaction does the work once.
   */
  async drive(transactionId: string): Promise<Transaction> {
    let transaction = await this.load(transactionId)

    if (transaction.status === TxnStatus.VALIDATED) {
      transaction = await this.reserve(transaction)
    }
    if (transaction.status === TxnStatus.RESERVED) {
      transaction = await this.submit(transaction)
    }
    return transaction
  }

  /**
   * RESERVE — take the money out of the wallet before touching a rail.
   *
   * Everything in one database transaction, under a row lock on the wallet:
   *
   *  1. Lock the wallet and read its balance. The lock is what makes this safe — without
   *     it, two concurrent transfers both read the same balance, both pass the check, and
   *     the wallet goes negative. READ COMMITTED does not prevent that; the lock does.
   *  2. Re-check the sliding new-payee window INSIDE the lock. All of one user's
   *     transfers in a currency serialise on the same wallet row, which is what makes a
   *     sliding-window check race-free here even though it cannot be a counter.
   *  3. Consume the limit, atomically.
   *  4. Post the reserve.
   *  5. Flip the status.
   *
   * If any step throws, all of it rolls back — including the limit consumption.
   */
  private async reserve(transaction: Transaction): Promise<Transaction> {
    const limitBasis = this.limits.limitBasis(transaction.corridor, transaction)

    try {
      await this.prisma.$transaction(async (tx) => {
        const { account: wallet, balance } =
          await this.ledger.lockWalletAndBalance(
            tx,
            transaction.userId,
            transaction.sourceCurrency,
          )

        if (balance < transaction.totalDebitMinor) {
          throw new BadRequestException(
            'Not enough balance in your Pravaah wallet for this payment',
          )
        }

        if (transaction.beneficiaryId) {
          await this.limits.assertNewBeneficiaryWindow({
            userId: transaction.userId,
            corridor: transaction.corridor,
            beneficiaryId: transaction.beneficiaryId,
            amountMinor: limitBasis.amountMinor,
          })
        }

        await this.limits.consume(
          {
            userId: transaction.userId,
            corridor: transaction.corridor,
            amountMinor: limitBasis.amountMinor,
          },
          tx,
        )

        const suspense = await this.ledger.platformAccount(
          AccountType.SUSPENSE,
          transaction.sourceCurrency,
          tx,
        )
        await this.ledger.post(
          tx,
          transaction.id,
          reservePlan(
            { walletSrc: wallet.id, suspenseSrc: suspense.id },
            transaction,
          ),
        )

        await this.transition(tx, transaction, TxnStatus.RESERVED)
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        // Another worker reserved it first. Not a failure — read the row back.
        this.logger.warn(
          `[${this.reserve.name}] Reserve already posted by a concurrent attempt`,
          { transactionId: transaction.id },
        )
        return this.load(transaction.id)
      }

      /**
       * A validation failure at reserve time — insufficient balance, a limit reached
       * between the pre-flight check and now.
       *
       * Nothing was submitted, so the transaction is FAILED with no compensation needed:
       * the whole database transaction rolled back, which means the reserve never
       * happened and the limit was never consumed.
       */
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        await this.markFailed(
          transaction.id,
          error.message,
          null,
          TxnStatus.FAILED,
        )
        throw error
      }
      throw error
    }

    return this.load(transaction.id)
  }

  /**
   * SUBMIT — hand the payment to the rail.
   *
   * The riskiest moment in the module, because there are three possible outcomes and two
   * of them look the same from here:
   *
   *  - **The rail accepted it.** Persist the reference, move to PENDING/SUBMITTED, and
   *    let settlement arrive by webhook or poll.
   *  - **The rail refused it.** A rail code that classifies as a definite failure. Release
   *    the reserve; the sender is whole.
   *  - **We do not know.** A timeout, a connection reset, a 5xx. The request may have
   *    been received and may be settling RIGHT NOW.
   *
   * The third case is where money is lost, and the answer is to do nothing destructive:
   * the reserve is HELD and the submit is retried later with the SAME idempotency key,
   * which the rail treats as the same payment. That key is also why a crash between the
   * HTTP call and persisting `railRef` is survivable — a re-submit returns the original
   * reference rather than creating a second payment.
   */
  private async submit(transaction: Transaction): Promise<Transaction> {
    const provider = this.providers.byName(transaction.provider)
    const beneficiary = transaction.beneficiaryId
      ? await this.prisma.beneficiary.findUnique({
          where: { id: transaction.beneficiaryId },
        })
      : null

    const payerVpa =
      (await this.handles.primary(transaction.userId))?.vpa ?? null

    const result = await provider.submitPayout({
      // The rail's own dedupe key. See the method comment.
      idempotencyKey: transaction.idempotencyKey,
      transactionId: transaction.id,
      payeeHandle: transaction.counterpartyHandle,
      payeeHandleType: beneficiary?.handleType ?? 'UPI_VPA',
      payeeName: transaction.counterpartyName,
      amountMinor: transaction.destAmount,
      currency: transaction.destCurrency,
      purposeCode: transaction.purposeCode,
      narration: transaction.narration,
      mcc: transaction.mcc,
      payerVpa,
      traceId: transaction.id,
    })

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { submittedAt: new Date() },
    })

    if (!result.ok) {
      const { retryable, message, code } = result.error

      if (retryable) {
        /**
         * We do not know. Hold everything.
         *
         * The transaction stays RESERVED with a poll time set, so the recovery scheduler
         * re-submits under the same key. After the status-check budget is exhausted it
         * becomes DEEMED and a human decides — which is a worse outcome for our
         * operations team and a far better one for the customer's money than guessing.
         */
        this.logger.error(
          `[${this.submit.name}] Rail did not answer — holding the reserve and retrying`,
          { transactionId: transaction.id, code },
        )
        await this.prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            failureReason: `Awaiting rail confirmation: ${message}`,
            statusCheckCount: { increment: 1 },
            nextPollAt: nextPollAt(transaction.statusCheckCount),
          },
        })
        return this.load(transaction.id)
      }

      // A deterministic rejection — the rail refused the request itself. Nothing is in
      // flight, so the reserve comes back.
      await this.releaseReserve(transaction.id, message, null, TxnStatus.FAILED)
      return this.load(transaction.id)
    }

    const submitted = result.value
    const classification = classifyRailCode(submitted.railCode)

    // Persist the reference FIRST, so a crash on the next line still leaves the payment
    // trackable.
    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        railRef: submitted.railRef,
        utr: submitted.utr ?? null,
        railCode: submitted.railCode ?? null,
      },
    })

    if (
      classification.outcome === 'FAILED_TERMINAL' ||
      classification.outcome === 'FAILED_RETRYABLE'
    ) {
      // The rail took the message and said no. A definite answer, so release.
      await this.releaseReserve(
        transaction.id,
        classification.userMessage,
        submitted.railCode ?? null,
        TxnStatus.FAILED,
      )
      return this.load(transaction.id)
    }

    if (
      submitted.status === 'SUCCESS' &&
      classification.outcome === 'SUCCESS'
    ) {
      await this.transitionStandalone(transaction.id, TxnStatus.SUBMITTED)
      await this.applyRailOutcome(transaction.id, {
        status: 'SUCCESS',
        railCode: submitted.railCode,
        utr: submitted.utr,
      })
      return this.load(transaction.id)
    }

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status:
          submitted.status === 'PENDING'
            ? TxnStatus.PENDING
            : TxnStatus.SUBMITTED,
        nextPollAt: nextPollAt(transaction.statusCheckCount),
      },
    })
    return this.load(transaction.id)
  }

  // ── the rail's answer ─────────────────────────────────────────────────────
  /**
   * Apply what the rail says. THE single entry point for every settlement decision.
   *
   * Webhooks, status polls, statement reconciliation and admin resolutions all come
   * through here, and that is deliberate: four callers with four copies of "when may a
   * transaction settle?" would eventually disagree, and the disagreement would be a
   * double credit.
   *
   * Idempotent at three levels — the status guard, the state machine, and the ledger's
   * unique constraint. Only the last of those actually holds under concurrency, which is
   * why it exists.
   */
  async applyRailOutcome(
    transactionId: string,
    outcome: RailOutcomeInput,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)
    const classification = classifyRailCode(outcome.railCode)

    // Prefer the code's classification over the bare status when the two disagree: a
    // vendor reporting "FAILED" with a timeout code has not actually failed.
    const effective =
      outcome.status === 'SUCCESS' || classification.outcome === 'SUCCESS'
        ? 'SUCCESS'
        : classification.outcome === 'DEEMED'
          ? 'DEEMED'
          : outcome.status

    switch (effective) {
      case 'SUCCESS':
        return this.settle(transactionId, outcome)

      case 'FAILED': {
        if (isSettled(transaction.status)) {
          /**
           * The rail now says FAILED for something we already settled.
           *
           * Never un-settled here. A settled payment can only be returned by a REFUND,
           * which is a new, balanced set of entries — silently flipping the status would
           * leave the beneficiary credited and the transaction reading as failed, and no
           * subsequent reconciliation could tell which was true.
           */
          this.logger.error(
            `[${this.applyRailOutcome.name}] Rail reports FAILED for a settled transaction — needs a refund decision`,
            { transactionId, railCode: outcome.railCode },
          )
          return transaction
        }
        if (hasFundsInSuspense(transaction.status)) {
          await this.releaseReserve(
            transactionId,
            classification.userMessage,
            outcome.railCode ?? null,
            TxnStatus.FAILED,
          )
        } else if (canTransition(transaction.status, TxnStatus.FAILED)) {
          await this.markFailed(
            transactionId,
            classification.userMessage,
            outcome.railCode ?? null,
            TxnStatus.FAILED,
          )
        }
        return this.load(transactionId)
      }

      case 'DEEMED':
        return this.markDeemed(transactionId, outcome.railCode ?? null)

      default: {
        // Still pending. Record the code and schedule the next look.
        await this.prisma.transaction.update({
          where: { id: transactionId },
          data: {
            railCode: outcome.railCode ?? transaction.railCode,
            utr: outcome.utr ?? transaction.utr,
            nextPollAt: nextPollAt(transaction.statusCheckCount),
          },
        })
        return this.load(transactionId)
      }
    }
  }

  /**
   * SETTLE — book the fee, cross the currency, pay the beneficiary.
   *
   * One balanced posting set for the whole settlement, so a crash cannot leave a
   * transaction that booked our fee but never paid the payee — the worst partial state
   * available, because it looks like revenue.
   *
   * The branch at the top is the money-safety showpiece. If the transaction was already
   * REVERSED or REFUNDED, the money has genuinely left AND the sender has already been
   * made whole, so the settlement is booked as a RECOVERY against a receivable rather
   * than as a normal payout. Refusing to book it would break the trial balance, which is
   * the one alarm that must never be silenced.
   */
  async settle(
    transactionId: string,
    outcome: RailOutcomeInput = { status: 'SUCCESS' },
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)

    if (transaction.status === TxnStatus.SUCCESS) return transaction
    if (!canTransition(transaction.status, TxnStatus.SUCCESS)) {
      this.logger.warn(
        `[${this.settle.name}] Refusing to settle from an illegal state`,
        { transactionId, status: transaction.status },
      )
      return transaction
    }

    /**
     * The rail settled a DIFFERENT amount than we asked for.
     *
     * Rare and severe. Settling anyway would post entries that do not match the money
     * that actually moved; the row is escalated instead, with both figures recorded.
     */
    if (
      outcome.amountMinor !== undefined &&
      outcome.amountMinor !== null &&
      outcome.amountMinor !== transaction.destAmount
    ) {
      this.logger.error(
        `[${this.settle.name}] Rail settled a different amount — escalating instead of settling`,
        {
          transactionId,
          expected: transaction.destAmount.toString(),
          railReported: outcome.amountMinor.toString(),
        },
      )
      return this.markDeemed(
        transactionId,
        outcome.railCode ?? null,
        `Rail reported ${outcome.amountMinor.toString()} but we sent ${transaction.destAmount.toString()}`,
      )
    }

    const isRecovery =
      transaction.status === TxnStatus.REVERSED ||
      transaction.status === TxnStatus.REFUNDED

    try {
      await this.prisma.$transaction(async (tx) => {
        const accounts = await this.resolveTransactionAccounts(
          tx,
          transaction,
          {
            includeReceivable: isRecovery,
          },
        )
        const amounts = this.amountsOf(transaction)

        const postings = isRecovery
          ? recoveryPlan(accounts, amounts, transaction.id)
          : settlePlan(accounts, amounts, {
              payoutLeg:
                transaction.type === TxnType.WITHDRAWAL
                  ? LedgerLeg.WITHDRAW
                  : LedgerLeg.PAYOUT,
            })

        await this.ledger.post(tx, transaction.id, postings)
        await this.transition(tx, transaction, TxnStatus.SUCCESS, {
          completedAt: new Date(),
          railCode: outcome.railCode ?? transaction.railCode,
          utr: outcome.utr ?? transaction.utr,
          failureReason: null,
          nextPollAt: null,
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        /**
         * A concurrent settlement won.
         *
         * The expected outcome of two webhooks arriving together, not a bug: both read
         * PENDING, both decided to settle, and the unique constraint stopped the second
         * before it credited the beneficiary twice.
         */
        this.logger.warn(
          `[${this.settle.name}] Settlement already posted by a concurrent caller`,
          { transactionId },
        )
        return this.load(transactionId)
      }
      throw error
    }

    if (transaction.beneficiaryId) {
      await this.beneficiaries.touch(transaction.beneficiaryId)
    }
    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: isRecovery ? 'txn.recovered' : 'txn.settled',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: {
        railCode: outcome.railCode ?? null,
        utr: outcome.utr ?? null,
        recovery: isRecovery,
      },
    })

    this.logger.info(
      `[${this.settle.name}] ${isRecovery ? 'Recovered a late settlement' : 'Settled'}`,
      {
        transactionId,
        corridor: transaction.corridor,
        payee: maskHandle(transaction.counterpartyHandle),
      },
    )
    return this.load(transactionId)
  }

  /**
   * Release a reserve. The compensating transaction.
   *
   * Called when the rail definitely refused, or when a pre-submission step failed. The
   * limit is returned in the same database transaction, so a user whose payment did not
   * happen is not charged a day's quota for it.
   */
  async releaseReserve(
    transactionId: string,
    reason: string,
    railCode: string | null,
    toStatus: TxnStatus = TxnStatus.REVERSED,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)

    if (!hasFundsInSuspense(transaction.status)) {
      // Nothing is held. Either already released, or never reserved.
      return transaction
    }
    if (!canTransition(transaction.status, toStatus)) {
      this.logger.warn(
        `[${this.releaseReserve.name}] Refusing an illegal transition`,
        { transactionId, from: transaction.status, to: toStatus },
      )
      return transaction
    }

    const limitBasis = this.limits.limitBasis(transaction.corridor, transaction)

    try {
      await this.prisma.$transaction(async (tx) => {
        const wallet = await this.ledger.userWallet(
          transaction.userId,
          transaction.sourceCurrency,
          tx,
        )
        const suspense = await this.ledger.platformAccount(
          AccountType.SUSPENSE,
          transaction.sourceCurrency,
          tx,
        )

        await this.ledger.post(
          tx,
          transaction.id,
          reverseReservePlan(
            { walletSrc: wallet.id, suspenseSrc: suspense.id },
            transaction,
          ),
        )
        await this.limits.release(
          {
            userId: transaction.userId,
            corridor: transaction.corridor,
            amountMinor: limitBasis.amountMinor,
          },
          tx,
        )
        await this.transition(tx, transaction, toStatus, {
          failureReason: reason.slice(0, 500),
          railCode: railCode ?? transaction.railCode,
          completedAt: new Date(),
          nextPollAt: null,
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        this.logger.warn(
          `[${this.releaseReserve.name}] Reserve already released concurrently`,
          { transactionId },
        )
        return this.load(transactionId)
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'txn.reserve_released',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { reason, railCode, toStatus },
    })
    return this.load(transactionId)
  }

  /**
   * DEEMED — the rail never gave a final answer.
   *
   * The funds STAY in suspense. Nothing is released and nothing is credited, because the
   * one thing we know is that we do not know. A human resolves it against a bank
   * statement, and until then the money is visibly parked rather than invisibly assumed.
   *
   * Auto-failing here is the mistake this state exists to prevent: refund the sender, the
   * rail settles an hour later, and the beneficiary keeps a payment nobody funded.
   */
  async markDeemed(
    transactionId: string,
    railCode: string | null,
    detail?: string,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)
    if (transaction.status === TxnStatus.DEEMED) return transaction
    if (!canTransition(transaction.status, TxnStatus.DEEMED)) {
      return transaction
    }

    const updated = await this.prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: TxnStatus.DEEMED,
        railCode: railCode ?? transaction.railCode,
        failureReason:
          detail ??
          'The payment network has not confirmed this yet. Your money is safe while we check.',
        // Polling stops; a human takes over. Continuing to poll would spend a status
        // budget the rail has already declined to answer.
        nextPollAt: null,
      },
    })

    this.logger.error(
      `[${this.markDeemed.name}] Transaction DEEMED — funds held in suspense pending a human decision`,
      { transactionId, railCode, detail },
    )
    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'txn.deemed',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { railCode, detail: detail ?? null },
    })
    return updated
  }

  /** Mark failed with no ledger effect. Only for pre-reserve failures. */
  async markFailed(
    transactionId: string,
    reason: string,
    railCode: string | null,
    toStatus: TxnStatus = TxnStatus.FAILED,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)
    if (hasFundsInSuspense(transaction.status)) {
      // There is money to give back — this is the wrong tool.
      return this.releaseReserve(transactionId, reason, railCode, toStatus)
    }
    if (!canTransition(transaction.status, toStatus)) return transaction

    return this.prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: toStatus,
        failureReason: reason.slice(0, 500),
        railCode: railCode ?? transaction.railCode,
        completedAt: new Date(),
        nextPollAt: null,
      },
    })
  }

  // ── risk hold release ─────────────────────────────────────────────────────
  /**
   * Release or block a held transaction.
   *
   * Attributed, always. A hold anyone can clear with one tap and no note is not a
   * control, it is a delay.
   */
  async resolveRiskHold(
    transactionId: string,
    decision: 'RELEASE' | 'BLOCK',
    actor: { type: ActorType; id?: string | null },
    reason: string,
  ): Promise<Transaction> {
    const transaction = await this.load(transactionId)
    if (transaction.status !== TxnStatus.RISK_HELD) {
      throw new ConflictException('That payment is not on hold')
    }

    if (decision === 'BLOCK') {
      await this.markFailed(transactionId, reason, null, TxnStatus.FAILED)
      await this.audit.log({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'txn.risk_blocked',
        entity: 'Transaction',
        entityId: transactionId,
        metadata: { reason },
      })
      return this.load(transactionId)
    }

    /**
     * A released hold re-enters the saga at VALIDATED, not at RESERVED.
     *
     * The balance and the limits must be re-checked: a hold can sit for hours, and the
     * money may have been spent or the day's quota used in the meantime. Skipping
     * straight to the reserve would be trusting a check made before the delay.
     */
    await this.prisma.transaction.update({
      where: { id: transactionId },
      data: { status: TxnStatus.VALIDATED, failureReason: null },
    })
    await this.audit.log({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: 'txn.risk_released',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { reason },
    })
    return this.drive(transactionId)
  }

  // ── shared helpers ────────────────────────────────────────────────────────
  /**
   * Resolve every ledger account a transaction touches.
   *
   * The payee is the interesting one: when the beneficiary's address is one of OURS and
   * resolves to an active handle, the money never leaves the platform, so the payee
   * account is that user's WALLET rather than an external account. Booking an internal
   * transfer as external would show money leaving the building when it did not, and the
   * recipient's balance would never move.
   */
  async resolveTransactionAccounts(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    options: { includeReceivable?: boolean } = {},
  ): Promise<TransactionAccounts> {
    const sameCurrency = transaction.sourceCurrency === transaction.destCurrency

    const [walletSrc, suspenseSrc, feeSrc, fxSrc] = await Promise.all([
      this.ledger.userWallet(
        transaction.userId,
        transaction.sourceCurrency,
        tx,
      ),
      this.ledger.platformAccount(
        AccountType.SUSPENSE,
        transaction.sourceCurrency,
        tx,
      ),
      this.ledger.platformAccount(
        AccountType.PLATFORM_FEE,
        transaction.sourceCurrency,
        tx,
      ),
      this.ledger.platformAccount(
        AccountType.FX_POSITION,
        transaction.sourceCurrency,
        tx,
      ),
    ])

    const suspenseDst = sameCurrency
      ? suspenseSrc
      : await this.ledger.platformAccount(
          AccountType.SUSPENSE,
          transaction.destCurrency,
          tx,
        )
    const fxDst = sameCurrency
      ? fxSrc
      : await this.ledger.platformAccount(
          AccountType.FX_POSITION,
          transaction.destCurrency,
          tx,
        )

    const payee = await this.resolvePayeeAccount(tx, transaction)

    const receivableSrc = options.includeReceivable
      ? (
          await this.ledger.platformAccount(
            AccountType.RECEIVABLE,
            transaction.sourceCurrency,
            tx,
          )
        ).id
      : undefined

    return {
      walletSrc: walletSrc.id,
      suspenseSrc: suspenseSrc.id,
      suspenseDst: suspenseDst.id,
      feeSrc: feeSrc.id,
      fxSrc: fxSrc.id,
      fxDst: fxDst.id,
      payee,
      receivableSrc,
    }
  }

  private async resolvePayeeAccount(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
  ): Promise<string> {
    const internal = await this.handles.resolveInternal(
      transaction.counterpartyHandle,
    )
    if (internal) {
      const wallet = await this.ledger.userWallet(
        internal.userId,
        transaction.destCurrency,
        tx,
      )
      return wallet.id
    }

    // Keyed by beneficiary id so each payee has its own external account and the ledger
    // can answer "how much has ever gone to this payee?" without scanning transactions.
    const external = await this.ledger.ensureAccount(
      OWNER_TYPE.EXTERNAL,
      transaction.beneficiaryId ?? PLATFORM_OWNER,
      AccountType.EXTERNAL,
      transaction.destCurrency,
      tx,
    )
    return external.id
  }

  /** The transaction's amounts, in the shape the posting plans expect. */
  amountsOf(transaction: Transaction): TransferAmounts {
    return {
      sourceCurrency: transaction.sourceCurrency,
      destCurrency: transaction.destCurrency,
      sourceAmount: transaction.sourceAmount,
      destAmount: transaction.destAmount,
      feeMinor: transaction.feeMinor,
      taxMinor: transaction.taxMinor,
      totalDebitMinor: transaction.totalDebitMinor,
      rateE8: transaction.fxRateE8 ?? undefined,
    }
  }

  /**
   * Change status, through the state machine.
   *
   * A CONDITIONAL update on the current status, so the transition is atomic: if another
   * worker moved the row between our read and this write, zero rows are affected and the
   * whole database transaction is aborted rather than overwriting their decision.
   */
  private async transition(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    to: TxnStatus,
    extra: Prisma.TransactionUpdateInput = {},
  ): Promise<void> {
    if (!canTransition(transaction.status, to)) {
      throw new ConflictException(
        `Illegal transition ${transaction.status} → ${to}`,
      )
    }

    const updated = await tx.transaction.updateMany({
      where: { id: transaction.id, status: transaction.status },
      data: {
        status: to,
        ...(extra as Prisma.TransactionUpdateManyMutationInput),
      },
    })
    if (updated.count === 0) {
      throw new ConflictException(
        `Transaction ${transaction.id} changed state concurrently`,
      )
    }
  }

  private async transitionStandalone(
    transactionId: string,
    to: TxnStatus,
  ): Promise<void> {
    const transaction = await this.load(transactionId)
    if (!canTransition(transaction.status, to)) return
    await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: transaction.status },
      data: { status: to },
    })
  }

  async load(transactionId: string): Promise<Transaction> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
    })
    if (!transaction) throw new NotFoundException('Payment not found')
    return transaction
  }

  /** Whether this row has exhausted its status-check budget and its grace window. */
  shouldBeDeemed(transaction: Transaction, now = new Date()): boolean {
    const reference = transaction.submittedAt ?? transaction.createdAt
    return (
      hasFundsInSuspense(transaction.status) &&
      transaction.status !== TxnStatus.DEEMED &&
      !hasStatusCheckBudget(transaction.statusCheckCount) &&
      now.getTime() - reference.getTime() > DEEMED_AFTER_MS
    )
  }

  /** Remaining refundable amount, in the source currency. */
  refundableMinor(transaction: Transaction): bigint {
    return subMinor(
      transaction.sourceAmount,
      transaction.refundedMinor,
      'refundable',
    )
  }
}
