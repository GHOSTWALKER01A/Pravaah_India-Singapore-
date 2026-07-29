'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  BookProvenanceNote,
  LossRatioBanner,
} from '@/components/insurance/loss-ratio';
import { Figure } from '@/components/payments/figure';
import { ROUTES } from '@/features/routes';
import { insuranceAdminService } from '@/lib/api/insurance/insurance.service';

/**
 * The insurance book — M5's front page.
 *
 * ## Why the loss ratio leads
 *
 * It is the only figure on this page that can be an ALARM rather than a metric. A book paying
 * out more than it earns is not a queue to work through, it is a pricing decision to revisit —
 * and it is the one number an insurer or an actuary will look for first. So it gets the top of
 * the page and a banner with a sentence, exactly as the trial balance does on the Money page,
 * rather than a tile in a row of four where a reader learns to scroll past amber.
 *
 * ## Why the conversion funnel is second, ahead of the queue counts
 *
 * The funnel is where an underwriting problem shows up FIRST. A rising decline rate means the
 * band floor is excluding a population rather than pricing it — which is precisely the outcome
 * M2's fairness audit exists to catch — and a high priced-but-not-bought rate means the price is
 * wrong. Both are visible here months before they surface as a loss ratio. A console that put
 * them below the claim queue would only ever find them retrospectively.
 *
 * ## Why `pendingPayouts` gets its own treatment
 *
 * Every row in that count is a person who has been TOLD their claim is approved and has not been
 * paid. It is the quietest failure in the product — nothing errored, no exception was thrown,
 * and nobody is looking — so it is the one count on this page rendered as a warning rather than
 * a number.
 */
