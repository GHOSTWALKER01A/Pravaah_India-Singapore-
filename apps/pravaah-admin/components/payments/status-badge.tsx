import type { TxnStatus } from '@/lib/api/payments/payments.schema';

/**
 * How a payment status reads to an operator.
 *
 * `Record<TxnStatus, …>` rather than `Record<string, …>` with a fallback, which is what these maps
 * were before they were unified: a `string` key means adding a state to the backend enum leaves this
 * file compiling happily while rendering a raw `SCREAMING_CASE` token on the one screen somebody
 * opens during an incident. Keyed on the type, the same change is a build failure.
 *
 * **DEEMED is amber, never red, and its label never contains the word "failed."** The rail did not
 * answer; the funds sit in suspense awaiting a human decision. Red would tell an operator the
 * payment is dead, and the action that follows from "dead" is to refund — which, if the rail
 * actually settled, pays twice. The RN app makes the identical choice for the identical reason.
 */
const STATUS_TONE: Record<TxnStatus, string> = {
  SUCCESS: 'text-green-600 dark:text-green-400',
  PARTIALLY_REFUNDED: 'text-amber-600 dark:text-amber-400',
  PENDING: 'text-amber-600 dark:text-amber-400',
  SUBMITTED: 'text-amber-600 dark:text-amber-400',
  RESERVED: 'text-amber-600 dark:text-amber-400',
  AWAITING_APPROVAL: 'text-amber-600 dark:text-amber-400',
  DEEMED: 'text-amber-600 dark:text-amber-400',
  RISK_HELD: 'text-amber-600 dark:text-amber-400',
  FAILED: 'text-red-600 dark:text-red-400',
  REVERSED: 'text-red-600 dark:text-red-400',
  REFUNDED: 'text-red-600 dark:text-red-400',
  EXPIRED: 'text-zinc-500 dark:text-zinc-400',
  INITIATED: 'text-zinc-500 dark:text-zinc-400',
  VALIDATED: 'text-zinc-500 dark:text-zinc-400',
};

/** Plain words for an operator. `AWAITING_APPROVAL` is not a sentence. */
const STATUS_LABEL: Record<TxnStatus, string> = {
  INITIATED: 'Starting',
  VALIDATED: 'Checked',
  RISK_HELD: 'Held on risk',
  AWAITING_APPROVAL: 'Awaiting payer',
  RESERVED: 'Funds held',
  SUBMITTED: 'With the rail',
  PENDING: 'Clearing',
  SUCCESS: 'Settled',
  FAILED: 'Failed',
  REVERSED: 'Reserve released',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Part refunded',
  EXPIRED: 'Expired',
  DEEMED: 'Rail never answered',
};

export function statusLabel(status: TxnStatus): string {
  return STATUS_LABEL[status];
}

export function statusTone(status: TxnStatus): string {
  return STATUS_TONE[status];
}

/** The status, toned and worded. Used in every payments table. */
export function StatusBadge({
  status,
  className = '',
}: {
  status: TxnStatus;
  className?: string;
}) {
  return (
    <span className={`text-sm ${STATUS_TONE[status]} ${className}`.trim()}>
      {STATUS_LABEL[status]}
    </span>
  );
}
