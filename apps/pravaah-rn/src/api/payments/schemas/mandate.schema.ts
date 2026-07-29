import type {
  MandateExecutionStatus,
  MandateFrequency,
  MandateStatus,
  MoneyView,
} from './vocabulary';

/** AutoPay — a standing authorisation, and every debit taken under it. */

/**
 * A mandate the user has authorised.
 *
 * `maxAmount` is on every response, deliberately and without exception. It is the ceiling the payer
 * agreed to, and it is the only number that makes a standing authorisation reviewable — a mandate
 * screen showing the frequency but not the cap tells the user something is recurring without
 * telling them how much it could take.
 */
export interface MandateView {
  id: string;
  mandateRef: string;
  umn: string | null;
  status: MandateStatus;
  frequency: MandateFrequency;
  amountRule: 'EXACT' | 'MAX';
  maxAmount: MoneyView;
  currency: string;
  purposeCode: string;
  narration: string | null;
  validFrom: string;
  validUntil: string;
  nextDebitAt: string | null;
  lastDebitAt: string | null;
  revokeReason: string | null;
  failureReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

/**
 * One debit taken under a mandate.
 *
 * `notifiedAt` is shown rather than kept internal: NPCI requires 24 hours' notice before a mandate
 * debit, and surfacing when that notice actually went out is how the user holds us to the
 * obligation instead of taking our word for it.
 */
export interface MandateDebit {
  sequence: number;
  status: MandateExecutionStatus;
  amount: MoneyView;
  dueAt: string;
  notifiedAt: string | null;
  debitedAt: string | null;
  failureReason: string | null;
  transactionId: string | null;
}

export interface MandateDetail extends MandateView {
  payee: { displayName: string; registeredName: string | null };
  debits: MandateDebit[];
}
