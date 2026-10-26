import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

/**
 * Something that happened to a verifier request, as M3 observed it.
 *
 * Deliberately a FACT, not a command: M3 reports "the holder approved request X"
 * and has no idea whether anyone meters it, receipts it or tells a partner about
 * it. That is what lets the handshake stay in M3 while M7 builds a commercial
 * product on top of it.
 */
export type VerifierRequestEventType =
  | 'REQUEST_CREATED'
  | 'APPROVED'
  /** The holder's device produced a proof that did not verify. Retryable. */
  | 'PRESENTATION_REJECTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED'
  /** The verifier read the result; the nonce is burnt. */
  | 'COLLECTED'

export interface VerifierRequestEvent {
  type: VerifierRequestEventType
  requestId: string
  /** Null for a peer (person-to-person) request. */
  partnerId: string | null
  userId?: string | null
  presentationId?: string | null
  occurredAt: Date
}

/** What an observer is shown before a holder's approval is allowed to proceed. */
export interface VerifierApprovalContext {
  requestId: string
  partnerId: string | null
  userId: string
  revealClaims: string[]
}

export interface VerifierRequestObserver {
  /** Unique; a second registration under the same name is a wiring bug. */
  readonly name: string
  /**
   * Veto an approval by throwing. Runs AFTER the request lock is taken and BEFORE
   * a presentation is built, so a veto releases the lock and discloses nothing.
   */
  beforeApprove?: (ctx: VerifierApprovalContext) => Promise<void>
  /** React to a fact. Must be idempotent: the same event may be delivered twice. */
  onEvent?: (event: VerifierRequestEvent) => Promise<void>
}

/**
 * The seam between M3's handshake and anything built on top of it.
 *
 * The dependency INVERTS here, exactly as M6's `RiskActionRegistry` does for
 * M4/M5: M7 imports `PassportModule` and registers an observer in `onModuleInit`;
 * M3 imports nothing of M7's. `forwardRef` was the alternative and was rejected
 * for the same reason M6 rejected it — it resolves at runtime, so a mistake
 * surfaces as an undefined injection in the middle of a holder's approval.
 *
 * The two hooks have opposite failure semantics, on purpose:
 *
 *  - `beforeApprove` FAILS CLOSED. An observer that throws — including one that
 *    throws because its database read failed — stops the share. A consent gate
 *    that lets data through when it cannot decide is not a gate.
 *  - `emit` FAILS OPEN. A handshake fact that has already happened (the holder
 *    approved, the verdict is cached) cannot be un-happened because a downstream
 *    meter hiccupped. Observers must therefore reconcile missed events themselves
 *    (M7 runs a sweeper), and every failure here is logged, never swallowed quietly.
 */
@Injectable()
export class VerifierEventsRegistry {
  private readonly logger: AppLogger
  private readonly observers: VerifierRequestObserver[] = []

  constructor(@Inject(APP_LOGGER) logger: AppLogger) {
    this.logger = logger.child({ context: VerifierEventsRegistry.name })
  }

  register(observer: VerifierRequestObserver): void {
    if (this.observers.some((existing) => existing.name === observer.name)) {
      throw new Error(
        `A verifier-request observer named "${observer.name}" is already registered`,
      )
    }
    this.observers.push(observer)
    this.logger.info(`[${this.register.name}] Observer registered`, {
      observer: observer.name,
    })
  }

  /** Names of registered observers — for the wiring spec and diagnostics. */
  registered(): string[] {
    return this.observers.map((observer) => observer.name)
  }

  /**
   * Ask every observer whether this approval may proceed. Sequential, so the first
   * veto wins and later observers are not consulted about a share that is not
   * going to happen.
   */
  async beforeApprove(ctx: VerifierApprovalContext): Promise<void> {
    for (const observer of this.observers) {
      if (observer.beforeApprove) await observer.beforeApprove(ctx)
    }
  }

  /** Report a fact to every observer. Never throws. */
  async emit(event: VerifierRequestEvent): Promise<void> {
    const listeners = this.observers.filter((observer) => observer.onEvent)
    if (!listeners.length) return

    const settled = await Promise.allSettled(
      listeners.map(async (observer) => {
        await observer.onEvent?.(event)
      }),
    )
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `[${this.emit.name}] Observer failed to handle a verifier-request event`,
          {
            observer: listeners[index]?.name,
            type: event.type,
            requestId: event.requestId,
            err: result.reason,
          },
        )
      }
    })
  }
}
