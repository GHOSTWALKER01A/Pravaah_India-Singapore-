'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FilterChips } from '@/components/payments/filter-chips';
import { Pager } from '@/components/payments/pager';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { formatMoney } from '@/lib/api/payments/money';
import { paymentsAdminService } from '@/lib/api/payments/payments.service';
import { cn } from '@/lib/utils/utils';

const PAGE_SIZE = 50;

/** The four reconciliation outcomes, in an operator's words rather than the enum's. */
const OUTCOME = {
  MATCHED: {
    label: 'Agreed',
    hint: 'The rail said what we said.',
    tone: 'text-zinc-500 dark:text-zinc-400',
  },
  MISMATCH: {
    label: 'Disagreed',
    hint: 'The rail and our record differ. This is the work.',
    tone: 'font-semibold text-red-600 dark:text-red-400',
  },
  RESOLVED: {
    label: 'Corrected',
    hint: 'We disagreed, and our record was brought into line.',
    tone: 'text-green-600 dark:text-green-400',
  },
  ESCALATED: {
    label: 'Escalated',
    hint: 'Beyond automatic correction — a human has to decide.',
    tone: 'font-semibold text-amber-600 dark:text-amber-400',
  },
} as const;

type Outcome = keyof typeof OUTCOME;

const FILTERS: { key: Outcome | 'ALL'; label: string }[] = [
  { key: 'MISMATCH', label: 'Disagreed' },
  { key: 'ESCALATED', label: 'Escalated' },
  { key: 'RESOLVED', label: 'Corrected' },
  { key: 'MATCHED', label: 'Agreed' },
  { key: 'ALL', label: 'Everything' },
];

/**
 * The reconciliation trail.
 *
 * The rail is the source of truth about whether money moved; our database only holds what we
 * believed at the time. Every row here is one moment where those two were compared, and the rows
 * worth an operator's attention are the ones where they differed — so the page opens on MISMATCH
 * rather than on everything, and "Everything" is the last filter rather than the first.
 *
 * The trail is append-only by design. "Pending at 10:00, pending at 10:02, success at 10:05 after
 * we had already given up and refunded" is the entire story of a late settlement and the reason the
 * platform is out of pocket. A table that overwrote each check with the latest one would keep only
 * the final frame of that story, which is the one frame that explains nothing.
 */
