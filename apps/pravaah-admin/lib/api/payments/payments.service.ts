import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../core/base-api-service';
import {
  AdminDisputeListResponseSchema,
  AdminTransactionListResponseSchema,
  DisputeActionResponseSchema,
  LedgerListResponseSchema,
  PaymentStatsResponseSchema,
  ReconListResponseSchema,
  ReconcileSweepResponseSchema,
  RefundResponseSchema,
  SimpleTxnResponseSchema,
  SlaBreachResponseSchema,
  TransactionDetailResponseSchema,
  TrialBalanceResponseSchema,
  type DisputeStatus,
  type TxnStatus,
} from './payments.schema';

/**
 * M4 admin console — money oversight and the two break-glass controls.
 *
 * Every write here calls the SAME backend service the app and the schedulers use. There is
 * deliberately no admin-only refund path and no admin-only settle: a second implementation of
 * "refund" would eventually refund differently, and the ledger and the rail must never disagree
 * about how much came back. The admin routes add attribution and a required reason on top of the
 * ordinary flow, nothing more.
 */
class PaymentsAdminService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.PAYMENTS.BASE);
  }

  private query(params: Record<string, unknown>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '' || value === 'ALL') {
        continue;
      }
      query.set(key, String(value));
    }
    const text = query.toString();
    return text ? `?${text}` : '';
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  /** Σ of every account balance per currency. Must always be zero. */
  async trialBalance(detailed = false) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.PAYMENTS.TRIAL_BALANCE}${this.query({ detailed })}`,
    );
    return TrialBalanceResponseSchema.parse(raw).data;
  }

  async stats() {
    const raw = await this.get<unknown>(API_ENDPOINTS.PAYMENTS.STATS);
    return PaymentStatsResponseSchema.parse(raw).data;
  }

  async listTransactions(params: {
    status?: TxnStatus | 'ALL';
    corridor?: string;
    userId?: string;
    /** Only DEEMED and RISK_HELD — the rows where money waits on a human. */
    needsAttention?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.PAYMENTS.TRANSACTIONS}${this.query(params)}`,
    );
    return AdminTransactionListResponseSchema.parse(raw).data;
  }

  /** One payment: ledger legs, rail events, reconciliation trail, reversals, disputes. */
  async transactionDetail(id: string) {
    const raw = await this.get<unknown>(
      API_ENDPOINTS.PAYMENTS.TRANSACTION_DETAIL(id),
    );
    return TransactionDetailResponseSchema.parse(raw).data;
  }

  async listReconciliations(params: {
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.PAYMENTS.RECONCILIATIONS}${this.query(params)}`,
    );
    return ReconListResponseSchema.parse(raw).data;
  }

  async listLedger(params: {
    accountType?: string;
    currency?: string;
    transactionId?: string;
    limit?: number;
    offset?: number;
  }) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.PAYMENTS.LEDGER}${this.query(params)}`,
    );
    return LedgerListResponseSchema.parse(raw).data;
  }

  // ── operations ────────────────────────────────────────────────────────────
  /** Ask the rail about one payment, now. Read-only in effect. */
  async recheck(id: string) {
    const raw = await this.post<unknown>(API_ENDPOINTS.PAYMENTS.RECHECK(id));
    return AdminTransactionListResponseSchema.shape.data.shape.items.element.parse(
      (raw as { data: unknown }).data,
    );
  }

  /** Run a reconciliation sweep on demand. Reports late settlements it corrected. */
  async reconcileNow() {
    const raw = await this.post<unknown>(API_ENDPOINTS.PAYMENTS.RECONCILE_NOW);
    return ReconcileSweepResponseSchema.parse(raw).data;
  }

  /**
   * Resolve a payment the rail never answered.
   *
   * The two options are opposites and both irreversible, which is why the backend demands an
   * evidence reference on top of a reason: SETTLE credits the beneficiary and closes the ledger,
   * REVERSE gives the money back. Guessing wrong pays twice or not at all.
   */
  async resolveDeemed(
    id: string,
    body: {
      resolution: 'SETTLE' | 'REVERSE';
      evidenceRef: string;
      reason: string;
      confirmed: true;
    },
  ) {
    const raw = await this.post<unknown, typeof body>(
      API_ENDPOINTS.PAYMENTS.RESOLVE_DEEMED(id),
      body,
    );
    return SimpleTxnResponseSchema.parse(raw).data;
  }

  async refund(
    id: string,
    body: { amountMinor: string; reason: string; confirmed: true },
  ) {
    const raw = await this.post<unknown, typeof body>(
      API_ENDPOINTS.PAYMENTS.REFUND(id),
      body,
    );
    return RefundResponseSchema.parse(raw).data;
  }

  /** Release or block a payment the risk engine held. */
  async resolveRisk(
    id: string,
    body: { decision: 'RELEASE' | 'BLOCK'; reason: string },
  ) {
    const raw = await this.post<unknown, typeof body>(
      API_ENDPOINTS.PAYMENTS.RISK(id),
      body,
    );
    return SimpleTxnResponseSchema.parse(raw).data;
  }

  // ── disputes ──────────────────────────────────────────────────────────────
  /**
   * The dispute work queue, across every user, SLA-soonest first.
   *
   * Deliberately a superset of {@link slaBreaches}: a queue that showed only disputes already past
   * their deadline would let every one of them go late before an operator could act, which is the
   * opposite of what an SLA is for.
   */
  async listDisputes(params: {
    status?: DisputeStatus;
    kind?: string;
    openOnly?: boolean;
    breachedOnly?: boolean;
    orderBy?: 'sla' | 'created';
    limit?: number;
    offset?: number;
  }) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.PAYMENTS.DISPUTES}${this.query(params)}`,
    );
    return AdminDisputeListResponseSchema.parse(raw).data;
  }

  /** Disputes past their SLA. The queue an operations lead actually watches. */
  async slaBreaches() {
    const raw = await this.get<unknown>(API_ENDPOINTS.PAYMENTS.DISPUTES_SLA);
    return SlaBreachResponseSchema.parse(raw).data;
  }

  async claimDispute(id: string) {
    const raw = await this.post<unknown>(
      API_ENDPOINTS.PAYMENTS.DISPUTE_CLAIM(id),
    );
    return DisputeActionResponseSchema.parse(raw).data;
  }

  async resolveDispute(
    id: string,
    body: {
      status: 'RESOLVED_CREDITED' | 'RESOLVED_REJECTED';
      resolution: string;
      refundAmountMinor?: string;
    },
  ) {
    const raw = await this.post<unknown, typeof body>(
      API_ENDPOINTS.PAYMENTS.DISPUTE_RESOLVE(id),
      body,
    );
    return DisputeActionResponseSchema.parse(raw).data;
  }
}

export const paymentsAdminService = new PaymentsAdminService();
