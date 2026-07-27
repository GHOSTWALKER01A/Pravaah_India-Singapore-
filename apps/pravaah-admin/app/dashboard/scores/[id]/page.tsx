'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import type { ScoreBand } from '@/lib/api/scoring/scoring.schema';
import { scoringService } from '@/lib/api/scoring/scoring.service';

const BANDS: ScoreBand[] = ['POOR', 'FAIR', 'GOOD', 'VERY_GOOD', 'EXCELLENT'];
const MIN_REASON = 20;

/**
 * Score audit — the model-risk exhibit for a single decision.
 *
 * Answers, for any score: which consented data, which model version, which
 * runtime actually served it, which factors drove it, and who has touched it.
 *
 * Note what it does NOT show: the feature VALUES. It shows the `inputsHash`,
 * which proves the score is reproducible, without handing a reviewer a window
 * into someone's bank statement. That asymmetry is deliberate.
 */
export default function ScoreAuditPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const queryClient = useQueryClient();

  const [newBand, setNewBand] = useState<ScoreBand | ''>('');
  const [reason, setReason] = useState('');

  const score = useQuery({
    queryKey: ['score', id],
    queryFn: () => scoringService.getScore(id),
    enabled: Boolean(id),
  });

  const trail = useQuery({
    queryKey: ['score-audit', id],
    queryFn: () => scoringService.getScoreAudit(id),
    enabled: Boolean(id),
  });

  const override = useMutation({
    mutationFn: () =>
      scoringService.overrideScore(id, newBand as ScoreBand, reason),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['score', id] });
      void queryClient.invalidateQueries({ queryKey: ['score-audit', id] });
      void queryClient.invalidateQueries({ queryKey: ['scores'] });
      setNewBand('');
      setReason('');
      toast.success(
        `Band changed ${result.previousBand} → ${result.newBand}`,
        {
          description:
            'The model value is unchanged. Both are kept so the audit can always show the gap.',
        },
      );
    },
    onError: (err) =>
      toast.error('Override failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  });

  if (score.isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (score.isError) {
    return (
      <p className="text-sm text-red-500">
        {score.error instanceof Error
          ? score.error.message
          : 'Failed to load score'}
      </p>
    );
  }
  const data = score.data;
  if (!data) return null;

  const consent = data.provenance.consent;
  const canOverride = data.band !== null && data.value !== null;
  const reasonTooShort = reason.trim().length < MIN_REASON;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link
          href={ROUTES.DASHBOARD.SCORES}
          className="text-muted-foreground text-xs hover:underline"
        >
          ← Issued scores
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-4">
          <h1 className="font-mono text-3xl font-semibold">
            {data.value ?? '—'}
          </h1>
          <span className="text-lg">
            {data.band?.replaceAll('_', ' ') ?? 'no band'}
          </span>
          {data.confidence !== null && (
            <span className="text-muted-foreground text-sm">
              confidence {data.confidence.toFixed(2)}
              {data.bandLow !== null && data.bandHigh !== null
                ? ` · likely ${data.bandLow}–${data.bandHigh}`
                : ''}
            </span>
          )}
          <span className="text-muted-foreground text-sm">
            {data.status.replaceAll('_', ' ')}
          </span>
        </div>
        {data.failureReason && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            {data.failureReason}
          </p>
        )}
      </div>

      {/* Reproducibility receipt */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          Reproducibility receipt
        </div>
        <div className="mt-1 break-all font-mono text-xs">{data.inputsHash}</div>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          sha256 of the ordered feature vector. This hash plus model version{' '}
          <span className="font-mono">v{data.provenance.model.version}</span>{' '}
          reproduces this exact score. The feature values themselves are not
          stored on the score and are not shown here — the hash is what proves
          reproducibility without exposing the user&apos;s financial data.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Coverage" value={data.coverage !== null ? `${Math.round(data.coverage * 100)}%` : '—'} />
        <Field label="Features imputed" value={String(data.missingCount)} />
        <Field label="Served by" value={data.servedBy ?? '—'} mono />
        <Field label="Runtime" value={data.provenance.model.runtime} mono />
        <Field
          label="Computed"
          value={data.computedAt ? formatDateTime(data.computedAt) : '—'}
        />
        <Field
          label="Expires"
          value={data.expiresAt ? formatDateTime(data.expiresAt) : '—'}
        />
        <Field label="User" value={data.userRef ?? '—'} mono />
        <Field label="KYC" value={data.user.kycStatus} />
      </section>

      {/* Provenance: which consent authorised this, and which model priced it. */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="text-sm font-semibold">Consent that authorised it</h2>
          {consent ? (
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row label="Purpose" value={`${consent.purpose} (${consent.purposeCode})`} />
              <Row label="FI types" value={consent.fiTypes.join(', ')} />
              <Row label="AA provider" value={consent.aaProvider} />
              <Row
                label="Artefact"
                value={consent.artefactVerified ? 'Verified' : 'Unverified'}
              />
              <Row label="Status" value={consent.status} />
              <Row
                label="Data range"
                value={`${new Date(consent.dataRangeFrom).toLocaleDateString()} → ${new Date(consent.dataRangeTo).toLocaleDateString()}`}
              />
              <Row
                label="Consent"
                value={
                  <Link
                    href={ROUTES.DASHBOARD.CONSENT_DETAIL(consent.id)}
                    className="underline"
                  >
                    Inspect →
                  </Link>
                }
              />
            </dl>
          ) : (
            <p className="text-muted-foreground mt-2 text-sm">
              The consent behind this score no longer exists — it was revoked and
              purged. The score itself will expire on the next lifecycle sweep.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="text-sm font-semibold">Model that produced it</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row
              label="Version"
              value={`${data.provenance.model.name} v${data.provenance.model.version}`}
            />
            <Row label="Runtime" value={data.provenance.model.runtime} />
            <Row
              label="Trained"
              value={formatDateTime(data.provenance.model.trainedAt)}
            />
            <Row label="Dataset" value={data.provenance.model.datasetRef ?? '—'} />
            <Row
              label="Fairness"
              value={
                data.provenance.model.fairnessPassed
                  ? `Passed${data.provenance.model.fairnessAt ? ` ${formatDateTime(data.provenance.model.fairnessAt)}` : ''}`
                  : 'Not passed'
              }
            />
            <Row
              label="Model"
              value={
                <Link
                  href={ROUTES.DASHBOARD.MODEL_DETAIL(data.provenance.model.id)}
                  className="underline"
                >
                  Inspect →
                </Link>
              }
            />
          </dl>
        </div>
      </section>

      {/* Factors — from the same prediction call that produced the number. */}
      <section>
        <h2 className="text-lg font-semibold">Why this score</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Exact Shapley contributions in the model&apos;s margin space, from the
          same prediction call that produced the value — so the explanation cannot
          drift from the number.
        </p>
        <div className="mt-3 divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/10">
          {data.factors.length === 0 && (
            <p className="text-muted-foreground p-4 text-sm">
              No factor breakdown recorded.
            </p>
          )}
          {data.factors.map((f) => (
            <div key={f.feature} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
              <span className="text-muted-foreground w-6 font-mono text-xs">
                {f.rank}
              </span>
              <span className="min-w-45 font-medium">{f.label}</span>
              <span
                className={`w-20 font-mono text-xs ${
                  f.direction === 'POSITIVE'
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {f.shapValue >= 0 ? '+' : ''}
                {f.shapValue.toFixed(4)}
              </span>
              <span className="text-muted-foreground flex-1 text-xs">
                {f.plainText}
              </span>
            </div>
          ))}
        </div>
      </section>

      {data.improvements.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">Improvements offered</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Point gains are real counterfactual deltas — the model was re-run with
            each feature moved to its target and everything else held.
          </p>
          <div className="mt-3 divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/10">
            {data.improvements.map((im) => (
              <div key={im.feature} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                <span className="min-w-45 font-medium">{im.label}</span>
                <span className="font-mono text-xs text-green-600 dark:text-green-400">
                  +{im.estimatedGain} pts
                </span>
                <span className="text-muted-foreground font-mono text-xs">
                  {im.currentValue} → {im.targetValue}
                </span>
                <span className="text-muted-foreground flex-1 text-xs">
                  {im.plainText}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Override ───────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          Manual band override
        </h2>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          A documented human judgement about the <strong>band</strong>, not a
          rewrite of the model&apos;s output — the computed value stays exactly as
          it was, so the audit can always show the gap between what the model said
          and what a person decided. Senior reviewers only, reason mandatory,
          permanently attributed.
        </p>

        {!canOverride ? (
          <p className="text-muted-foreground mt-3 text-sm">
            This score has no computed band to override.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="New band"
                value={newBand}
                onChange={(e) => setNewBand(e.target.value as ScoreBand | '')}
                className="w-56"
              >
                {/* Disabled so it reads as a prompt rather than a valid choice —
                    the submit button is gated on a real band being picked. */}
                <option value="" disabled>
                  Select a new band…
                </option>
                {BANDS.filter((b) => b !== data.band).map((b) => (
                  <option key={b} value={b}>
                    {b.replaceAll('_', ' ')}
                  </option>
                ))}
              </Select>
              <span className="text-muted-foreground text-sm">
                currently {data.band?.replaceAll('_', ' ')}
              </span>
            </div>

            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this override justified? A model-risk reviewer will read this."
              className="border-input w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <span
                className={`text-xs ${reasonTooShort ? 'text-muted-foreground' : 'text-green-600 dark:text-green-400'}`}
              >
                {reason.trim().length}/{MIN_REASON} characters minimum
              </span>
              <Button
                onClick={() => override.mutate()}
                disabled={!newBand || reasonTooShort || override.isPending}
              >
                {override.isPending ? 'Recording…' : 'Record override'}
              </Button>
            </div>
          </div>
        )}

        {data.overrides.length > 0 && (
          <div className="mt-5 space-y-2 border-t border-amber-500/20 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Override history
            </div>
            {data.overrides.map((o) => (
              <div key={o.id} className="text-sm">
                <div className="font-mono text-xs">
                  {o.previousBand} → {o.newBand} · {o.admin.email} ({o.admin.role})
                  · {formatDateTime(o.createdAt)}
                </div>
                <div className="text-muted-foreground">{o.reason}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Append-only trail */}
      <section>
        <h2 className="text-lg font-semibold">Audit trail</h2>
        {trail.data && trail.data.length === 0 && (
          <p className="text-muted-foreground mt-2 text-sm">
            No audit rows recorded for this score.
          </p>
        )}
        {trail.data && trail.data.length > 0 && (
          <div className="mt-3 divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/10">
            {trail.data.map((row) => (
              <div key={row.id} className="p-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-muted-foreground text-xs">
                    {row.actorType}
                  </span>
                  <span className="text-muted-foreground ml-auto text-xs">
                    {formatDateTime(row.createdAt)}
                  </span>
                </div>
                {row.metadata ? (
                  <pre className="text-muted-foreground mt-1 overflow-x-auto text-xs">
                    {JSON.stringify(row.metadata)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className={`mt-0.5 text-sm ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <dt className="text-muted-foreground w-28 shrink-0 text-xs uppercase tracking-wide">
        {label}
      </dt>
      <dd className="flex-1">{value}</dd>
    </div>
  );
}
