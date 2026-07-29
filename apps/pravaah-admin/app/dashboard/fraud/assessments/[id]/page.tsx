'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';

import {
  DecisionBadge,
  ScoreReadout,
  SignalBar,
  subjectLabel,
} from '@/components/fraud/badges';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';

/**
 * One risk decision, in full.
 *
 * ## Why this page exists when the case detail already shows a signal trail
 *
 * Because most assessments have NO case. Only a `HOLD` or a `BLOCK` opens one — an `ALLOW`, a
 * `STEP_UP` or a sampled `REVIEW` does not, and those are the overwhelming majority. So without
 * this page the only decisions an operator could inspect would be the ones that stopped
 * somebody, which is precisely the wrong sample for calibration work: you cannot tell whether a
 * threshold is too tight by looking only at what it caught.
 *
 * The near-misses are the interesting rows. A payment that scored 0.84 and was allowed sits one
 * marginal signal away from being held, and this is where you read what that signal would have
 * been.
 */
export default function AssessmentDetailPage() {
  const params = useParams<{ id: string }>();

  const detail = useQuery({
    queryKey: ['fraud-assessment', params.id],
    queryFn: () => fraudAdminService.assessmentDetail(params.id),
  });

  if (detail.isLoading) {
    return (
      <p className="text-muted-foreground text-sm">Loading this decision…</p>
    );
  }

  const row = detail.data;
  if (!row) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Could not load this decision.
      </p>
    );
  }

  /**
   * Sorted by CONTRIBUTION, hard signals first — the same ordering the case detail uses.
   *
   * Consistent on purpose: an analyst who learns to read the trail on one screen should not
   * have to re-learn it on the other.
   */
  const signals = [...row.signals].sort((a, b) => {
    if (a.isHard !== b.isHard) return a.isHard ? -1 : 1;
    return b.weight * b.value - a.weight * a.value;
  });

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {subjectLabel(row.subjectType)}
          </h1>
          <DecisionBadge decision={row.decision} />
          <ScoreReadout score={row.score} />
        </div>
        <p className="text-muted-foreground text-sm">
          {formatDateTime(row.computedAt)} ·{' '}
          <span className="font-mono text-xs">{row.modelVersion}</span>
          {row.geoHint ? ` · ${row.geoHint}` : ''}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">What fired</h2>

          {signals.length === 0 ? (
            /*
              An empty trail is a real and informative outcome, not an error.

              It means every layer ran and none of them objected — which is what the
              overwhelming majority of assessments look like, and what a healthy engine
              produces most of the time.
            */
            <p className="text-muted-foreground text-sm">
              Nothing fired. Every layer ran and none objected.
            </p>
          ) : (
            <ul className="space-y-2">
              {signals.map((signal) => (
                <li
                  key={signal.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs">
                      {signal.type}
                      {signal.isHard ? (
                        <span className="ml-2 text-red-600 dark:text-red-400">
                          bypassed scoring
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {signal.reason}
                    </p>
                  </div>
                  <SignalBar
                    weight={signal.weight}
                    value={signal.value}
                    isHard={signal.isHard}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-medium">Context</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground text-xs">Subject id</dt>
              {/*
                Rendered as-is and wrapped, because it is not always a uuid: a LOGIN is scored
                before any row exists, so its subject is a synthetic key. Truncating would hide
                which kind it is.
              */}
              <dd className="break-all text-right font-mono text-[11px]">
                {row.subjectId}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground text-xs">Device</dt>
              <dd className="text-right font-mono text-[11px]">
                {row.deviceRef ? row.deviceRef.slice(0, 8) : 'none sent'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground text-xs">Network</dt>
              {/*
                A HASH, and that is the whole point. The console cannot show the IP because we
                do not store one — only a keyed hash of the /24. Shown truncated purely so two
                assessments from one network are visibly the same.
              */}
              <dd className="text-right font-mono text-[11px]">
                {row.ipHash ? `${row.ipHash.slice(0, 12)}…` : 'unknown'}
              </dd>
            </div>
          </dl>

          <Link
            href={ROUTES.DASHBOARD.FRAUD_USER(row.userId)}
            className="inline-block text-sm underline underline-offset-2"
          >
            Open this customer&apos;s risk picture →
          </Link>
        </section>
      </div>
    </div>
  );
}
