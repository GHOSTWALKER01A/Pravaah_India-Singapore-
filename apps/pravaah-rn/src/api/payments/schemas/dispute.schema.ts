import type {
  DisputeKind,
  DisputeStatus,
  MoneyView,
  TxnStatus,
} from './vocabulary';

/** UDIR — the in-app dispute every UPI app is obliged to offer. */

/**
 * A claim the user has raised against a payment.
 *
 * `slaDueAt` is stamped server-side when the dispute is created, which is what makes it an
 * obligation rather than a reassurance: the deadline is a queryable fact the user can hold us to,
 * not a sentence in a support script. The app shows it for exactly that reason.
 *
 * Raising a dispute is not a refund. Money moves only when one is upheld, and then through the
 * ordinary refund path.
 */
export interface DisputeView {
  id: string;
  transactionId: string;
  kind: DisputeKind;
  status: DisputeStatus;
  description: string;
  claimedAmountMinor: string | null;
  resolution: string | null;
  slaDueAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DisputeDetail extends DisputeView {
  payment: {
    id: string;
    status: TxnStatus;
    amount: MoneyView;
    counterpartyName: string | null;
    utr: string | null;
    createdAt: string;
  };
}
