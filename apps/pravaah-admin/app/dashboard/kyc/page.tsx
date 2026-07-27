'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { StatusBadge } from '@/components/kyc/status-badge';
import { useReviewStream } from '@/features/kyc/use-review-stream';
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
import { kycService } from '@/lib/api/kyc/kyc.service';
import { formatDateTime } from '@/helper/date-convertor';

/**
 * Queue filters. `APPROVED`/`REJECTED` are decisions on a RESOLVED case (not
 * case statuses), so the backend maps them to `status=RESOLVED + decision=…`.
 * `RESOLVED` shows both; `ALL` shows everything.
 */
const FILTERS: { value: string; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'CLAIMED', label: 'Claimed' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'RESOLVED', label: 'Resolved (all)' },
  { value: 'ALL', label: 'All cases' },
];

export default function KycQueuePage() {
  const [status, setStatus] = useState('OPEN');
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['kyc-cases', status],
    queryFn: () => kycService.listCases(status),
  });

  // Live queue: refetch whenever any case changes, pushed via SSE/Redis.
  const onReviewEvent = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['kyc-cases'] });
  }, [queryClient]);
  useReviewStream(onReviewEvent);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">KYC Review</h1>
        <Select
          aria-label="Filter cases by status"
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
          {error instanceof Error ? error.message : 'Failed to load cases'}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="text-muted-foreground mt-6 text-sm">
          No “{FILTERS.find((f) => f.value === status)?.label ?? status}”
          cases.
        </p>
      )}

      {data && data.length > 0 && (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono font-medium">
                  {c.caseCode}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{c.userName}</div>
                  <div className="text-muted-foreground font-mono text-xs">
                    {c.userRef}
                  </div>
                </TableCell>
                <TableCell>{c.country}</TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(c.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm">
                    <Link href={ROUTES.DASHBOARD.KYC_CASE(c.id)}>Review</Link>
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
