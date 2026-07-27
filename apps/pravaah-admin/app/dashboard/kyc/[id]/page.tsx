'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { StatusBadge } from '@/components/kyc/status-badge';
import { formatDateTime } from '@/helper/date-convertor';
import type { KycCheckRow } from '@/lib/api/kyc/kyc.schema';
import { kycService } from '@/lib/api/kyc/kyc.service';

export default function KycCaseDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['kyc-case', id],
    queryFn: () => kycService.getCase(id),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['kyc-case', id] });
    queryClient.invalidateQueries({ queryKey: ['kyc-cases'] });
  };

  const claim = useMutation({
    mutationFn: () => kycService.claimCase(id),
    onSuccess: () => {
      toast.success('Case claimed');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  const decide = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') =>
      kycService.decideCase(id, { decision, notes }),
    onSuccess: () => {
      toast.success('Decision recorded');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  if (isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (isError)
    return (
      <p className="text-sm text-red-500">
        {error instanceof Error ? error.message : 'Failed to load case'}
      </p>
    );
  if (!data) return null;

  const resolved = data.status === 'RESOLVED';

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-semibold">{data.caseCode}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {data.userName} · <span className="font-mono">{data.userRef}</span>
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {/* Case summary */}
      <Section title="Case">
        <Field label="Case status" value={<StatusBadge status={data.status} />} />
        <Field label="Reason" value={data.reason ?? '—'} />
        <Field label="Country" value={data.country} />
        <Field label="Claimed by" value={data.claimedBy ?? 'Unclaimed'} />
        <Field label="SLA due" value={formatDateTime(data.slaDueAt)} />
        <Field label="Opened" value={formatDateTime(data.createdAt)} />
        <Field label="Last updated" value={formatDateTime(data.updatedAt)} />
        {resolved && (
          <>
            <Field
              label="Decision"
              value={data.decision ? <StatusBadge status={data.decision} /> : '—'}
            />
            <Field label="Resolved" value={formatDateTime(data.resolvedAt)} />
            <Field label="Decision notes" value={data.decisionNotes ?? '—'} />
          </>
        )}
      </Section>

      {/* User */}
      <Section title="User">
        <Field label="Reference" value={<span className="font-mono">{data.user.ref}</span>} />
        <Field label="Verified name" value={data.user.name ?? '—'} />
        <Field label="Email" value={data.user.email ?? '—'} />
        <Field label="Phone" value={data.user.phone ?? '—'} />
        <Field label="Primary country" value={data.user.country} />
        <Field
          label="Account status"
          value={data.user.suspended ? 'Suspended' : 'Active'}
        />
        <Field label="Registered" value={formatDateTime(data.user.createdAt)} />
      </Section>

      {/* KYC profile */}
      <Section title="KYC profile">
        <Field
          label="Overall status"
          value={<StatusBadge status={data.profile.overallStatus} />}
        />
        <Field
          label="Name match"
          value={fmtScore(data.profile.nameMatchScore)}
        />
        <Field label="Risk score" value={fmtScore(data.profile.riskScore)} />
        <Field label="Started" value={formatDateTime(data.profile.startedAt)} />
        <Field
          label="Completed"
          value={formatDateTime(data.profile.completedAt)}
        />
      </Section>

      {/* Checks */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-500">
          Checks ({data.checks.length})
        </h2>
        {data.checks.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No checks recorded.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/10">
            {data.checks.map((c: KycCheckRow, i) => (
              <li
                key={`${c.checkType}-${c.attempt ?? i}`}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium">
                    {c.checkType.replaceAll('_', ' ')}
                    {c.attempt && c.attempt > 1 ? (
                      <span className="text-muted-foreground ml-2 text-xs">
                        attempt {c.attempt}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {c.provider}
                    {typeof c.confidence === 'number'
                      ? ` · ${(c.confidence * 100).toFixed(0)}% confidence`
                      : ''}
                    {c.updatedAt ? ` · ${formatDateTime(c.updatedAt)}` : ''}
                  </div>
                </div>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Actions */}
      {!resolved && (
        <div className="mt-8 flex flex-col gap-4 rounded-lg border border-black/10 p-6 dark:border-white/10">
          {data.status === 'OPEN' && (
            <button
              onClick={() => claim.mutate()}
              disabled={claim.isPending}
              className="self-start rounded-md border border-black/10 px-4 py-2 text-sm disabled:opacity-50 dark:border-white/15"
            >
              {claim.isPending ? 'Claiming…' : 'Claim case'}
            </button>
          )}

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Decision notes (required, min 3 characters)"
            rows={3}
            className="rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          />
          <div className="flex gap-3">
            <button
              onClick={() => decide.mutate('APPROVED')}
              disabled={decide.isPending || notes.trim().length < 3}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => decide.mutate('REJECTED')}
              disabled={decide.isPending || notes.trim().length < 3}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Reject
            </button>
          </div>
          {data.status === 'OPEN' && (
            <p className="text-muted-foreground text-xs">
              Claim the case before recording a decision.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-500">{title}</h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-black/10 p-4 text-sm sm:grid-cols-2 dark:border-white/10">
        {children}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium wrap-break-word">{value}</dd>
    </div>
  );
}

function fmtScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return '—';
  return `${(score * 100).toFixed(0)}%`;
}
