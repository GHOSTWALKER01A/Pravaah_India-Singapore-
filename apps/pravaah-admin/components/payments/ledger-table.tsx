import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/helper/date-convertor';
import { formatMoney } from '@/lib/api/payments/money';
import type { LedgerEntry, LedgerLeg } from '@/lib/api/payments/payments.schema';

/**
 * What each ledger leg means, in an operator's words.
 *
 * `Record<LedgerLeg, …>` rather than `Record<string, …>`: the shared schema package now owns the leg
 * vocabulary, so a leg added to the Prisma enum breaks this build instead of rendering `FX_OUT` at a
 * reviewer mid-incident.
 */
const LEG_LABEL: Record<LedgerLeg, string> = {
  RESERVE: 'Reserve — wallet to suspense',
  FEE: 'Fee — suspense to platform income',
  TAX: 'Tax on the fee',
  FX_OUT: 'FX out — source suspense to position',
  FX_IN: 'FX in — dest position to suspense',
  PAYOUT: 'Payout — suspense to beneficiary',
  REVERSE: 'Reverse — reserve released',
  REFUND: 'Refund — returned to the payer',
  TOPUP: 'Topup — money in',
  WITHDRAW: 'Withdraw — money out to own bank',
  RECOVERY: 'Recovery — booked against a receivable',
  ADJUSTMENT: 'Adjustment — by an administrator',
};

/**
 * The ledger for one payment, PER LEG and in order.
 *
 * The rows are never netted, and that is the entire reason an append-only ledger is worth having.
 * During an incident the useful question is not "what was the amount" — it is "did the reserve post
 * before the payout, did the fee come out of suspense or out of the wallet, and did the FX legs
 * balance". A single summed row answers none of those. Anyone tempted to aggregate these for
 * tidiness would be deleting the only record that explains what happened.
 *
 * Credits are signed `+` and toned green, debits `−` and neutral. The sign is applied here from
 * `direction` rather than expected in the amount, because a minor-unit figure from the ledger is
 * always unsigned — the direction column IS the sign.
 */
export function LedgerTable({ entries }: { entries: readonly LedgerEntry[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Ledger</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Every entry this payment posted, per leg and in order. Append-only — a correction is a new
        balanced pair, never an edit. Debits and credits must net to zero per currency.
      </p>
      <div className="mt-3 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Posted</TableHead>
              <TableHead>Leg</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-muted-foreground py-6 text-center"
                >
                  Nothing posted. The payment never reached the reserve.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatDateTime(entry.postedAt)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {LEG_LABEL[entry.leg]}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.account.type}
                    <span className="text-muted-foreground">
                      {' '}
                      · {entry.account.currency}
                    </span>
                  </TableCell>
                  <TableCell
                    className={`text-xs ${
                      entry.direction === 'CREDIT'
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-zinc-600 dark:text-zinc-300'
                    }`}
                  >
                    {entry.direction}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {entry.direction === 'CREDIT' ? '+' : '−'}
                    {formatMoney(entry.amountMinor, entry.currency)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
