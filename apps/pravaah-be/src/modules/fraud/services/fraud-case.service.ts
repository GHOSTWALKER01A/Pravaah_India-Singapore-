import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { FraudCaseOutcomeInput } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { canCaseTransition } from '@/modules/fraud/fraud.state'
import { RiskActionRegistry } from '@/modules/fraud/services/risk-action.registry'
import { WatchlistService } from '@/modules/fraud/services/watchlist.service'

import {
  ActorType,
  AdminRole,
  FraudCaseStatus,
  FraudSeverity,
  ListEntityType,
  ListKind,
  RiskSubjectType,
  type Prisma,
} from 'generated/prisma/client'

/** The acting analyst, always from the authenticated session. */
export interface ActingAnalyst {
  id: string
  role: AdminRole
}

/**
 * The analyst workflow — M6's human-in-the-loop guarantee.
 *
 * ## Why cases exist at all
 *
 * They are what makes an automated `HOLD` defensible. A system that freezes somebody's
 * remittance on a model's say-so, with no named reviewer, no stated reason and no
 * appeal, is not a fraud control — it is an unaccountable denial of service against
 * your own customers. A case carries the triggering `RiskAssessment` (so the analyst
 * sees exactly which signals fired), an append-only note trail, and an SLA clock. The
 * user's money is DELAYED, not lost, and somebody owns the delay.
 *
 * ## The two outcomes that matter
 *
 *  - **CLEARED** — a false positive. Releases the held action through
 *    `RiskActionRegistry` AND records a whitelist signal, so the same benign behaviour
 *    is not re-flagged tomorrow. Without the second half the user is held every week
 *    and the analyst re-clears it every week.
 *  - **CONFIRMED_FRAUD** — blocks the action, adds the artefacts to the mule/block
 *    lists so the graph and the watchlist learn from it, and (for cross-border) routes
 *    to compliance for STR filing.
 *
 * ## Authority, and where it comes from
 *
 * Never from the request body. The M6 build doc's version accepted `analystId` and
 * `role` as body fields, which would let any authenticated analyst confirm a sanctions
 * case by typing `"role": "ADMIN"`. Both come from the admin session, and the
 * senior-role gate is checked against THAT.
 */
