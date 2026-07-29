'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Figure } from '@/components/payments/figure';
import { StatusBadge } from '@/components/payments/status-badge';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { formatMoney, isZeroMinor } from '@/lib/api/payments/money';
import { paymentsAdminService } from '@/lib/api/payments/payments.service';
import type { TxnStatus } from '@/lib/api/payments/payments.schema';

const PAGE_SIZE = 50;

const FILTERS: { value: TxnStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All payments' },
  { value: 'DEEMED', label: 'Unconfirmed by the rail' },
  { value: 'RISK_HELD', label: 'Held on risk' },
  { value: 'PENDING', label: 'Clearing' },
  { value: 'SUCCESS', label: 'Settled' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'REFUNDED', label: 'Refunded' },
];

/**
 * Every status, and the tone it gets.
 *
 * `DEEMED` is amber, never red, and that is the same decision the mobile app makes for the same
 * reason: the rail did not answer, the money is in suspense, and a human decides. Styling it as a
 * failure would tell an operator the payment is dead when it is the one row on the screen that most
 * needs a careful decision.
 */
/**
 * Money — the operations overview.
 *
 * The trial balance leads, and it leads because it is the only figure on this page that can be an
 * ALARM rather than a metric. Every posting set is validated as balanced before it is written, so a
 * non-zero net cannot come from a bad payment — it means entries reached the table without going
 * through the ledger service at all: a raw SQL fix, a migration, a direct database edit. That is
 * exactly the class of change that loses money quietly, so it gets the top of the page and a red
 * banner rather than a tile in a row of four.
 *
 * Second is the attention queue, because DEEMED and RISK_HELD are the only states where real money
 * is parked waiting on a decision nobody has made. A console that made those findable only by
 * scrolling would leave funds in suspense indefinitely.
 */
