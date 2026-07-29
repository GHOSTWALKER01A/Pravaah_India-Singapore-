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
import { passportService } from '@/lib/api/passport/passport.service';

/** Mirrors the Prisma CredentialStatus enum. */
const FILTERS = [
  { value: 'ALL', label: 'All passports' },
  { value: 'ISSUED', label: 'Live' },
  { value: 'SUSPENDED', label: 'On hold' },
  { value: 'REVOKED', label: 'Revoked' },
  { value: 'EXPIRED', label: 'Expired' },
];

const PAGE_SIZE = 50;

const STATUS_COLOR: Record<string, string> = {
  ISSUED: 'text-green-600 dark:text-green-400',
  SUSPENDED: 'text-amber-600 dark:text-amber-400',
  REVOKED: 'text-red-600 dark:text-red-400',
  EXPIRED: 'text-zinc-500 dark:text-zinc-400',
};

const BAND_COLOR: Record<string, string> = {
  POOR: 'text-red-600 dark:text-red-400',
  FAIR: 'text-amber-600 dark:text-amber-400',
  GOOD: 'text-blue-600 dark:text-blue-400',
  VERY_GOOD: 'text-indigo-600 dark:text-indigo-400',
  EXCELLENT: 'text-green-600 dark:text-green-400',
};

/**
 * Every credential the platform has issued.
 *
 * REVOKED and EXPIRED rows are first-class here rather than filtered away: the question a
 * reviewer actually arrives with is "why did this person's passport stop working?", and that
 * is unanswerable from a list of live ones.
 *
 * No claim values appear anywhere on this page. An admin needs to know a passport exists, who
 * holds it, and what state it is in — not the holder's name or score. That is a deliberate
 * limit of the console, enforced by the backend projection rather than by this component.
 */
export default function PassportsPage() {
  const [status, setStatus] = useState('ALL');
  const [offset, setOffset] = useState(0);

  const stats = useQuery({
    queryKey: ['passport-stats'],
    queryFn: () => passportService.stats(),
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['passports', status, offset],
    queryFn: () =>
      passportService.listCredentials({ status, limit: PAGE_SIZE, offset }),
  });

  const failureRate = stats.data?.last30Days.failureRate ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Passports</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every issued credential, its status-list position, and everyone it has been
            presented to. Claim values are never shown here — only which claims exist.
          </p>
        </div>
        <Select
          aria-label="Filter passports by status"
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

      {/* Operational tiles. The FAILED presentation rate leads, because a spike in refused
          presentations against one credential is the shape a theft attempt makes — and it is
          invisible on a dashboard that only counts issuance. */}
      {stats.data && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Live" value={stats.data.credentials.ISSUED ?? 0} />
          <Stat
            label="Revoked"
            value={stats.data.credentials.REVOKED ?? 0}
            tone={
              (stats.data.credentials.REVOKED ?? 0) > 0 ? 'muted' : 'default'
            }
          />
          <Stat
            label="Shares (30d)"
            value={stats.data.last30Days.presentations}
          />
          <Stat
            label="Refused (30d)"
            value={stats.data.last30Days.failedPresentations}
            detail={`${(failureRate * 100).toFixed(1)}% of shares`}
            // Any refusals at all deserve a look; a high rate is an alarm.
            tone={
              stats.data.last30Days.failedPresentations === 0
                ? 'default'
                : failureRate > 0.1
                  ? 'alert'
                  : 'warn'
            }
          />
        </div>
      )}

      {isLoading && (
        <p className="text-muted-foreground mt-6 text-sm">Loading…</p>
      )}
      {isError && (
        <p className="mt-6 text-sm text-red-600 dark:text-red-400">
          {(error as Error).message}
        </p>
      )}

      {data && data.items.length === 0 && (
        <p className="text-muted-foreground mt-6 text-sm">
          No passports match this filter.
        </p>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="mt-6 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Credential</TableHead>
                  <TableHead>Holder</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Band</TableHead>
                  <TableHead>Rails</TableHead>
                  <TableHead>Shares</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        href={ROUTES.DASHBOARD.PASSPORT_DETAIL(item.id)}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {item.credentialNumber}
                      </Link>
                      {item.passportBound && (
                        <span
                          className="text-muted-foreground ml-2 text-[10px] uppercase tracking-wide"
                          title="Bound to a verified passport number — usable for cross-border verification"
                        >
                          Intl
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {item.pravaahId ?? '—'}
                    </TableCell>
                    <TableCell
                      className={STATUS_COLOR[item.status] ?? ''}
                      title={item.revokeReason ?? undefined}
                    >
                      {item.status}
                    </TableCell>
                    <TableCell className={BAND_COLOR[item.scoreBand ?? ''] ?? ''}>
                      {item.scoreBand?.replace(/_/g, ' ') ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.dataRails.join(', ')}
                    </TableCell>
                    <TableCell>{item.presentationCount}</TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(item.expiresAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <p className="text-muted-foreground text-sm">
              {offset + 1}–{offset + data.items.length} of {data.total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={offset + data.items.length >= data.total}
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

function Stat({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: 'default' | 'muted' | 'warn' | 'alert';
}) {
  const valueTone =
    tone === 'alert'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'muted'
          ? 'text-zinc-500 dark:text-zinc-400'
          : '';

  return (
    <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold ${valueTone}`}>{value}</p>
      {detail && <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>}
    </div>
  );
}
