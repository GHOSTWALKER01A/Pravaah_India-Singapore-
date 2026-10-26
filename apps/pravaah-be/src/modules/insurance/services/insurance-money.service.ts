import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  CLAIM_PAYOUT_NARRATION,
  INSURANCE_BOOK_HANDLE,
  INSURANCE_BOOK_NAME,
  INSURANCE_PURPOSE_CODE,
  PREMIUM_NARRATION,
  PREMIUM_REFUND_NARRATION,
} from '@/modules/insurance/insurance.config'
import {
  claimPayoutPlan,
  claimReservePlan,
  premiumEarnPlan,
  premiumRefundPlan,
  premiumReleasePlan,
  premiumReservePlan,
  type InsuranceAccounts,
} from '@/modules/insurance/insurance-posting-plan'
import {
  canTransition,
  hasFundsInSuspense,
} from '@/modules/payments/payments.state'
import {
  isDuplicatePostingError,
  LedgerService,
} from '@/modules/payments/services/ledger.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'

import {
  AccountType,
  ActorType,
  PaymentRail,
  Prisma,
  TxnStatus,
  TxnType,
  type Transaction,
} from 'generated/prisma/client'

/** Why a premium collection did not complete, in a shape the caller can branch on. */
export type PremiumFailure =
  | { kind: 'INSUFFICIENT_BALANCE'; shortfallMinor: bigint }
  | { kind: 'STATE_CONFLICT'; detail: string }

export interface PremiumCollectionResult {
  transaction: Transaction
  collected: boolean
  failure?: PremiumFailure
}

/**
 * The bridge between insurance and money.
 *
 * Everything M5 does to the ledger goes through here, and nowhere else in the
 * module touches `LedgerEntry` or `Transaction`. That containment is the point: M4's
 * module comment is explicit that a module writing ledger rows directly would bypass
 * every invariant while appearing to reuse the ledger, so M5 reuses the SERVICES —
 * `LedgerService.post` for the balance check and the unique constraint,
 * `TransferOrchestratorService.createRaw` for the idempotent transaction row — and
 * confines its own posting logic to one file with pure plans behind it.
 *
 * ## The two-step shape, and why it is not one step
 *
 * A premium is wallet → insurance float. It would be one balanced pair. It is two —
 * wallet → suspense, then suspense → float — because M4's transaction saga is the
 * only state machine that governs money here, and its legal path to a settled
 * transaction runs `VALIDATED → RESERVED → SUBMITTED → SUCCESS` where `RESERVED`
 * MEANS "the funds are in suspense". Collapsing the plan would need either a new
 * edge in M4's state machine or a status that lied about where the money was, and
 * the second is how a reconciler comes to disagree with a ledger.
 *
 * Both steps commit in ONE database transaction, so the intermediate state is not
 * observable in the ordinary case. It is observable after a crash, and that is a
 * feature: the money sits in the same suspense account M4's admin console already
 * lists, and `InsuranceLifecycleService` resumes it.
 *
 * ## Where the row lock is, and why
 *
 * `lockWalletAndBalance` on the premium path. Prisma's interactive transactions run
 * at READ COMMITTED, so two concurrent premium collections — the dunning cron and a
 * manual retry, say — would both read the same balance and both spend it. The lock
 * is what makes the check atomic with the debit. The payout path locks the FLOAT for
 * the mirror reason: two adjudications of one claim would otherwise both pay.
 */
