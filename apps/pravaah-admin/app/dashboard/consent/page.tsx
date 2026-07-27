'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import { StatusBadge } from '@/components/kyc/status-badge';
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
import { consentService } from '@/lib/api/consent/consent.service';

/** Consent lifecycle filters (mirror the Prisma ConsentStatus enum). */
const FILTERS: { value: string; label: string }[] = [
  { value: 'ALL', label: 'All consents' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'REVOKED', label: 'Revoked' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'FAILED', label: 'Failed' },
];

export default function ConsentEstatePage() {
  const [status, setStatus] = useState('ALL');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['consents', status],
    queryFn: () => consentService.listConsents(status),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Consent estate</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Account Aggregator data-sharing consents. Read-only oversight — the
            append-only audit trail is the compliance record.
          </p>
        </div>
        <Select
          aria-label="Filter consents by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-48"
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
          {error instanceof Error ? error.message : 'Failed to load consents'}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="text-muted-foreground mt-6 text-sm">
          No “{FILTERS.find((f) => f.value === status)?.label ?? status}”
          consents.
        </p>
      )}

      {data && data.length > 0 && (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Purpose</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Artefact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="max-w-55">
                  <div className="truncate font-medium">{c.purpose}</div>
                  <div className="text-muted-foreground font-mono text-xs">
                    {c.purposeCode} · {c.fetchType}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {c.userRef ?? '—'}
                </TableCell>
                <TableCell className="text-xs">
                  {c.fiTypes.map((t) => t.replaceAll('_', ' ')).join(', ')}
                </TableCell>
                <TableCell className="uppercase">{c.aaProvider}</TableCell>
                <TableCell>
                  {c.artefactVerified ? (
                    <span className="text-green-600 dark:text-green-400">
                      Verified
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Unverified</span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(c.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm">
                    <Link href={ROUTES.DASHBOARD.CONSENT_DETAIL(c.id)}>
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
