'use client';

import Link from 'next/link';

import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
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
import { scoringService } from '@/lib/api/scoring/scoring.service';

/**
 * Model registry — the model-risk landing page.
 *
 * The column that matters is Fairness. A version cannot be activated until its
 * bias audit passes, so this table doubles as the deploy queue: registered means
 * "exists", audited means "eligible", active means "pricing real people".
 */
export default function ModelRegistryPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['models'],
    queryFn: () => scoringService.listModels(),
  });

  const { data: drift } = useQuery({
    queryKey: ['drift'],
    queryFn: () => scoringService.getDrift(),
  });

  const active = data?.find((m) => m.isActive);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Models &amp; fairness</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every score is stamped with the version that produced it. A version
            cannot go live until its bias audit passes — fairness is a deploy
            blocker here, not a report that gets filed.
          </p>
        </div>
        <Button asChild>
          <Link href={ROUTES.DASHBOARD.MODEL_REGISTER}>Register a version</Link>
        </Button>
      </div>

      {/* Live state, up front: which model is pricing people right now. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Active model
          </div>
          <div className="mt-1 font-mono text-lg font-semibold">
            {active ? `v${active.version}` : '— none —'}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            {active
              ? `${active.runtime} runtime · ${active.scoreCount ?? 0} scores issued`
              : 'No model is active, so no score can be computed.'}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Registered versions
          </div>
          <div className="mt-1 text-lg font-semibold">{data?.length ?? '—'}</div>
          <div className="text-muted-foreground mt-1 text-xs">
            {data
              ? `${data.filter((m) => m.fairnessPassed).length} passed the fairness gate`
              : ''}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Score drift (24h vs prior week)
          </div>
          <div
            className={`mt-1 text-lg font-semibold ${
              drift?.alert ? 'text-amber-600 dark:text-amber-400' : ''
            }`}
          >
            {drift
              ? `${drift.meanShift > 0 ? '+' : ''}${drift.meanShift} pts`
              : '—'}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            {drift
              ? drift.alert
                ? drift.reasons[0]
                : `Stable · n=${drift.recent.count} recent, ${drift.baseline.count} baseline`
              : ''}
          </div>
        </div>
      </div>

      {isLoading && (
        <p className="text-muted-foreground mt-6 text-sm">Loading…</p>
      )}
      {isError && (
        <p className="text-destructive mt-6 text-sm">
          {error instanceof Error ? error.message : 'Failed to load models'}
        </p>
      )}

      {data && data.length > 0 && (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Runtime</TableHead>
              <TableHead>Trained</TableHead>
              <TableHead>Fairness</TableHead>
              <TableHead>Scores</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="font-mono font-medium">v{m.version}</div>
                  <div className="text-muted-foreground max-w-70 truncate text-xs">
                    {m.notes ?? m.datasetRef ?? m.name}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{m.runtime}</span>
                  {m.runtimeConfigured === false && (
                    <div
                      className="text-xs text-amber-600 dark:text-amber-400"
                      title="No ML_BASE_URL is set, so this runtime cannot be attempted at all."
                    >
                      not configured
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {formatDateTime(m.trainedAt)}
                </TableCell>
                <TableCell>
                  {m.fairnessPassed ? (
                    <span className="text-green-600 dark:text-green-400">
                      Passed
                    </span>
                  ) : m.fairnessAt ? (
                    <span className="text-destructive">Failed</span>
                  ) : (
                    <span className="text-muted-foreground">Not audited</span>
                  )}
                  {m.fairnessReportCount ? (
                    <div className="text-muted-foreground text-xs">
                      {m.fairnessReportCount} group metrics
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {m.scoreCount ?? 0}
                </TableCell>
                <TableCell>
                  {m.isActive ? (
                    <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                      <span className="size-2 rounded-full bg-current" />
                      Active
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Inactive</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm">
                    <Link href={ROUTES.DASHBOARD.MODEL_DETAIL(m.id)}>
                      Inspect
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
