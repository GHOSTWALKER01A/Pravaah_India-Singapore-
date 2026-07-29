import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  CreateTransferRequest,
  DisputeKind,
  DisputeView,
  Paged,
  ReceiptView,
  TransactionView,
  TransferType,
  TxnStatus,
} from '../schemas';
import { toQuery } from './query';

/** Sending money, and everything that happens to a payment afterwards. */
class TransferService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.TRANSFERS.BASE);
  }

  /** Send money. The amount lives on the quote; this carries the three confirmations. */
  create(
    idempotencyKey: string,
    request: CreateTransferRequest,
  ): Promise<TransactionView> {
    return this.postIdempotent<TransactionView>(
      API_ENDPOINTS.TRANSFERS.CREATE,
      idempotencyKey,
      request,
    );
  }

  list(
    params: {
      status?: TxnStatus;
      type?: TransferType;
      beneficiaryId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Paged<TransactionView>> {
    return this.get<Paged<TransactionView>>(
      `${API_ENDPOINTS.TRANSFERS.LIST}${toQuery(params)}`,
    );
  }

  /** The status the client polls. Never the rail — only we know what an answer MEANS. */
  detail(id: string): Promise<TransactionView> {
    return this.get<TransactionView>(API_ENDPOINTS.TRANSFERS.DETAIL(id));
  }

  /** The counterfoil: the payment plus the user's own ledger movements and any refunds. */
  receipt(id: string): Promise<ReceiptView> {
    return this.get<ReceiptView>(API_ENDPOINTS.TRANSFERS.RECEIPT(id));
  }

  /**
   * Answer the M6 step-up on a payment awaiting confirmation.
   *
   * ## Why this takes no idempotency key
   *
   * The single-use NONCE already provides replay protection, and it does so more strictly
   * than a key would: a second call with the same nonce is REFUSED, because the challenge has
   * left `PENDING` server-side. An idempotency replay would cheerfully return the first
   * call's success — which is the correct behaviour for a payment and the wrong behaviour for
   * an authentication.
   *
   * Returns the payment with `stepUp: null`, which is how the receipt screen knows to close
   * the prompt: the data says the challenge is spent, rather than the screen guessing.
   */
  confirmStepUp(
    id: string,
    nonce: string,
    answer: string,
  ): Promise<TransactionView> {
    return this.post<TransactionView>(
      API_ENDPOINTS.TRANSFERS.CONFIRM_STEP_UP(id),
      { nonce, answer },
    );
  }

  /**
   * Ask for a fresh confirmation on a held payment whose challenge lapsed.
   *
   * Returns the same `TransactionView` the poll does, with a live `stepUp` — so the screen
   * re-renders the prompt from one field rather than merging a nonce into state it already holds.
   *
   * Refused, with the server's own message, when the payment is under ANALYST review rather than
   * awaiting the user. Both look like the same held status from here, and only the server can tell
   * them apart — a client that assumed otherwise would offer a confirmation button for a payment a
   * reviewer had deliberately stopped.
   */
  requestStepUp(id: string): Promise<TransactionView> {
    return this.post<TransactionView>(
      API_ENDPOINTS.TRANSFERS.REQUEST_STEP_UP(id),
    );
  }

  /** Retry mints a NEW payment against a FRESH quote, so it needs its own key. */
  retry(
    id: string,
    idempotencyKey: string,
    request: {
      quoteId: string;
      expectedTotalDebitMinor: string;
      confirmedRegisteredName: string;
      confirmedName: true;
      deviceId?: string;
    },
  ): Promise<TransactionView> {
    return this.postIdempotent<TransactionView>(
      API_ENDPOINTS.TRANSFERS.RETRY(id),
      idempotencyKey,
      request,
    );
  }

  /**
   * Raise a dispute against this payment.
   *
   * Not idempotency-keyed, because the backend enforces one open dispute per (transaction, kind)
   * with a unique index — a double submission is a 409, not a second investigation. That
   * constraint is a better guarantee than a client-held key, which a reinstalled app would lose.
   */
  raiseDispute(
    id: string,
    request: {
      kind: DisputeKind;
      description: string;
      claimedAmountMinor?: string;
    },
  ): Promise<
    Pick<DisputeView, 'id' | 'kind' | 'status' | 'slaDueAt' | 'createdAt'>
  > {
    return this.post(API_ENDPOINTS.TRANSFERS.DISPUTE(id), request);
  }
}

export const transferService = new TransferService();
