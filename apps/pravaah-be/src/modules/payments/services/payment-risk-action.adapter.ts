import { Inject, Injectable, OnModuleInit } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  RiskActionRegistry,
  type RiskActionHandler,
} from '@/modules/fraud/services/risk-action.registry'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'

import { ActorType, RiskSubjectType, TxnStatus } from 'generated/prisma/client'

/**
 * Lets an analyst release or block a `RISK_HELD` transaction, without M6 importing M4.
 *
 * ## Why this file exists
 *
 * M4 depends on M6 (its risk scoring delegates to `RiskService`). But clearing a fraud
 * case has to RELEASE the held transfer, which means calling
 * {@link TransferOrchestratorService} from inside M6's case service — the opposite
 * direction, and therefore a circular module reference.
 *
 * NestJS offers `forwardRef` for exactly this, and it is the wrong tool here: it resolves
 * at runtime, so a wiring mistake surfaces as an undefined injection deep inside a case
 * resolution — while an analyst is releasing somebody's money — rather than at startup.
 *
 * So the dependency is INVERTED instead. M6 owns a registry of handlers keyed by subject
 * type and knows nothing about payments; this adapter lives in M4, where importing the
 * orchestrator is natural, and registers itself on init. Dependencies point one way and
 * the wiring is explicit.
 *
 * ## Why it is thin on purpose
 *
 * Every method delegates to `resolveRiskHold`, which is where the invariants live: the
 * status check, the re-validation of limits and balance before re-entering the saga, and
 * the audit row. An adapter that updated `Transaction.status` itself would bypass all
 * three while appearing to reuse the orchestrator — the same failure M5's module comment
 * warns about for the ledger.
 */
@Injectable()
export class PaymentRiskActionAdapter
  implements RiskActionHandler, OnModuleInit
{
  private readonly logger: AppLogger

  constructor(
    private readonly registry: RiskActionRegistry,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentRiskActionAdapter.name })
  }

  onModuleInit(): void {
    this.registry.register(RiskSubjectType.TRANSACTION, this)
    /**
     * A payout is a transaction too, so the same handler serves both.
     *
     * Registered explicitly rather than relying on `TRANSACTION` to cover it, because
     * `RiskSubjectType.PAYOUT` exists for the insurance claim-payout leg and an
     * unregistered subject type resolves to "nothing to release" — which would silently
     * leave a held payout unreleasable while the case closed successfully.
     */
    this.registry.register(RiskSubjectType.PAYOUT, this)
  }

  /**
   * Let a held transfer proceed.
   *
   * Re-enters the saga at `VALIDATED`, not `RESERVED` — the orchestrator's own comment
   * explains why, and it matters more here than anywhere: a hold can sit for hours, so the
   * balance may have been spent and the day's limit used since the check that produced the
   * hold. Skipping to the reserve would trust a check made before the delay.
   */
  async release(params: {
    subjectId: string
    userId: string
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }> {
    const guard = await this.assertReleasable(params.subjectId, params.userId)
    if (guard) return guard

    const transaction = await this.orchestrator.resolveRiskHold(
      params.subjectId,
      'RELEASE',
      { type: ActorType.ADMIN, id: params.actorId ?? null },
      params.reason,
    )

    this.logger.warn(`[${this.release.name}] Held transfer released`, {
      transactionId: params.subjectId,
      status: transaction.status,
      analystId: params.actorId,
    })

    return {
      applied: true,
      detail: `Transfer released and re-driven; now ${transaction.status}`,
    }
  }

  /** Refuse a held transfer for good. */
  async block(params: {
    subjectId: string
    userId: string
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }> {
    const guard = await this.assertReleasable(params.subjectId, params.userId)
    if (guard) return guard

    const transaction = await this.orchestrator.resolveRiskHold(
      params.subjectId,
      'BLOCK',
      { type: ActorType.ADMIN, id: params.actorId ?? null },
      params.reason,
    )

    return {
      applied: true,
      detail: `Transfer blocked; now ${transaction.status}`,
    }
  }

  /**
   * Refuse to act on anything that is not this user's held transaction.
   *
   * Returns a non-applied RESULT rather than throwing, because `RiskActionRegistry.apply`
   * treats a throw and a false the same way but a described reason is what an analyst
   * reads in `actionResult`. "That payment is no longer on hold" is actionable; a
   * swallowed exception is not.
   *
   * ## Why the subject id is verified against the user
   *
   * `FraudCase.subjectId` is TEXT, not a foreign key — it has to be, because a LOGIN case
   * points at a synthetic key. That flexibility means nothing enforces at the database
   * level that a case's subject belongs to its user, so it is enforced here. Without it, a
   * case whose subject id was wrong (or tampered with) could release a DIFFERENT user's
   * held transfer.
   */
  private async assertReleasable(
    subjectId: string,
    userId: string,
  ): Promise<{ applied: boolean; detail: string } | null> {
    /**
     * A pre-flight assessment's synthetic subject (`pending:<beneficiaryId>`) is not a
     * transaction id. Detected before the query, because `findUnique` on a non-uuid
     * string against a `@db.Uuid` column raises `22P02` rather than returning null.
     */
    if (!isUuid(subjectId)) {
      return {
        applied: false,
        detail:
          'This case refers to a pre-submission risk check, so there is no held payment to release',
      }
    }

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: subjectId },
      select: { id: true, userId: true, status: true },
    })

    if (!transaction) {
      return { applied: false, detail: 'That transaction no longer exists' }
    }

    if (transaction.userId !== userId) {
      this.logger.error(
        `[${this.assertReleasable.name}] Case subject does not belong to the case user — refusing`,
        { subjectId, caseUserId: userId },
      )
      return {
        applied: false,
        detail: 'That transaction does not belong to this account',
      }
    }

    if (transaction.status !== TxnStatus.RISK_HELD) {
      return {
        applied: false,
        detail: `That payment is no longer on hold (it is ${transaction.status})`,
      }
    }

    return null
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