@Injectable()
export class InsuranceMoneyService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: InsuranceMoneyService.name })
  }

  // ── premium in ────────────────────────────────────────────────────────────
  /**
   * Collect a premium from the policyholder's wallet.
   *
   * Idempotent at two levels, and both are needed:
   *
   *  1. `createRaw` resolves a duplicate `idempotencyKey` to the EXISTING
   *     transaction, so a retry cannot mint a second premium row.
   *  2. The ledger's unique constraint on
   *     `(transaction, account, direction, leg, legRef)` stops a second posting
   *     against that transaction — which is what actually holds under concurrency,
   *     because two callers both read `VALIDATED` before either writes.
   *
   * Returns a RESULT-shaped value rather than throwing on an empty wallet. A
   * daily-wage earner whose balance is short on the due date is the ORDINARY case
   * this product has to survive: it must leave the policy in `GRACE` with a retry,
   * not surface a 500 to a cron.
   */
  async collectPremium(params: {
    userId: string
    policyId: string
    premiumPaymentId: string
    amountMinor: bigint
    currency: string
    idempotencyKey: string
    deviceId?: string | null
    ipAddress?: string | null
  }): Promise<PremiumCollectionResult> {
    const transaction = await this.orchestrator.createRaw({
      userId: params.userId,
      type: TxnType.PREMIUM,
      currency: params.currency,
      amountMinor: params.amountMinor,
      counterpartyHandle: INSURANCE_BOOK_HANDLE,
      counterpartyName: INSURANCE_BOOK_NAME,
      purposeCode: INSURANCE_PURPOSE_CODE,
      narration: PREMIUM_NARRATION,
      idempotencyKey: params.idempotencyKey,
      status: TxnStatus.VALIDATED,
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      /**
       * INTERNAL, not UPI.
       *
       * The money never reaches a PSP — it moves between a holder's wallet and our
       * own book. Labelled `UPI`, the reconciler would eventually ask the rail
       * about it, be told "unknown reference", and mark a settled premium DEEMED.
       */
      rail: PaymentRail.INTERNAL,
    })

    // Already settled by a previous attempt. The whole point of the key.
    if (transaction.status === TxnStatus.SUCCESS) {
      return { transaction, collected: true }
    }

    return this.settlePremium(
      transaction,
      params.premiumPaymentId,
      params.policyId,
    )
  }

  /**
   * Drive a premium transaction to SUCCESS.
   *
   * Split out from {@link collectPremium} so the lifecycle sweep can resume a
   * transaction abandoned mid-saga without re-deriving its idempotency key. Safe to
   * call repeatedly: each step is guarded by its own precondition, exactly as M4's
   * `drive` is.
   */
  async settlePremium(
    transaction: Transaction,
    premiumPaymentId: string,
    policyId: string,
  ): Promise<PremiumCollectionResult> {
    let current = transaction

    if (current.status === TxnStatus.VALIDATED) {
      const reserved = await this.reservePremium(current)
      if (!reserved.ok) {
        return {
          transaction: reserved.transaction,
          collected: false,
          failure: reserved.failure,
        }
      }
      current = reserved.transaction
    }

    if (current.status === TxnStatus.SUCCESS) {
      return { transaction: current, collected: true }
    }

    if (!hasFundsInSuspense(current.status)) {
      /**
       * Nothing in suspense and not settled — the reserve was released, or the row
       * is in a state this path does not own.
       *
       * Reported rather than forced. A premium whose funds are not where this
       * method expects them is exactly the case where continuing would post against
       * an account that has not been debited.
       */
      return {
        transaction: current,
        collected: false,
        failure: {
          kind: 'STATE_CONFLICT',
          detail: `Premium transaction is ${current.status} with no funds in suspense`,
        },
      }
    }

    return this.earnPremium(current, premiumPaymentId, policyId)
  }

  /**
   * RESERVE — the premium leaves the wallet, under a row lock.
   *
   * The lock and the balance read are one operation, because a balance read without
   * the lock is advisory: two concurrent collections would both see enough money and
   * both spend it, and the wallet would go negative. READ COMMITTED does not prevent
   * that; the lock does.
   */
  private async reservePremium(
    transaction: Transaction,
  ): Promise<
    | { ok: true; transaction: Transaction }
    | { ok: false; transaction: Transaction; failure: PremiumFailure }
  > {
    let shortfall: bigint | null = null

    try {
      await this.prisma.$transaction(async (tx) => {
        const { account: wallet, balance } =
          await this.ledger.lockWalletAndBalance(
            tx,
            transaction.userId,
            transaction.sourceCurrency,
          )

        if (balance < transaction.totalDebitMinor) {
          shortfall = transaction.totalDebitMinor - balance
          // Thrown to roll back the lock, then converted to a typed failure below.
          // A premium that cannot be funded is not an exception the caller should
          // have to catch — it is the outcome the dunning path is built around.
          throw new ConflictException('INSUFFICIENT_BALANCE')
        }

        const suspense = await this.ledger.platformAccount(
          AccountType.SUSPENSE,
          transaction.sourceCurrency,
          tx,
        )

        await this.ledger.post(
          tx,
          transaction.id,
          premiumReservePlan(
            { wallet: wallet.id, suspense: suspense.id },
            transaction.sourceCurrency,
            transaction.totalDebitMinor,
          ),
        )
        await this.transition(tx, transaction, TxnStatus.RESERVED)
      })
    } catch (error) {
      if (shortfall !== null) {
        this.logger.info(
          `[${this.reservePremium.name}] Premium could not be funded from the wallet`,
          {
            transactionId: transaction.id,
            shortfallMinor: (shortfall as bigint).toString(),
          },
        )
        return {
          ok: false,
          transaction: await this.orchestrator.load(transaction.id),
          failure: {
            kind: 'INSUFFICIENT_BALANCE',
            shortfallMinor: shortfall,
          },
        }
      }

      if (isDuplicatePostingError(error)) {
        // A concurrent attempt reserved it first. Not a failure — read it back.
        this.logger.warn(
          `[${this.reservePremium.name}] Premium reserve already posted concurrently`,
          { transactionId: transaction.id },
        )
        return {
          ok: true,
          transaction: await this.orchestrator.load(transaction.id),
        }
      }
      throw error
    }

    return {
      ok: true,
      transaction: await this.orchestrator.load(transaction.id),
    }
  }

  /**
   * EARN — suspense → the insurance float, and the transaction closes.
   *
   * `RESERVED → SUBMITTED → SUCCESS` in one database transaction. Two hops because
   * that is M4's legal path and M5 does not get its own; the intermediate
   * `SUBMITTED` is not observable outside this commit.
   */
  private async earnPremium(
    transaction: Transaction,
    premiumPaymentId: string,
    policyId: string,
  ): Promise<PremiumCollectionResult> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const accounts = await this.resolveAccounts(
          tx,
          transaction.userId,
          transaction.sourceCurrency,
        )

        await this.ledger.post(
          tx,
          transaction.id,
          premiumEarnPlan(
            accounts,
            transaction.sourceCurrency,
            transaction.totalDebitMinor,
          ),
        )

        const submitted = await this.transition(
          tx,
          transaction,
          TxnStatus.SUBMITTED,
        )
        await this.transition(tx, submitted, TxnStatus.SUCCESS, {
          completedAt: new Date(),
          nextPollAt: null,
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        this.logger.warn(
          `[${this.earnPremium.name}] Premium already earned by a concurrent caller`,
          { transactionId: transaction.id },
        )
        const settled = await this.orchestrator.load(transaction.id)
        return {
          transaction: settled,
          collected: settled.status === TxnStatus.SUCCESS,
        }
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'insurance.premium.collected',
      entity: 'PremiumPayment',
      entityId: premiumPaymentId,
      metadata: {
        policyId,
        transactionId: transaction.id,
        amountMinor: transaction.totalDebitMinor.toString(),
        currency: transaction.sourceCurrency,
      },
    })

    this.logger.info(`[${this.earnPremium.name}] Premium earned`, {
      transactionId: transaction.id,
      policyId,
    })
    return {
      transaction: await this.orchestrator.load(transaction.id),
      collected: true,
    }
  }

  /**
   * Release a premium reserve that will never be earned.
   *
   * Called when a policy is cancelled or abandoned while its premium sits in
   * suspense. A COMPENSATION, not a refund: the premium was never earned, so
   * nothing comes off the float and the money simply returns to the wallet.
   */
  async releasePremiumReserve(
    transactionId: string,
    reason: string,
  ): Promise<Transaction> {
    const transaction = await this.orchestrator.load(transactionId)

    if (!hasFundsInSuspense(transaction.status)) {
      // Either already released, settled, or never reserved. Nothing to do.
      return transaction
    }
    if (!canTransition(transaction.status, TxnStatus.REVERSED)) {
      this.logger.warn(
        `[${this.releasePremiumReserve.name}] Refusing an illegal transition`,
        { transactionId, from: transaction.status },
      )
      return transaction
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const accounts = await this.resolveAccounts(
          tx,
          transaction.userId,
          transaction.sourceCurrency,
        )
        await this.ledger.post(
          tx,
          transaction.id,
          premiumReleasePlan(
            accounts,
            transaction.sourceCurrency,
            transaction.totalDebitMinor,
          ),
        )
        await this.transition(tx, transaction, TxnStatus.REVERSED, {
          failureReason: reason.slice(0, 500),
          completedAt: new Date(),
          nextPollAt: null,
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        return this.orchestrator.load(transactionId)
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'insurance.premium.reserve_released',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { reason },
    })
    return this.orchestrator.load(transactionId)
  }

  /**
   * Close a premium transaction that never reached the reserve.
   *
   * VALIDATED means nothing has been posted: `reservePremium` debits the wallet and
   * flips the row to RESERVED in ONE database transaction, so a row still VALIDATED has
   * moved no money and needs no ledger entry to unwind. `VALIDATED → FAILED` is a legal
   * edge in M4's saga. The status is re-checked inside the compare-and-swap, so a
   * collection that reserved this row in the meantime is never overwritten.
   */
  async failUnreservedPremium(
    transactionId: string,
    reason: string,
  ): Promise<Transaction> {
    const transaction = await this.orchestrator.load(transactionId)
    if (transaction.status !== TxnStatus.VALIDATED) return transaction

    try {
      await this.prisma.$transaction((tx) =>
        this.transition(tx, transaction, TxnStatus.FAILED, {
          failureReason: reason.slice(0, 500),
          completedAt: new Date(),
          nextPollAt: null,
        }),
      )
    } catch (error) {
      // Moved on concurrently (reserved by a live collection). Its new owner decides.
      if (error instanceof ConflictException) {
        return this.orchestrator.load(transactionId)
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'insurance.premium.unreserved_failed',
      entity: 'Transaction',
      entityId: transactionId,
      metadata: { reason },
    })
    this.logger.warn(
      `[${this.failUnreservedPremium.name}] Closed an orphaned, never-reserved premium`,
      { transactionId },
    )
    return this.orchestrator.load(transactionId)
  }

  // ── claim payout ──────────────────────────────────────────────────────────
  /**
   * Pay an approved claim into the claimant's wallet.
   *
   * Idempotent on `claim-payout:{claimId}` — one claim, one payout, enforced by
   * `Transaction.idempotencyKey` being UNIQUE and again by `Claim.payoutTxnId`
   * being UNIQUE. Two constraints because they stop different things: the key stops
   * a second transaction being MINTED, the claim column stops a second transaction
   * being ATTACHED to the claim.
   *
   * Never throws on a shortfall. The float is permitted to go negative, because
   * refusing an approved claim for lack of book value would be the insurer failing
   * its own policyholder to keep a number tidy — the negative balance is the honest
   * record of an underwriting loss and shows up on the loss-ratio dashboard.
   */
  async payoutClaim(params: {
    userId: string
    claimId: string
    claimNumber: string
    amountMinor: bigint
    currency: string
  }): Promise<{ transaction: Transaction; paid: boolean }> {
    const transaction = await this.orchestrator.createRaw({
      userId: params.userId,
      type: TxnType.CLAIM_PAYOUT,
      // INBOUND: money moving TOWARDS the user. The direction is what makes the
      // wallet statement read "credit" rather than showing a claim as a debit.
      direction: 'INBOUND',
      currency: params.currency,
      amountMinor: params.amountMinor,
      counterpartyHandle: INSURANCE_BOOK_HANDLE,
      counterpartyName: INSURANCE_BOOK_NAME,
      purposeCode: INSURANCE_PURPOSE_CODE,
      narration: CLAIM_PAYOUT_NARRATION,
      idempotencyKey: `claim-payout:${params.claimId}`,
      status: TxnStatus.VALIDATED,
      rail: PaymentRail.INTERNAL,
    })

    if (transaction.status === TxnStatus.SUCCESS) {
      return { transaction, paid: true }
    }

    return this.settleClaimPayout(
      transaction,
      params.claimId,
      params.claimNumber,
    )
  }

  /**
   * Drive a claim payout to SUCCESS. Resumable, for the same reason as premiums.
   *
   * The float's reserve mirrors a sender's wallet reserve in a transfer: the money
   * stops being available to fund a second payout at the moment it moves to
   * suspense, so two concurrent adjudications of one claim cannot both pay.
   */
  async settleClaimPayout(
    transaction: Transaction,
    claimId: string,
    claimNumber: string,
  ): Promise<{ transaction: Transaction; paid: boolean }> {
    let current = transaction

    if (current.status === TxnStatus.VALIDATED) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const accounts = await this.resolveAccounts(
            tx,
            current.userId,
            current.destCurrency,
          )
          /**
           * Lock the FLOAT, not the wallet.
           *
           * The float is what is being spent. Locking the claimant's wallet would
           * serialise the wrong resource and leave two concurrent payouts from one
           * book racing each other.
           */
          await this.ledger.lockAccount(tx, accounts.float)

          await this.ledger.post(
            tx,
            current.id,
            claimReservePlan(
              accounts,
              current.destCurrency,
              current.destAmount,
            ),
          )
          await this.transition(tx, current, TxnStatus.RESERVED)
        })
      } catch (error) {
        if (!isDuplicatePostingError(error)) throw error
        this.logger.warn(
          `[${this.settleClaimPayout.name}] Payout reserve already posted concurrently`,
          { transactionId: current.id, claimId },
        )
      }
      current = await this.orchestrator.load(current.id)
    }

    if (current.status === TxnStatus.SUCCESS) {
      return { transaction: current, paid: true }
    }
    if (!hasFundsInSuspense(current.status)) {
      this.logger.error(
        `[${this.settleClaimPayout.name}] Payout is not in a payable state`,
        { transactionId: current.id, status: current.status, claimId },
      )
      return { transaction: current, paid: false }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const accounts = await this.resolveAccounts(
          tx,
          current.userId,
          current.destCurrency,
        )
        await this.ledger.post(
          tx,
          current.id,
          claimPayoutPlan(accounts, current.destCurrency, current.destAmount),
        )
        const submitted = await this.transition(
          tx,
          current,
          TxnStatus.SUBMITTED,
        )
        await this.transition(tx, submitted, TxnStatus.SUCCESS, {
          completedAt: new Date(),
          nextPollAt: null,
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        const settled = await this.orchestrator.load(current.id)
        return {
          transaction: settled,
          paid: settled.status === TxnStatus.SUCCESS,
        }
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'insurance.claim.paid',
      entity: 'Claim',
      entityId: claimId,
      metadata: {
        claimNumber,
        transactionId: current.id,
        amountMinor: current.destAmount.toString(),
        currency: current.destCurrency,
      },
    })

    this.logger.info(`[${this.settleClaimPayout.name}] Claim payout settled`, {
      transactionId: current.id,
      claimNumber,
    })
    const settled = await this.orchestrator.load(current.id)
    return { transaction: settled, paid: settled.status === TxnStatus.SUCCESS }
  }

  // ── premium refund (free look) ────────────────────────────────────────────
  /**
   * Refund an earned premium — the free-look cancellation.
   *
   * Posted against the ORIGINAL premium transaction with the PremiumPayment id as
   * `legRef`, rather than as a new transaction. Two reasons, and both come from M4:
   *
   *  1. A refund belongs to what it reverses. `SUCCESS → REFUNDED` is a legal
   *     transition, so the transaction's own history shows the money came back.
   *  2. `legRef` is what lets a policy refunded across two premium periods post two
   *     entries instead of colliding on the unique constraint.
   */
  async refundPremium(params: {
    transactionId: string
    premiumPaymentId: string
    amountMinor: bigint
    reason: string
  }): Promise<{ transaction: Transaction; refunded: boolean }> {
    const transaction = await this.orchestrator.load(params.transactionId)

    if (transaction.status !== TxnStatus.SUCCESS) {
      /**
       * Only a SETTLED premium can be refunded.
       *
       * A premium still in suspense is released, not refunded — see
       * {@link releasePremiumReserve}. Conflating the two would debit the float for
       * money it never received.
       */
      this.logger.warn(
        `[${this.refundPremium.name}] Refusing to refund a premium that is not settled`,
        { transactionId: transaction.id, status: transaction.status },
      )
      return { transaction, refunded: false }
    }

    const refundable = transaction.sourceAmount - transaction.refundedMinor
    if (refundable <= 0n || params.amountMinor > refundable) {
      this.logger.warn(
        `[${this.refundPremium.name}] Refund exceeds the refundable balance`,
        {
          transactionId: transaction.id,
          requestedMinor: params.amountMinor.toString(),
          refundableMinor: refundable.toString(),
        },
      )
      return { transaction, refunded: false }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const accounts = await this.resolveAccounts(
          tx,
          transaction.userId,
          transaction.sourceCurrency,
        )
        await this.ledger.post(
          tx,
          transaction.id,
          premiumRefundPlan(
            accounts,
            transaction.sourceCurrency,
            params.amountMinor,
            params.premiumPaymentId,
          ),
        )
        await this.transition(tx, transaction, TxnStatus.REFUNDED, {
          refundedMinor: transaction.refundedMinor + params.amountMinor,
          failureReason: PREMIUM_REFUND_NARRATION,
        })
        await tx.premiumPayment.update({
          where: { id: params.premiumPaymentId },
          data: {
            status: 'REFUNDED',
            refundedMinor: { increment: params.amountMinor },
          },
        })
      })
    } catch (error) {
      if (isDuplicatePostingError(error)) {
        this.logger.warn(
          `[${this.refundPremium.name}] Premium refund already posted`,
          { transactionId: transaction.id },
        )
        return {
          transaction: await this.orchestrator.load(transaction.id),
          refunded: true,
        }
      }
      throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'insurance.premium.refunded',
      entity: 'PremiumPayment',
      entityId: params.premiumPaymentId,
      metadata: {
        transactionId: transaction.id,
        amountMinor: params.amountMinor.toString(),
        reason: params.reason,
      },
    })
    return {
      transaction: await this.orchestrator.load(transaction.id),
      refunded: true,
    }
  }

  // ── the book ──────────────────────────────────────────────────────────────
  /**
   * The insurance float's balance, per currency.
   *
   * Derived from ledger entries, never stored. A negative balance is a real
   * underwriting loss and is returned as-is rather than clamped — clamping would
   * make a loss-making book look break-even, which is the one number a judge or an
   * actuary is actually checking.
   */
  async floatBalances(): Promise<
    Array<{ currency: string; balanceMinor: bigint }>
  > {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { type: AccountType.INSURANCE_FLOAT },
      orderBy: { currency: 'asc' },
    })
    return Promise.all(
      accounts.map(async (account) => ({
        currency: account.currency,
        balanceMinor: await this.ledger.balance(account.id),
      })),
    )
  }

  /**
   * Earned premium and paid claims, per currency, READ OFF THE LEDGER.
   *
   * From `LedgerEntry`, not from `PremiumPayment.status` and
   * `Claim.amountApprovedMinor`. The application tables record what we INTENDED;
   * the ledger records what actually moved. A loss ratio computed from the first
   * would drift from the money the moment a payout failed after a claim was marked
   * paid — and the loss ratio is the one figure that has to agree with the trial
   * balance.
   */
  async bookTotals(filter: { currency?: string; from?: Date; to?: Date } = {}) {
    const postedAt =
      filter.from || filter.to
        ? {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          }
        : undefined

    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['currency', 'leg', 'direction'],
      where: {
        leg: { in: ['PREMIUM', 'CLAIM_PAYOUT', 'PREMIUM_REFUND'] },
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(postedAt ? { postedAt } : {}),
      },
      _sum: { amountMinor: true },
    })

    const totals = new Map<
      string,
      { earnedMinor: bigint; paidMinor: bigint; refundedMinor: bigint }
    >()

    for (const row of grouped) {
      const entry = totals.get(row.currency) ?? {
        earnedMinor: 0n,
        paidMinor: 0n,
        refundedMinor: 0n,
      }
      const sum = row._sum.amountMinor ?? 0n

      /**
       * Count ONE side of each leg, never both.
       *
       * Every posting set is balanced, so summing both directions would always net
       * to zero. Premium is counted on its CREDIT to the float (money arriving in
       * the book) and the payout and refund on their DEBIT from it (money leaving)
       * — which is the same convention that makes these three numbers reconcile
       * against the float's balance.
       */
      if (row.leg === 'PREMIUM' && row.direction === 'CREDIT') {
        entry.earnedMinor += sum
      }
      if (row.leg === 'CLAIM_PAYOUT' && row.direction === 'DEBIT') {
        entry.paidMinor += sum
      }
      if (row.leg === 'PREMIUM_REFUND' && row.direction === 'DEBIT') {
        entry.refundedMinor += sum
      }
      totals.set(row.currency, entry)
    }

    return [...totals.entries()].map(([currency, entry]) => ({
      currency,
      ...entry,
      /**
       * Premium the book actually keeps.
       *
       * Refunds are subtracted, because a free-look refund means that premium was
       * never earned. Leaving it in the denominator would flatter the loss ratio by
       * counting money we gave back as income.
       */
      netEarnedMinor:
        entry.earnedMinor - entry.refundedMinor > 0n
          ? entry.earnedMinor - entry.refundedMinor
          : 0n,
    }))
  }

  // ── shared helpers ────────────────────────────────────────────────────────
  /** Wallet, suspense and float for one user and currency. */
  private async resolveAccounts(
    tx: Prisma.TransactionClient,
    userId: string,
    currency: string,
  ): Promise<InsuranceAccounts> {
    const [wallet, suspense, float] = await Promise.all([
      this.ledger.userWallet(userId, currency, tx),
      this.ledger.platformAccount(AccountType.SUSPENSE, currency, tx),
      this.ledger.platformAccount(AccountType.INSURANCE_FLOAT, currency, tx),
    ])
    return { wallet: wallet.id, suspense: suspense.id, float: float.id }
  }

  /**
   * Change a transaction's status, through M4's state machine.
   *
   * A CONDITIONAL update on the current status, so the transition is atomic: if
   * another worker moved the row between our read and this write, zero rows are
   * affected and the whole database transaction aborts rather than overwriting
   * their decision. Returns the updated row so a caller can chain a second hop —
   * `RESERVED → SUBMITTED → SUCCESS` — inside one commit.
   */
  private async transition(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    to: TxnStatus,
    extra: Prisma.TransactionUpdateManyMutationInput = {},
  ): Promise<Transaction> {
    if (!canTransition(transaction.status, to)) {
      throw new ConflictException(
        `Illegal transition ${transaction.status} → ${to} on transaction ${transaction.id}`,
      )
    }

    const updated = await tx.transaction.updateMany({
      where: { id: transaction.id, status: transaction.status },
      data: { status: to, ...extra },
    })
    if (updated.count === 0) {
      throw new ConflictException(
        `Transaction ${transaction.id} changed state concurrently`,
      )
    }

    const reread = await tx.transaction.findUnique({
      where: { id: transaction.id },
    })
    if (!reread)
      throw new NotFoundException('Transaction vanished mid-transition')
    return reread
  }
}