@Injectable()
export class FraudCaseService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: RiskActionRegistry,
    private readonly watchlist: WatchlistService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FraudCaseService.name })
  }

  // ── the queue ─────────────────────────────────────────────────────────────
  /**
   * The analyst queue.
   *
   * Ordered by severity DESC then SLA due ASC — the most dangerous first, and within a
   * severity the longest-waiting first. A newest-first queue starves the user who has
   * been held longest, which is the person most likely to be a false positive and most
   * likely to churn. The enum's declaration order in `schema.prisma` is what makes
   * `severity: 'desc'` put CRITICAL on top.
   */
  async queue(params: {
    status?: FraudCaseStatus
    severity?: FraudSeverity
    analystId?: string
    limit: number
    offset: number
  }) {
    const where: Prisma.FraudCaseWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.analystId ? { assignedAnalystId: params.analystId } : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fraudCase.findMany({
        where,
        orderBy: [
          { severity: 'desc' },
          { slaDueAt: 'asc' },
          { openedAt: 'asc' },
        ],
        take: params.limit,
        skip: params.offset,
        include: {
          assessment: {
            select: {
              score: true,
              decision: true,
              modelVersion: true,
              signals: {
                select: { type: true, weight: true, value: true, isHard: true },
              },
            },
          },
          user: {
            select: {
              id: true,
              pravaahId: true,
              kycStatus: true,
              isSuspended: true,
            },
          },
          _count: { select: { notes: true } },
        },
      }),
      this.prisma.fraudCase.count({ where }),
    ])

    const now = Date.now()
    return {
      items: items.map((item) => ({
        ...item,
        /**
         * Computed rather than stored, because it changes with the clock and a stored
         * boolean would be wrong the moment after it was written.
         */
        slaBreached: Boolean(
          item.slaDueAt && item.slaDueAt.getTime() < now && !item.resolvedAt,
        ),
      })),
      total,
    }
  }

  detail(caseId: string) {
    return this.prisma.fraudCase.findUnique({
      where: { id: caseId },
      include: {
        assessment: { include: { signals: true } },
        notes: { orderBy: { createdAt: 'asc' } },
        user: {
          select: {
            id: true,
            pravaahId: true,
            phone: true,
            kycStatus: true,
            isSuspended: true,
            createdAt: true,
          },
        },
        assignedAnalyst: { select: { id: true, email: true, role: true } },
      },
    })
  }

  // ── claiming ──────────────────────────────────────────────────────────────
  /**
   * Take ownership of a case.
   *
   * An atomic conditional `updateMany` whose WHERE clause encodes the precondition
   * (`status: OPEN`, `assignedAnalystId: null`). Two analysts opening the same queue
   * and clicking at once is not hypothetical in a shared console, and the alternative —
   * read, check, write — lets both succeed, with the second silently overwriting the
   * first. The database arbitrates; the loser gets a 409 and reloads.
   */
  async claim(caseId: string, analyst: ActingAnalyst): Promise<void> {
    const claimed = await this.prisma.fraudCase.updateMany({
      where: {
        id: caseId,
        status: FraudCaseStatus.OPEN,
        assignedAnalystId: null,
      },
      data: {
        status: FraudCaseStatus.INVESTIGATING,
        assignedAnalystId: analyst.id,
      },
    })

    if (claimed.count === 0) {
      const existing = await this.prisma.fraudCase.findUnique({
        where: { id: caseId },
        select: { id: true, assignedAnalystId: true, status: true },
      })
      if (!existing) throw new NotFoundException('No such case')
      throw new ConflictException(
        existing.assignedAnalystId === analyst.id
          ? 'You have already claimed this case'
          : 'Another analyst is already working this case',
      )
    }

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: analyst.id,
      action: 'fraud.case.claimed',
      entity: 'FraudCase',
      entityId: caseId,
    })
  }

  /** Add a note without deciding. The investigation trail. */
  async addNote(
    caseId: string,
    analyst: ActingAnalyst,
    note: string,
  ): Promise<void> {
    const fraudCase = await this.requireOwned(caseId, analyst)

    await this.prisma.fraudCaseNote.create({
      data: { caseId: fraudCase.id, analystId: analyst.id, note },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: analyst.id,
      action: 'fraud.case.note',
      entity: 'FraudCase',
      entityId: caseId,
    })
  }

  /** Pause on the user. Stops the SLA clock, because the wait is not ours. */
  async requestInfo(
    caseId: string,
    analyst: ActingAnalyst,
    note: string,
  ): Promise<void> {
    const fraudCase = await this.requireOwned(caseId, analyst)

    if (!canCaseTransition(fraudCase.status, FraudCaseStatus.INFO_REQUESTED)) {
      throw new ConflictException(
        `A ${fraudCase.status.toLowerCase()} case cannot request information`,
      )
    }

    await this.prisma.$transaction([
      this.prisma.fraudCase.update({
        where: { id: caseId },
        data: { status: FraudCaseStatus.INFO_REQUESTED, slaDueAt: null },
      }),
      this.prisma.fraudCaseNote.create({
        data: {
          caseId,
          analystId: analyst.id,
          note,
          action: 'INFO_REQUESTED',
        },
      }),
    ])

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: analyst.id,
      action: 'fraud.case.info_requested',
      entity: 'FraudCase',
      entityId: caseId,
    })
  }

  // ── resolution ────────────────────────────────────────────────────────────
  /**
   * Decide a case, and apply the decision downstream.
   *
   * ## Ordering, which is the subtle part
   *
   * The case is marked resolved and the note written in ONE transaction, then the
   * downstream action is applied, then the result recorded. Not all four in one
   * transaction, and deliberately:
   *
   *  - The downstream release calls into M4, which runs its OWN transaction (a ledger
   *    reserve, a limit consume). Nesting that inside this one would hold a write lock
   *    on the case row for the duration of a payment-rail submission.
   *  - If the release then fails, the analyst's DECISION is still recorded. That is the
   *    right failure mode: the judgement was made by a human and must not be lost
   *    because a transaction had meanwhile expired. `actionApplied` and `actionResult`
   *    are what tell an operator the difference, which is exactly why they are separate
   *    columns from `status`.
   */
  async resolve(params: {
    caseId: string
    analyst: ActingAnalyst
    outcome: FraudCaseOutcomeInput
    note: string
  }): Promise<{
    status: FraudCaseStatus
    actionApplied: boolean
    actionResult: string
  }> {
    const fraudCase = await this.requireOwned(params.caseId, params.analyst)
    const target = params.outcome as FraudCaseStatus

    if (!canCaseTransition(fraudCase.status, target)) {
      throw new ConflictException(
        `A ${fraudCase.status.toLowerCase()} case cannot become ${params.outcome.toLowerCase()}`,
      )
    }

    this.assertSeniorityFor(fraudCase.reason, params.outcome, params.analyst)

    const isEscalation = params.outcome === 'ESCALATED'

    await this.prisma.$transaction([
      this.prisma.fraudCase.update({
        where: { id: params.caseId },
        data: {
          status: target,
          resolution: params.note.slice(0, 1000),
          /**
           * An escalated case is NOT resolved — it is waiting for a more senior
           * decision. Stamping `resolvedAt` would drop it out of every open-case
           * query and lose it.
           */
          resolvedAt: isEscalation ? null : new Date(),
          /** Unassigned on escalation so a senior analyst can claim it. */
          ...(isEscalation
            ? { assignedAnalystId: null, status: FraudCaseStatus.ESCALATED }
            : {}),
        },
      }),
      this.prisma.fraudCaseNote.create({
        data: {
          caseId: params.caseId,
          analystId: params.analyst.id,
          note: params.note,
          action: actionLabelFor(params.outcome),
        },
      }),
    ])

    // ── apply downstream ──
    let actionApplied = false
    let actionResult = 'No downstream action required'

    if (params.outcome === 'CLEARED' || params.outcome === 'CONFIRMED_FRAUD') {
      const applied = await this.actions.apply({
        subjectType: fraudCase.subjectType,
        subjectId: fraudCase.subjectId,
        userId: fraudCase.userId,
        outcome: params.outcome === 'CLEARED' ? 'RELEASE' : 'BLOCK',
        reason: params.note,
        actorId: params.analyst.id,
      })
      actionApplied = applied.applied
      actionResult = applied.detail

      await this.prisma.fraudCase.update({
        where: { id: params.caseId },
        data: { actionApplied, actionResult: actionResult.slice(0, 500) },
      })
    }

    if (params.outcome === 'CONFIRMED_FRAUD') {
      await this.onConfirmedFraud(fraudCase, params.analyst, params.note)
    }

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: params.analyst.id,
      action: `fraud.case.${params.outcome.toLowerCase()}`,
      entity: 'FraudCase',
      entityId: params.caseId,
      metadata: {
        outcome: params.outcome,
        subjectType: fraudCase.subjectType,
        subjectId: fraudCase.subjectId,
        actionApplied,
        actionResult,
        note: params.note,
      },
    })

    this.logger.warn(`[${this.resolve.name}] Case resolved`, {
      caseId: params.caseId,
      outcome: params.outcome,
      analystId: params.analyst.id,
      actionApplied,
    })

    return {
      status: isEscalation ? FraudCaseStatus.ESCALATED : target,
      actionApplied,
      actionResult,
    }
  }

  /**
   * The consequences of a confirmed fraud.
   *
   * The system LEARNS here, and that is the point of confirming rather than merely
   * blocking: the payee goes on the mule list so the next user is protected, the
   * account is suspended, and cross-border cases are flagged for STR filing.
   *
   * Each step is independently guarded and failures are logged rather than thrown. The
   * case is already decided; failing the resolution because one list write errored
   * would leave the analyst unable to close a confirmed fraud.
   */
  private async onConfirmedFraud(
    fraudCase: {
      id: string
      userId: string
      subjectType: RiskSubjectType
      subjectId: string
    },
    analyst: ActingAnalyst,
    note: string,
  ): Promise<void> {
    try {
      /**
       * Suspend the account.
       *
       * `User.isSuspended` is already honoured by M4's transfer path, and now by the
       * risk engine for every other module — so one flag stops payments, claims,
       * consents and binds rather than just transfers.
       */
      await this.prisma.user.update({
        where: { id: fraudCase.userId },
        data: { isSuspended: true },
      })

      await this.watchlist.add({
        kind: ListKind.MULE,
        entityType: ListEntityType.USER,
        value: fraudCase.userId,
        reason: `Confirmed fraud on case ${fraudCase.id}: ${note.slice(0, 200)}`,
        source: 'mule_confirmed',
        addedById: analyst.id,
      })

      /**
       * List the counterparty too, when the case was about a transaction.
       *
       * This is the step that protects OTHER users: the mule account that received
       * this payment is the one the next victim will be told to pay. Read off the
       * transaction rather than taken from the analyst, so it cannot be mistyped.
       */
      if (fraudCase.subjectType === RiskSubjectType.TRANSACTION) {
        const transaction = await this.prisma.transaction.findUnique({
          where: { id: fraudCase.subjectId },
          select: { counterpartyHandle: true, corridor: true },
        })

        if (transaction?.counterpartyHandle) {
          await this.watchlist.add({
            kind: ListKind.MULE,
            entityType: ListEntityType.BENEFICIARY,
            value: transaction.counterpartyHandle,
            reason: `Received funds in confirmed fraud case ${fraudCase.id}`,
            source: 'mule_confirmed',
            addedById: analyst.id,
          })
        }

        /**
         * Cross-border confirmed fraud routes to compliance for STR filing.
         *
         * Recorded as an audit row rather than filed automatically, and that is the
         * honest position: an STR is a regulated filing to FIU-IND made by a
         * designated principal officer, not something an application submits. What the
         * code can correctly do is make the obligation undeniable and timestamped.
         */
        if (transaction?.corridor === 'CROSS_BORDER') {
          await this.audit.log({
            actorType: ActorType.ADMIN,
            actorId: analyst.id,
            action: 'compliance.str_required',
            entity: 'FraudCase',
            entityId: fraudCase.id,
            metadata: {
              reason: 'Confirmed cross-border fraud',
              subjectId: fraudCase.subjectId,
              note: note.slice(0, 500),
            },
          })

          this.logger.warn(
            `[${this.onConfirmedFraud.name}] Cross-border fraud confirmed — STR filing required`,
            { caseId: fraudCase.id, userId: fraudCase.userId },
          )
        }
      }
    } catch (error) {
      this.logger.error(
        `[${this.onConfirmedFraud.name}] Post-confirmation actions partially failed`,
        { err: error, caseId: fraudCase.id },
      )
    }
  }

  // ── guards ────────────────────────────────────────────────────────────────
  /**
   * Load a case the acting analyst is entitled to act on.
   *
   * An unclaimed case can be acted on by anyone (that is what claiming is for), but a
   * case assigned to somebody else cannot — except by an `ADMIN`, who needs an
   * override for the case whose owner has left. The override is audited like any other
   * action.
   */
  private async requireOwned(caseId: string, analyst: ActingAnalyst) {
    const fraudCase = await this.prisma.fraudCase.findUnique({
      where: { id: caseId },
    })
    if (!fraudCase) throw new NotFoundException('No such case')

    const isOwner = fraudCase.assignedAnalystId === analyst.id
    const isUnassigned = fraudCase.assignedAnalystId === null
    const isAdmin = analyst.role === AdminRole.ADMIN

    if (!isOwner && !isUnassigned && !isAdmin) {
      throw new ForbiddenException('This case is assigned to another analyst')
    }

    return fraudCase
  }

  /**
   * The senior-role gate on sanctions-derived confirmations.
   *
   * A sanctions determination has legal consequences that outlast the case — it names
   * a person as a designated party — so it needs a senior reviewer or compliance, not
   * a first-line analyst. Mirrors M0's senior-reviewer gate on KYC rejections and M5's
   * on claim approvals.
   *
   * Matched on the stored signal types rather than the analyst's note, because the note
   * is free text: gating on it would let the gate be avoided by wording, and trigger
   * falsely on an analyst who merely mentioned the word.
   */
  private assertSeniorityFor(
    reason: string,
    outcome: FraudCaseOutcomeInput,
    analyst: ActingAnalyst,
  ): void {
    if (outcome !== 'CONFIRMED_FRAUD') return

    const isSanctionsDerived = reason.includes('WATCHLIST_HIT')
    if (!isSanctionsDerived) return

    if (
      analyst.role === AdminRole.SENIOR_REVIEWER ||
      analyst.role === AdminRole.ADMIN
    ) {
      return
    }

    throw new ForbiddenException(
      'Confirming a sanctions-derived case requires a senior reviewer or compliance role',
    )
  }

  // ── stats ─────────────────────────────────────────────────────────────────
  /**
   * The operational overview.
   *
   * `slaBreached` is the number that matters and the one an operator should be paged
   * on: it counts people whose money has been held past the promised window. Every
   * other figure here is context for that one.
   */
  async stats() {
    const now = new Date()

    /**
     * `Promise.all`, deliberately NOT `$transaction`.
     *
     * Two reasons. The practical one: a read-only dashboard does not need a consistent
     * snapshot across five aggregates — a count that is one case stale is not a wrong
     * answer, and holding a transaction open for five aggregations on the hot tables is
     * a real cost for no benefit.
     *
     * The mechanical one: Prisma's `$transaction([...])` tuple inference gives up on a
     * heterogeneous array of `groupBy` and `count` promises and silently widens the
     * `_count` payload to a union, so `row._count._all` stops type-checking. Running
     * them concurrently keeps each call's own inference intact.
     */
    const [byStatus, bySeverity, byDecision, slaBreached, openTotal] =
      await Promise.all([
        this.prisma.fraudCase.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.fraudCase.groupBy({
          by: ['severity'],
          where: { resolvedAt: null },
          _count: { _all: true },
        }),
        this.prisma.riskAssessment.groupBy({
          by: ['decision'],
          where: {
            computedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1_000) },
          },
          _count: { _all: true },
        }),
        this.prisma.fraudCase.count({
          where: { resolvedAt: null, slaDueAt: { lt: now } },
        }),
        this.prisma.fraudCase.count({ where: { resolvedAt: null } }),
      ])

    return {
      cases: {
        open: openTotal,
        slaBreached,
        byStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, row._count._all]),
        ),
        byOpenSeverity: Object.fromEntries(
          bySeverity.map((row) => [row.severity, row._count._all]),
        ),
      },
      /** The last 24 hours' decision mix — the model's behaviour at a glance. */
      decisions24h: Object.fromEntries(
        byDecision.map((row) => [row.decision, row._count._all]),
      ),
    }
  }
}

function actionLabelFor(outcome: FraudCaseOutcomeInput): string {
  switch (outcome) {
    case 'CLEARED':
      return 'HELD_RELEASED'
    case 'CONFIRMED_FRAUD':
      return 'USER_BLOCKED'
    case 'ESCALATED':
      return 'ESCALATED'
  }
}