export default function PaymentsOverviewPage() {
  const client = useQueryClient();
  const [status, setStatus] = useState<TxnStatus | 'ALL'>('ALL');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [offset, setOffset] = useState(0);

  const trial = useQuery({
    queryKey: ['trial-balance'],
    queryFn: () => paymentsAdminService.trialBalance(true),
    // The alarm is only useful if it is fresh. A minute is well inside the window in which an
    // operator would want to know the ledger had broken.
    refetchInterval: 60_000,
  });

  const stats = useQuery({
    queryKey: ['payment-stats'],
    queryFn: () => paymentsAdminService.stats(),
    refetchInterval: 60_000,
  });

  const transactions = useQuery({
    queryKey: ['admin-transactions', status, needsAttention, offset],
    queryFn: () =>
      paymentsAdminService.listTransactions({
        status,
        needsAttention: needsAttention || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  });

  const sweep = useMutation({
    mutationFn: () => paymentsAdminService.reconcileNow(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin-transactions'] });
      void client.invalidateQueries({ queryKey: ['payment-stats'] });
      void client.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });

  const broken = trial.data && !trial.data.balanced;
  const attention = stats.data?.needsAttention ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Money</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every payment, the ledger behind it, and what the rail actually said. Counterparty
            addresses are masked everywhere in this console — support never needs a payable
            address to do its job.
          </p>
        </div>
        <Button
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          variant="outline"
        >
          {sweep.isPending ? 'Reconciling…' : 'Reconcile now'}
        </Button>
      </div>

      {/* ── THE ALARM ──────────────────────────────────────────────────── */}
      <section className="mt-6">
        {broken ? (
          <div className="rounded-md border border-red-500 bg-red-50 p-4 dark:bg-red-950/30">
            <h2 className="font-semibold text-red-700 dark:text-red-400">
              Trial balance is broken
            </h2>
            <p className="mt-1 text-sm text-red-700/90 dark:text-red-300/90">
              The ledger no longer nets to zero. This cannot be caused by a payment — the ledger
              rejects an unbalanced posting set — so entries have reached the table without going
              through <code>LedgerService.post</code>. Investigate a manual database change or a
              migration before doing anything else.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-black/10 p-4 dark:border-white/10">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-semibold">
                Trial balance{' '}
                <span className="text-green-600 dark:text-green-400">nets to zero</span>
              </h2>
              <span className="text-muted-foreground text-xs">
                Checked every minute · debits = credits in every currency
              </span>
            </div>
          </div>
        )}

        {trial.data ? (
          <div className="mt-3 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Debits</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trial.data.currencies.map((row) => (
                  <TableRow key={row.currency}>
                    <TableCell className="font-mono">{row.currency}</TableCell>
                    <TableCell className="text-right font-mono">
                      {row.credits.formatted}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.debits.formatted}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        isZeroMinor(row.netMinor)
                          ? 'text-green-600 dark:text-green-400'
                          : 'font-semibold text-red-600 dark:text-red-400'
                      }`}
                    >
                      {formatMoney(row.netMinor, row.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      {/* ── WHAT IS HELD, AND BY WHOM ──────────────────────────────────── */}
      {stats.data ? (
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          <Figure
            label="Waiting on a human"
            value={String(attention)}
            detail="Rail never answered, or held on risk. Real money is parked."
            tone={attention > 0 ? 'warn' : 'ok'}
          />
          <Figure
            label="Open mismatches"
            value={String(stats.data.openMismatches)}
            detail="The rail and our record disagreed and it is not resolved."
            tone={stats.data.openMismatches > 0 ? 'warn' : 'ok'}
          />
          <Figure
            label="Open disputes"
            value={String(stats.data.openDisputes)}
            detail="Customers who have reported a problem."
            tone={stats.data.openDisputes > 0 ? 'warn' : 'ok'}
          />
        </section>
      ) : null}

      {/*
        Suspense, read from the LEDGER rather than summed from transactions. That distinction is the
        whole reason it is on this page: the ledger says what the platform is actually holding, and
        a transaction-derived total says what it believes it is holding.
      */}
      {stats.data && stats.data.suspense.length > 0 ? (
        <section className="mt-4 rounded-md border border-black/10 p-4 dark:border-white/10">
          <h3 className="text-sm font-semibold">Held in suspense</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Money that has left a wallet and not yet reached a beneficiary. Read from the ledger,
            not from the transaction rows.
          </p>
          <div className="mt-3 flex flex-wrap gap-6">
            {stats.data.suspense.map((entry) => (
              <div key={entry.currency}>
                <div className="font-mono text-lg">
                  {formatMoney(entry.balanceMinor, entry.currency)}
                </div>
                <div className="text-muted-foreground text-xs">{entry.currency}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {sweep.data ? (
        <section
          className={`mt-4 rounded-md border p-4 ${
            sweep.data.lateSettlements > 0
              ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
              : 'border-black/10 dark:border-white/10'
          }`}
        >
          <h3 className="text-sm font-semibold">
            {sweep.data.lateSettlements > 0
              ? `Corrected ${sweep.data.lateSettlements} late settlement(s)`
              : 'Reconciliation complete'}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Checked {sweep.data.checked} · matched {sweep.data.matched} · corrected{' '}
            {sweep.data.corrected} · refunded {sweep.data.refunded} · newly unconfirmed{' '}
            {sweep.data.deemed}
            {sweep.data.lateSettlements > 0
              ? ' — a late settlement is a payment the rail completed after we had given up on it. Each one would have been a real loss.'
              : ''}
          </p>
        </section>
      ) : null}

      {/* ── THE PAYMENTS ───────────────────────────────────────────────── */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Payments</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={needsAttention}
                onChange={(event) => {
                  setNeedsAttention(event.target.checked);
                  setOffset(0);
                }}
                className="size-4"
              />
              Only rows waiting on a human
            </label>
            <Select
              aria-label="Filter payments by status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as TxnStatus | 'ALL');
                setOffset(0);
              }}
            >
              {FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {transactions.isError ? (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">
            {transactions.error instanceof Error
              ? transactions.error.message
              : 'Could not load payments.'}
          </p>
        ) : null}

        <div className="mt-4 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Written</TableHead>
                <TableHead>Counterparty</TableHead>
                <TableHead>Corridor</TableHead>
                <TableHead className="text-right">Debited</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Rail</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : (transactions.data?.items.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    {needsAttention
                      ? 'Nothing is waiting on a human. Every payment has reached an outcome.'
                      : 'No payments match that filter.'}
                  </TableCell>
                </TableRow>
              ) : (
                transactions.data?.items.map((txn) => (
                  <TableRow key={txn.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(txn.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{txn.counterpartyName ?? '—'}</div>
                      <div className="text-muted-foreground font-mono text-xs">
                        {txn.counterparty}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {txn.corridor === 'CROSS_BORDER' ? 'SG → IN' : 'IN'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatMoney(txn.totalDebitMinor, txn.sourceCurrency)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={txn.status} />
                      {/*
                        The rail code, verbatim, next to the status. An operator diagnosing a run of
                        failures needs the code the network actually returned, not our translation
                        of it.
                      */}
                      {txn.railCode ? (
                        <div className="text-muted-foreground font-mono text-xs">
                          {txn.railCode}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{txn.provider}</div>
                      {txn.utr ? (
                        <div className="text-muted-foreground font-mono">{txn.utr}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={ROUTES.DASHBOARD.PAYMENT_DETAIL(txn.id)}
                        className="text-sm underline underline-offset-4"
                      >
                        Open
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            {transactions.data
              ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, transactions.data.total)} of ${transactions.data.total}`
              : ''}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!transactions.data?.hasMore}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * One operational figure.
 *
 * Not a "stat card" — the tone is derived from whether the number represents WORK, so a zero reads
 * as calm and a non-zero reads as a queue. A dashboard where every tile looks identical regardless
 * of value makes the operator do the comparison the interface should have done.
 */
