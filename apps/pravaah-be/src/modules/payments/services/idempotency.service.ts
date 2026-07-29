import { createHash } from 'crypto'

import { ConflictException, Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import {
  IDEMPOTENCY_STALE_LOCK_MS,
  IDEMPOTENCY_TTL_MS,
} from '@/modules/payments/payments.config'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { IdempotencyStatus, Prisma } from 'generated/prisma/client'

/** The endpoints that require a key. Scoped so one key may be reused across them. */
export const IDEMPOTENCY_SCOPE = {
  TRANSFER_CREATE: 'transfer.create',
  TRANSFER_RETRY: 'transfer.retry',
  TOPUP: 'wallet.topup',
  WITHDRAW: 'wallet.withdraw',
  COLLECT_CREATE: 'collect.create',
  COLLECT_RESPOND: 'collect.respond',
  QR_PAY: 'qr.pay',
  MANDATE_CREATE: 'mandate.create',
  MANDATE_EXECUTE: 'mandate.execute',
  REFUND: 'refund.create',
} as const

export type IdempotencyScope =
  (typeof IDEMPOTENCY_SCOPE)[keyof typeof IDEMPOTENCY_SCOPE]

export interface IdempotentResult<T> {
  value: T
  /** True when this is a replay of a previously completed request. */
  replayed: boolean
}

/**
 * Idempotency — the guarantee that a retry never moves money twice.
 *
 * Mobile clients retry. Networks drop the response, not the request; users
 * double-tap; React Native remounts a screen mid-flight. Every one of those is a
 * second identical POST arriving at a server that has already debited somebody, and
 * "the client should not do that" is not an available answer.
 *
 * The design in one line: the key is a UNIQUE ROW, taken before the work starts.
 * Not a lookup-then-insert — that has a window in which two concurrent requests both
 * find nothing and both proceed, which is exactly the race being defended against.
 * The database's unique index is the only thing that can arbitrate, so it does.
 *
 * Four cases, each with a distinct and deliberate answer:
 *
 *  - **New key** → run the work, store the response.
 *  - **Same key, COMPLETED** → return the stored response verbatim. The caller gets
 *    the same transaction id and never learns it was a retry.
 *  - **Same key, DIFFERENT body** → 409. This is not a retry; it is a client bug or
 *    an attack, and replaying the first response would silently discard the second
 *    request. Loud beats convenient.
 *  - **Same key, IN_PROGRESS** → 409 with a retry hint, UNLESS the lock is stale, in
 *    which case it is reclaimed. Without reclamation a process that died mid-request
 *    would brick that operation for that user permanently.
 *
 * The one thing this service cannot do alone is make the INNER work idempotent. A
 * reclaimed lock re-runs the handler, so the ledger's unique constraint on
 * `(transaction, account, direction, leg, legRef)` is the second half of the
 * guarantee. Neither is sufficient by itself.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: IdempotencyService.name })
  }

  /**
   * Canonical hash of a request body.
   *
   * Keys are sorted recursively before hashing, so `{a:1,b:2}` and `{b:2,a:1}` are
   * the same request. Without that, two clients (or two versions of one client)
   * serialising the same intent in a different property order would hash
   * differently, and a legitimate retry would be rejected as a key reused with a
   * different payload.
   */
  hashRequest(body: unknown): string {
    return createHash('sha256').update(canonicalise(body)).digest('hex')
  }

  /**
   * Run `work` at most once for `(user, scope, key)`.
   *
   * `work` receives the record id so it can stamp the transaction it creates onto
   * the key — which is what lets a replay return the same transaction rather than a
   * cached blob that has since drifted from the row.
   */
  async runOnce<T>(
    params: {
      userId: string
      scope: IdempotencyScope
      key: string
      body: unknown
    },
    work: (recordId: string) => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const { userId, scope, key, body } = params
    const requestHash = this.hashRequest(body)

    const claim = await this.claim({ userId, scope, key, requestHash })
    if (claim.kind === 'replay') {
      this.logger.info(`[${this.runOnce.name}] Replaying a completed request`, {
        userId,
        scope,
        transactionId: claim.transactionId,
      })
      return { value: claim.response as T, replayed: true }
    }

    try {
      const value = await work(claim.recordId)
      await this.complete(claim.recordId, value)
      return { value, replayed: false }
    } catch (error) {
      await this.fail(claim.recordId, error)
      throw error
    }
  }

  /**
   * Take the lock, or discover why we cannot.
   *
   * Insert-first, and the ordering is the whole mechanism: the unique index on
   * `(userId, scope, key)` decides the winner, so there is no window between
   * checking and claiming for a concurrent request to slip through.
   */
  private async claim(params: {
    userId: string
    scope: string
    key: string
    requestHash: string
  }): Promise<
    | { kind: 'claimed'; recordId: string }
    | { kind: 'replay'; response: unknown; transactionId: string | null }
  > {
    const { userId, scope, key, requestHash } = params
    const now = new Date()

    try {
      const created = await this.prisma.idempotencyRecord.create({
        data: {
          userId,
          scope,
          key,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          lockedAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        },
      })
      return { kind: 'claimed', recordId: created.id }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }

    // Somebody holds the key. Which of the four cases is it?
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { userId_scope_key: { userId, scope, key } },
    })
    if (!existing) {
      // The row was created and deleted between our INSERT and this SELECT — only
      // possible via expiry cleanup. Treat the key as free and let the caller retry.
      throw new ConflictException(
        'That request key was being cleaned up. Please retry.',
      )
    }

    /**
     * Same key, different body.
     *
     * Checked FIRST, before the status, because it is a correctness question rather
     * than a timing one: whatever state the original request is in, this is not the
     * same request, and answering it with the original's response would silently
     * throw away whatever the caller actually asked for.
     */
    if (existing.requestHash !== requestHash) {
      this.logger.warn(
        `[${this.claim.name}] Idempotency key reused with a different payload`,
        { userId, scope },
      )
      throw new ConflictException(
        'This Idempotency-Key was already used for a different request. Use a new key.',
      )
    }

    if (existing.status === IdempotencyStatus.COMPLETED) {
      return {
        kind: 'replay',
        response: existing.responseJson,
        transactionId: existing.transactionId,
      }
    }

    if (existing.status === IdempotencyStatus.IN_PROGRESS) {
      const lockAge = now.getTime() - existing.lockedAt.getTime()
      if (lockAge < IDEMPOTENCY_STALE_LOCK_MS) {
        /**
         * A live request is still running. 409, not "wait and return its result":
         * holding this connection open would double the time a stuck payment ties up
         * a socket, and the client already knows how to poll the transaction.
         */
        throw new ConflictException(
          'That request is still being processed. Check its status before retrying.',
        )
      }

      /**
       * The lock is stale — the process holding it is gone.
       *
       * Reclaimed with a CONDITIONAL update on `lockedAt`, so if two recovery
       * attempts race, exactly one wins. Reclaiming is safe only because the work
       * itself is idempotent at the ledger level; re-running it cannot double-post.
       */
      const reclaimed = await this.prisma.idempotencyRecord.updateMany({
        where: {
          id: existing.id,
          status: IdempotencyStatus.IN_PROGRESS,
          lockedAt: existing.lockedAt,
        },
        data: { lockedAt: now },
      })
      if (reclaimed.count === 0) {
        throw new ConflictException(
          'That request is still being processed. Check its status before retrying.',
        )
      }

      this.logger.warn(
        `[${this.claim.name}] Reclaimed a stale idempotency lock`,
        { userId, scope, lockAgeMs: lockAge },
      )
      return { kind: 'claimed', recordId: existing.id }
    }

    /**
     * The previous attempt FAILED.
     *
     * A retry is allowed — that is the whole point of a failed request being
     * retryable with the same key. The status flips back to IN_PROGRESS so a second
     * concurrent retry still queues behind this one.
     */
    const retaken = await this.prisma.idempotencyRecord.updateMany({
      where: { id: existing.id, status: IdempotencyStatus.FAILED },
      data: {
        status: IdempotencyStatus.IN_PROGRESS,
        lockedAt: now,
        errorMessage: null,
      },
    })
    if (retaken.count === 0) {
      throw new ConflictException(
        'That request is being retried elsewhere. Check its status before retrying.',
      )
    }
    return { kind: 'claimed', recordId: existing.id }
  }

  private async complete(recordId: string, value: unknown): Promise<void> {
    // `BigInt` has no JSON representation, so the response is serialised through
    // the same string projection the API uses. A raw `JSON.stringify` here would
    // throw and turn a successful payment into a 500 AFTER the money had moved.
    const responseJson = jsonSafe(value)
    await this.prisma.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseJson: responseJson as Prisma.InputJsonValue,
        statusCode: 200,
        transactionId: extractTransactionId(value),
      },
    })
  }

  private async fail(recordId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown failure'
    // Best-effort: a failure to record the failure must not replace the real error
    // the caller needs to see.
    await this.prisma.idempotencyRecord
      .update({
        where: { id: recordId },
        data: {
          status: IdempotencyStatus.FAILED,
          errorMessage: message.slice(0, 500),
        },
      })
      .catch((writeError: unknown) => {
        this.logger.error(
          `[${this.fail.name}] Could not record an idempotency failure`,
          { recordId, err: writeError },
        )
      })
  }

  /** Link a key to the transaction it produced, from inside the work function. */
  async attachTransaction(
    recordId: string,
    transactionId: string,
  ): Promise<void> {
    await this.prisma.idempotencyRecord
      .update({ where: { id: recordId }, data: { transactionId } })
      .catch(() => void 0)
  }

  /** Drop expired keys. A key honoured forever is an unbounded table. */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    return result.count
  }
}

/**
 * Deterministic JSON for hashing: object keys sorted, recursively.
 *
 * `BigInt` is stringified rather than rejected, because DTOs carry minor amounts as
 * strings but internal calls may pass `bigint` — and a hash function that throws on
 * a valid input turns a correctness feature into an outage.
 */
function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`
  }
  if (value instanceof Date) return `"${value.toISOString()}"`

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are absent as far as JSON is concerned, so an explicit
    // `{ mcc: undefined }` must hash the same as omitting `mcc` entirely.
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalise(member)}`)
    .join(',')}}`
}

/** Deep-convert `BigInt` to string so a response can be persisted as JSON. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, member]) => [
      key,
      jsonSafe(member),
    ]),
  )
}

/** Pull a transaction id out of a handler result, when there is one. */
function extractTransactionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const candidate =
    record.transactionId ??
    (typeof record.id === 'string' && 'status' in record ? record.id : null)
  return typeof candidate === 'string' ? candidate : null
}
