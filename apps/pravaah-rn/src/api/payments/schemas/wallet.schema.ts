import type {
  LedgerDirection,
  LedgerLeg,
  MoneyView,
  TxnStatus,
  TxnType,
  UpiHandleStatus,
} from './vocabulary';

/** The wallet screen, the statement, and the caps that gate every send. */

export interface UpiHandleView {
  id: string;
  vpa: string;
  status: UpiHandleStatus;
  isPrimary: boolean;
  linkedAccountMasked: string | null;
  linkedIfsc: string | null;
  linkedBankName: string | null;
  verifiedAt: string | null;
}

/**
 * A corridor's caps and what is left of them.
 *
 * Carried on the wallet response rather than fetched separately, because a balance without the
 * remaining limit is misleading: ₹50,000 held with ₹2,000 of daily limit left cannot send ₹10,000,
 * and finding that out at the confirmation screen is worse than being told up front.
 */
export interface LimitView {
  currency: string;
  perTransaction: MoneyView;
  dailyCap: MoneyView;
  dailyUsed: MoneyView;
  dailyRemaining: MoneyView;
  dailyCountCap: number;
  dailyUsedCount: number;
  resetAt: string;
  annualCap: MoneyView | null;
  annualRemaining: MoneyView | null;
  /** The ₹5,000 / 24-hour ceiling on a newly added payee. */
  newPayeeCap: MoneyView;
}

export interface WalletView {
  balances: (MoneyView & { label: string })[];
  upiHandles: UpiHandleView[];
  limits: { domestic: LimitView; crossBorder: LimitView };
}

/**
 * One line of the account statement — a LEDGER ENTRY, not a transaction.
 *
 * A transaction list says what the user tried to do; this says what happened to their money, with
 * the reserve, the fee and any refund as separate lines. When somebody disputes a balance, this is
 * the document that answers them.
 */
export interface StatementEntry {
  id: string;
  direction: LedgerDirection;
  amount: MoneyView;
  /** Signed for display — the sign is the direction, applied once, by the server. */
  signedMinor: string;
  leg: LedgerLeg;
  postedAt: string;
  transaction: {
    id: string;
    type: TxnType;
    status: TxnStatus;
    counterpartyName: string | null;
    counterparty: string;
    narration: string | null;
    utr: string | null;
  } | null;
}
