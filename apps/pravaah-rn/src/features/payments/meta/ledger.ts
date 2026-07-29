import type { LedgerLeg } from '@/api/payments/schemas';

/**
 * What each ledger leg means on a statement line.
 *
 * These are the counterfoil's line items. A user disputing a balance needs to see the reserve, the
 * fee and the refund as separate facts — which is the whole reason the statement is built from
 * ledger entries rather than from transactions.
 *
 * Named for the labels rather than the legs: the shared schema package now exports a `LEDGER_LEG`
 * holding the enum VALUES, and two constants a word apart meaning different things is how somebody
 * imports the wrong one and renders `RESERVE` at a customer.
 */
export const LEDGER_LEG_LABEL: Record<LedgerLeg, string> = {
  RESERVE: 'Set aside to pay',
  FEE: 'Transfer fee',
  TAX: 'Tax on the fee',
  FX_OUT: 'Currency exchange out',
  FX_IN: 'Currency exchange in',
  PAYOUT: 'Paid out',
  REVERSE: 'Released back to you',
  REFUND: 'Refunded to you',
  TOPUP: 'Money added',
  WITHDRAW: 'Withdrawn to your bank',
  RECOVERY: 'Adjustment after a late settlement',
  ADJUSTMENT: 'Correction by support',
};
