import { Inject, Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  INFO_REQUEST_TTL_DAYS,
  LIFECYCLE_BATCH_SIZE,
  STUCK_TRANSACTION_MS,
} from '@/modules/insurance/insurance.config'
import {
  addDays,
  canPolicyTransition,
} from '@/modules/insurance/insurance.state'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import { ClaimsService } from '@/modules/insurance/services/claims.service'
import { InsuranceMoneyService } from '@/modules/insurance/services/insurance-money.service'
import { PremiumService } from '@/modules/insurance/services/premium.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'

import {
  ActorType,
  ClaimStatus,
  InsuranceQuoteStatus,
  PolicyStatus,
  PremiumFrequency,
  TxnStatus,
  TxnType,
} from 'generated/prisma/client'

/**
 * The safety nets.
 *
 * Six sweeps, and each exists because a state in M5 has to actually CHANGE rather
 * than merely look changed to whoever happens to load the row. That distinction is
 * the whole reason these are crons and not lazy checks on read:
 *
 *  - An unexpired quote is still BUYABLE. A quote that only looked expired to the
 *    screen showing it could still be purchased by a client that skipped the check.
 *  - A policy whose grace window has closed is still returning `isCoverLive === true`
 *    to the claims service. A claim against it would be paid.
 *  - An APPROVED claim whose payout failed is a debt to a real person that nobody is
 *    looking at.
 *
 * ## Two properties every sweep here has
 *
 *  1. **Bounded.** `LIFECYCLE_BATCH_SIZE` rows per pass, so one sweep cannot run for
 *     an hour and overlap itself.
 *  2. **Conditional writes.** Every `updateMany` re-states the status it expects, so a
 *     user action landing in the same instant WINS rather than being overwritten by a
 *     sweep that read the row a moment earlier. A holder paying their premium at
 *     23:59:59 must not be lapsed by a cron that started at 23:59:58.
 */