export default function ReconciliationPage() {
  const client = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome | 'ALL'>('MISMATCH');
  const [page, setPage] = useState(0);

  const records = useQuery({
    queryKey: ['reconciliations', outcome, page],
    queryFn: () =>
      paymentsAdminService.listReconciliations({
        status: outcome === 'ALL' ? undefined : outcome,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const sweep = useMutation({
    mutationFn: () => paymentsAdminService.reconcileNow(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['reconciliations'] });
      void client.invalidateQueries({ queryKey: ['payment-stats'] });
      void client.invalidateQueries({ queryKey: ['trial-balance'] });
    },
  });

  const items = records.data?.items ?? [];
  const total = records.data?.total ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Reconciliation</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Every time we asked a rail what really happened, and what it said. The rail is the source
            of truth; our record is only what we believed. These rows are where the two were
            compared.
          </p>
        </div>
        <Button onClick={() => sweep.mutate()} disabled={sweep.isPending}>
          {sweep.isPending ? 'Sweeping…' : 'Run a sweep now'}
        </Button>
      </div>

      {/*
        The sweep result leads with lateSettlements, because that is the only figure in it that
        represents money the platform may have lost: a payment the rail settled after we had given
        up on it and refunded the customer.
      */}
      {sweep.data ? (
        <div
          className={cn(
            'mt-4 rounded-md border p-4 text-sm',
            sweep.data.lateSettlements > 0
              ? 'border-red-500 bg-red-50 dark:bg-red-950/30'
              : 'border-black/10 dark:border-white/10',
          )}
        >
          {sweep.data.lateSettlements > 0 ? (
            <p className="font-semibold text-red-700 dark:text-red-300">
              {sweep.data.lateSettlements} payment
              {sweep.data.lateSettlements === 1 ? '' : 's'} settled at the rail after we had given
              up. Where a refund had already gone out, the platform is short — open each one and
              check.
            </p>
          ) : (
            <p className="font-medium">No late settlements. Nothing was lost in this sweep.</p>
          )}
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            {(
              [
                ['Checked', sweep.data.checked],
                ['Agreed', sweep.data.matched],
                ['Corrected', sweep.data.corrected],
                ['Refunded', sweep.data.refunded],
                ['Given up on', sweep.data.deemed],
                ['Skipped', sweep.data.skipped],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {sweep.isError ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          {sweep.error instanceof Error ? sweep.error.message : 'The sweep could not be run.'}
        </p>
      ) : null}

      <div className="mt-6">
        <FilterChips
          options={FILTERS}
          value={outcome}
          onChange={(key) => {
            setOutcome(key);
            setPage(0);
          }}
          trailing={
            <span className="text-muted-foreground text-xs">
              {records.isFetching
                ? 'Loading…'
                : `${total} record${total === 1 ? '' : 's'}`}
            </span>
          }
        />
      </div>

      {outcome !== 'ALL' ? (
        <p className="text-muted-foreground mt-2 text-xs">{OUTCOME[outcome].hint}</p>
      ) : null}

      <div className="mt-3 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Checked</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Rail said</TableHead>
              <TableHead>We said</TableHead>
              <TableHead className="text-right">Rail amount</TableHead>
              <TableHead className="text-right">Our amount</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Action taken</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground py-8 text-center">
                  Loading…
                </TableCell>
              </TableRow>
            ) : records.isError ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-red-600 dark:text-red-400">
                  {records.error instanceof Error
                    ? records.error.message
                    : 'Could not load the reconciliation trail.'}
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground py-8 text-center">
                  {outcome === 'MISMATCH'
                    ? 'No disagreements. Every check so far has matched what we recorded.'
                    : 'Nothing here.'}
                </TableCell>
              </TableRow>
            ) : (
              items.map((record) => {
                const outcomeMeta = OUTCOME[record.status];
                const ourAmount = record.transaction?.totalDebitMinor;
                const currency = record.transaction?.sourceCurrency ?? 'INR';
                /*
                 * A visible amount difference is the discrepancy that matters most and the one
                 * least likely to be described in the `discrepancy` text, so it is computed here
                 * rather than trusted to prose. String comparison is exact and safe on minor units;
                 * a numeric one would not be.
                 */
                const amountsDiffer =
                  record.railAmountMinor !== null &&
                  ourAmount !== undefined &&
                  record.railAmountMinor !== ourAmount;

                return (
                  <TableRow key={record.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(record.createdAt)}
                    </TableCell>
                    <TableCell className={cn('text-xs', outcomeMeta.tone)}>
                      {outcomeMeta.label}
                      {record.discrepancy ? (
                        <div className="text-muted-foreground mt-0.5 max-w-56 font-normal">
                          {record.discrepancy}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {record.railStatus}
                      {record.railCode ? (
                        <span className="text-muted-foreground font-mono"> {record.railCode}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{record.internalStatus}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-mono text-xs',
                        amountsDiffer && 'font-semibold text-red-600 dark:text-red-400',
                      )}
                    >
                      {record.railAmountMinor === null
                        ? '—'
                        : formatMoney(record.railAmountMinor, currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {ourAmount === undefined ? '—' : formatMoney(ourAmount, currency)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {record.source}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{record.action ?? '—'}</TableCell>
                    <TableCell>
                      <Link
                        href={ROUTES.DASHBOARD.PAYMENT_DETAIL(record.transactionId)}
                        className="text-xs underline underline-offset-4"
                      >
                        Open
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPage={setPage}
        noun="records"
      />
    </div>
  );
}
