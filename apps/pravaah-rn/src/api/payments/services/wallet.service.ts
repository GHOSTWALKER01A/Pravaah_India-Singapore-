import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  QuoteRequest,
  QuoteView,
  StatementEntry,
  TopupResult,
  TransactionView,
  UpiHandleView,
  WalletView,
} from '../schemas';
import { toQuery } from './query';

/**
 * The wallet: balances, addresses, pricing, and money in and out.
 *
 * Bound to `API_ENDPOINTS.PAYMENTS.BASE`. The services are split by base path rather than by
 * feeling, because `BaseApiService` binds exactly one — merging them would mean hand-writing
 * absolute paths for the others and losing the base-path guarantee.
 *
 * Every mutation goes through `postIdempotent` with the key as an explicit argument. The key is
 * minted by `useIdempotencyKey` when the user forms an INTENT, never here: minting it inside a
 * service method would give a retried submit a fresh key, and the server would read that as a
 * second payment.
 */
class WalletService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.PAYMENTS.BASE);
  }

  /** Balances, UPI IDs and remaining limits. Safe to poll; cheap enough to refresh on focus. */
  wallet(): Promise<WalletView> {
    return this.get<WalletView>(API_ENDPOINTS.PAYMENTS.WALLET);
  }

  /**
   * The ledger-derived statement.
   *
   * Not the transaction list. A transaction says what the user tried to do; this says what happened
   * to their money — the reserve, the fee and any refund as separate lines.
   */
  statement(
    params: { currency?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: StatementEntry[]; total: number }> {
    return this.get<{ items: StatementEntry[]; total: number }>(
      `${API_ENDPOINTS.PAYMENTS.STATEMENT}${toQuery(params)}`,
    );
  }

  /**
   * Lock a price. Valid 90 seconds, usable exactly once.
   *
   * Called for domestic transfers too, where the rate is 1:1 — a quote is a priced INTENT, and the
   * transfer endpoint reads its numbers back rather than recomputing them.
   */
  quote(request: QuoteRequest): Promise<QuoteView> {
    return this.post<QuoteView>(API_ENDPOINTS.PAYMENTS.QUOTE, request);
  }

  listHandles(): Promise<UpiHandleView[]> {
    return this.get<UpiHandleView[]>(API_ENDPOINTS.PAYMENTS.HANDLES);
  }

  /** Allocate a UPI ID. Idempotent server-side — an existing active handle comes back as-is. */
  createHandle(vpa?: string): Promise<UpiHandleView> {
    return this.post<UpiHandleView>(
      API_ENDPOINTS.PAYMENTS.HANDLES,
      vpa ? { vpa } : {},
    );
  }

  setPrimaryHandle(id: string): Promise<UpiHandleView> {
    return this.post<UpiHandleView>(API_ENDPOINTS.PAYMENTS.HANDLE_PRIMARY(id));
  }

  /** Retire a UPI ID. The address is never reissued to anyone else. */
  deactivateHandle(id: string): Promise<UpiHandleView> {
    return this.post<UpiHandleView>(
      API_ENDPOINTS.PAYMENTS.HANDLE_DEACTIVATE(id),
    );
  }

  /** Add money: a collect raised against the user's OWN account, approved in their bank app. */
  topup(
    idempotencyKey: string,
    request: {
      sourceBeneficiaryId: string;
      amountMinor: string;
      currency: string;
    },
  ): Promise<TopupResult> {
    return this.postIdempotent<TopupResult>(
      API_ENDPOINTS.PAYMENTS.TOPUP,
      idempotencyKey,
      request,
    );
  }

  withdraw(
    idempotencyKey: string,
    request: {
      destBeneficiaryId: string;
      amountMinor: string;
      currency: string;
    },
  ): Promise<TransactionView> {
    return this.postIdempotent<TransactionView>(
      API_ENDPOINTS.PAYMENTS.WITHDRAW,
      idempotencyKey,
      request,
    );
  }
}

export const paymentsService = new WalletService();
