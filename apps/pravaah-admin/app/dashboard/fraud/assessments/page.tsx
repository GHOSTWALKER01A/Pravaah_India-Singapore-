'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import {
  DecisionBadge,
  ScoreReadout,
  subjectLabel,
} from '@/components/fraud/badges';
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
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';
import type { RiskDecision } from '@/lib/api/fraud/fraud.schema';

const PAGE_SIZE = 25;

/**
 * Filters ordered by what somebody investigating the MODEL wants, not by severity.
 *
 * `ALL` leads here — the opposite of the case queue — because this page answers "what is the
 * engine doing", and that question needs the denominator. A view that opened on holds alone
 * would show a wall of stopped payments and no sense of what fraction they are.
 */
const FILTERS: { key: RiskDecision | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'Every decision' },
  { key: 'HOLD', label: 'Held' },
  { key: 'BLOCK', label: 'Blocked' },
  { key: 'STEP_UP', label: 'Challenged' },
  { key: 'REVIEW', label: 'Sampled' },
  { key: 'ALLOW', label: 'Allowed' },
];

/**
 * Every risk decision the engine has made — the model's behaviour, inspectable.
 *
 * ## Why this page exists separately from the case queue
 *
 * The queue is WORK: rows with a person waiting. This is CALIBRATION: it answers whether the
 * thresholds are right, which is a different job done at a different cadence by someone asking
 * a different question.
 *
 * The two failure modes it exists to catch are opposite and equally bad. If challenges dominate
 * allows, the thresholds are too tight and the product is unusable — users will be asked for a
 * code on every payment and will stop paying. If nothing ever leaves `ALLOW`, the layers are
 * not wired: a fraud engine that has never held anything is indistinguishable from one that is
 * switched off, and both report success.
 *
 * ## Why the score is shown here and not in the app
 *
 * An analyst tuning a threshold needs the arithmetic. A customer must not have it — a precise
 * score turns the user-facing view into a calibration oracle, letting somebody tune inputs
 * until the number drops below a threshold they can watch. That asymmetry is the reason there
 * are two projections of one assessment rather than one.
 */
export default function FraudAssessmentsPage() {
  const [decision, setDecision] = useState<RiskDecision | 'ALL'>('ALL');
  const [offset, setOffset] = useState(0);

  const assessments = useQuery({
    queryKey: ['fraud-assessments', decision, offset],
    queryFn: () =>
      fraudAdminService.assessments({
        decision,
        limit: PAGE_SIZE,
        offset,
      }),
    refetchInterval: 60_000,
  });

  const rows = assessments.data?.items ?? [];
  const total = assessments.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Risk decisions</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every assessment, with the score and the signals behind it. Newest first.
        </p>
      </header>

      <FilterChips
        options={FILTERS}
        value={decision}
        onChange={(next) => {
          setDecision(next);
          setOffset(0);
        }}
        trailing={
          assessments.isFetching ? (
            <span className="text-muted-foreground text-xs">Refreshing…</span>
          ) : null
        }
      />

      {assessments.isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          Could not load the assessments.
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Signals</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Customer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && !assessments.isLoading ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="text-muted-foreground py-8 text-center text-sm"
              >
                {decision === 'ALL'
                  ? 'No assessments recorded yet. Nothing has been scored — check that the modules are calling the engine.'
                  : 'No decisions of that kind.'}
              </TableCell>
            </TableRow>
          ) : null}

          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-xs">
                {formatDateTime(row.computedAt)}
              </TableCell>

              <TableCell>
                <Link
                  href={ROUTES.DASHBOARD.FRAUD_ASSESSMENT_DETAIL(row.id)}
                  className="underline-offset-2 hover:underline"
                >
                  {subjectLabel(row.subjectType)}
                </Link>
                {row.geoHint ? (
                  <span className="text-muted-foreground ml-2 font-mono text-[10px]">
                    {row.geoHint}
                  </span>
                ) : null}
              </TableCell>

              <TableCell>
                <DecisionBadge decision={row.decision} />
              </TableCell>

              <TableCell>
                <ScoreReadout score={row.score} />
              </TableCell>

              <TableCell>
                <span className="flex flex-wrap items-center gap-1">
                  {row.signals.slice(0, 3).map((signal) => (
                    <span
                      key={signal.type}
                      className={`rounded px-1 py-0.5 font-mono text-[10px] ${
                        signal.isHard
                          ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                      }`}
                    >
                      {signal.type}
                    </span>
                  ))}
                  {row.signals.length > 3 ? (
                    <span className="text-muted-foreground text-[10px]">
                      +{row.signals.length - 3}
                    </span>
                  ) : null}
                  {row.signals.length === 0 ? (
                    <span className="text-muted-foreground text-[10px]">
                      nothing fired
                    </span>
                  ) : null}
                </span>
              </TableCell>

              <TableCell className="text-muted-foreground font-mono text-[10px]">
                {row.modelVersion}
              </TableCell>

              <TableCell>
                <Link
                  href={ROUTES.DASHBOARD.FRAUD_USER(row.userId)}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {row.userId.slice(0, 8)}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Pager
        page={Math.floor(offset / PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        total={total}
        onPage={(page) => setOffset(page * PAGE_SIZE)}
        noun="assessments"
      />
    </div>
  );
}
