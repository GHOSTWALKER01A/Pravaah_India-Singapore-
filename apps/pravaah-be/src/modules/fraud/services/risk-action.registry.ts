import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import type { RiskSubjectType } from 'generated/prisma/client'

/**
 * What a module must implement to have its held actions releasable by an analyst.
 *
 * Two methods, both idempotent, both returning a description rather than throwing on
 * a no-op — because a case resolution must not fail because the underlying action
 * has already moved on.
 */
export interface RiskActionHandler {
  /** Let a held action proceed. Called when a case is CLEARED. */
  release(params: {
    subjectId: string
    userId: string
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }>

  /** Refuse a held action for good. Called when a case is CONFIRMED_FRAUD. */
  block(params: {
    subjectId: string
    userId: string
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }>
}

/**
 * The seam that lets M6 release M4's held transfers without importing M4.
 *
 * ## The problem this solves
 *
 * `FraudCaseService.resolve` must, on a CLEARED case, tell M4 to release the
 * `RISK_HELD` transaction — which means calling `TransferOrchestratorService`. But M4
 * already imports M6 (its risk scoring delegates to `RiskService`). A direct
 * dependency the other way is a circular module reference, and NestJS's escape hatch
 * for that (`forwardRef`) is fragile: it resolves at runtime, so a mistake surfaces as
 * an undefined injection deep inside a case resolution rather than at startup.
 *
 * ## The shape instead
 *
 * Inversion of control through a registry. M6 owns this class and knows nothing about
 * payments or insurance. Each downstream module provides a small adapter that
 * `register`s itself for its subject type in `onModuleInit`. Dependencies point ONE
 * way — payments → fraud, insurance → fraud — and the wiring is explicit rather than
 * magical.
 *
 * This is the same "registry, not a ternary" instinct M5's
 * `InsuranceProviderRegistry` and M4's `PaymentProviderFactory` both document, applied
 * to a dependency cycle rather than to provider selection.
 *
 * ## Why an unregistered handler is a WARNING and not a throw
 *
 * A subject type with no handler means "nothing downstream needs releasing" — a LOGIN
 * or DEVICE_BIND case has no held money. Throwing would make every such case
 * unresolvable. The case still records `actionApplied: false`, so an operator can see
 * that nothing was released rather than being told it was.
 */
@Injectable()
export class RiskActionRegistry {
  private readonly logger: AppLogger
  private readonly handlers = new Map<RiskSubjectType, RiskActionHandler>()

  constructor(@Inject(APP_LOGGER) logger: AppLogger) {
    this.logger = logger.child({ context: RiskActionRegistry.name })
  }

  /**
   * Claim a subject type. Called from a downstream module's `onModuleInit`.
   *
   * A second registration for the same type REPLACES the first and logs loudly. It
   * is always a bug — two modules both believing they own transaction releases — and
   * silently keeping either one would make which handler runs depend on module
   * initialisation order.
   */
  register(subjectType: RiskSubjectType, handler: RiskActionHandler): void {
    if (this.handlers.has(subjectType)) {
      this.logger.error(
        `[${this.register.name}] Two handlers registered for ${subjectType} — the later one wins`,
        { subjectType },
      )
    }
    this.handlers.set(subjectType, handler)
    this.logger.info(`[${this.register.name}] Handler registered`, {
      subjectType,
    })
  }

  has(subjectType: RiskSubjectType): boolean {
    return this.handlers.has(subjectType)
  }

  /**
   * Apply a case outcome to the underlying action.
   *
   * Never throws. A downstream failure — the transaction expired, the claim was
   * already withdrawn — is captured as `applied: false` with a reason, because the
   * analyst's DECISION is recorded either way and a case that could not be closed
   * because a release failed would strand both the case and the user.
   */
  async apply(params: {
    subjectType: RiskSubjectType
    subjectId: string
    userId: string
    outcome: 'RELEASE' | 'BLOCK'
    reason: string
    actorId?: string | null
  }): Promise<{ applied: boolean; detail: string }> {
    const handler = this.handlers.get(params.subjectType)

    if (!handler) {
      const detail = `No release handler for ${params.subjectType} — nothing to apply`
      this.logger.warn(`[${this.apply.name}] ${detail}`, {
        subjectType: params.subjectType,
      })
      return { applied: false, detail }
    }

    try {
      const action = params.outcome === 'RELEASE' ? 'release' : 'block'
      return await handler[action]({
        subjectId: params.subjectId,
        userId: params.userId,
        reason: params.reason,
        actorId: params.actorId,
      })
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Unknown downstream failure'

      this.logger.error(
        `[${this.apply.name}] Handler threw applying a case outcome`,
        {
          err: error,
          subjectType: params.subjectType,
          subjectId: params.subjectId,
          outcome: params.outcome,
        },
      )
      return { applied: false, detail }
    }
  }
}
