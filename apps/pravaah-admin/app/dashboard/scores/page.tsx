'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
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

/** Mirrors the Prisma ScoreStatus enum. */
const FILTERS = [
  { value: 'ALL', label: 'All scores' },
  { value: 'COMPUTED', label: 'Computed' },
  { value: 'OVERRIDDEN', label: 'Overridden' },
  { value: 'INSUFFICIENT_DATA', label: 'Insufficient data' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'EXPIRED', label: 'Expired' },
];

const PAGE_SIZE = 50;

const BAND_COLOR: Record<string, string> = {
  POOR: 'text-red-600 dark:text-red-400',
  FAIR: 'text-amber-600 dark:text-amber-400',
  GOOD: 'text-blue-600 dark:text-blue-400',
  VERY_GOOD: 'text-indigo-600 dark:text-indigo-400',
  EXCELLENT: 'text-green-600 dark:text-green-400',
};

/**
 * Every score the platform has issued.
 *
 * `INSUFFICIENT_DATA` rows are first-class here rather than filtered out: an
 * honest refusal is a real outcome M2 is accountable for, and a reviewer needs to
 * see how often the engine declines to score someone.
 */
export default function IssuedScoresPage() {
  const [status, setStatus] = useState('ALL');
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['scores', status, offset],
    queryFn: () =>
      scoringService.listScores({ status, limit: PAGE_SIZE, offset }),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Issued scores</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every score, its model version, and which runtime actually served it.
            Open one to see its inputs hash, provenance, and factor breakdown.
          </p>
        </div>
        <Select
          aria-label="Filter scores by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            // Reset paging: offset 12 of the old filter is meaningless in the new one.
            setOffset(0);
          }}
          className="w-52"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      {isLoading && (
        <p className="text-muted-foreground mt-6 text-sm">Loading…</p>
      )}
      {isError && (
        <p className="text-destructive mt-6 text-sm">
          {error instanceof Error ? error.message : 'Failed to load scores'}
        </p>
      )}

      {data && data.items.length === 0 && (
        <p className="text-muted-foreground mt-6 text-sm">
          No “{FILTERS.find((f) => f.value === status)?.label ?? status}” scores.
        </p>
      )}

      {data && data.items.length > 0 && (
        <>
          <Table className="mt-6">
            <TableHeader>
              <TableRow>
                <TableHead>Score</TableHead>
                <TableHead>Band</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Served by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Computed</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono font-semibold">
                    {s.value ?? '—'}
                  </TableCell>
                  <TableCell>
                    <span
                      className={s.band ? BAND_COLOR[s.band] : 'text-muted-foreground'}
                    >
                      {s.band?.replaceAll('_', ' ') ?? '—'}
                    </span>
                    {s.overrideCount > 0 && (
                      <div className="text-xs text-amber-600 dark:text-amber-400">
                        overridden ×{s.overrideCount}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.confidence !== null ? s.confidence.toFixed(2) : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.coverage !== null
                      ? `${Math.round(s.coverage * 100)}%`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {s.userRef ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    v{s.modelVersion}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.servedBy ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {s.status.replaceAll('_', ' ')}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {s.computedAt ? formatDateTime(s.computedAt) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={ROUTES.DASHBOARD.SCORE_DETAIL(s.id)}>
                        Audit
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {offset + 1}–{offset + data.items.length} of {data.total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
