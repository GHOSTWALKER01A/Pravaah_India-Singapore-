import { z } from 'zod';

import { APIResponseSchema } from '../core/api.schema';

/**
 * M4 · Payments, as surfaced to operators — the money-risk console.
 *
 * Two properties of these shapes are deliberate and worth stating, because both are enforced by
 * the backend projection rather than by this file:
 *
 * 1. **Every amount is a minor-unit STRING.** Never a `z.number()`. A rupee figure parsed as a
 *    JavaScript number has already been through binary floating point, and the one place that must
 *    not happen is the console an operator uses to decide whether the ledger balances.
 * 2. **Counterparty addresses arrive MASKED.** A console is the most-shared screen during an
 *    incident — screenshots, screen shares, tickets — and a full VPA is a directly payable
 *    address. Support staff never need it to do their job, so the API does not send it.
 */

// ── shared vocabulary ───────────────────────────────────────────────────────
export const TxnStatusSchema = z.enum([
  'INITIATED',
  'VALIDATED',
  'RISK_HELD',
  'AWAITING_APPROVAL',
  'RESERVED',
  'SUBMITTED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'REVERSED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'EXPIRED',
  'DEEMED',
]);
export type TxnStatus = z.infer<typeof TxnStatusSchema>;

export const CorridorSchema = z.enum(['DOMESTIC', 'CROSS_BORDER']);
export type Corridor = z.infer<typeof CorridorSchema>;

export const ReconStatusSchema = z.enum([
  'MATCHED',
  'MISMATCH',
  'RESOLVED',
  'ESCALATED',
]);

/**
 * The twelve legs, mirroring `LEDGER_LEG` in `@pravaah/schema` and the Prisma enum behind it.
 *
 * Exported as a type as well as a schema so the console's label maps can be keyed on it. A
 * `Record<string, string>` label map compiles happily when a leg is added upstream and then renders
 * the raw enum token; a `Record<LedgerLeg, string>` fails the build, which is the only way this stays
 * correct without anybody remembering to check.
 */
export const LedgerLegSchema = z.enum([
  'RESERVE',
  'FEE',
  'TAX',
  'FX_OUT',
  'FX_IN',
  'PAYOUT',
  'REVERSE',
  'REFUND',
  'TOPUP',
  'WITHDRAW',
  'RECOVERY',
  'ADJUSTMENT',
]);
export type LedgerLeg = z.infer<typeof LedgerLegSchema>;

export const AccountTypeSchema = z.enum([
  'USER_WALLET',
  'PLATFORM_NOSTRO',
  'PLATFORM_FEE',
  'FX_POSITION',
  'SUSPENSE',
  'EXTERNAL',
  'RECEIVABLE',
]);

/** One amount, in every representation. `minor` is authoritative. */
const MoneySchema = z.object({
  minor: z.string(),
  major: z.string(),
  formatted: z.string(),
  currency: z.string(),
});

// ── the trial balance ───────────────────────────────────────────────────────
/**
 * The one number an operator should be paged about.
 *
 * Zero in every currency, always. Since the ledger rejects an unbalanced posting set, a non-zero
 * `netMinor` cannot come from a bad payment — it means entries reached the table WITHOUT going
 * through `LedgerService.post`: a raw SQL fix, a migration, a direct database edit. So the console
 * treats a broken trial balance as an alarm rather than as a metric.
 */
export const TrialBalanceSchema = z.object({
  balanced: z.boolean(),
  currencies: z.array(
    z.object({
      currency: z.string(),
      credits: MoneySchema,
      debits: MoneySchema,
      netMinor: z.string(),
      balanced: z.boolean(),
    }),
  ),
  accounts: z
    .array(
      z.object({
        id: z.string(),
        ownerType: z.string(),
        type: AccountTypeSchema,
        currency: z.string(),
        label: z.string().nullable(),
        allowNegative: z.boolean(),
        balanceMinor: z.string(),
        balance: MoneySchema.nullable(),
      }),
    )
    .optional(),
});
export type TrialBalance = z.infer<typeof TrialBalanceSchema>;
export const TrialBalanceResponseSchema = APIResponseSchema(TrialBalanceSchema);

