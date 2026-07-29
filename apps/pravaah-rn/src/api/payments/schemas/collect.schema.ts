import type { CollectStatus, MoneyView } from './vocabulary';

/** Collect requests — asking someone else to pay, and adding money to your own wallet. */

/**
 * A request for payment, awaiting the payer's approval in their own bank app.
 *
 * `expiresInMs` travels beside `expiresAt` for the same reason a quote carries `validForMs`: a
 * device with a skewed clock would compute the wrong countdown from the absolute timestamp alone,
 * and a collect that looks live after it has lapsed sends the user to a screen that will refuse
 * them.
 */
export interface CollectView {
  id: string;
  status: CollectStatus;
  payer: string;
  payerName: string | null;
  amount: MoneyView;
  purposeCode: string;
  narration: string | null;
  isOpen: boolean;
  expiresAt: string;
  expiresInMs: number;
  declineReason: string | null;
  transactionId: string | null;
  createdAt: string;
  respondedAt: string | null;
}

/**
 * The result of a topup.
 *
 * A topup IS a collect — a pull from an account the user controls, authorised with their UPI PIN in
 * their bank's app. We never hold that credential, and the wallet is credited only when the rail
 * confirms the debit. `nextStep` is server-authored prose precisely because the user has to go
 * somewhere else to finish, and the app should not invent instructions about another app's UI.
 */
export interface TopupResult {
  collectId: string;
  status: CollectStatus;
  amount: MoneyView;
  expiresAt: string;
  nextStep: string;
}
