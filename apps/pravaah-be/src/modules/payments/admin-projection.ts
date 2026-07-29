import type {
  LedgerAccount,
  LedgerEntry,
  PaymentDispute,
  ReconciliationRecord,
  Reversal,
  Transaction,
} from 'generated/prisma/client'

/**
 * Console projections for the M4 rows that carry `BigInt` columns.
 *
 * These exist because of a hard property of the wire format rather than a stylistic preference:
 * **`JSON.stringify` throws on a `BigInt`.** Not "loses precision" — throws, with
 * `TypeError: Do not know how to serialize a BigInt`. So any controller that returns a raw Prisma
 * row containing `amountMinor`, `claimedAmountMinor` or `railAmountMinor` does not return a wrong
 * number; it returns a 500. Every path out of this module must pass through a projection.
 *
 * The deliberate choice NOT made here: patching `BigInt.prototype.toJSON` globally. One line would
 * fix all of this, and it would also silently change serialization for M0–M3 and hide the next
 * missed projection behind a value that merely looks plausible. An explicit projection per shape is
 * readable, greppable, and lets the console omit fields an operator has no business seeing.
 *
 * Minor units leave as decimal STRINGS. Never `Number(...)`: `9_007_199_254_740_993n` and a paise
 * figure large enough to matter both survive a string and do not survive a double.
 */

/** Optional BigInt → string, preserving null. */
const minor = (value: bigint | null): string | null =>
  value === null ? null : value.toString()

export function presentReversal(reversal: Reversal) {
  return {
    id: reversal.id,
    sequence: reversal.sequence,
    kind: reversal.kind,
    reason: reversal.reason,
    amountMinor: reversal.amountMinor.toString(),
    status: reversal.status,
    railRef: reversal.railRef,
    failureReason: reversal.failureReason,
    initiatedByAdminId: reversal.initiatedByAdminId,
    createdAt: reversal.createdAt,
    completedAt: reversal.completedAt,
  }
}

/**
 * One reconciliation check.
 *
 * `railAmountMinor` is kept even though it is usually equal to ours, because the case where it is
 * NOT equal is the entire reason the record exists — a rail that settled a different amount than
 * we asked for is a discrepancy no other field on the row would reveal.
 */
export function presentRecon(
  record: ReconciliationRecord & {
    transaction?: Pick<
      Transaction,
      'id' | 'status' | 'corridor' | 'totalDebitMinor' | 'sourceCurrency'
    > | null
  },
) {
  return {
    id: record.id,
    transactionId: record.transactionId,
    source: record.source,
    railStatus: record.railStatus,
    railCode: record.railCode,
    railAmountMinor: minor(record.railAmountMinor),
    internalStatus: record.internalStatus,
    status: record.status,
    discrepancy: record.discrepancy,
    action: record.action,
    resolvedAt: record.resolvedAt,
    createdAt: record.createdAt,
    ...(record.transaction === undefined
      ? {}
      : {
          transaction: record.transaction
            ? {
                id: record.transaction.id,
                status: record.transaction.status,
                corridor: record.transaction.corridor,
                totalDebitMinor: record.transaction.totalDebitMinor.toString(),
                sourceCurrency: record.transaction.sourceCurrency,
              }
            : null,
        }),
  }
}

/**
 * One dispute, for an operator.
 *
 * `evidence` is deliberately absent. It is customer-uploaded free-form JSON — screenshots,
 * statement excerpts, whatever they attached — and a queue screen that rendered it would be
 * echoing untrusted content into the console for every row an operator scrolls past. The reviewer
 * who needs it opens the individual dispute.
 */
export function presentDispute(
  dispute: PaymentDispute & {
    transaction?: Pick<
      Transaction,
      | 'id'
      | 'status'
      | 'corridor'
      | 'totalDebitMinor'
      | 'sourceCurrency'
      | 'refundedMinor'
    > | null
  },
) {
  return {
    id: dispute.id,
    userId: dispute.userId,
    transactionId: dispute.transactionId,
    kind: dispute.kind,
    status: dispute.status,
    description: dispute.description,
    claimedAmountMinor: minor(dispute.claimedAmountMinor),
    resolution: dispute.resolution,
    railRef: dispute.railRef,
    resolvedByAdminId: dispute.resolvedByAdminId,
    slaDueAt: dispute.slaDueAt,
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt,
    ...(dispute.transaction === undefined
      ? {}
      : {
          transaction: dispute.transaction
            ? {
                id: dispute.transaction.id,
                status: dispute.transaction.status,
                corridor: dispute.transaction.corridor,
                totalDebitMinor: dispute.transaction.totalDebitMinor.toString(),
                sourceCurrency: dispute.transaction.sourceCurrency,
                refundedMinor: dispute.transaction.refundedMinor.toString(),
              }
            : null,
        }),
  }
}

/** One ledger entry with its account. Per leg — the caller must not net these. */
export function presentLedgerEntry(
  entry: LedgerEntry & { account: LedgerAccount },
) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    leg: entry.leg,
    legRef: entry.legRef,
    direction: entry.direction,
    amountMinor: entry.amountMinor.toString(),
    currency: entry.currency,
    postedAt: entry.postedAt,
    account: {
      id: entry.account.id,
      type: entry.account.type,
      ownerType: entry.account.ownerType,
      currency: entry.account.currency,
      label: entry.account.label,
    },
  }
}