// ── operations overview ─────────────────────────────────────────────────────
export const PaymentStatsSchema = z.object({
  byStatus: z.array(
    z.object({
      status: TxnStatusSchema,
      count: z.number(),
      totalMinor: z.string(),
    }),
  ),
  byCorridor: z.array(
    z.object({ corridor: CorridorSchema, count: z.number() }),
  ),
  /** DEEMED + RISK_HELD. The only states where money waits on a human. */
  needsAttention: z.number(),
  openDisputes: z.number(),
  openMismatches: z.number(),
  trialBalanceOk: z.boolean(),
  /**
   * Read from the LEDGER, not summed from transactions.
   *
   * The suspense balance is what the platform is actually holding; a total derived from
   * transaction rows is what it BELIEVES it is holding, and the whole point of the trial balance
   * is that those two can differ.
   */
  suspense: z.array(
    z.object({ currency: z.string(), balanceMinor: z.string() }),
  ),
});
export type PaymentStats = z.infer<typeof PaymentStatsSchema>;
export const PaymentStatsResponseSchema = APIResponseSchema(PaymentStatsSchema);

// ── transactions ────────────────────────────────────────────────────────────
export const AdminTransactionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.string(),
  direction: z.enum(['OUTBOUND', 'INBOUND']),
  corridor: CorridorSchema,
  rail: z.string(),
  provider: z.string(),
  status: TxnStatusSchema,
  needsAttention: z.boolean(),

  sourceCurrency: z.string(),
  destCurrency: z.string(),
  sourceAmountMinor: z.string(),
  destAmountMinor: z.string(),
  feeMinor: z.string(),
  taxMinor: z.string(),
  totalDebitMinor: z.string(),
  refundedMinor: z.string(),
  fxRateE8: z.string().nullable(),

  /** Masked. See the file comment. */
  counterparty: z.string(),
  counterpartyName: z.string().nullable(),
  purposeCode: z.string(),

  railRef: z.string().nullable(),
  utr: z.string().nullable(),
  railCode: z.string().nullable(),
  failureReason: z.string().nullable(),

  riskScore: z.number().nullable(),
  riskFlags: z.array(z.string()),
  statusCheckCount: z.number(),
  nextPollAt: z.string().nullable(),

  createdAt: z.string(),
  submittedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type AdminTransaction = z.infer<typeof AdminTransactionSchema>;

