'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { FilterChips } from '@/components/payments/filter-chips';
import { Pager } from '@/components/payments/pager';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { formatMoney } from '@/lib/api/payments/money';
import type { AdminDispute, DisputeStatus } from '@/lib/api/payments/payments.schema';
import { paymentsAdminService } from '@/lib/api/payments/payments.service';
import { cn } from '@/lib/utils/utils';

const PAGE_SIZE = 50;

/** What each dispute kind is actually claiming. */
const KIND_MEANING: Record<string, string> = {
  NOT_CREDITED: 'Debited, but the payee says nothing arrived.',
  DUPLICATE_DEBIT: 'Charged more than once for one payment.',
  WRONG_BENEFICIARY: 'The money reached the wrong person.',
  AMOUNT_MISMATCH: 'A different amount left than was authorised.',
  UNAUTHORISED: 'They say they never made this payment at all.',
  CHARGEBACK: 'Raised through the rail rather than through us.',
};

const STATUS_LABEL: Record<DisputeStatus, string> = {
  OPEN: 'Unclaimed',
  UNDER_REVIEW: 'Being worked',
  RESOLVED_CREDITED: 'Upheld — credited',
  RESOLVED_REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn by the customer',
};

/**
 * The wall clock, treated as the external system it is.
 *
 * Reading `Date.now()` during render is impure, and on a server-rendered client component it is
 * also wrong in a way that shows: the server's markup carries one instant and hydration carries
 * another, so the deadline an operator first reads silently disagrees with the one a moment later.
 * `useSyncExternalStore` is the primitive for exactly this — a value that lives outside React and
 * changes on its own — and its separate server snapshot solves the hydration half properly rather
 * than by convention.
 *
 * `getServerSnapshot` returns null, so the first paint is deterministic and every row shows its
 * absolute deadline. That is correct information, not a placeholder. The client snapshot takes over
 * immediately afterwards and the relative countdowns appear.
 *
 * The snapshot is quantised to `BUCKET_MS` because React requires a stable value between
 * notifications — an unquantised `Date.now()` would return something new on every call and React
 * would warn and loop. Ticking twice per bucket guarantees at least one notification lands inside
 * each new bucket, so the display lags by at most half a bucket. Whole hours are what is rendered,
 * so that is invisible.
 */
const BUCKET_MS = 30_000;

const clock = {
  subscribe(onChange: () => void) {
    const timer = setInterval(onChange, BUCKET_MS / 2);
    return () => clearInterval(timer);
  },
  getSnapshot: (): number => Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS,
  getServerSnapshot: (): number | null => null,
};

function useNow(): number | null {
  return useSyncExternalStore(
    clock.subscribe,
    clock.getSnapshot,
    clock.getServerSnapshot,
  );
}

type Tab = 'open' | 'breached' | 'all';

const TABS: { key: Tab; label: string; hint: string }[] = [
  {
    key: 'open',
    label: 'Open work',
    hint: 'Unclaimed and in-progress, most urgent deadline first.',
  },
  {
    key: 'breached',
    label: 'Past SLA',
    hint: 'The promises already broken. Every one of these is escalation material.',
  },
  { key: 'all', label: 'Everything', hint: 'Including resolved and withdrawn.' },
];

/**
 * The dispute queue.
 *
 * Ordered by deadline, not by arrival, because a dispute queue exists to be worked and the only
 * defensible priority is what is closest to breaking a promise the platform made in writing. The
 * `slaDueAt` on each row was stamped server-side when the customer raised it — it is an obligation
 * with a timestamp, not a target in a support script.
 *
 * The default tab is open work rather than breaches, deliberately. A queue that showed only what
 * was already late would let every dispute go late before anyone could act on it.
 *
 * `UNAUTHORISED` is drawn apart from the other kinds: it is a fraud claim rather than a service
 * complaint. It feeds the risk engine, and it is a statement about the account, not only about the
 * one payment.
 */
