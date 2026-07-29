'use client';

import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import { PolicyStatusBadge } from '@/components/insurance/badges';
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
import { formatDateTime } from '@/helper/date-convertor';
import { insuranceAdminService } from '@/lib/api/insurance/insurance.service';
import type {
  AdminPremiumRow,
  PolicyStatus,
} from '@/lib/api/insurance/insurance.schema';

const PAGE_SIZE = 25;

/**
 * The filters, ordered by what needs an operator rather than by lifecycle sequence.
 *
 * `GRACE` is second, ahead of the far more numerous `ACTIVE`, because it is the only status here
 * with a closing window: cover is live, a premium is late, and there are seven days to recover it
 * before it lapses. `PENDING_PAYMENT` is third for the same reason — a policy somebody bought and
 * has not got.
 */
const FILTERS: { key: PolicyStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All policies' },
  { key: 'GRACE', label: 'Premium overdue' },
  { key: 'PENDING_PAYMENT', label: 'Awaiting first premium' },
  { key: 'ACTIVE', label: 'In force' },
  { key: 'LAPSED', label: 'Lapsed' },
  { key: 'EXPIRED', label: 'Term ended' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

/**
 * The policy estate.
 *
 * ## Why the premium history opens inline
 *
 * It is the document a support call is argued from — a policyholder who believes they paid and
 * whose cover lapsed anyway needs each period, its dates, and whether the collection succeeded.
 * Putting it behind a route would mean losing the queue position an operator is working through;
 * inline keeps the list and the evidence on one screen, which is how a support conversation
 * actually goes.
 */
export default function InsurancePoliciesPage() {
  const [status, setStatus] = useState<PolicyStatus | 'ALL'>('ALL');
  const [offset, setOffset] = useState(0);
  const [openPolicy, setOpenPolicy] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: ['insurance-policies', status, offset],
    queryFn: () =>
      insuranceAdminService.policies({ status, limit: PAGE_SIZE, offset }),
  });

  const rows = policies.data?.items ?? [];
  const total = policies.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Policies</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every policy sold. A lapsed policy is kept and shown, never hidden — the holder can see
          it too.
        </p>
      </header>

      <FilterChips
        options={FILTERS}
        value={status}
        onChange={(next) => {
          setStatus(next);
          setOffset(0);
        }}
        trailing={
          policies.isFetching ? (
            <span className="text-muted-foreground text-xs">Refreshing…</span>
          ) : null
        }
      />

      {policies.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading the estate…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
          No policies match this filter.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Policy</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sum insured</TableHead>
                  <TableHead>Premium</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead>Holder &amp; pricing</TableHead>
                  <TableHead>Premiums</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-mono text-xs">{row.policyNumber}</div>
                      <div className="text-muted-foreground text-xs">
                        {row.product}
                      </div>
                      {/*
                        The binding gap, surfaced rather than inferred from a null.

                        Cover is real — the premium settled — but the insurer has not
                        acknowledged the reference. An operator should be able to see which
                        policies those are without reading a nullable column.
                      */}
                      {row.insurerBindPending ? (
                        <div className="text-xs text-amber-600 dark:text-amber-400">
                          insurer binding pending
                        </div>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      <PolicyStatusBadge status={row.status} />
                      {/*
                        The server does not send `graceEndsAt` on this projection, so the
                        actionable date for a GRACE policy is the premium that went unpaid.
                        Naming that rather than inventing a lapse date keeps the column honest
                        about what is actually known here.
                      */}
                      {row.status === 'GRACE' && row.nextPremiumDueAt ? (
                        <div className="text-xs text-amber-600 dark:text-amber-400">
                          due {formatDateTime(row.nextPremiumDueAt)}
                        </div>
                      ) : null}
                    </TableCell>

                    <TableCell className="font-mono text-xs">
                      {row.coverage.formatted}
                      {/*
                        Cover paid out so far, shown only once there is some.

                        The server sends `claimedToDate` on this projection rather than a
                        remainder — the reviewer's claim view computes the remainder because that
                        is where a claim is assessed against it. Subtracting here would mean two
                        places deriving the same figure, and the one that matters is the one the
                        adjudication uses.
                      */}
                      {row.claimedToDate.minor !== '0' ? (
                        <div className="text-amber-600 dark:text-amber-400">
                          {row.claimedToDate.formatted} claimed
                        </div>
                      ) : null}
                    </TableCell>

                    <TableCell className="font-mono text-xs">
                      {row.premium.formatted}
                      <div className="text-muted-foreground">
                        {row.frequency === 'MONTHLY' ? 'monthly' : 'one-time'}
                      </div>
                    </TableCell>

                    <TableCell className="font-mono text-xs">
                      {row.nextPremiumDueAt
                        ? formatDateTime(row.nextPremiumDueAt)
                        : '—'}
                    </TableCell>

                    <TableCell className="text-xs">
                      <div className="font-mono">{row.holder ?? '—'}</div>
                      {/*
                        How this holder was priced, on the estate list.

                        A row of policies whose tiers can be scanned is how a pricing problem
                        becomes visible — an estate that is all SUBSTANDARD means the band
                        thresholds are wrong for the population, not that the population is.
                      */}
                      <div className="text-muted-foreground">
                        {row.underwriting.riskTier.toLowerCase()}
                        {row.underwriting.scoreBand
                          ? ` · ${row.underwriting.scoreBand.replace(/_/g, ' ').toLowerCase()}`
                          : ' · thin file'}
                      </div>
                      {row.claimCount > 0 ? (
                        <div className="text-muted-foreground">
                          {row.claimCount} claim{row.claimCount === 1 ? '' : 's'}
                        </div>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      <button
                        onClick={() =>
                          setOpenPolicy((prev) => (prev === row.id ? null : row.id))
                        }
                        className="text-xs underline"
                        aria-expanded={openPolicy === row.id}
                      >
                        {openPolicy === row.id ? 'Hide' : 'History'}
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {openPolicy ? <PremiumHistory policyId={openPolicy} /> : null}

          <Pager
            page={Math.floor(offset / PAGE_SIZE)}
            pageSize={PAGE_SIZE}
            total={total}
            onPage={(page) => setOffset(page * PAGE_SIZE)}
            noun="policies"
          />
        </>
      )}
    </div>
  );
}

/**
 * Every premium period on one policy.
 *
 * ## Why a FAILED period is amber and not red
 *
 * A premium that could not be collected is almost always an empty wallet on the due date, not a
 * fault and not a dispute. Red across a table that may be mostly failures for somebody paid
 * irregularly would train an operator to ignore the colour — and the one row that genuinely
 * matters (a repeated failure heading for a lapse) would be lost in it. The `attempt` count is
 * what distinguishes those, so it gets its own column.
 */
function PremiumHistory({ policyId }: { policyId: string }) {
  const premiums = useQuery({
    queryKey: ['insurance-premiums', policyId],
    queryFn: () => insuranceAdminService.premiums(policyId),
  });

  const items = premiums.data?.items ?? [];

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">
        Premium history
        {premiums.data ? (
          <span className="text-muted-foreground ml-2 font-mono text-xs font-normal">
            {premiums.data.policyNumber}
          </span>
        ) : null}
      </h2>
      {premiums.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
          No premium has been collected on this policy.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cover period</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Attempt</TableHead>
                <TableHead>Ledger</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <PremiumRow key={row.id} row={row} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function PremiumRow({ row }: { row: AdminPremiumRow }) {
  const tone =
    row.status === 'PAID'
      ? 'text-green-600 dark:text-green-400'
      : row.status === 'REFUNDED'
        ? 'text-zinc-500 dark:text-zinc-400'
        : 'text-amber-600 dark:text-amber-400';

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        {/*
          The COVER PERIOD, not the collection date.

          What the money bought. A row showing only "paid on 3 Aug" cannot answer "was this
          policyholder covered on the 14th?", which is the only question this table is ever
          opened for.
        */}
        {formatDateTime(row.periodStart)} → {formatDateTime(row.periodEnd)}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {row.amount.formatted}
        {row.refunded && row.refunded.minor !== '0' ? (
          <div className="text-muted-foreground">
            {row.refunded.formatted} refunded
          </div>
        ) : null}
      </TableCell>
      <TableCell className={`text-xs ${tone}`}>
        {row.status.toLowerCase()}
        {row.paidAt ? (
          <div className="text-muted-foreground">
            {formatDateTime(row.paidAt)}
          </div>
        ) : null}
        {row.failureReason ? (
          <div className="text-muted-foreground">{row.failureReason}</div>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {row.attempt > 1 ? (
          <span className="text-amber-600 dark:text-amber-400">
            {row.attempt}
          </span>
        ) : (
          row.attempt
        )}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {row.transactionId ? row.transactionId.slice(0, 8) : '—'}
      </TableCell>
    </TableRow>
  );
}