export default function InsuranceBookPage() {
  const client = useQueryClient();
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  const book = useQuery({
    queryKey: ['insurance-book'],
    queryFn: () => insuranceAdminService.book(),
    // A minute is well inside the window in which an operator would want to know the book had
    // turned. Matches the payments pages so the two observers agree.
    refetchInterval: 60_000,
  });

  const stats = useQuery({
    queryKey: ['insurance-stats'],
    queryFn: () => insuranceAdminService.stats(),
    refetchInterval: 60_000,
  });

  /**
   * Force every lifecycle sweep.
   *
   * Exposed because the dunning path (ACTIVE → GRACE → LAPSED) otherwise only runs on a cron,
   * and an operator needs to be able to prove it works — or nudge a stuck premium — without
   * waiting an hour or shipping a deploy. It calls the same schedulers, not a parallel
   * implementation.
   */
  const sweep = useMutation({
    mutationFn: () => insuranceAdminService.runLifecycle(),
    onSuccess: (result) => {
      /**
       * The dunning outcomes are reported separately, not summed.
       *
       * `attempted`, `collected` and `lapsed` are three different events and one of them is
       * somebody losing cover. A single "premiums processed" figure would hide the lapse, which
       * is the only line in this summary an operator might need to act on.
       */
      setSweepResult(
        [
          `${result.quotesExpired} quotes expired`,
          `${result.dunning.attempted} premiums attempted · ${result.dunning.collected} collected · ${result.dunning.lapsed} lapsed`,
          `${result.policiesExpired} terms ended`,
          `${result.payoutsRetried} payouts retried`,
          `${result.resumedTransactions} stuck movements resumed`,
          `${result.insurerBindingsCompleted} insurer bindings completed`,
          `${result.infoRequestsClosed} abandoned info requests closed`,
        ].join(' · '),
      );
      void client.invalidateQueries({ queryKey: ['insurance-book'] });
      void client.invalidateQueries({ queryKey: ['insurance-stats'] });
      void client.invalidateQueries({ queryKey: ['insurance-policies'] });
      void client.invalidateQueries({ queryKey: ['insurance-claims'] });
    },
  });

  const attention = stats.data?.attention;
  const funnel = stats.data?.funnel;
  const providers = stats.data?.providers;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">The insurance book</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Usage-based micro-insurance priced from the M2 reputation score. Premiums and
            payouts move over the same double-entry ledger as every payment.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
        >
          {sweep.isPending ? 'Running…' : 'Run lifecycle sweeps now'}
        </Button>
      </header>

      {sweepResult ? (
        <p className="rounded-md border border-black/10 p-3 font-mono text-xs dark:border-white/10">
          {sweepResult}
        </p>
      ) : null}

      {/* ── 1. the loss ratio, per currency ──────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Underwriting result</h2>

        {book.isLoading ? (
          <p className="text-muted-foreground text-sm">Reading the ledger…</p>
        ) : book.data && book.data.byCurrency.length > 0 ? (
          <>
            <div className="space-y-3">
              {book.data.byCurrency.map((row) => (
                <LossRatioBanner key={row.currency} row={row} />
              ))}
            </div>
            <BookProvenanceNote note={book.data.note} />
          </>
        ) : (
          <p className="text-muted-foreground rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
            No premium has moved through the ledger yet, so there is no book to report. Sell a
            policy and this page fills itself from the ledger entries — nothing here is
            maintained separately.
          </p>
        )}
      </section>

      {/* ── 2. what needs a human ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Needs attention</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Approved, not paid"
            value={String(attention?.pendingPayouts ?? '—')}
            detail="Each one is a person told their claim was approved. The payout is retryable — money is never lost, but nobody is watching."
            tone={(attention?.pendingPayouts ?? 0) > 0 ? 'warn' : 'ok'}
          />
          <Figure
            label="Claims to decide"
            value={String(attention?.claimsAwaitingReview ?? '—')}
            detail="Sitting at review. Worked oldest-first."
            tone={(attention?.claimsAwaitingReview ?? 0) > 0 ? 'warn' : 'ok'}
          />
          <Figure
            label="Documents flagged"
            value={String(attention?.suspectDocuments ?? '—')}
            detail="Tripped the alteration check. These claims cannot auto-approve."
            tone={(attention?.suspectDocuments ?? 0) > 0 ? 'warn' : 'ok'}
          />
          <Figure
            label="Awaiting insurer binding"
            value={String(attention?.policiesAwaitingInsurerBinding ?? '—')}
            detail="Cover is real and the premium settled; the insurer has not acknowledged the reference."
            tone={
              (attention?.policiesAwaitingInsurerBinding ?? 0) > 0 ? 'warn' : 'ok'
            }
          />
        </div>
        <Link
          href={ROUTES.DASHBOARD.INSURANCE_CLAIMS}
          className="inline-block text-sm underline"
        >
          Open the claim queue →
        </Link>
      </section>

      {/* ── 3. the funnel — where underwriting problems appear first ─────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Underwriting funnel</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Quotes given"
            value={String(funnel?.totalQuotes ?? '—')}
            detail="Every price ever computed, including declines."
            tone="ok"
          />
          <Figure
            label="Decline rate"
            value={
              funnel?.declineRatePercent === null ||
              funnel?.declineRatePercent === undefined
                ? '—'
                : `${funnel.declineRatePercent.toFixed(1)}%`
            }
            /*
              The fairness canary.

              A sharply rising decline rate means the band floor is excluding a population
              rather than pricing it — the exact outcome M2's fairness audit exists to catch.
              Flagged above 40% because at that point the product is refusing more people than
              it serves, which is the thing it was built not to do.
            */
            detail="If this climbs, the band floor is excluding a population rather than pricing it. Cross-check the M2 fairness report."
            tone={(funnel?.declineRatePercent ?? 0) > 40 ? 'warn' : 'ok'}
          />
          <Figure
            label="Conversion"
            value={
              funnel?.conversionRatePercent === null ||
              funnel?.conversionRatePercent === undefined
                ? '—'
                : `${funnel.conversionRatePercent.toFixed(1)}%`
            }
            detail="Priced and then bought. Low conversion means the price is wrong, not that demand is absent."
            tone="ok"
          />
          <Figure
            label="Active products"
            value={String(stats.data?.products.active ?? '—')}
            detail="Catalogue entries on offer. An admin can add one without a deploy."
            tone="ok"
          />
        </div>
      </section>

      {/* ── 4. the portfolio ────────────────────────────────────────────────── */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Tally
          title="Policies"
          rows={stats.data?.policies}
          href={ROUTES.DASHBOARD.INSURANCE_POLICIES}
          hrefLabel="Open the policy estate →"
        />
        <Tally
          title="Claims"
          rows={stats.data?.claims}
          href={ROUTES.DASHBOARD.INSURANCE_CLAIMS}
          hrefLabel="Open the claim queue →"
        />
      </section>

      {/* ── 5. what is actually running ─────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Providers in use</h2>
        {/*
          Surfaced deliberately.

          A judge or an auditor should be able to read which insurer bound a policy and which
          engine read a claim document without inferring it from behaviour. A console that
          quietly presented a demonstration insurer as a licensed one would be the single thing
          that discredits everything else in the module.
        */}
        <div className="rounded-md border border-black/10 dark:border-white/10">
          <dl className="divide-y divide-black/5 dark:divide-white/5">
            <ProviderRow
              label="Insurer"
              mode={providers?.insurer.mode}
              provider={providers?.insurer.provider}
              live={providers?.insurer.live}
              note="Production requires an IRDAI-regulated partner behind the same InsurerProvider interface — a credential swap, not a rewrite."
            />
            <ProviderRow
              label="Document reader"
              mode={providers?.ocr.mode}
              provider={providers?.ocr.provider}
              live={providers?.ocr.live}
              note="Google Vision or Textract replace this behind the same OcrProvider interface."
            />
            <ProviderRow
              label="Health claims exchange"
              mode={providers?.claimsExchange.configured ? 'configured' : 'off'}
              provider={providers?.claimsExchange.provider ?? 'none'}
              live={false}
              note="HCX. Unconfigured by default, so the health-claim exchange leg is skipped visibly rather than answering with a fabricated reference."
            />
          </dl>
        </div>
      </section>
    </div>
  );
}

/** A status tally with a link to the list it summarises. */
function Tally({
  title,
  rows,
  href,
  hrefLabel,
}: {
  title: string;
  rows: Record<string, number> | undefined;
  href: string;
  hrefLabel: string;
}) {
  const entries = Object.entries(rows ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="rounded-md border border-black/10 dark:border-white/10">
      <div className="border-b border-black/10 px-4 py-2 text-sm font-semibold dark:border-white/10">
        {title}
      </div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground px-4 py-3 text-sm">None yet.</p>
      ) : (
        <dl className="divide-y divide-black/5 dark:divide-white/5">
          {entries.map(([status, count]) => (
            <div
              key={status}
              className="flex items-baseline justify-between gap-4 px-4 py-2"
            >
              <dt className="text-muted-foreground text-xs">
                {status.replace(/_/g, ' ').toLowerCase()}
              </dt>
              <dd className="font-mono text-sm">{count}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="border-t border-black/10 px-4 py-2 dark:border-white/10">
        <Link href={href} className="text-sm underline">
          {hrefLabel}
        </Link>
      </div>
    </div>
  );
}

function ProviderRow({
  label,
  mode,
  provider,
  live,
  note,
}: {
  label: string;
  mode: string | undefined;
  provider: string | undefined;
  live: boolean | undefined;
  note: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <dt className="text-sm">{label}</dt>
        <dd className="flex items-baseline gap-2">
          <span className="font-mono text-xs">{provider ?? '—'}</span>
          <span
            className={`text-xs ${
              live
                ? 'text-green-600 dark:text-green-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {live ? 'live' : `demonstration · ${mode ?? '—'}`}
          </span>
        </dd>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{note}</p>
    </div>
  );
}
