import { Inject, Injectable, OnModuleInit } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  RiskActionRegistry,
  type RiskActionHandler,
} from '@/modules/fraud/services/risk-action.registry'

import {
  ActorType,
  ClaimDecision,
  ClaimStatus,
  RiskSubjectType,
} from 'generated/prisma/client'

/**
 * Lets an analyst resolve the fraud case on a claim, without M6 importing M5.
 *
 * Registers into {@link RiskActionRegistry} on init, exactly as
 * `PaymentRiskActionAdapter` does and for the same reason: M5 depends on M6, so the
 * reverse call has to be an inversion rather than a `forwardRef`.
 *
 * ## Why this adapter does LESS than the payments one
 *
 * A held transfer has money sitting in suspense, so clearing its case must actually
 * release funds. A claim under review has moved no money — the fraud gate blocks
 * AUTO-APPROVAL, and the claim then waits in `UNDER_REVIEW` for an adjudicator. So the
 * fraud analyst's job here is to clear the FRAUD question, not to decide the claim.
 *
 * That separation is deliberate and it is a control, not an omission. Approving a claim
 * means paying out against a policy's remaining cover, checking the waiting period, and
 * booking a payout on the ledger — all of which live in `ClaimsService.decide` behind an
 * adjudicator's authority. A fraud analyst clearing a case should not be able to
 * short-circuit that and pay a claim; they should be able to say "this is not fraud" and
 * hand it back to the claims queue.
 *
 * `CONFIRMED_FRAUD` is the asymmetric case: that IS a claims decision, because a claim
 * confirmed fraudulent must not sit in a queue waiting to be approved by somebody who has
 * not read the case. So it rejects.
 */
@Injectable()
export class ClaimRiskActionAdapter implements RiskActionHandler, OnModuleInit {
  private readonly logger: AppLogger

  constructor(
    private readonly registry: RiskActionRegistry,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: ClaimRiskActionAdapter.name })
  }

  onModuleInit(): void {
    this.registry.register(RiskSubjectType.CLAIM, this)
  }

  /**
   * Clear the fraud question on a claim.
   *
   * Leaves the claim in `UNDER_REVIEW` for an adjudicator, and records the clearance as a
   * note on the claim's own trail. It does NOT approve — see the class comment.
   */
  async release(params: {
    subjectId: string
    userId: string
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }> {
    const claim = await this.load(params.subjectId, params.userId)
    if ('applied' in claim) return claim

    if (isTerminal(claim.status)) {
      return {
        applied: false,
        detail: `That claim is already ${claim.status.toLowerCase()}`,
      }
    }

    /**
     * The fraud flags are annotated, not erased.
     *
     * An adjudicator reading this claim next needs to know it was flagged AND cleared —
     * that is different information from never having been flagged, and it is what stops
     * the same benign pattern being re-escalated on the holder's next claim. Deleting the
     * flags would make the clearance invisible.
     */
    await this.prisma.claim.update({
      where: { id: claim.id },
      data: {
        riskFlags: [...claim.riskFlags, 'FRAUD_CLEARED'],
      },
    })

    this.logger.warn(`[${this.release.name}] Fraud case cleared on a claim`, {
      claimId: claim.id,
      analystId: params.actorId,
    })

    return {
      applied: true,
      detail:
        'Fraud cleared. The claim remains under review for an adjudicator to decide.',
    }
  }

  /**
   * Reject a claim confirmed fraudulent.
   *
   * Written directly rather than through `ClaimsService.decide`, and that is a considered
   * exception. `decide` requires an `AdminUser` in its adjudicator role and records a
   * `ClaimDecision` attributed to them; a fraud analyst confirming fraud is a DIFFERENT
   * authority reaching a different conclusion, and attributing their finding as a claims
   * adjudication would misrepresent who decided what.
   *
   * Safe because it only ever moves a claim to REJECTED and pays nothing — the payout path,
   * with its cover checks and ledger postings, is untouched. A rejection needs no money to
   * move, which is exactly why it is the one outcome that can be written here.
   */
  async block(params: {
    subjectId: string
    userId: string
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }> {
    const claim = await this.load(params.subjectId, params.userId)
    if ('applied' in claim) return claim

    if (isTerminal(claim.status)) {
      return {
        applied: false,
        detail: `That claim is already ${claim.status.toLowerCase()}`,
      }
    }

    if (claim.payoutTxnId) {
      /**
       * Already paid. Refused rather than silently rejected.
       *
       * A claim with a payout transaction has had money leave the ledger, and flipping its
       * status to REJECTED would leave the books saying one thing and the claim another.
       * Recovering a paid-out fraudulent claim is a recovery action against the holder, not
       * a status change — so the analyst is told plainly.
       */
      return {
        applied: false,
        detail:
          'That claim has already been paid out. Recovery must be handled as a separate action.',
      }
    }

    await this.prisma.claim.update({
      where: { id: claim.id },
      data: {
        status: ClaimStatus.REJECTED,
        riskFlags: [...claim.riskFlags, 'FRAUD_CONFIRMED'],
        decision: ClaimDecision.REJECT,
        decisionReason: `Rejected on confirmed fraud: ${params.reason}`.slice(
          0,
          1000,
        ),
        /**
         * Attributed to ADMIN, and `reviewerId` deliberately left null.
         *
         * `reviewerId` is a foreign key to `AdminUser` in the claims-adjudicator sense, and
         * a fraud analyst is a different authority reaching a different conclusion —
         * recording them there would misrepresent a fraud finding as a claims adjudication.
         * Who actually decided is on the `FraudCase` and in the audit trail, both of which
         * name them.
         */
        decidedByType: ActorType.ADMIN,
        decidedAt: new Date(),
      },
    })

    this.logger.warn(`[${this.block.name}] Claim rejected on confirmed fraud`, {
      claimId: claim.id,
      analystId: params.actorId,
    })

    return { applied: true, detail: 'Claim rejected on confirmed fraud' }
  }

  /**
   * Load a claim, verifying it belongs to the case's user.
   *
   * `FraudCase.subjectId` is TEXT rather than a foreign key — it has to be, because a
   * LOGIN case points at a synthetic key — so nothing at the database level guarantees a
   * case's subject belongs to its user. Enforced here, or a case with a wrong subject id
   * could reject a DIFFERENT holder's claim.
   */
  private async load(subjectId: string, userId: string) {
    if (!isUuid(subjectId)) {
      return {
        applied: false,
        detail: 'That case does not refer to a claim',
      } as const
    }

    const claim = await this.prisma.claim.findUnique({
      where: { id: subjectId },
      select: {
        id: true,
        userId: true,
        status: true,
        riskFlags: true,
        payoutTxnId: true,
      },
    })

    if (!claim) {
      return { applied: false, detail: 'That claim no longer exists' } as const
    }

    if (claim.userId !== userId) {
      this.logger.error(
        `[${this.load.name}] Case subject does not belong to the case user — refusing`,
        { subjectId, caseUserId: userId },
      )
      return {
        applied: false,
        detail: 'That claim does not belong to this account',
      } as const
    }

    return claim
  }
}

function isTerminal(status: ClaimStatus): boolean {
  return (
    status === ClaimStatus.REJECTED ||
    status === ClaimStatus.WITHDRAWN ||
    status === ClaimStatus.PAID
  )
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
