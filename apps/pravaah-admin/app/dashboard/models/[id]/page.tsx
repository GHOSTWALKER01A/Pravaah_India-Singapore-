'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import type { FairnessReportRow } from '@/lib/api/scoring/scoring.schema';
import { scoringService } from '@/lib/api/scoring/scoring.service';

/**
 * Model detail + the bias dashboard.
 *
 * This is the page the activation gate lives on. The Activate button is disabled
 * with the backend's own reason string — the same predicate the API enforces — so
 * the console can never imply an action the server would refuse. Pressing it
 * anyway (a stale page) still fails server-side, and the refusal is audited.
 */
export default function ModelDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const queryClient = useQueryClient();
  const [threshold, setThreshold] = useState(670);

  const model = useQuery({
    queryKey: ['model', id],
    queryFn: () => scoringService.getModel(id),
    enabled: Boolean(id),
  });

  const fairness = useQuery({
    queryKey: ['model-fairness', id],
    queryFn: () => scoringService.getFairness(id),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['model', id] });
    void queryClient.invalidateQueries({ queryKey: ['model-fairness', id] });
    void queryClient.invalidateQueries({ queryKey: ['models'] });
  };

  const audit = useMutation({
    mutationFn: () => scoringService.auditFairness(id, threshold),
    onSuccess: (result) => {
      invalidate();
      toast[result.passed ? 'success' : 'error'](
        result.passed
          ? `Fairness PASSED over ${result.subjects} subjects — this version may now be activated.`
          : `Fairness FAILED — activation remains blocked.`,
        {
          description: result.passed
            ? result.monitoredConcerns.length > 0
              ? `${result.monitoredConcerns.length} monitored (non-blocking) age metrics are outside threshold and are shown below.`
              : undefined
            : `${result.reports.filter((r) => !r.passed).length} group metrics outside threshold.`,
        },
      );
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Audit failed'),
  });

  const activate = useMutation({
    mutationFn: () => scoringService.activateModel(id),
    onSuccess: (result) => {
      invalidate();
      toast.success(`v${result.version} is now the active model.`, {
        description: result.scoresPendingRecompute
          ? `${result.scoresPendingRecompute} existing scores stay valid under the version that produced them, and recompute on next request.`
          : undefined,
      });
    },
    // The blocked-activation message from the backend IS the explanation. Shown
    // verbatim rather than paraphrased.
    onError: (err) =>
      toast.error('Activation blocked', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  });

  if (model.isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (model.isError) {
    return (
      <p className="text-sm text-red-500">
        {model.error instanceof Error
          ? model.error.message
          : 'Failed to load model'}
      </p>
    );
  }
  const data = model.data;
  if (!data) return null;

  const blocked = data.activationBlockedReason;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href={ROUTES.DASHBOARD.MODELS}
            className="text-muted-foreground text-xs hover:underline"
          >
            ← Models
          </Link>
          <h1 className="mt-1 font-mono text-2xl font-semibold">
            {data.name} v{data.version}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {data.notes ?? data.datasetRef ?? '—'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-muted-foreground text-xs">
            Approval cut-off
            <input
              type="number"
              min={300}
              max={900}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="border-input ml-2 w-20 rounded-md border bg-transparent px-2 py-1 text-sm"
            />
          </label>
          <Button
            variant="outline"
            onClick={() => audit.mutate()}
            disabled={audit.isPending}
          >
            {audit.isPending ? 'Auditing…' : 'Run fairness audit'}
          </Button>
          {data.isActive ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
              <span className="size-2 rounded-full bg-current" />
              Active
            </span>
          ) : (
            <Button
              onClick={() => activate.mutate()}
              disabled={Boolean(blocked) || activate.isPending}
              title={blocked ?? 'Activate this model version'}
            >
              {activate.isPending ? 'Activating…' : 'Activate'}
            </Button>
          )}
        </div>
      </div>

      {/* The gate, stated. Not a greyed-out button with no explanation. */}
      {blocked && !data.isActive && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Activation blocked
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{blocked}</p>
        </div>
      )}

      {/* Provenance */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Runtime" value={data.runtime} mono />
        <Field label="Trained" value={formatDateTime(data.trainedAt)} />
        <Field
          label="Fairness"
          value={
            data.fairness.passed
              ? 'Passed'
              : data.fairness.auditedAt
                ? 'Failed'
                : 'Not audited'
          }
        />
        <Field
          label="Scores issued"
          value={String(data.scoreCount ?? 0)}
        />
        <Field
          label="Dataset"
          value={data.datasetRef ?? '—'}
          className="sm:col-span-2"
        />
        <Field
          label="Audited at"
          value={
            data.fairness.auditedAt
              ? formatDateTime(data.fairness.auditedAt)
              : '—'
          }
        />
        <Field
          label="Activated"
          value={data.activatedAt ? formatDateTime(data.activatedAt) : '—'}
        />
      </section>

      {/* ── Bias dashboard ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Bias audit</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Protected attributes are <strong>never</strong> model inputs. They are
            collected under a separate consent, stored encrypted, and read by
            exactly one caller — this audit — so that outcomes can be tested across
            groups. Blind when scoring, sighted when auditing.
          </p>
        </div>

        {fairness.isLoading && (
          <p className="text-muted-foreground text-sm">Loading report…</p>
        )}

        {fairness.data && fairness.data.metrics.length === 0 && (
          <p className="text-muted-foreground rounded-lg border border-dashed border-black/15 p-6 text-sm dark:border-white/15">
            No audit has been run for this version yet. Run one above — until it
            passes, this version cannot be activated.
          </p>
        )}

        {fairness.data && fairness.data.metrics.length > 0 && (
          <>
            {/* Which attributes block, and why — visible at the point of decision. */}
            <div className="grid gap-3 sm:grid-cols-3">
              {fairness.data.attributePolicy.map((p) => (
                <div
                  key={p.attribute}
                  className={`rounded-lg border p-3 ${
                    p.mode === 'blocking'
                      ? 'border-black/15 dark:border-white/15'
                      : 'border-dashed border-black/15 dark:border-white/15'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs">{p.attribute}</span>
                    <span
                      className={`text-xs font-semibold uppercase ${
                        p.mode === 'blocking'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {p.mode}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                    {p.rationale}
                  </p>
                </div>
              ))}
            </div>

            {fairness.data.blockingFailures.length > 0 && (
              <Callout tone="danger" title="Blocking failures">
                These stop the deploy. Every one is a group where approval rates
                differ with no legitimate business reason.
                <GroupList rows={fairness.data.blockingFailures} />
              </Callout>
            )}

            {fairness.data.monitoredConcerns.length > 0 && (
              <Callout tone="warning" title="Monitored concerns (not blocking)">
                Age disparity driven by income, savings and history depth. Reported
                in full and designed against — wealth and tenure features are
                capped at roughly a fifth of total model weight — but not a hard
                block, because a gate no model can ever pass is a gate that gets
                switched off.
                <GroupList rows={fairness.data.monitoredConcerns} />
              </Callout>
            )}

            {fairness.data.metrics.map((metric) => (
              <div
                key={metric.metric}
                className="rounded-lg border border-black/10 dark:border-white/10"
              >
                <div className="border-b border-black/10 p-4 dark:border-white/10">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-mono text-sm font-semibold">
                      {metric.metric}
                    </h3>
                    <span className="text-muted-foreground text-xs">
                      threshold {metric.threshold} ·{' '}
                      {metric.failing === 0
                        ? 'all groups within threshold'
                        : `${metric.failing} outside threshold`}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {metric.interpretation}
                  </p>
                </div>
                <div className="divide-y divide-black/5 dark:divide-white/5">
                  {metric.groups.map((g) => (
                    <GroupRow key={`${metric.metric}-${g.group}`} row={g} />
                  ))}
                </div>
              </div>
            ))}

            <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
              <h3 className="text-sm font-semibold">
                If a group fails: the mitigation path
              </h3>
              <p className="text-muted-foreground mt-1 text-xs">
                Detection without a stated remedy is theatre. These are the options,
                in the order they should be considered.
              </p>
              <ol className="mt-3 space-y-2.5">
                {fairness.data.mitigations.map((m, i) => (
                  <li key={m.name} className="flex gap-3 text-sm">
                    <span className="text-muted-foreground font-mono text-xs">
                      {i + 1}.
                    </span>
                    <div>
                      <div className="font-medium">{m.name}</div>
                      <div className="text-muted-foreground text-xs leading-relaxed">
                        {m.detail}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </section>

      {/* The scorecard IS the model for this runtime — a reviewer must be able to
          read the weights that priced someone's creditworthiness. */}
      {data.scorecard ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Model parameters</h2>
          <p className="text-muted-foreground text-sm">
            This version runs the in-process additive scorecard, so these
            parameters <em>are</em> the model — every score it issued can be
            recomputed from them plus the stored <code>inputsHash</code>.
          </p>
          <pre className="max-h-96 overflow-auto rounded-lg border border-black/10 bg-black/3 p-4 text-xs dark:border-white/10 dark:bg-white/3">
            {JSON.stringify(data.scorecard, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function GroupRow({ row }: { row: FairnessReportRow }) {
  const indecisive = row.decisive === false;
  const tone = row.passed
    ? 'text-green-600 dark:text-green-400'
    : indecisive
      ? 'text-muted-foreground'
      : row.blocking
        ? 'text-red-600 dark:text-red-400'
        : 'text-amber-600 dark:text-amber-400';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
      <span className="min-w-50 font-mono text-xs">{row.group}</span>
      <span className={`w-16 font-semibold ${tone}`}>
        {row.value.toFixed(2)}
      </span>
      <span className="text-muted-foreground text-xs">n={row.sampleSize}</span>
      {row.approvalRate !== null && row.approvalRate !== undefined && (
        <span className="text-muted-foreground text-xs">
          approved {(row.approvalRate * 100).toFixed(0)}%
        </span>
      )}
      {row.zScore !== null && row.zScore !== undefined && row.zScore !== 0 && (
        <span
          className="text-muted-foreground text-xs"
          title={
            row.significant
              ? 'The gap is statistically significant at α=0.05.'
              : 'The gap is not distinguishable from sampling noise, so it cannot fail the gate on its own.'
          }
        >
          z={row.zScore.toFixed(2)}
          {row.significant ? '' : ' (ns)'}
        </span>
      )}
      <span className={`ml-auto text-xs font-medium ${tone}`}>
        {row.passed ? 'within' : 'outside'}
        {indecisive ? ' · sample too small to decide' : ''}
        {row.passed &&
        row.significant === false &&
        row.metric === 'disparate_impact' &&
        row.value < row.threshold
          ? ' · gap not significant'
          : ''}
        {!row.passed && !indecisive && row.blocking === false
          ? ' · monitored'
          : ''}
      </span>
    </div>
  );
}

function GroupList({ rows }: { rows: FairnessReportRow[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {rows.map((r) => (
        <li key={`${r.metric}-${r.group}`} className="font-mono text-xs">
          {r.metric} · {r.group} = {r.value.toFixed(2)} (needs{' '}
          {r.metric === 'demographic_parity' ? '≤' : '≥'} {r.threshold})
        </li>
      ))}
    </ul>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'danger' | 'warning';
  title: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'danger'
      ? 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400'
      : 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400';
  return (
    <div className={`rounded-lg border p-4 ${cls}`}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-muted-foreground mt-1 text-sm leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className={`mt-0.5 text-sm ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