export const AdminTransactionListResponseSchema = APIResponseSchema(
  z.object({
    items: z.array(AdminTransactionSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().optional(),
  }),
);

/** One ledger entry, as the console shows it — per leg, never netted. */
export const LedgerEntrySchema = z.object({
  id: z.string(),
  leg: LedgerLegSchema,
  legRef: z.string().nullable(),
  direction: z.enum(['DEBIT', 'CREDIT']),
  amountMinor: z.string(),
  currency: z.string(),
  account: z.object({
    id: z.string(),
    type: AccountTypeSchema,
    ownerType: z.string(),
    currency: z.string(),
  }),
  postedAt: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const ReconciliationRecordSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  source: z.enum(['WEBHOOK', 'POLL', 'STATEMENT']),
  railStatus: z.string(),
  railCode: z.string().nullable(),
  railAmountMinor: z.string().nullable(),
  internalStatus: z.string(),
  status: ReconStatusSchema,
  discrepancy: z.string().nullable(),
  action: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ReconciliationRecord = z.infer<typeof ReconciliationRecordSchema>;

/**
 * A rail event, WITHOUT its payload.
 *
 * The encrypted body is deliberately absent from the console projection: an operator needs to know
 * an event arrived, whether its signature verified, and what it said. The raw bytes are evidence
 * for a chargeback months later, not material for a screen.
 */
export const RailEventSchema = z.object({
  id: z.string(),
  provider: z.string(),
  eventId: z.string(),
  kind: z.string(),
  status: z.enum(['RECEIVED', 'MATCHED', 'UNMATCHED', 'IGNORED']),
  signatureVerified: z.boolean(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
});

export const ReversalSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  kind: z.enum(['RESERVE_RELEASE', 'REFUND', 'PARTIAL_REFUND', 'CHARGEBACK']),
  reason: z.string(),
  amountMinor: z.string(),
  status: z.enum(['PENDING', 'DONE', 'FAILED']),
  railRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  initiatedByAdminId: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export const DisputeStatusSchema = z.enum([
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_CREDITED',
  'RESOLVED_REJECTED',
  'WITHDRAWN',
]);
export type DisputeStatus = z.infer<typeof DisputeStatusSchema>;

export const AdminDisputeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  transactionId: z.string(),
  kind: z.string(),
  status: DisputeStatusSchema,
  description: z.string(),
  claimedAmountMinor: z.string().nullable(),
  resolution: z.string().nullable(),
  railRef: z.string().nullable().optional(),
  resolvedByAdminId: z.string().nullable().optional(),
  slaDueAt: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  /**
   * Present on the queue and the SLA list, absent on the per-transaction detail — where the
   * transaction is already the subject of the page.
   */
  transaction: z
    .object({
      id: z.string(),
      status: TxnStatusSchema,
      corridor: CorridorSchema,
      totalDebitMinor: z.string(),
      sourceCurrency: z.string(),
      refundedMinor: z.string(),
    })
    .nullable()
    .optional(),
});
export type AdminDispute = z.infer<typeof AdminDisputeSchema>;

export const AdminDisputeListResponseSchema = APIResponseSchema(
  z.object({
    items: z.array(AdminDisputeSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().optional(),
  }),
);

export const TransactionDetailSchema = z.object({
  transaction: AdminTransactionSchema,
  ledger: z.array(LedgerEntrySchema),
  reversals: z.array(ReversalSchema),
  reconciliations: z.array(ReconciliationRecordSchema),
  disputes: z.array(AdminDisputeSchema),
  railEvents: z.array(RailEventSchema),
  beneficiary: z
    .object({
      id: z.string(),
      displayName: z.string(),
      registeredName: z.string().nullable(),
      handle: z.string(),
      status: z.string(),
      screeningHit: z.boolean(),
    })
    .nullable(),
});
export type TransactionDetail = z.infer<typeof TransactionDetailSchema>;
export const TransactionDetailResponseSchema =
  APIResponseSchema(TransactionDetailSchema);

export const ReconListResponseSchema = APIResponseSchema(
  z.object({
    items: z.array(
      ReconciliationRecordSchema.extend({
        transaction: z
          .object({
            id: z.string(),
            status: TxnStatusSchema,
            corridor: CorridorSchema,
            totalDebitMinor: z.string(),
            sourceCurrency: z.string(),
          })
          .nullable()
          .optional(),
      }),
    ),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().optional(),
  }),
);

export const LedgerListResponseSchema = APIResponseSchema(
  z.object({
    items: z.array(
      z.object({
        id: z.string(),
        transactionId: z.string(),
        leg: LedgerLegSchema,
        legRef: z.string(),
        direction: z.enum(['DEBIT', 'CREDIT']),
        amountMinor: z.string(),
        currency: z.string(),
        postedAt: z.string(),
        account: z.object({
          id: z.string(),
          type: AccountTypeSchema,
          ownerType: z.string(),
          currency: z.string(),
          label: z.string().nullable(),
        }),
      }),
    ),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean().optional(),
  }),
);

export const ReconcileSweepResponseSchema = APIResponseSchema(
  z.object({
    checked: z.number(),
    matched: z.number(),
    corrected: z.number(),
    /** Payments the rail settled after we had given up. The money-loss counter. */
    lateSettlements: z.number(),
    refunded: z.number(),
    deemed: z.number(),
    skipped: z.number(),
  }),
);

export const SlaBreachResponseSchema = APIResponseSchema(
  z.array(AdminDisputeSchema),
);

export const SimpleTxnResponseSchema = APIResponseSchema(
  z.object({ id: z.string(), status: TxnStatusSchema }),
);

export const RefundResponseSchema = APIResponseSchema(
  z.object({ id: z.string(), status: z.string(), amountMinor: z.string() }),
);

export const DisputeActionResponseSchema = APIResponseSchema(
  z.object({
    id: z.string(),
    status: z.string(),
    resolution: z.string().nullable().optional(),
  }),
);
