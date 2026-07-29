'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import {
  CaseStatusBadge,
  ScoreReadout,
  SeverityBadge,
  subjectLabel,
} from '@/components/fraud/badges';
import { formatAge, hoursSince, useNow } from '@/components/insurance/use-now';
import { FilterChips } from '@/components/payments/filter-chips';
import { Pager } from '@/components/payments/pager';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ROUTES } from '@/features/routes';
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';
import type { FraudCaseStatus } from '@/lib/api/fraud/fraud.schema';

const PAGE_SIZE = 25;

/**
 * The filters, ordered by what an analyst opens the page to do.
 *
 * `OPEN` leads AND is the default, because it is the only status with nobody working it — every
 * row is a held customer with no analyst assigned. A queue that opened on "everything" would
 * bury those under cases already in hand.
 *
 * `ESCALATED` is high in the list despite being rare: those are the cases waiting on a senior
 * reviewer or compliance, and they are unassigned by design, so nothing else surfaces them.
 */
const FILTERS: { key: FraudCaseStatus | 'ALL'; label: string }[] = [
  { key: 'OPEN', label: 'Unclaimed' },
  { key: 'INVESTIGATING', label: 'Being worked' },
  { key: 'ESCALATED', label: 'Escalated' },
  { key: 'INFO_REQUESTED', label: 'Waiting on customer' },
  { key: 'CLEARED', label: 'Cleared' },
  { key: 'CONFIRMED_FRAUD', label: 'Confirmed' },
  { key: 'ALL', label: 'All cases' },
];

/**
 * The fraud case queue.
 *
 * ## Why this is the only screen in the console with a clock against it
 *
 * Every row is a PERSON WHOSE ACTION IS STOPPED, and for a `TRANSACTION` case that means their
 * money is sitting in suspense. The four-hour SLA is not an internal target — it is what makes
 * an automated hold defensible in the first place. A held payment nobody looks at is not a
 * fraud control; it is an unaccountable denial of service against a customer who is, at these
 * thresholds, most likely legitimate.
 *
 * So the age column is the one the eye lands on, breaches are marked, and the ordering is
 * severity-then-oldest SERVER-SIDE, where a client-side sort cannot lose it.
 *
 * ## Why the score is shown here and not just on the detail page
 *
 * An analyst triaging twenty rows needs to know which are close calls. A case at 0.86 scraped
 * into the hold band on marginal signals; one at 0.97 did not. Reading that from the list is
 * what lets someone pick up the ambiguous ones first, rather than working top to bottom.
 */