export default function DisputesPage() {
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>('open');
  const [page, setPage] = useState(0);
  const [resolving, setResolving] = useState<AdminDispute | null>(null);

  const disputes = useQuery({
    queryKey: ['disputes', tab, page],
    queryFn: () =>
      paymentsAdminService.listDisputes({
        openOnly: tab === 'open' ? true : undefined,
        breachedOnly: tab === 'breached' ? true : undefined,
        orderBy: 'sla',
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['disputes'] });
    void client.invalidateQueries({ queryKey: ['payment-stats'] });
  };

  const claim = useMutation({
    mutationFn: (id: string) => paymentsAdminService.claimDispute(id),
    onSuccess: invalidate,
  });

  const items = disputes.data?.items ?? [];
  const total = disputes.data?.total ?? 0;
  const now = useNow();
  const activeTab = TABS.find((entry) => entry.key === tab);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Payment disputes</h1>
      <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
        Every UDIR claim raised in the app, soonest deadline first. Raising a dispute is not a
        refund — money moves only when one is upheld, and then through the ordinary refund path.
      </p>

      <div className="mt-6">
        <FilterChips
          options={TABS}
          value={tab}
          onChange={(key) => {
            setTab(key);
            setPage(0);
          }}
          trailing={
            <span className="text-muted-foreground text-xs">
              {disputes.isFetching
                ? 'Loading…'
                : `${total} dispute${total === 1 ? '' : 's'}`}
            </span>
          }
        />
      </div>
      {activeTab ? (
        <p className="text-muted-foreground mt-2 text-xs">{activeTab.hint}</p>
      ) : null}

      {claim.isError ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          {claim.error instanceof Error ? claim.error.message : 'Could not claim that dispute.'}
        </p>
      ) : null}

      {/*
        Cards rather than a table. A dispute's substance is the customer's own words, and prose in a
        table cell is either truncated into uselessness or wrecks the column rhythm for every other
        row. The claim is the point of the record, so it gets room.
      */}
      <div className="mt-4 space-y-3">
        {disputes.isLoading ? (
          <p className="text-muted-foreground py-8 text-center text-sm">Loading…</p>
        ) : disputes.isError ? (
          <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">
            {disputes.error instanceof Error
              ? disputes.error.message
              : 'Could not load the dispute queue.'}
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-black/10 py-10 text-center text-sm dark:border-white/10">
            {tab === 'breached'
              ? 'Nothing past its SLA. Every open dispute is still inside its deadline.'
              : tab === 'open'
                ? 'No open disputes.'
                : 'No disputes have been raised.'}
          </p>
        ) : (
          items.map((dispute) => {
            const due = new Date(dispute.slaDueAt).getTime();
            const open = dispute.status === 'OPEN' || dispute.status === 'UNDER_REVIEW';
            /*
             * `now` is null on the first paint (see useNow). Until it arrives, no row claims to be
             * breached — an unread clock must not be allowed to paint a border red, because a false
             * breach is exactly the alarm an operator learns to ignore.
             */
            const hoursLeft =
              now === null || !Number.isFinite(due) ? null : (due - now) / 3_600_000;
            const breached = open && hoursLeft !== null && hoursLeft < 0;
            /* Under six hours is the point at which a reviewer needs urgency, not a date. */
            const urgent = open && hoursLeft !== null && hoursLeft >= 0 && hoursLeft < 6;
            const fraud = dispute.kind === 'UNAUTHORISED';

            return (
              <article
                key={dispute.id}
                className={cn(
                  'rounded-md border p-4',
                  breached
                    ? 'border-red-500/70 bg-red-50/50 dark:bg-red-950/20'
                    : fraud
                      ? 'border-amber-500/60'
                      : 'border-black/10 dark:border-white/10',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">
                        {dispute.kind.replaceAll('_', ' ').toLowerCase()}
                      </h2>
                      {fraud ? (
                        <span className="rounded-full border border-amber-500 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                          fraud claim
                        </span>
                      ) : null}
                      <span className="text-muted-foreground text-xs">
                        · {STATUS_LABEL[dispute.status]}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {KIND_MEANING[dispute.kind] ?? 'A claim against a payment.'}
                    </p>
                  </div>

                  <div className="text-right">
                    <p
                      className={cn(
                        'text-xs',
                        breached
                          ? 'font-semibold text-red-600 dark:text-red-400'
                          : urgent
                            ? 'font-semibold text-amber-600 dark:text-amber-400'
                            : 'text-muted-foreground',
                      )}
                    >
                      {!open
                        ? `Closed ${formatDateTime(dispute.resolvedAt)}`
                        : hoursLeft === null
                          ? `Due ${formatDateTime(dispute.slaDueAt)}`
                          : hoursLeft < 0
                            ? `${Math.floor(-hoursLeft)}h past the deadline`
                            : hoursLeft < 24
                              ? `${Math.floor(hoursLeft)}h left`
                              : `Due ${formatDateTime(dispute.slaDueAt)}`}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Raised {formatDateTime(dispute.createdAt)}
                    </p>
                  </div>
                </div>

                <p className="mt-3 border-l-2 border-black/10 pl-3 text-sm dark:border-white/10">
                  {dispute.description}
                </p>

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {dispute.transaction ? (
                    <>
                      <div>
                        <dt className="text-muted-foreground">Payment</dt>
                        <dd className="font-mono">
                          {formatMoney(
                            dispute.transaction.totalDebitMinor,
                            dispute.transaction.sourceCurrency,
                          )}{' '}
                          · {dispute.transaction.status}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Already refunded</dt>
                        <dd className="font-mono">
                          {formatMoney(
                            dispute.transaction.refundedMinor,
                            dispute.transaction.sourceCurrency,
                          )}
                        </dd>
                      </div>
                    </>
                  ) : null}
                  {dispute.claimedAmountMinor ? (
                    <div>
                      <dt className="text-muted-foreground">Claimed</dt>
                      <dd className="font-mono">
                        {formatMoney(
                          dispute.claimedAmountMinor,
                          dispute.transaction?.sourceCurrency ?? 'INR',
                        )}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {dispute.resolution ? (
                  <p className="text-muted-foreground mt-3 text-xs">
                    <span className="font-medium">Outcome:</span> {dispute.resolution}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Link
                    href={ROUTES.DASHBOARD.PAYMENT_DETAIL(dispute.transactionId)}
                    className="text-xs underline underline-offset-4"
                  >
                    Open the payment
                  </Link>
                  <span className="grow" />
                  {dispute.status === 'OPEN' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={claim.isPending}
                      onClick={() => claim.mutate(dispute.id)}
                    >
                      {claim.isPending ? 'Claiming…' : 'Claim for review'}
                    </Button>
                  ) : null}
                  {open ? (
                    <Button size="sm" onClick={() => setResolving(dispute)}>
                      Resolve
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>

      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPage={setPage}
        noun="disputes"
      />

      {resolving ? (
        <ResolveDialog
          dispute={resolving}
          onClose={() => setResolving(null)}
          onResolved={() => {
            setResolving(null);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The resolution form.
 *
 * Upholding a dispute is not itself a refund — it routes through the ordinary refund path, which
 * bounds the amount by what remains refundable and sends the rail leg before the ledger may say the
 * money came back. So this form takes an amount only as a *request*, and the server is free to
 * refuse it. Leaving the amount blank refunds what the customer claimed, which is the common case.
 */
function ResolveDialog({
  dispute,
  onClose,
  onResolved,
}: {
  dispute: AdminDispute;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [uphold, setUphold] = useState(true);
  const [resolution, setResolution] = useState('');
  const [amountMinor, setAmountMinor] = useState('');
  const currency = dispute.transaction?.sourceCurrency ?? 'INR';

  const resolve = useMutation({
    mutationFn: () =>
      paymentsAdminService.resolveDispute(dispute.id, {
        status: uphold ? 'RESOLVED_CREDITED' : 'RESOLVED_REJECTED',
        resolution,
        refundAmountMinor: uphold && amountMinor ? amountMinor : undefined,
      }),
    onSuccess: onResolved,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve dispute"
    >
      {/* `popover`, not `background` — this is a floating surface, so it sits at the same elevation
          as every other one in the console. See the note in globals.css. */}
      <form
        className="bg-popover text-popover-foreground max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-black/10 p-5 shadow-lg dark:border-white/10"
        onSubmit={(event) => {
          event.preventDefault();
          resolve.mutate();
        }}
      >
        <h2 className="text-lg font-semibold">
          Resolve {dispute.kind.replaceAll('_', ' ').toLowerCase()}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Your words go to the customer verbatim, and are recorded against your account
          permanently.
        </p>

        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="outcome"
              className="mt-1"
              checked={uphold}
              onChange={() => setUphold(true)}
            />
            <span>
              <span className="font-medium">Uphold and credit them</span>
              <span className="text-muted-foreground block text-xs">
                Raises a refund through the normal path. It is bounded by what is still refundable,
                so an over-refund is refused rather than posted.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="outcome"
              className="mt-1"
              checked={!uphold}
              onChange={() => setUphold(false)}
            />
            <span>
              <span className="font-medium">Reject the claim</span>
              <span className="text-muted-foreground block text-xs">
                No money moves. Say why in terms the customer can act on.
              </span>
            </span>
          </label>
        </div>

        {uphold ? (
          <div className="mt-4">
            <label
              htmlFor="refund-amount"
              className="text-muted-foreground block text-xs"
            >
              Refund amount in minor units — paise, not rupees. Leave blank to refund what they
              claimed
              {dispute.claimedAmountMinor
                ? ` (${formatMoney(dispute.claimedAmountMinor, currency)})`
                : ''}
              .
            </label>
            <input
              id="refund-amount"
              inputMode="numeric"
              pattern="[0-9]*"
              value={amountMinor}
              onChange={(event) => setAmountMinor(event.target.value.replace(/[^0-9]/g, ''))}
              className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
            />
            {amountMinor ? (
              <p className="text-muted-foreground mt-1 text-xs">
                That is {formatMoney(amountMinor, currency)}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4">
          <label htmlFor="resolution" className="text-muted-foreground block text-xs">
            What you found, and what happens next
          </label>
          <textarea
            id="resolution"
            required
            minLength={10}
            rows={4}
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          />
        </div>

        {resolve.isError ? (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {resolve.error instanceof Error
              ? resolve.error.message
              : 'The dispute could not be resolved.'}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={resolve.isPending}>
            {resolve.isPending
              ? 'Resolving…'
              : uphold
                ? 'Uphold and refund'
                : 'Reject the claim'}
          </Button>
        </div>
      </form>
    </div>
  );
}
