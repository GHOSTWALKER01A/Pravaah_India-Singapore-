import type {
  Corridor,
  LedgerDirection,
  LedgerLeg,
  MoneyView,
  PaymentRail,
  PurposeCode,
  TransferType,
  TxnDirection,
  TxnStatus,
  TxnType,
} from './vocabulary';

/** Pricing, sending, and the receipt. The core of the module. */

export interface QuoteRequest {
  sourceCurrency: string;
  destCurrency: string;
  /** Price from the send side or the receive side. Both are real user intents. */
  mode: 'SOURCE' | 'DEST';
  amountMinor: string;
  type: TransferType;
  purposeCode: PurposeCode;
}

/**
 * A locked, single-use price — the numbers the user was shown, frozen server-side.
 *
 * `midRate` travels beside `rate` so the spread is VISIBLE rather than implied. A remittance
 * product that shows only its own rate is asking to be trusted about the difference.
 */
export interface QuoteView {
  quoteId: string;
  corridor: Corridor;
  youSend: MoneyView;
  theyGet: MoneyView;
  fee: MoneyView;
  tax: MoneyView;
  totalDebit: MoneyView;
  rate: string;
  midRate: string;
  spreadBps: number;
  /** `live` | `static` | `identity`. `static` means a configured fallback, said plainly. */
  rateSource: string;
  validUntil: string;
  /** Sent as a duration so a clock-skewed device still expires the quote about right. */
  validForMs: number;
}

export interface CreateTransferRequest {
  beneficiaryId: string;
  quoteId: string;
  type: TransferType;
  purposeCode: PurposeCode;
  narration?: string;
  mcc?: string;
  /** The total the user saw. A cross-check; the server charges the quote, not this. */
  expectedTotalDebitMinor: string;
  /** The bank-registered name the user read, verbatim. */
  confirmedRegisteredName: string;
  confirmedName: true;
  /**
   * The device authorising this payment (M6).
   *
   * Optional on the wire, but the app should always send it: absent, the risk engine scores
   * `DEVICE_UNBOUND` (0.35) and the ladder's structural rule challenges any sensitive action
   * from an unidentified device. So omitting it does not avoid friction — it guarantees it.
   */
  deviceId?: string;
  /**
   * Coarse location — a country or country-region code, never a coordinate (M6).
   *
   * Feeds the impossible-travel check: two different countries inside an hour means one of
   * the two sessions is not the account holder. `IN-MH` is enough to establish that, and a
   * latitude would make this a location-tracking field under a far heavier consent regime.
   */
  geoHint?: string;
  passportRef?: string;
}

/**
 * A payment, as the client sees it.
 *
 * `isFinal` exists so the app knows when to STOP polling rather than inferring it from a status
 * enum it would have to keep in sync. `railMessage` is the rail's own code already translated —
 * "U30" tells a person nothing; "your bank could not complete this" tells them what to try.
 */
export interface TransactionView {
  id: string;
  type: TxnType;
  direction: TxnDirection;
  corridor: Corridor;
  rail: PaymentRail;
  status: TxnStatus;
  isSuccess: boolean;
  youSend: MoneyView;
  theyGet: MoneyView;
  fee: MoneyView;
  tax: MoneyView;
  totalDebit: MoneyView;
  refunded: MoneyView;
  fxRateE8: string | null;
  counterpartyName: string | null;
  counterparty: string;
  purposeCode: string;
  narration: string | null;
  utr: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  isFinal?: boolean;
  railMessage?: string | null;
  canRetry?: boolean;
  /**
   * The M6 challenge waiting on the user, when there is one.
   *
   * ## Why this field is what distinguishes a hold from a confirmation
   *
   * `RISK_HELD` covers BOTH outcomes: a `HOLD` waiting on an analyst, and a `STEP_UP` waiting
   * on the user. They are the same status on purpose — M4 has exactly one "money not yet
   * moved" state, and a second would have to be taught to every reconciler and scheduler.
   *
   * So the presence of a live challenge is the ONLY thing that tells the app which of the two
   * it is looking at. Without it a stepped-up payment renders as "we are reviewing this",
   * which is both wrong and unactionable — the user could have released it themselves in two
   * taps.
   *
   * Present on `create` AND on every `detail` poll, so a challenge survives the app being
   * killed mid-payment.
   */
  stepUp?: {
    /** An identifier, not a secret. The secret is the code, which arrives by SMS. */
    nonce: string;
    method: 'OTP' | 'BIOMETRIC' | 'PIN_REAUTH';
    expiresAt: string;
    attemptsRemaining: number;
  } | null;
}

/** One movement of the user's own money, from the ledger. The counterfoil's line items. */
export interface ReceiptMovement {
  leg: LedgerLeg;
  direction: LedgerDirection;
  amountMinor: string;
  currency: string;
  postedAt: string;
}

export interface ReceiptRefund {
  id: string;
  kind: 'RESERVE_RELEASE' | 'REFUND' | 'PARTIAL_REFUND' | 'CHARGEBACK';
  amountMinor: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
  reason: string;
  completedAt: string | null;
}

export interface ReceiptView extends TransactionView {
  movements: ReceiptMovement[];
  refunds: ReceiptRefund[];
}