export default function FraudCasesPage() {
  const [status, setStatus] = useState<FraudCaseStatus | 'ALL'>('OPEN');
  const [mine, setMine] = useState(false);
  const [offset, setOffset] = useState(0);

  /**
   * One clock for the whole table, on the same cadence as the refetch.
   *
   * The ages advance while an analyst watches, so a case crossing its SLA changes appearance
   * without a reload — and it stays a pure value during render.
   */
  const now = useNow();

  const cases = useQuery({
    queryKey: ['fraud-cases', status, mine, offset],
    queryFn: () =>
      fraudAdminService.cases({
        status,
        mine,
        limit: PAGE_SIZE,
        offset,
      }),
    /**
     * 30 seconds, not the 60 the other queues use.
     *
     * This is the only queue where staleness has a cost measured against a promise: a case
     * that breached its SLA a minute ago is a customer already waiting longer than we said.
     */
    refetchInterval: 30_000,
  });

  const rows = cases.data?.items ?? [];
  const total = cases.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Fraud case queue</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Most severe first, then longest-waiting. Every row is an action that is
          stopped — clearing one releases it.
        </p>
      </header>

      <div className="space-y-3">
        <FilterChips
          options={FILTERS}
          value={status}
          onChange={(next) => {
            setStatus(next);
            setOffset(0);
          }}
          trailing={
            cases.isFetching ? (
              <span className="text-muted-foreground text-xs">Refreshing…</span>
            ) : null
          }
        />

        {/*
          "Only mine" composes with the status filter rather than replacing it.

          "My cases that are still being worked" is the query an analyst returning from lunch
          actually wants, and a filter chip could not express it alongside a status.
        */}
        <label className="flex w-fit items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={mine}
            onChange={(event) => {
              setMine(event.target.checked);
              setOffset(0);
            }}
            className="size-3.5"
          />
          <span className="text-muted-foreground">
            Only cases assigned to me
          </span>
        </label>
      </div>

      {cases.isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          Could not load the case queue.
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Severity</TableHead>
            <TableHead>Waiting</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Signals</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Customer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && !cases.isLoading ? (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground py-8 text-center text-sm">
                {status === 'OPEN'
                  ? 'Nothing unclaimed. Every held action has an analyst on it.'
                  : 'No cases match this filter.'}
              </TableCell>
            </TableRow>
          ) : null}

          {rows.map((row) => {
            const age = hoursSince(row.openedAt, now);

            return (
              <TableRow key={row.id}>
                <TableCell>
                  <SeverityBadge severity={row.severity} />
                </TableCell>

                <TableCell>
                  {/*
                    The SLA breach is stated in WORDS, not only in colour.

                    An analyst working a long shift on a dim screen, or anyone with a colour
                    vision deficiency, must be able to see which rows have broken the promise.
                    Red alone does not carry that.
                  */}
                  <div className="flex flex-col">
                    <span
                      className={
                        row.slaBreached
                          ? 'font-medium text-red-600 dark:text-red-400'
                          : age >= 2
                            ? 'text-amber-600 dark:text-amber-400'
                            : ''
                      }
                    >
                      {formatAge(age)}
                    </span>
                    {row.slaBreached ? (
                      <span className="text-[11px] text-red-600 dark:text-red-400">
                        past SLA
                      </span>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell>
                  <Link
                    href={ROUTES.DASHBOARD.FRAUD_CASE_DETAIL(row.id)}
                    className="underline-offset-2 hover:underline"
                  >
                    {subjectLabel(row.subjectType)}
                  </Link>
                </TableCell>

                <TableCell>
                  {row.assessment ? (
                    <ScoreReadout score={row.assessment.score} />
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>

                <TableCell>
                  {/*
                    The first three signal types, and a count of the rest.

                    Truncated because the full list is often eight tokens and would dominate
                    the row — but the COUNT is shown, so nobody mistakes a truncation for the
                    whole picture. That distinction matters on a screen where "what fired" is
                    the reason the case exists.
                  */}
                  <SignalSummary reason={row.reason} />
                </TableCell>

                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <CaseStatusBadge status={row.status} />
                    {/*
                      A resolved case whose downstream action did NOT apply.

                      The quietest failure in this module: the analyst decided, the case closed,
                      and the payment was never released. Surfaced in the queue rather than only
                      on the detail page, because nobody re-opens a case they believe is done.
                    */}
                    {row.resolvedAt && !row.actionApplied ? (
                      <span className="text-[11px] text-red-600 dark:text-red-400">
                        action not applied
                      </span>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell>
                  <Link
                    href={ROUTES.DASHBOARD.FRAUD_USER(row.userId)}
                    className="font-mono text-xs underline-offset-2 hover:underline"
                  >
                    {row.user.pravaahId ?? row.userId.slice(0, 8)}
                  </Link>
                  {row.user.isSuspended ? (
                    <span className="ml-2 text-[11px] text-red-600 dark:text-red-400">
                      suspended
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Pager
        page={Math.floor(offset / PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        total={total}
        onPage={(page) => setOffset(page * PAGE_SIZE)}
        noun="cases"
      />
    </div>
  );
}

/**
 * The signal types, abbreviated for a table cell.
 *
 * Reads the comma-joined `reason` the server stores rather than the assessment's signal array,
 * because `reason` is what the case was OPENED with — the assessment can be re-read but the
 * case's own record of why is the audit-relevant one.
 */
function SignalSummary({ reason }: { reason: string }) {
  const signals = reason.split(',').filter(Boolean);
  const shown = signals.slice(0, 3);
  const rest = signals.length - shown.length;

  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((signal) => (
        <span
          key={signal}
          className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
        >
          {signal}
        </span>
      ))}
      {rest > 0 ? (
        <span className="text-muted-foreground text-[10px]">+{rest} more</span>
      ) : null}
    </span>
  );
}
