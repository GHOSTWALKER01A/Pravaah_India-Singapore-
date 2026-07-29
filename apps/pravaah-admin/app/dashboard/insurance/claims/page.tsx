'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import {
  ClaimStatusBadge,
  RiskScoreBadge,
} from '@/components/insurance/badges';
import {
  formatAge,
  hoursSince,
  useNow,
} from '@/components/insurance/use-now';
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
import { formatDateTime } from '@/helper/date-convertor';
import { insuranceAdminService } from '@/lib/api/insurance/insurance.service';
import type { ClaimStatus } from '@/lib/api/insurance/insurance.schema';

const PAGE_SIZE = 25;

/**
 * The filters, ordered by what an operator opens the page to do.
 *
 * `UNDER_REVIEW` is first AND the default, because it is the only status a reviewer can act on.
 * A queue that opened on "everything" would bury the actionable rows under settled ones — the
 * same reasoning the payments queue applies to `DEEMED`.
 *
 * `APPROVED` is in the list and is not a "done" state: it means approved and NOT YET PAID. Its
 * rows are the quietest failure in the product, so they are reachable in one tap.
 */
const FILTERS: { key: ClaimStatus | 'ALL'; label: string }[] = [
  { key: 'UNDER_REVIEW', label: 'Needs a decision' },
  { key: 'APPROVED', label: 'Approved · payout pending' },
  { key: 'INFO_REQUESTED', label: 'Waiting on claimant' },
  { key: 'SUBMITTED', label: 'No evidence yet' },
  { key: 'PAID', label: 'Paid' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'ALL', label: 'All claims' },
];

/**
 * The claim queue.
 *
 * ## Why it is ordered oldest-first, server-side
 *
 * A newest-first queue starves the longest-waiting claimant. For somebody holding a hospital
 * bill that is the difference between a product that works and one they abandon — and the
 * ordering is on the server so it cannot be lost by a client-side sort somebody adds later.
 *
 * ## Why the age column exists at all
 *
 * A timestamp tells an operator when a claim arrived; the age tells them whether it has been
 * waiting too long. On a queue whose whole job is not leaving people waiting, the derived figure
 * is the one that drives the decision, so it is the column the eye lands on.
 */
export default function InsuranceClaimsPage() {
  const [status, setStatus] = useState<ClaimStatus | 'ALL'>('UNDER_REVIEW');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [offset, setOffset] = useState(0);

  /**
   * One clock for the whole table, ticking on the same cadence as the refetch.
   *
   * The ages advance while an operator watches, so a claim that crosses the 24- or 48-hour
   * threshold changes colour without a reload — and it stays a pure value during render.
   */
  const now = useNow();

  const claims = useQuery({
    queryKey: ['insurance-claims', status, flaggedOnly, offset],
    queryFn: () =>
      insuranceAdminService.claims({
        status,
        flaggedOnly,
        limit: PAGE_SIZE,
        offset,
      }),
    refetchInterval: 60_000,
  });

  const rows = claims.data?.items ?? [];
  const total = claims.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Claims</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Oldest first. Every decision is attributed and needs a written reason — including an
          approval.
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
            claims.isFetching ? (
              <span className="text-muted-foreground text-xs">Refreshing…</span>
            ) : null
          }
        />

        {/*
          Triage: only the claims the fraud hook flagged.

          A separate toggle rather than a filter chip, because it composes with the status
          filter — "flagged claims that still need a decision" is the query a reviewer with
          twenty minutes actually wants.
        */}
        <label className="flex w-fit items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(event) => {
              setFlaggedOnly(event.target.checked);
              setOffset(0);
            }}
            className="size-3.5"
          />
          <span className="text-muted-foreground">
            Only claims with a fraud signal or a flagged document
          </span>
        </label>
      </div>

      {claims.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading the queue…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
          {status === 'UNDER_REVIEW'
            ? 'Nothing is waiting on a decision. That is the state this queue should normally be in.'
            : 'No claims match this filter.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim</TableHead>
                  <TableHead>Waiting</TableHead>
                  <TableHead>Claimed</TableHead>
                  <TableHead>Fraud score</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Policy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  /**
                   * Age and the flagged-document count, derived here.
                   *
                   * The server sends neither — it sends `submittedAt` and the documents
                   * themselves, which is the right call: a console that needed the backend to
                   * pre-compute every display figure would need a release to add a column.
                   * Both derivations are trivial and neither is money.
                   */
                  const ageHours = hoursSince(row.submittedAt, now);
                  const flaggedDocs = row.documents.filter(
                    (doc) => doc.status === 'SUSPECT',
                  ).length;

                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link
                          href={ROUTES.DASHBOARD.INSURANCE_CLAIM_DETAIL(row.id)}
                          className="font-mono text-xs underline"
                        >
                          {row.claimNumber}
                        </Link>
                        <div className="text-muted-foreground text-xs">
                          {row.type.replace(/_/g, ' ').toLowerCase()} · incident{' '}
                          {formatDateTime(row.incidentDate)}
                        </div>
                      </TableCell>

                      <TableCell>
                        {/*
                          Age, toned by how long. Over 48 hours on a claim somebody is waiting
                          on is a service failure, not a backlog statistic.
                        */}
                        <span
                          className={`font-mono text-xs ${
                            ageHours >= 48
                              ? 'text-red-600 dark:text-red-400'
                              : ageHours >= 24
                                ? 'text-amber-600 dark:text-amber-400'
                                : ''
                          }`}
                        >
                          {formatAge(ageHours)}
                        </span>
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        {row.amountClaimed.formatted}
                        {row.amountApproved &&
                        row.amountApproved.minor !== row.amountClaimed.minor ? (
                          <div className="text-muted-foreground">
                            approved {row.amountApproved.formatted}
                          </div>
                        ) : null}
                      </TableCell>

                      <TableCell>
                        <RiskScoreBadge
                          score={row.risk.score}
                          flags={row.risk.flags}
                        />
                      </TableCell>

                      <TableCell className="text-xs">
                        {row.documents.length === 0 ? (
                          <span className="text-amber-600 dark:text-amber-400">
                            none
                          </span>
                        ) : (
                          <span>
                            {row.documents.length} doc
                            {row.documents.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {flaggedDocs > 0 ? (
                          <div className="text-amber-700 dark:text-amber-400">
                            {flaggedDocs} flagged
                          </div>
                        ) : null}
                      </TableCell>

                      <TableCell>
                        <ClaimStatusBadge status={row.status} />
                        {/*
                          The state that must never go unnoticed, called out in the queue as
                          well as on the detail page. A claimant has been told they will be paid
                          and the money has not moved.
                        */}
                        {row.payout.pending ? (
                          <div className="text-xs text-red-600 dark:text-red-400">
                            payout not settled
                          </div>
                        ) : null}
                      </TableCell>

                      <TableCell className="text-xs">
                        <div className="font-mono">{row.policy.policyNumber}</div>
                        <div className="text-muted-foreground">
                          {row.policy.remainingCover.formatted} cover left
                        </div>
                        <div className="text-muted-foreground font-mono">
                          {row.holder.pravaahId ?? 'unknown holder'}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <Pager
            page={Math.floor(offset / PAGE_SIZE)}
            pageSize={PAGE_SIZE}
            total={total}
            onPage={(page) => setOffset(page * PAGE_SIZE)}
            noun="claims"
          />
        </>
      )}
    </div>
  );
}