@Injectable()
export class InsuranceLifecycleService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly premiums: PremiumService,
    private readonly money: InsuranceMoneyService,
    private readonly claims: ClaimsService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly registry: InsuranceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: InsuranceLifecycleService.name })
  }

  // ── quotes ────────────────────────────────────────────────────────────────
  /**
   * Expire quotes nobody bought.
   *
   * Every ten minutes against a thirty-minute TTL, so a quote is never buyable more
   * than ten minutes past its stated validity. The buy path also checks `validUntil`
   * itself — this sweep is what makes the STORED state honest, so an admin reading the
   * table sees the same thing the API would enforce.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireQuotes(): Promise<number> {
    const result = await this.prisma.insuranceQuote.updateMany({
      where: {
        status: InsuranceQuoteStatus.PRICED,
        validUntil: { lt: new Date() },
      },
      data: { status: InsuranceQuoteStatus.EXPIRED },
    })

    if (result.count > 0) {
      this.logger.info(`[${this.expireQuotes.name}] Expired stale quotes`, {
        count: result.count,
      })
    }
    return result.count
  }

  // ── premium dunning ───────────────────────────────────────────────────────
  /**
   * Collect premiums that have come due, then lapse the ones grace has run out on.
   *
   * The ORDER is the consumer protection. Collection runs FIRST, so a holder who
   * topped up their wallet overnight has their premium taken and their cover restored
   * in the same pass that would otherwise have lapsed them. Lapsing first and
   * collecting second would end cover for somebody whose money was already there.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runPremiumDunning(): Promise<{
    attempted: number
    collected: number
    lapsed: number
  }> {
    const now = new Date()

    const due = await this.prisma.policy.findMany({
      where: {
        status: { in: [PolicyStatus.ACTIVE, PolicyStatus.GRACE] },
        frequency: PremiumFrequency.MONTHLY,
        nextPremiumDueAt: { lte: now },
      },
      orderBy: { nextPremiumDueAt: 'asc' },
      take: LIFECYCLE_BATCH_SIZE,
    })

    let collected = 0
    for (const policy of due) {
      try {
        const result = await this.premiums.settleDuePremium(policy)
        if (result.outcome.ok) collected += 1
      } catch (error) {
        /**
         * One policy's failure must not abort the batch.
         *
         * A single row in an unexpected state would otherwise stop every remaining
         * policy from being collected — turning one broken record into a whole billing
         * run missed, and a cohort of holders lapsed for it.
         */
        this.logger.error(
          `[${this.runPremiumDunning.name}] Premium collection threw for one policy`,
          { policyId: policy.id, err: error },
        )
      }
    }

    const lapsed = await this.lapseExpiredGrace(now)

    if (due.length > 0 || lapsed > 0) {
      this.logger.info(
        `[${this.runPremiumDunning.name}] Dunning pass complete`,
        {
          attempted: due.length,
          collected,
          lapsed,
        },
      )
    }
    return { attempted: due.length, collected, lapsed }
  }

  /**
   * Grace has run out. Cover ends.
   *
   * A conditional update on `status: GRACE`, so a premium that settled microseconds
   * earlier — flipping the policy back to ACTIVE — is not overwritten by this sweep.
   * `LAPSED` is terminal by design: money arriving later must not silently revive
   * cover, because a claim decided against a policy that resurrected itself is
   * unarguable in both directions.
   */
  private async lapseExpiredGrace(now: Date): Promise<number> {
    const stale = await this.prisma.policy.findMany({
      where: {
        status: PolicyStatus.GRACE,
        graceEndsAt: { lt: now },
      },
      take: LIFECYCLE_BATCH_SIZE,
      select: { id: true, userId: true, policyNumber: true },
    })

    let lapsed = 0
    for (const policy of stale) {
      const result = await this.prisma.policy.updateMany({
        where: { id: policy.id, status: PolicyStatus.GRACE },
        data: {
          status: PolicyStatus.LAPSED,
          nextPremiumDueAt: null,
          graceEndsAt: null,
        },
      })
      if (result.count === 0) continue

      lapsed += 1
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'insurance.policy.lapsed',
        entity: 'Policy',
        entityId: policy.id,
        metadata: {
          policyNumber: policy.policyNumber,
          reason: 'Grace period elapsed without the premium being collected',
        },
      })
      this.logger.warn(
        `[${this.lapseExpiredGrace.name}] Policy lapsed — cover has ended`,
        { policyId: policy.id, policyNumber: policy.policyNumber },
      )
    }
    return lapsed
  }

  // ── policy term ───────────────────────────────────────────────────────────
  /**
   * End policies whose term has run out.
   *
   * Includes GRACE as well as ACTIVE. A policy can reach the end of its term while its
   * premium is overdue, and a sweep that only looked at ACTIVE would leave that row in
   * GRACE for ever — reading as though cover were still live, months after the contract
   * ended.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expirePolicies(): Promise<number> {
    const now = new Date()
    const ending = await this.prisma.policy.findMany({
      where: {
        status: { in: [PolicyStatus.ACTIVE, PolicyStatus.GRACE] },
        endAt: { lt: now },
      },
      take: LIFECYCLE_BATCH_SIZE,
      select: { id: true, status: true, policyNumber: true },
    })

    let expired = 0
    for (const policy of ending) {
      if (!canPolicyTransition(policy.status, PolicyStatus.EXPIRED)) continue

      const result = await this.prisma.policy.updateMany({
        where: { id: policy.id, status: policy.status },
        data: {
          status: PolicyStatus.EXPIRED,
          nextPremiumDueAt: null,
          graceEndsAt: null,
        },
      })
      expired += result.count
    }

    if (expired > 0) {
      this.logger.info(`[${this.expirePolicies.name}] Policy terms ended`, {
        count: expired,
      })
    }
    return expired
  }

  // ── stuck money ───────────────────────────────────────────────────────────
  /**
   * Resume premium and payout transactions abandoned mid-saga.
   *
   * These are INTERNAL ledger moves with no rail involved, so anything unfinished is a
   * crash between the reserve and the settle — which means REAL MONEY is parked in the
   * suspense account. Left alone, a policyholder's premium would sit there indefinitely
   * while their policy showed as unpaid, or a claimant's approved payout would never
   * reach their wallet.
   *
   * Every step in `settlePremium` / `settleClaimPayout` is guarded by its own
   * precondition and the ledger's unique constraint, so re-driving is safe: it does the
   * remaining work once and no more.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async resumeStuckTransactions(): Promise<{
    premiums: number
    payouts: number
  }> {
    const cutoff = new Date(Date.now() - STUCK_TRANSACTION_MS)

    const stuck = await this.prisma.transaction.findMany({
      where: {
        type: { in: [TxnType.PREMIUM, TxnType.CLAIM_PAYOUT] },
        status: {
          in: [TxnStatus.VALIDATED, TxnStatus.RESERVED, TxnStatus.SUBMITTED],
        },
        updatedAt: { lt: cutoff },
      },
      take: LIFECYCLE_BATCH_SIZE,
    })

    let premiums = 0
    let payouts = 0

    for (const transaction of stuck) {
      try {
        if (transaction.type === TxnType.PREMIUM) {
          const premium = await this.prisma.premiumPayment.findUnique({
            where: { transactionId: transaction.id },
          })
          if (!premium) {
            /**
             * A premium transaction with no premium row.
             *
             * The transaction was created and the process died before the row was
             * linked. The safe action is to RELEASE the reserve — the money goes back to
             * the wallet — rather than to earn a premium against a period nobody can
             * name.
             *
             * Unless it was never reserved. A VALIDATED orphan has moved no money, so
             * there is no reserve to release — and `releasePremiumReserve` correctly
             * declines to do anything with it. Left there, the row was re-selected by
             * this sweep every five minutes forever (and by M4's saga sweep every
             * minute, until that stopped picking up M5's rows). It is closed as FAILED.
             */
            const reason =
              'Orphaned premium transaction — no premium period to attribute it to'
            if (transaction.status === TxnStatus.VALIDATED) {
              await this.money.failUnreservedPremium(transaction.id, reason)
            } else {
              await this.money.releasePremiumReserve(transaction.id, reason)
            }
            continue
          }

          const result = await this.money.settlePremium(
            transaction,
            premium.id,
            premium.policyId,
          )
          if (result.collected) {
            await this.prisma.premiumPayment.update({
              where: { id: premium.id },
              data: {
                status: 'PAID',
                paidAt: premium.paidAt ?? new Date(),
                failureReason: null,
              },
            })
            premiums += 1
          }
          continue
        }

        // CLAIM_PAYOUT
        const claim = await this.prisma.claim.findFirst({
          where: { userId: transaction.userId, payoutTxnId: transaction.id },
        })
        const byKey =
          claim ?? (await this.claimForPayoutKey(transaction.idempotencyKey))

        if (!byKey) {
          this.logger.error(
            `[${this.resumeStuckTransactions.name}] Payout transaction has no claim — needs an operator`,
            { transactionId: transaction.id },
          )
          continue
        }

        const settled = await this.money.settleClaimPayout(
          transaction,
          byKey.id,
          byKey.claimNumber,
        )
        if (settled.paid) {
          await this.claims.markPaid(byKey.id, transaction.id)
          payouts += 1
        }
      } catch (error) {
        this.logger.error(
          `[${this.resumeStuckTransactions.name}] Could not resume a transaction`,
          { transactionId: transaction.id, err: error },
        )
      }
    }

    if (premiums > 0 || payouts > 0) {
      this.logger.info(
        `[${this.resumeStuckTransactions.name}] Resumed stuck insurance money`,
        { premiums, payouts },
      )
    }
    return { premiums, payouts }
  }

  /**
   * Retry payouts for claims that were APPROVED but never paid.
   *
   * The most important sweep in the module, because its failure mode is the quietest:
   * a claimant has been TOLD their claim is approved and the money never arrives. There
   * is no error anybody is watching, no failed request in a log, and nothing on the
   * claim to suggest a problem — just a status that stopped moving.
   *
   * Runs separately from {@link resumeStuckTransactions} because these claims may have
   * no transaction at all: if `payoutClaim` failed before the row was created, there is
   * nothing for a transaction sweep to find.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async retryPendingPayouts(): Promise<number> {
    const pending = await this.prisma.claim.findMany({
      where: { status: ClaimStatus.APPROVED, payoutTxnId: null },
      take: LIFECYCLE_BATCH_SIZE,
      orderBy: { decidedAt: 'asc' },
    })

    let paid = 0
    for (const claim of pending) {
      if (claim.amountApprovedMinor === null) {
        this.logger.error(
          `[${this.retryPendingPayouts.name}] Approved claim has no approved amount — needs an operator`,
          { claimId: claim.id, claimNumber: claim.claimNumber },
        )
        continue
      }

      try {
        const payout = await this.money.payoutClaim({
          userId: claim.userId,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          amountMinor: claim.amountApprovedMinor,
          currency: claim.currency,
        })
        if (payout.paid) {
          await this.claims.markPaid(claim.id, payout.transaction.id)
          paid += 1
          this.logger.info(
            `[${this.retryPendingPayouts.name}] A pending claim payout has settled`,
            { claimId: claim.id, claimNumber: claim.claimNumber },
          )
        }
      } catch (error) {
        this.logger.error(
          `[${this.retryPendingPayouts.name}] Payout retry threw`,
          { claimId: claim.id, err: error },
        )
      }
    }
    return paid
  }

  // ── loose ends ────────────────────────────────────────────────────────────
  /**
   * Retry insurer bindings for active policies that have no reference.
   *
   * These policies have PAID premiums and LIVE cover — they were activated deliberately
   * despite the insurer being unreachable, because withholding cover from somebody who
   * has paid is the wrong party bearing a third party's outage. This sweep closes the
   * operational loose end.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async retryInsurerBindings(): Promise<number> {
    const unbound = await this.prisma.policy.findMany({
      where: {
        status: { in: [PolicyStatus.ACTIVE, PolicyStatus.GRACE] },
        insurerPolicyRef: null,
      },
      include: { product: true, quote: { select: { riskTier: true } } },
      take: LIFECYCLE_BATCH_SIZE,
    })
    if (unbound.length === 0) return 0

    let bound = 0
    for (const policy of unbound) {
      const holder = await this.prisma.user.findUnique({
        where: { id: policy.userId },
        select: { pravaahId: true },
      })

      const result = await this.registry
        .insurer()
        .bindPolicy({
          productType: policy.product.type,
          coverageMinor: policy.coverageMinor,
          currency: policy.currency,
          holderRef: holder?.pravaahId ?? policy.userId,
          policyNumber: policy.policyNumber,
          termDays: policy.product.termDays,
          waitingPeriodDays:
            policy.waitingPeriodEndsAt && policy.startAt
              ? Math.round(
                  (policy.waitingPeriodEndsAt.getTime() -
                    policy.startAt.getTime()) /
                    86_400_000,
                )
              : policy.product.waitingPeriodDays,
          premiumMinor: policy.premiumMinor,
          riskTier: policy.quote.riskTier,
        })
        .catch(() => null)

      if (result?.ok) {
        await this.prisma.policy.update({
          where: { id: policy.id },
          data: { insurerPolicyRef: result.value.insurerPolicyRef },
        })
        bound += 1
      }
    }

    if (bound > 0) {
      this.logger.info(
        `[${this.retryInsurerBindings.name}] Bound policies the insurer had not acknowledged`,
        { count: bound },
      )
    }
    return bound
  }

  /**
   * Close claims that have been waiting on the claimant for too long.
   *
   * CLOSED, and the closure is recorded as a rejection with an explicit reason
   * naming the silence — because `ClaimStatus` has no "abandoned" state and inventing
   * one would fork every downstream count. The claim can be re-filed: a new claim for
   * the same incident with the missing document is a different row and passes the
   * dedupe fingerprint only if the amount or day differs, which is why the reason text
   * tells the claimant to contact support rather than simply re-submit.
   *
   * The alternative — leaving them open for ever — is an unbounded liability on the
   * book that no reviewer will ever clear.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async closeAbandonedInfoRequests(): Promise<number> {
    const cutoff = addDays(new Date(), -INFO_REQUEST_TTL_DAYS)

    const stale = await this.prisma.claim.findMany({
      where: {
        status: ClaimStatus.INFO_REQUESTED,
        updatedAt: { lt: cutoff },
      },
      take: LIFECYCLE_BATCH_SIZE,
      select: { id: true, claimNumber: true },
    })

    let closed = 0
    for (const claim of stale) {
      const result = await this.prisma.claim.updateMany({
        where: { id: claim.id, status: ClaimStatus.INFO_REQUESTED },
        data: {
          status: ClaimStatus.REJECTED,
          decidedByType: ActorType.SYSTEM,
          decidedAt: new Date(),
          decisionReason: `Closed after ${INFO_REQUEST_TTL_DAYS} days without the information we asked for. If you still want this assessed, contact support and we will reopen it.`,
        },
      })
      if (result.count === 0) continue

      closed += 1
      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'insurance.claim.closed_no_response',
        entity: 'Claim',
        entityId: claim.id,
        metadata: {
          claimNumber: claim.claimNumber,
          ttlDays: INFO_REQUEST_TTL_DAYS,
        },
      })
    }

    if (closed > 0) {
      this.logger.info(
        `[${this.closeAbandonedInfoRequests.name}] Closed claims with no claimant response`,
        { count: closed },
      )
    }
    return closed
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * Recover the claim behind a payout transaction from its idempotency key.
   *
   * The key is `claim-payout:{claimId}` by construction, so this is a deterministic
   * reverse lookup rather than a guess — needed when a crash left the transaction
   * created but never attached to the claim, which is precisely the case where the
   * forward reference does not exist yet.
   */
  private async claimForPayoutKey(
    idempotencyKey: string,
  ): Promise<{ id: string; claimNumber: string } | null> {
    const prefix = 'claim-payout:'
    if (!idempotencyKey.startsWith(prefix)) return null

    const claimId = idempotencyKey.slice(prefix.length)
    return this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { id: true, claimNumber: true },
    })
  }

  /**
   * Run every sweep once, now. For the admin console and the demo.
   *
   * Sequential rather than parallel: the dunning pass can flip a policy back to ACTIVE
   * and the expiry pass reads status, so running them concurrently would make the
   * outcome depend on which query returned first.
   */
  async runAllNow(): Promise<Record<string, unknown>> {
    const quotes = await this.expireQuotes()
    const dunning = await this.runPremiumDunning()
    const expired = await this.expirePolicies()
    const resumed = await this.resumeStuckTransactions()
    const payouts = await this.retryPendingPayouts()
    const bindings = await this.retryInsurerBindings()
    const abandoned = await this.closeAbandonedInfoRequests()

    return {
      quotesExpired: quotes,
      dunning,
      policiesExpired: expired,
      resumedTransactions: resumed,
      payoutsRetried: payouts,
      insurerBindingsCompleted: bindings,
      infoRequestsClosed: abandoned,
    }
  }
}
